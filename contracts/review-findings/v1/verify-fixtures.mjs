#!/usr/bin/env node
// Verifies contracts/review-findings/v1/fixtures/* against review-findings.schema.json plus the
// semantic MUSTs the schema alone cannot express (docs/protocols/review-findings-v1.md):
//
//   finding_id uniqueness within one record (a single-record schema cannot see its own
//   siblings, same reason release-evidence/v0 folds duplicate event_id at collection level);
//   no numeric "confidence" field anywhere, including inside the open params bags
//   (assessor.independence.params, findings[].evidence_gate.predicate.params) that
//   additionalProperties:false cannot reach because those bags are intentionally open;
//   the personal-dimension scan, same as every other contract in this repo.
//
//   draft_revision 2: assessor.independence.params.attestation is schema-required (a missing
//   attestation rejects the record -- it is never read as "unknown"), params.session_ref is
//   required exactly when attestation=orchestrator_observed and forbidden otherwise (schema
//   allOf if/then/else), and session_ref.started_at must parse to a real date (checked here,
//   same reason recorded_at is). Whether an orchestrator_observed claim is TRUE is not this
//   contract's question: only promotion-receipt/v0's evaluateReceipt() can answer it, by
//   matching the wrapper's session ledger.
//
// Zero npm dependencies by design. Usage: node verify-fixtures.mjs (no args, no network).

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createValidator } from "../../shared/schema-validator.mjs";
import { scanPersonalDimensions } from "../../shared/personal-dimensions.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(HERE, "fixtures");
const { validate } = createValidator(HERE);

const read = (f) => JSON.parse(readFileSync(path.join(FIXTURES_DIR, f), "utf-8"));
const dedupe = (a) => [...new Set(a)];

// R7: "SHALL NOT contain numeric confidence fields anywhere." additionalProperties:false closes
// off the named object shapes, but assessor.independence.params and
// findings[].evidence_gate.predicate.params are intentionally OPEN dictionaries (arbitrary
// {code, params} records, same shape contracts/shared/derive-independence.mjs emits) -- a
// numeric confidence smuggled into one of those bags would not be caught by the schema alone.
// Broadened (sol architect should-4): matches any key whose lowercased name CONTAINS
// "confidence" (e.g. "confidenceScore"), not only an exact "confidence" key -- copied
// identically into promotion-receipt/v0's and release-approval/v0's own verify-fixtures.mjs
// (contracts/shared cannot be touched, so this lives in all three).
// reason_code matching: a machine code (snake_case) must match the reason's leading code exactly
// (`<code>:` or the whole reason), so `promotion_id_mismatch` cannot be satisfied by
// `context_promotion_id_mismatch`; free-text reason codes (legacy, e.g. "not in enum") stay substrings.
function reasonMatches(reason, code) {
  if (/^[a-z][a-z0-9_]*$/.test(code)) {
    // whole-token match: the code may be nested (`outer_code: inner_code: ...`) but may not be a
    // suffix of a longer identifier (`context_promotion_id_mismatch` must not satisfy `promotion_id_mismatch`)
    return reason === code || new RegExp(`(^|[^a-z0-9_])${code}(:|$)`).test(reason);
  }
  return reason.includes(code);
}

function scanNumericConfidence(value, pathStr = "") {
  const violations = [];
  if (Array.isArray(value)) {
    value.forEach((item, i) => violations.push(...scanNumericConfidence(item, `${pathStr}[${i}]`)));
    return violations;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, val] of Object.entries(value)) {
      const here = pathStr ? `${pathStr}.${key}` : key;
      if (key.toLowerCase().includes("confidence") && typeof val === "number") violations.push(here);
      violations.push(...scanNumericConfidence(val, here));
    }
  }
  return violations;
}

// Real-calendar UTC timestamp check. Date.parse alone is not enough: V8 rolls day overflow within
// 1..31 into the next month ("2026-02-29T00:00:00Z" and "2026-04-31T00:00:00Z" both parse), so the
// string is split into its fields and the fields Date.UTC() normalizes them to must equal the
// input. Leap seconds (":60") and years 0000-0099 (Date.UTC maps them to 19xx) are rejected.
// Duplicated identically in review-findings/v1, promotion-receipt/v0 and release-approval/v0's
// verify-fixtures.mjs (contracts/shared cannot be touched) -- keep the three bodies identical; the
// promotion-receipt/v0 copy is exported because evaluate.mjs uses it for ledger started_at.
function isRealUtcTimestamp(s) {
  if (typeof s !== "string") return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?Z$/.exec(s);
  if (!m) return false;
  const [y, mo, d, h, mi, sec] = m.slice(1, 7).map(Number);
  const t = new Date(Date.UTC(y, mo - 1, d, h, mi, sec));
  return (
    t.getUTCFullYear() === y &&
    t.getUTCMonth() === mo - 1 &&
    t.getUTCDate() === d &&
    t.getUTCHours() === h &&
    t.getUTCMinutes() === mi &&
    t.getUTCSeconds() === sec
  );
}

