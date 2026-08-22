#!/usr/bin/env node
// Verifies contracts/release-evidence/v0/fixtures/* against the two schemas here, plus the
// semantic MUSTs neither schema alone can express (docs/protocols/release-evidence-v0.md):
//
//   bundle-level:  artifacts sorted-by-digest + unique; known_deviations sorted + unique;
//                  commit_sha/tree_digest same hash width; rollback target != self.
//   ledger-level:  attempt fold -- the transition graph applies per (release_id, bundle_digest)
//                  attempt; failure_phase must match the state the failure occurred in;
//                  staging_skipped required on a preview_verified -> production jump and
//                  forbidden otherwise; event_id unique across the ledger.
//   cross-record:  every event's bundle_digest must equal the REAL JCS sha256 of a bundle in
//                  the same release-collection (a repeated string proves nothing -- sol must-2);
//                  lane-backed bundles need a lane_done_overlay attestation before production;
//                  review.decision=commented never reaches production; rolled_back targets must
//                  be a DIFFERENT release that actually reached production earlier in the
//                  ledger; bundle.rollback.previous_release_id must resolve and differ from
//                  self.
//
// Zero npm dependencies by design. Usage: node verify-fixtures.mjs (no args, no network).

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createValidator } from "../../shared/schema-validator.mjs";
import { scanPersonalDimensions } from "../../shared/personal-dimensions.mjs";
import { canonicalize, sha256hex } from "../../shared/jcs.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(HERE, "fixtures");
const { validate } = createValidator(HERE);

const read = (f) => JSON.parse(readFileSync(path.join(FIXTURES_DIR, f), "utf-8"));
const dedupe = (a) => [...new Set(a)];
const bundleDigestOf = (bundle) => `sha256:${sha256hex(canonicalize(bundle))}`;

function schemaAndScan(schemaFile, instance) {
  const reasons = [];
  reasons.push(...validate(schemaFile, instance));
  reasons.push(...scanPersonalDimensions(instance).map((v) => `personal_dimension_forbidden_key: ${v}`));
  return dedupe(reasons);
}

function checkBundle(bundle) {
  const reasons = schemaAndScan("release-evidence-bundle.schema.json", bundle);
  if (reasons.length > 0) return reasons;

  const digests = bundle.artifacts.map((a) => a.digest);
  if (new Set(digests).size !== digests.length) {
    reasons.push(`artifacts_not_unique: duplicate artifact digest in release_id "${bundle.release_id}"`);
  }
  const sorted = [...digests].sort();
  if (digests.some((d, i) => d !== sorted[i])) {
    reasons.push(
      "artifacts_not_sorted: artifacts[] must be sorted ascending by digest (array order is inside the JCS digest)",
    );
  }
  const dev = bundle.known_deviations;
  if (new Set(dev).size !== dev.length) reasons.push("deviations_not_unique: duplicate entry in known_deviations");
  const devSorted = [...dev].sort();
  if (dev.some((d, i) => d !== devSorted[i])) reasons.push("deviations_not_sorted: known_deviations must be sorted ascending");

  if (bundle.source.commit_sha.length !== bundle.source.tree_digest.length) {
    reasons.push(
      "hash_width_mismatch: source.commit_sha and source.tree_digest have different widths -- one repository has one hash algorithm",
    );
  }
  if (bundle.rollback.previous_release_id === bundle.release_id) {
    reasons.push("rollback_to_self: rollback.previous_release_id must differ from the bundle's own release_id");
  }
  return dedupe(reasons);
}

// --- D5 transition graph, folded PER ATTEMPT (release_id, bundle_digest). `attested` leaves
// the state unchanged and is legal anywhere after prepared. `failed` legality depends on the
// prior state; its failure_phase must match how far the attempt had gotten.
const GRAPH = {
  "(none)": { "prepared|null": "prepared" },
  prepared: {
    "deployed|preview": "preview_deployed",
    "deployed|production": "production_deployed", // preview の無い deploy target (要 preview_skipped -- fold で検査)
    "failed|preview": "failed",
    "failed|production": "failed",
  },
  preview_deployed: { "verified|preview": "preview_verified", "failed|preview": "failed" },
  preview_verified: {
    "deployed|staging": "staging_deployed",
    "deployed|production": "production_deployed",
    "failed|staging": "failed",
    "failed|production": "failed",
  },
  staging_deployed: { "verified|staging": "staging_verified", "failed|staging": "failed" },
  staging_verified: { "deployed|production": "production_deployed", "failed|production": "failed" },
  production_deployed: {
    "verified|production": "production_verified",
    "failed|production": "failed",
    "rolled_back|production": "rolled_back",
  },
  production_verified: { "failed|production": "failed", "rolled_back|production": "rolled_back" },
  failed: {}, // rolled_back|production is allowed conditionally below (attempt must have reached production)
  rolled_back: {},
};
const EXPECTED_FAILURE_PHASE = {
  prepared: "deploy",
  preview_verified: "deploy",
  staging_verified: "deploy",
  preview_deployed: "verification",
  staging_deployed: "verification",
  production_deployed: "verification",
  production_verified: "post_verification",
};

