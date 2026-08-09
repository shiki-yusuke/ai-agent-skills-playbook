#!/usr/bin/env node
// Verifies contracts/trace/v1/fixtures/* against trace-event.schema.json and re-derives
// every value a reader is required (MUST, per docs/protocols/trace-v1.md) to independently
// recompute rather than trust: the event_id identity hash, and the personal-dimension scan.
// Three-layer verification, mirroring agent-metrics/v1's redundancy on purpose (schema
// validate + identity recomputation + personal-dimension scan are independent checks, not
// one check standing in for the others):
//   1. schema validate (trace-event.schema.json, via the shared validator)
//   2. event_id recomputation (RFC 8785 JCS via contracts/shared/jcs.mjs)
//   3. personal-dimension scan (closed set re-listed from agent-metrics-v1 protocol doc
//      section 7 -- same set, may only be extended, never shrunk, per that doc)
//
// Zero npm dependencies by design, same as agent-metrics/v1 (docs/protocols/agent-metrics-v1.md
// section 8): JCS canonicalizer and JSON Schema subset validator both come from contracts/shared/.
//
// Usage: node verify-fixtures.mjs   (no arguments, no install step)

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalize, sha256hex } from "../../shared/jcs.mjs";
import { createValidator } from "../../shared/schema-validator.mjs";
import { scanPersonalDimensions } from "../../shared/personal-dimensions.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(HERE, "fixtures");
const { validate } = createValidator(HERE);

// ---------------------------------------------------------------------------
// event_id identity recipe (docs/protocols/trace-v1.md section 3): "tr1_" + hex(sha256(JCS(
// {schema: "trace/v1", relation, identity}))), where `identity` is a relation-specific field
// subset chosen so that re-emitting the *same fact* (same binding, same import window, same
// artifact edge) always resolves to the same event_id, while occurred_at and payload as a
// whole are excluded so a re-run at a different wall-clock time, or a payload carrying an
// extra diagnostic field, never mints a new id for the same fact.
// ---------------------------------------------------------------------------
function refIdentity(ref) {
  if (!ref || typeof ref !== "object") return {};
  const out = { logical_id: ref.logical_id };
  if (ref.content_digest !== undefined) out.content_digest = ref.content_digest;
  return out;
}

function computeIdentity(event) {
  switch (event.relation) {
    case "session_bound":
      return { task_run_id: event.task_run_id, session_id: event.session_id };
    case "task_run_started":
      return { task_run_id: event.task_run_id };
    case "usage_imported":
      // Named exception to "payload is excluded from identity" (see trace-event.schema.json's
      // `payload` description and docs/protocols/trace-v1.md section 3): window.since/until
      // describe *what period this import covers*, not *when the import ran* -- re-importing
      // the same window MUST resolve to the same event_id (idempotent), unlike occurred_at.
      return {
        task_run_id: event.task_run_id,
        session_id: event.session_id,
        window: {
          since: event.payload?.window?.since,
          until: event.payload?.window?.until,
        },
      };
    case "attributed_to":
      // Deliberately logical_id only (no content_digest): usage attribution binds to a
      // stable logical thing (a task, an artifact's logical identity), not one specific
      // content revision of it.
      return {
        from_ref: { logical_id: event.from_ref?.logical_id },
        to_ref: { logical_id: event.to_ref?.logical_id },
        task_run_id: event.task_run_id,
      };
    default:
      // All other relations (declares/refines/acknowledges/critiques/implements/verifies/
      // produced_by/incurred_usage/deployed_as/supersedes/invalidates/session_observed/
      // incident_observed/rolled_back_to): identity is the edge itself, full ref identity
      // (logical_id + content_digest when present) on both ends.
      return {
        relation: event.relation,
        from_ref: refIdentity(event.from_ref),
        to_ref: refIdentity(event.to_ref),
      };
  }
}

function recomputeEventId(event) {
  const identity = computeIdentity(event);
  const canonicalTarget = { schema: "trace/v1", relation: event.relation, identity };
  return "tr1_" + sha256hex(canonicalize(canonicalTarget));
}

