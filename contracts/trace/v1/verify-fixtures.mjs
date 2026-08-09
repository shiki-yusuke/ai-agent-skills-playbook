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
//
// sol architect-review must3 (main裁定): when supersedes_event_id is present, it is folded
// INTO the identity object. Without this, a correction that doesn't change from_ref/to_ref
// (e.g. a payload-only fix) would compute the *same* base identity as the event it corrects
// and collide with it -- silently overwriting rather than layering a new fact via
// supersedes_event_id. See the supersedes-payload-only-* fixtures.
// ---------------------------------------------------------------------------
function refIdentity(ref) {
  if (!ref || typeof ref !== "object") return {};
  const out = { logical_id: ref.logical_id };
  if (ref.content_digest !== undefined) out.content_digest = ref.content_digest;
  return out;
}

// sol architect-review must1: which top-level fields (beyond from_ref/to_ref, already
// unconditionally required) each relation's identity depends on, so a reader can check their
// presence BEFORE attempting to hash -- never feed `undefined` into the JCS canonicalizer
// (see missingIdentityFields below; this table is also mirrored as if/then blocks in
// trace-event.schema.json so the requirement is structural, not just a verify-script opinion).
const RELATION_REQUIRED_FIELDS = {
  session_bound: ["task_run_id", "session_id"],
  task_run_started: ["task_run_id"],
  attributed_to: ["task_run_id"],
  usage_imported: ["task_run_id", "session_id"], // payload.window.{since,until} checked separately below
};

function missingIdentityFields(event) {
  const missing = [];
  for (const field of RELATION_REQUIRED_FIELDS[event.relation] ?? []) {
    if (event[field] === undefined) missing.push(field);
  }
  if (event.relation === "usage_imported") {
    if (event.payload?.window?.since === undefined) missing.push("payload.window.since");
    if (event.payload?.window?.until === undefined) missing.push("payload.window.until");
  }
  return missing;
}

// sol architect-review must1: from_ref/to_ref's logical_id is a redundant encoding of
// task_run_id/session_id for the relations that carry both (via a "task_run:<id>" /
// "session:<id>" prefix convention) -- catches the two representations drifting apart, which
// event_id recomputation alone would not catch (it trusts from_ref/to_ref as given, it doesn't
// cross-check them against the plain fields).
function refFieldConsistencyIssues(event) {
  const issues = [];
  const taskRunRef = `task_run:${event.task_run_id}`;
  const sessionRef = `session:${event.session_id}`;
  if (event.relation === "session_bound") {
    if (event.from_ref?.logical_id !== taskRunRef) {
      issues.push(
        `ref_field_mismatch: from_ref.logical_id (${event.from_ref?.logical_id}) does not match task_run_id-derived "${taskRunRef}"`,
      );
    }
    if (event.to_ref?.logical_id !== sessionRef) {
      issues.push(
        `ref_field_mismatch: to_ref.logical_id (${event.to_ref?.logical_id}) does not match session_id-derived "${sessionRef}"`,
      );
    }
  } else if (event.relation === "usage_imported") {
    if (event.from_ref?.logical_id !== sessionRef) {
      issues.push(
        `ref_field_mismatch: from_ref.logical_id (${event.from_ref?.logical_id}) does not match session_id-derived "${sessionRef}"`,
      );
    }
    if (event.to_ref?.logical_id !== taskRunRef) {
      issues.push(
        `ref_field_mismatch: to_ref.logical_id (${event.to_ref?.logical_id}) does not match task_run_id-derived "${taskRunRef}"`,
      );
    }
  } else if (event.relation === "task_run_started") {
    if (event.to_ref?.logical_id !== taskRunRef) {
      issues.push(
        `ref_field_mismatch: to_ref.logical_id (${event.to_ref?.logical_id}) does not match task_run_id-derived "${taskRunRef}"`,
      );
    }
  }
  return issues;
}