function foldAttempt(rid, digest, evs, problems) {
  let state = "(none)";
  let reachedProduction = false;
  const summary = { reachedProduction: false };

  for (const ev of evs) {
    const key = `${ev.kind}|${ev.environment ?? "null"}`;
    if (ev.kind === "attested") {
      if (state === "(none)") {
        problems.push(
          `illegal_transition: attempt "${rid}"/${digest.slice(0, 14)} event "${ev.event_id}" -- attested before prepared`,
        );
        return summary;
      }
      continue; // 状態不変
    }
    let next = (GRAPH[state] ?? {})[key];
    if (!next && state === "failed" && key === "rolled_back|production" && reachedProduction) {
      next = "rolled_back"; // 失敗の記録が rollback の記録を消さないための条件付き遷移 (sol must-7)
    }
    if (!next) {
      problems.push(
        `illegal_transition: attempt "${rid}"/${digest.slice(0, 14)} event "${ev.event_id}" (${key}) is not legal from derived state "${state}"`,
      );
      return summary;
    }
    if (ev.kind === "failed") {
      const expected = EXPECTED_FAILURE_PHASE[state];
      if (ev.failure_phase !== expected) {
        problems.push(
          `failure_phase_mismatch: event "${ev.event_id}" declares failure_phase "${ev.failure_phase}" but the attempt was in state "${state}" (expected "${expected}")`,
        );
      }
    }
    if (key === "deployed|production") {
      if (state === "prepared") {
        // preview 層そのものが無い deploy target (最初の実 adapter 実証が出した現実)。
        // 事実の記録が無い直行は違法。この jump は staging も定義上スキップするので
        // staging_skipped の併記は禁止 (1つの flag が全体を語る)。
        if (ev.preview_skipped !== true) {
          problems.push(
            `preview_skip_unrecorded: event "${ev.event_id}" jumps prepared -> production without preview_skipped: true (the skip FACT must be recorded on the event)`,
          );
        }
        if (ev.staging_skipped === true) {
          problems.push(
            `staging_skip_misrecorded: event "${ev.event_id}" declares staging_skipped on a prepared -> production jump -- preview_skipped alone tells that story`,
          );
        }
      } else {
        if (ev.preview_skipped === true) {
          problems.push(
            `preview_skip_misrecorded: event "${ev.event_id}" declares preview_skipped after state "${state}" -- preview was not skipped`,
          );
        }
        const direct = state === "preview_verified";
        if (direct && ev.staging_skipped !== true) {
          problems.push(
            `staging_skip_unrecorded: event "${ev.event_id}" jumps preview_verified -> production without staging_skipped: true (D5: the skip FACT must be recorded on the event)`,
          );
        }
        if (!direct && ev.staging_skipped === true) {
          problems.push(
            `staging_skip_misrecorded: event "${ev.event_id}" declares staging_skipped after state "${state}" -- staging was not skipped`,
          );
        }
      }
      reachedProduction = true;
    }
    state = next;
  }
  summary.reachedProduction = reachedProduction;
  return summary;
}

function checkLedger(events, problems) {
  const ids = events.map((e) => e.event_id);
  for (const dup of dedupe(ids.filter((id, i) => ids.indexOf(id) !== i))) {
    problems.push(`duplicate_event_id: "${dup}" appears more than once in the ledger`);
  }
  const attempts = new Map();
  for (const ev of events) {
    const k = `${ev.release_id} ${ev.bundle_digest}`;
    if (!attempts.has(k)) attempts.set(k, []);
    attempts.get(k).push(ev);
  }
  for (const [k, evs] of attempts) {
    const [rid, digest] = k.split(" ");
    foldAttempt(rid, digest, evs, problems);
  }
  // rollback target integrity: a DIFFERENT release whose attempt reached production BEFORE the
  // rollback event (ledger array order is ledger time order).
  for (const [idx, ev] of events.entries()) {
    if (ev.kind !== "rolled_back") continue;
    if (ev.rollback_to_release_id === ev.release_id) {
      problems.push(`rollback_to_self: event "${ev.event_id}" rolls back to its own release_id`);
      continue;
    }
    const targetReached = events.some(
      (e, i) =>
        i < idx && e.release_id === ev.rollback_to_release_id && e.kind === "deployed" && e.environment === "production",
    );
    if (!targetReached) {
      problems.push(
        `dangling_rollback_reference: event "${ev.event_id}" rolls back to "${ev.rollback_to_release_id}", which never reached production earlier in this ledger`,
      );
    }
  }
}