// Personal-dimension scan: contracts/shared/personal-dimensions.mjs (re-lists the exact
// closed set from docs/protocols/agent-metrics-v1.md section 7; centralized there so every
// contract scans against the same list by construction -- see that module's own comment).

// ---------------------------------------------------------------------------
// Full check pipeline for a single event object.
// ---------------------------------------------------------------------------
function dedupe(arr) {
  return [...new Set(arr)];
}

function checkEvent(event) {
  const reasons = [];
  reasons.push(...validate("trace-event.schema.json", event));
  reasons.push(...scanPersonalDimensions(event).map((v) => `personal_dimension_forbidden_key: ${v}`));

  if (typeof event.event_id === "string" && typeof event.relation === "string") {
    const recomputed = recomputeEventId(event);
    if (recomputed !== event.event_id) {
      reasons.push(`event_id_mismatch: declared=${event.event_id} recomputed=${recomputed}`);
    }
  }

  return dedupe(reasons);
}

function reasonCodesOf(reasons) {
  // Normalizes "code: detail" strings down to their leading token, same convention as
  // agent-metrics/v1's verify script -- for a raw schema-validator error this leading token
  // is the JSON path (e.g. "$.relation"), which doubles as that error's reason_code.
  return reasons.map((r) => r.split(":")[0].trim());
}

// ---------------------------------------------------------------------------
// Fixture runner
// ---------------------------------------------------------------------------
function readFixtureJson(filename) {
  return JSON.parse(readFileSync(path.join(FIXTURES_DIR, filename), "utf-8"));
}

function runEventFixture(entry) {
  const event = readFixtureJson(entry.files.event);
  const reasons = checkEvent(event);
  return { category: reasons.length > 0 ? "reject" : "accept", reasons };
}

function runCorrectionPairFixture(entry) {
  const first = readFixtureJson(entry.files.first);
  const second = readFixtureJson(entry.files.second);
  const problems = [];

  const firstReasons = checkEvent(first);
  const secondReasons = checkEvent(second);
  if (firstReasons.length > 0) problems.push(`first event not individually valid: ${firstReasons.join("; ")}`);
  if (secondReasons.length > 0) problems.push(`second event not individually valid: ${secondReasons.join("; ")}`);

  if (second.supersedes_event_id !== first.event_id) {
    problems.push(
      `second.supersedes_event_id (${second.supersedes_event_id}) does not equal first.event_id (${first.event_id})`,
    );
  }
  // A correction MUST mint a *different* event_id from what it corrects -- otherwise it
  // would silently collide with (and be indistinguishable from) the original fact rather
  // than layering a new fact on top of it via supersedes_event_id.
  if (first.event_id === second.event_id) {
    problems.push("correction pair must not share the same event_id as what it supersedes");
  }

  return { category: problems.length > 0 ? "reject" : "accept", reasons: problems };
}

function main() {
  const manifest = readFixtureJson("expected-results.json");
  let failures = 0;

  console.log(`trace:v1 fixture verification (${manifest.fixtures.length} fixtures)\n`);

  for (const entry of manifest.fixtures) {
    let result;
    if (entry.kind === "event") {
      result = runEventFixture(entry);
    } else if (entry.kind === "correction-pair") {
      result = runCorrectionPairFixture(entry);
    } else {
      throw new Error(`unknown fixture kind: ${entry.kind}`);
    }

    let ok = result.category === entry.expected;
    if (ok && entry.expected === "reject" && entry.reason_code) {
      const codes = reasonCodesOf(result.reasons);
      ok = codes.includes(entry.reason_code);
    }

    const status = ok ? "PASS" : "FAIL";
    if (!ok) failures++;
    console.log(`[${status}] ${entry.id}  (expected=${entry.expected}, got=${result.category})`);
    if (!ok || process.env.VERBOSE) {
      for (const r of result.reasons) console.log(`         - ${r}`);
    }
  }

  console.log(`\n${manifest.fixtures.length - failures}/${manifest.fixtures.length} fixtures passed.`);
  if (failures > 0) {
    console.error(`\n${failures} fixture(s) FAILED.`);
    process.exit(1);
  }
}

main();