function computeBaseIdentity(event) {
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
      // sol architect-review must2 (main裁定): this stays exactly {task_run_id, session_id,
      // window.since, window.until} -- a re-import of the same window under a different
      // token_basis is a supersedes correction (must3), not a reason to widen identity to a
      // second source of truth. See "Rejected: multi-source identity" in the protocol doc.
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

function computeIdentity(event) {
  const base = computeBaseIdentity(event);
  if (event.supersedes_event_id !== undefined) {
    return { ...base, supersedes_event_id: event.supersedes_event_id };
  }
  return base;
}

function recomputeEventId(event) {
  const identity = computeIdentity(event);
  const canonicalTarget = { schema: "trace/v1", relation: event.relation, identity };
  return "tr1_" + sha256hex(canonicalize(canonicalTarget));
}

// Personal-dimension scan: contracts/shared/personal-dimensions.mjs (re-lists the exact
// closed set from docs/protocols/agent-metrics-v1.md section 7; centralized there so every
// contract scans against the same list by construction -- see that module's own comment).

// sol architect-review 2nd round should: incident_observed/rolled_back_to remain valid
// `relation` enum members (reserved at v1's freeze, not added afterward -- see must8's
// immutability policy), but v1 never defined their identity/payload shape. A v1 reader MUST
// reject an event that actually uses one, right now, unconditionally -- this reverses the
// previous round's "a reader MUST accept, not reject" stance, which this round found to be
// wrong: "reserved" means the NAME is held for a future v2 to define, not that v1 has any
// idea how to compute an identity for one today.
const RESERVED_RELATIONS = new Set(["incident_observed", "rolled_back_to"]);

// ---------------------------------------------------------------------------
// Limits (docs/protocols/trace-v1.md section "Limits"). Mirrors agent-metrics/v1's own
// checkLimits pattern (payload size + nesting depth), enforced here for the first time --
// the protocol doc declared these MUSTs from the start but nothing previously checked them
// (sol architect-review 2nd round must D).
// ---------------------------------------------------------------------------
const MAX_EVENT_BYTES = 16 * 1024;
const MAX_DEPTH = 8;

function maxDepth(value) {
  if (value === null || typeof value !== "object") return 0;
  const children = Array.isArray(value) ? value : Object.values(value);
  if (children.length === 0) return 1;
  return 1 + Math.max(...children.map(maxDepth));
}

function checkLimits(event) {
  const reasons = [];
  const byteLength = Buffer.byteLength(JSON.stringify(event), "utf-8");
  if (byteLength > MAX_EVENT_BYTES) {
    reasons.push(`event_too_large: ${byteLength} bytes > ${MAX_EVENT_BYTES}`);
  }
  const depth = maxDepth(event);
  if (depth > MAX_DEPTH) {
    reasons.push(`event_too_deep: depth ${depth} > ${MAX_DEPTH}`);
  }
  return reasons;
}

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
  reasons.push(...checkLimits(event));

  // sol architect-review 2nd round should: reserved relations are valid enum members but
  // unconditionally unusable in v1 -- no identity/payload shape was ever defined for them.
  if (typeof event.relation === "string" && RESERVED_RELATIONS.has(event.relation)) {
    reasons.push(
      `reserved_relation_unusable_in_v1: relation "${event.relation}" is reserved for a future version; v1 never defined its identity/payload shape, so no v1 event may use it yet`,
    );
  }

  // Self-reference: compares two fields already on the event, independent of hashing --
  // checked unconditionally, never gated on whether identity fields are otherwise complete.
  if (
    typeof event.event_id === "string" &&
    event.supersedes_event_id !== undefined &&
    event.supersedes_event_id === event.event_id
  ) {
    reasons.push("self_supersedes: supersedes_event_id must not equal this event's own event_id");
  }

  // sol architect-review must1: never feed an incomplete identity into the JCS canonicalizer
  // -- a missing field must reject as "identity_fields_missing", not silently hash whatever
  // string coercion `undefined` happens to produce.
  const missing = missingIdentityFields(event);
  if (missing.length > 0) {
    reasons.push(
      `identity_fields_missing: relation "${event.relation}" requires ${missing.join(", ")} (event_id was not recomputed against an incomplete identity)`,
    );
  } else if (typeof event.event_id === "string" && typeof event.relation === "string") {
    const recomputed = recomputeEventId(event);
    if (recomputed !== event.event_id) {
      reasons.push(`event_id_mismatch: declared=${event.event_id} recomputed=${recomputed}`);
    }
    reasons.push(...refFieldConsistencyIssues(event));
  }

  // sol architect-review must2: usage_imported's window.since must be strictly earlier than
  // window.until. Parsed as instants (not compared lexically) since ISO 8601 strings with
  // differing fractional-second precision don't always sort correctly as plain strings.
  if (event.relation === "usage_imported" && missing.length === 0) {
    const since = event.payload.window.since;
    const until = event.payload.window.until;
    if (!(Date.parse(since) < Date.parse(until))) {
      reasons.push(`window_ordering_invalid: since (${since}) must be earlier than until (${until})`);
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
  // sol architect-review should: refuse to report a false-green success if the manifest
  // declares zero fixtures (e.g. a botched refactor that emptied the array) -- 0/0 passed
  // must never print the same shape of success line as an intentional, populated run.
  if (!Array.isArray(manifest.fixtures) || manifest.fixtures.length === 0) {
    console.error("expected-results.json declares zero fixtures -- refusing to report success.");
    process.exit(1);
  }
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