function checkReleaseCollection({ bundles, events }, problems) {
  const digestToBundle = new Map();
  for (const [i, b] of bundles.entries()) {
    const reasons = checkBundle(b);
    if (reasons.length > 0) {
      problems.push(`bundle[${i}] not individually valid: ${reasons.join("; ")}`);
      continue;
    }
    digestToBundle.set(bundleDigestOf(b), b);
  }
  for (const [i, ev] of events.entries()) {
    const reasons = schemaAndScan("release-event.schema.json", ev);
    if (reasons.length > 0) problems.push(`event[${i}] not individually valid: ${reasons.join("; ")}`);
  }
  if (problems.length > 0) return;

  for (const ev of events) {
    const bundle = digestToBundle.get(ev.bundle_digest);
    if (!bundle) {
      problems.push(
        `bundle_digest_unresolved: event "${ev.event_id}" carries bundle_digest ${ev.bundle_digest.slice(0, 18)}..., which is not the JCS sha256 of any bundle in this collection (a repeated string is not evidence)`,
      );
    } else if (bundle.release_id !== ev.release_id) {
      problems.push(
        `release_id_mismatch: event "${ev.event_id}" (release_id "${ev.release_id}") references the bundle of "${bundle.release_id}"`,
      );
    }
  }
  if (problems.length > 0) return;

  checkLedger(events, problems);

  // production gates, checkable only with the real bundle at hand
  for (const [idx, ev] of events.entries()) {
    if (!(ev.kind === "deployed" && ev.environment === "production")) continue;
    const bundle = digestToBundle.get(ev.bundle_digest);
    if (bundle.lane_ref !== null) {
      const attested = events.some(
        (e, i) => i < idx && e.kind === "attested" && e.bundle_digest === ev.bundle_digest && e.attestation.kind === "lane_done_overlay",
      );
      if (!attested) {
        problems.push(
          `production_gate_missing_done_attestation: event "${ev.event_id}" deploys a lane-backed bundle to production with no prior lane_done_overlay attestation`,
        );
      }
    }
    if (bundle.review !== null && bundle.review.decision === "commented") {
      problems.push(
        `production_gate_review_not_passed: event "${ev.event_id}" deploys a bundle whose review.decision is "commented" -- a comment is not a pass`,
      );
    }
  }
  // bundle rollback pointer resolution (against the same collection)
  const knownReleases = new Set(bundles.map((b) => b.release_id));
  for (const b of bundles) {
    const prev = b.rollback.previous_release_id;
    if (prev !== null && !knownReleases.has(prev) && !events.some((e) => e.release_id === prev)) {
      problems.push(
        `previous_release_unresolved: bundle "${b.release_id}" names previous_release_id "${prev}", which appears nowhere in this collection`,
      );
    }
  }
}

function runFixture(entry) {
  const problems = [];
  if (entry.type === "bundle") {
    problems.push(...checkBundle(read(entry.files)));
  } else if (entry.type === "event") {
    problems.push(...schemaAndScan("release-event.schema.json", read(entry.files)));
  } else if (entry.type === "event-collection") {
    const events = read(entry.files);
    for (const [i, ev] of events.entries()) {
      const reasons = schemaAndScan("release-event.schema.json", ev);
      if (reasons.length > 0) problems.push(`event[${i}] not individually valid: ${reasons.join("; ")}`);
    }
    if (problems.length === 0) checkLedger(events, problems);
  } else if (entry.type === "release-collection") {
    checkReleaseCollection(read(entry.files), problems);
  } else {
    problems.push(`unknown fixture type "${entry.type}"`);
  }
  return { category: problems.length ? "reject" : "accept", reasons: problems };
}

function main() {
  const manifest = read("expected-results.json");
  if (!Array.isArray(manifest.fixtures) || manifest.fixtures.length === 0) {
    console.error("expected-results.json declares zero fixtures -- refusing to report success.");
    process.exit(1);
  }
  // manifest completeness: the declared set and the directory contents must match exactly
  const declared = new Set(manifest.fixtures.map((e) => e.files));
  if (declared.size !== manifest.fixtures.length) {
    console.error("expected-results.json lists the same fixture twice -- refusing.");
    process.exit(1);
  }
  const onDisk = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".json") && f !== "expected-results.json");
  const undeclared = onDisk.filter((f) => !declared.has(f));
  const missing = [...declared].filter((f) => !onDisk.includes(f));
  if (undeclared.length > 0 || missing.length > 0) {
    console.error(`fixture/manifest drift -- undeclared on disk: [${undeclared}] / declared but absent: [${missing}]`);
    process.exit(1);
  }

  let failures = 0;
  console.log(`release-evidence:v0 fixture verification (${manifest.fixtures.length} fixtures)\n`);
  for (const entry of manifest.fixtures) {
    const result = runFixture(entry);
    let ok = result.category === entry.expected;
    if (ok && entry.expected === "reject" && entry.reason_code) {
      ok = result.reasons.some((r) => r.includes(entry.reason_code));
    }
    const status = ok ? "PASS" : "FAIL";
    if (!ok) failures++;
    console.log(`[${status}] ${entry.files}  (expected=${entry.expected}, got=${result.category})`);
    if (!ok) for (const r of result.reasons) console.log(`        ${r}`);
  }
  console.log(`\n${manifest.fixtures.length - failures}/${manifest.fixtures.length} fixtures behave as declared.`);
  process.exit(failures > 0 ? 1 : 0);
}

main();
