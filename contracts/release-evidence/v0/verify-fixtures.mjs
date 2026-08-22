#!/usr/bin/env node
// Verifies contracts/release-evidence/v0/fixtures/* against release-evidence-bundle.schema.json
// and release-event.schema.json, plus the semantic MUSTs neither schema alone can express
// (see docs/protocols/release-evidence-v0.md):
//   1. transition legality -- events of one release_id, taken in ledger order, MUST follow
//      D5's state machine (prepared -> preview deployed -> preview verified -> [staging] ->
//      production deployed -> production verified / failed / rolled_back). A single-record
//      schema cannot see order; this is the same schema/collection split every other contract
//      in this repo uses.
//   2. same-bundle invariant -- every event of one release_id MUST carry the same
//      bundle_digest (build once, promote the same evidence everywhere; a drifting digest
//      means a different build was silently substituted mid-promotion).
//   3. dangling-rollback -- rollback_to_release_id MUST name a release_id present in the same
//      checked collection (same rule and rationale as release-observation/v0's rollback_of).
//
// Zero npm dependencies by design, same as every verify-fixtures.mjs in this repo.
// Usage: node verify-fixtures.mjs   (no arguments, no install step, no network access)

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createValidator } from "../../shared/schema-validator.mjs";
import { scanPersonalDimensions } from "../../shared/personal-dimensions.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(HERE, "fixtures");
const { validate } = createValidator(HERE);

const read = (f) => JSON.parse(readFileSync(path.join(FIXTURES_DIR, f), "utf-8"));
const dedupe = (a) => [...new Set(a)];

function checkOne(schemaFile, instance) {
  const reasons = [];
  reasons.push(...validate(schemaFile, instance));
  reasons.push(...scanPersonalDimensions(instance).map((v) => `personal_dimension_forbidden_key: ${v}`));
  return dedupe(reasons);
}

// --- D5 transition graph. Key: current derived state; value: allowed (kind, environment)
// pairs and the state each one produces. Anything not listed is illegal_transition.
const GRAPH = {
  "(none)":              { "prepared|null": "prepared" },
  prepared:              { "deployed|preview": "preview_deployed" },
  preview_deployed:      { "verified|preview": "preview_verified", "failed|preview": "failed" },
  preview_verified:      { "deployed|staging": "staging_deployed", "deployed|production": "production_deployed" },
  staging_deployed:      { "verified|staging": "staging_verified", "failed|staging": "failed" },
  staging_verified:      { "deployed|production": "production_deployed" },
  production_deployed:   { "verified|production": "production_verified", "failed|production": "failed", "rolled_back|production": "rolled_back" },
  production_verified:   { "failed|production": "failed", "rolled_back|production": "rolled_back" },
  failed:                {},
  rolled_back:           {},
};

function checkCollection(events) {
  const problems = [];

  for (const [i, ev] of events.entries()) {
    const reasons = checkOne("release-event.schema.json", ev);
    if (reasons.length > 0) problems.push(`event[${i}] not individually valid: ${reasons.join("; ")}`);
  }
  if (problems.length > 0) return problems; // 構造が壊れた行に fold を適用しても意味のある診断にならない

  // 2. same-bundle invariant + 1. transition fold (per release, in ledger order)
  const byRelease = new Map();
  for (const ev of events) {
    if (!byRelease.has(ev.release_id)) byRelease.set(ev.release_id, []);
    byRelease.get(ev.release_id).push(ev);
  }
  for (const [rid, evs] of byRelease) {
    const digests = dedupe(evs.map((e) => e.bundle_digest));
    if (digests.length > 1) {
      problems.push(
        `bundle_digest_mismatch_within_release: release_id "${rid}" carries ${digests.length} distinct bundle_digest values (${digests.join(", ")}) -- build once, promote the same evidence everywhere`,
      );
    }
    let state = "(none)";
    for (const ev of evs) {
      const key = `${ev.kind}|${ev.environment ?? "null"}`;
      const next = (GRAPH[state] ?? {})[key];
      if (!next) {
        problems.push(
          `illegal_transition: release_id "${rid}" event "${ev.event_id}" (${key}) is not a legal transition from derived state "${state}"`,
        );
        break; // 以降の遷移診断は最初の違反に依存するため打ち切る
      }
      state = next;
    }
  }

  // 3. dangling rollback references
  const known = new Set(events.map((e) => e.release_id));
  for (const ev of events) {
    if (ev.kind === "rolled_back" && !known.has(ev.rollback_to_release_id)) {
      problems.push(
        `dangling_rollback_reference: "${ev.release_id}" rolls back to "${ev.rollback_to_release_id}", which does not match any release_id in the checked collection`,
      );
    }
  }
  return problems;
}

function runFixture(entry) {
  if (entry.type === "bundle") {
    const reasons = checkOne("release-evidence-bundle.schema.json", read(entry.file));
    return { category: reasons.length ? "reject" : "accept", reasons };
  }
  if (entry.type === "event") {
    const reasons = checkOne("release-event.schema.json", read(entry.file));
    return { category: reasons.length ? "reject" : "accept", reasons };
  }
  if (entry.type === "event-collection") {
    const reasons = checkCollection(read(entry.file));
    return { category: reasons.length ? "reject" : "accept", reasons };
  }
  return { category: "reject", reasons: [`unknown fixture type "${entry.type}"`] };
}

function main() {
  const manifest = read("expected-results.json");
  if (!Array.isArray(manifest.fixtures) || manifest.fixtures.length === 0) {
    console.error("expected-results.json declares zero fixtures -- refusing to report success.");
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
    console.log(`[${status}] ${entry.file}  (expected=${entry.expected}, got=${result.category})`);
    if (!ok) for (const r of result.reasons) console.log(`        ${r}`);
  }
  console.log(`\n${manifest.fixtures.length - failures}/${manifest.fixtures.length} fixtures behave as declared.`);
  process.exit(failures > 0 ? 1 : 0);
}

main();