// R5 (Revision 2, sol architect should-2): locations[].start_line/end_line must be both null or
// both non-null (never one recorded and the other missing), and when both are recorded,
// end_line >= start_line -- a schema-level `type: ["integer","null"]` cannot express either
// cross-field relationship on its own.
function checkLocationConsistency(record) {
  const reasons = [];
  for (const f of record.findings ?? []) {
    for (const [i, loc] of (f.locations ?? []).entries()) {
      const bothNull = loc.start_line === null && loc.end_line === null;
      const bothSet = loc.start_line !== null && loc.end_line !== null;
      if (!bothNull && !bothSet) {
        reasons.push(`location_line_partial: finding "${f.finding_id}" locations[${i}] has only one of start_line/end_line recorded`);
      } else if (bothSet && loc.end_line < loc.start_line) {
        reasons.push(`location_line_order: finding "${f.finding_id}" locations[${i}] end_line ${loc.end_line} < start_line ${loc.start_line}`);
      }
    }
  }
  return dedupe(reasons);
}

export function checkRecord(record) {
  const reasons = [];
  reasons.push(...validate("review-findings.schema.json", record));
  reasons.push(...scanPersonalDimensions(record).map((v) => `personal_dimension_forbidden_key: ${v}`));
  reasons.push(...scanNumericConfidence(record).map((v) => `numeric_confidence_forbidden_field: ${v}`));
  if (!isRealUtcTimestamp(record.recorded_at)) {
    reasons.push(`invalid_calendar_timestamp: record "${record.record_id}" recorded_at "${record.recorded_at}" is not a real calendar date/time`);
  }
  const sessionRef = record.assessor?.independence?.params?.session_ref;
  if (sessionRef && typeof sessionRef === "object" && !isRealUtcTimestamp(sessionRef.started_at)) {
    reasons.push(`invalid_calendar_timestamp: record "${record.record_id}" assessor.independence.params.session_ref.started_at "${sessionRef.started_at}" is not a real calendar date/time`);
  }
  if (reasons.length > 0) return dedupe(reasons);

  const ids = (record.findings ?? []).map((f) => f.finding_id);
  for (const dup of dedupe(ids.filter((id, i) => ids.indexOf(id) !== i))) {
    reasons.push(`duplicate_finding_id: "${dup}" appears more than once in record "${record.record_id}"`);
  }
  reasons.push(...checkLocationConsistency(record));
  return dedupe(reasons);
}

function runFixture(entry) {
  const problems = checkRecord(read(entry.files));
  return { category: problems.length ? "reject" : "accept", reasons: problems };
}

function main() {
  const manifest = read("expected-results.json");
  if (!Array.isArray(manifest.fixtures) || manifest.fixtures.length === 0) {
    console.error("expected-results.json declares zero fixtures -- refusing to report success.");
    process.exit(1);
  }
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
  console.log(`review-findings:v1 fixture verification (${manifest.fixtures.length} fixtures)\n`);
  for (const entry of manifest.fixtures) {
    const result = runFixture(entry);
    let ok = result.category === entry.expected;
    if (ok && entry.expected === "reject" && entry.reason_code) {
      ok = result.reasons.some((r) => reasonMatches(r, entry.reason_code));
    }
    const status = ok ? "PASS" : "FAIL";
    if (!ok) failures++;
    console.log(`[${status}] ${entry.files}  (expected=${entry.expected}, got=${result.category})`);
    if (!ok) for (const r of result.reasons) console.log(`        ${r}`);
  }
  console.log(`\n${manifest.fixtures.length - failures}/${manifest.fixtures.length} fixtures behave as declared.`);
  process.exit(failures > 0 ? 1 : 0);
}

function isMainModule() {
  return process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
}

if (isMainModule()) main();
