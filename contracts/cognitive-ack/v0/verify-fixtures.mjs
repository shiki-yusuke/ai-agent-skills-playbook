#!/usr/bin/env node
// Verifies contracts/cognitive-ack/v0/fixtures/* against cognitive-ack-record.schema.json plus the
// semantic rules of docs/protocols/cognitive-ack-v0.md. authority: none -- this contract gates
// nothing. Its ONLY verdict is about the ack ledger itself (checkAckLedger -> {verdict, problems});
// it never says whether a release-approval/v0 approval is valid, and no consumer may use its
// verdict to stop a promotion (protocol doc, MUST NOT).
//
//   repo guards (run on every invocation, before any fixture):
//     - authority independence: no file under the authority contracts / shared helpers / their
//       protocol docs (AUTHORITY_PATHS) may contain the string "cognitive-ack". The dependency
//       direction is one-way: this contract reads release-approval/v0, never the reverse.
//     - release-approval/v0 schema content pin (RELEASE_APPROVAL_SCHEMA_SHA256): a change to that
//       schema stops CI here until this contract's CHANGELOG follows it.
//     - this contract's own schema admits no number/integer anywhere (R4 at the schema level).
//
//   record-level (R1-R4): schema, record_id recomputation, real calendar timestamp; high <=> a
//     risk_reason other than "none", unique scope_digest, all-low => sampled:true, any-high =>
//     no sampled; explanation_present <=> explanation_id !== null; no number value anywhere.
//
//   composite ({approval_source, approval_events, ack_records, ingest}):
//     preflightComposite() is the INPUT BOUNDARY: closed shape, and approval_events must be
//     JCS-identical to the approval_events of the named release-approval/v0 accept composite, i.e.
//     a ledger that release-approval/v0's own verifier passed. A preflight failure is a broken
//     fixture (exit 1), never a "reject" verdict. checkAckLedger() then evaluates C1-C8 per ack
//     record; approval events are only used to resolve references.

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createValidator } from "../../shared/schema-validator.mjs";
import { canonicalize, sha256hex } from "../../shared/jcs.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, "..", "..", "..");
const FIXTURES_DIR = path.join(HERE, "fixtures");
const RELEASE_APPROVAL_DIR = path.join(HERE, "..", "..", "release-approval", "v0");
const RELEASE_APPROVAL_FIXTURES_DIR = path.join(RELEASE_APPROVAL_DIR, "fixtures");
const RELEASE_APPROVAL_SCHEMA = "release-approval-event.schema.json";
const RECORD_SCHEMA = "cognitive-ack-record.schema.json";

// sha256 of the BYTES of contracts/release-approval/v0/release-approval-event.schema.json
// (schema draft_revision 1), computed with `shasum -a 256` -- see CHANGELOG.md. A content pin,
// not a version-string pin: any byte change stops CI until this contract follows it.
export const RELEASE_APPROVAL_SCHEMA_SHA256 = "30fc6749e99d097b684baa228ab4feaa28caaad8da31c1a9a2f44539d3541dd3";

// Files that must never mention this contract (relative to the repo root). A missing path is
// itself a failure, so a rename cannot silently empty the scan.
export const AUTHORITY_PATHS = [
  "contracts/release-approval",
  "contracts/promotion-receipt",
  "contracts/release-evidence",
  "contracts/shared",
  "docs/protocols/release-approval-v0.md",
  "docs/protocols/promotion-receipt-v0.md",
  "docs/protocols/release-evidence-v0.md",
];
const FORBIDDEN_MENTION = "cognitive-ack";

const COMPOSITE_KEYS = ["approval_source", "approval_events", "ack_records", "ingest"];
const APPROVAL_SOURCE_PATTERN = /^accept-composite-[a-z0-9-]+\.json$/;
const COMMIT_OID_PATTERN = /^[0-9a-f]{40}$/;
// C4: held / rejected may only accompany an approval event that is itself a non-approval.
const NON_APPROVING_KINDS = new Set(["approval_rejected", "approval_revoked"]);

const { validate } = createValidator(HERE);
// Approval events are re-validated against release-approval/v0's OWN schema with the shared
// validator, and their event_id is recomputed with the shared JCS helper. release-approval/v0's
// semantic composite checker is NOT imported or re-implemented: its checkEventSchemaAndId is not
// exported, and its approval-validity rules are deliberately out of scope here -- the input
// boundary (preflightComposite) already requires a ledger that verifier accepted.
const { validate: validateApprovalEvent } = createValidator(RELEASE_APPROVAL_DIR);

const read = (f) => JSON.parse(readFileSync(path.join(FIXTURES_DIR, f), "utf-8"));
const dedupe = (a) => [...new Set(a)];
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// Same reason_code matching as release-approval/v0's verify-fixtures.mjs.
function reasonMatches(reason, code) {
  if (/^[a-z][a-z0-9_]*$/.test(code)) {
    return reason === code || new RegExp(`(^|[^a-z0-9_])${code}(:|$)`).test(reason);
  }
  return reason.includes(code);
}

// R4: every number value, whatever its key. Stricter than release-approval/v0's
// scanNumericConfidence (which only looks at keys containing "confidence").
export function scanNumbers(value, pathStr = "") {
  if (typeof value === "number") return [pathStr || "(root)"];
  if (Array.isArray(value)) return value.flatMap((item, i) => scanNumbers(item, `${pathStr}[${i}]`));
  if (isPlainObject(value)) {
    return Object.entries(value).flatMap(([k, v]) => scanNumbers(v, pathStr ? `${pathStr}.${k}` : k));
  }
  return [];
}

// Copied identically from release-approval/v0's verify-fixtures.mjs (not exported there, and
// contracts/shared cannot reference this contract's needs).
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

export function computeRecordId(record) {
  const { record_id, ...rest } = record;
  return `sha256:${sha256hex(canonicalize(rest))}`;
}

function computeEventId(event) {
  const { event_id, ...rest } = event;
  return `sha256:${sha256hex(canonicalize(rest))}`;
}

// R1-R4 for one record.
export function checkRecord(record) {
  const label = isPlainObject(record) && typeof record.record_id === "string" ? record.record_id : "(unidentified)";
  const reasons = scanNumbers(record).map((p) => `numeric_value_forbidden: record "${label}" has a number at ${p}`);
  const schemaErrors = validate(RECORD_SCHEMA, record);
  if (schemaErrors.length > 0) {
    return dedupe([...reasons, ...schemaErrors.map((e) => `schema_invalid: record "${label}": ${e}`)]);
  }

  if (!isRealUtcTimestamp(record.occurred_at)) {
    reasons.push(`invalid_calendar_timestamp: record "${label}" occurred_at "${record.occurred_at}" is not a real calendar date/time`);
  }
  const expectedId = computeRecordId(record);
  if (record.record_id !== expectedId) {
    reasons.push(`record_id_mismatch: record declares "${record.record_id}", recomputed "${expectedId}"`);
  }

  const digests = record.scopes.map((s) => s.scope_digest);
  for (const dup of dedupe(digests.filter((d, i) => digests.indexOf(d) !== i))) {
    reasons.push(`duplicate_scope_digest: record "${label}" lists scope_digest "${dup}" more than once`);
  }
  for (const s of record.scopes) {
    if ((s.risk_class === "high") !== (s.risk_reason !== "none")) {
      reasons.push(`risk_class_reason_mismatch: record "${label}" scope "${s.scope_digest}" is risk_class "${s.risk_class}" with risk_reason "${s.risk_reason}" (high requires a reason, low requires "none")`);
    }
    if (s.explanation_present !== (s.explanation_id !== null)) {
      reasons.push(`explanation_presence_mismatch: record "${label}" scope "${s.scope_digest}" has explanation_present ${s.explanation_present} but explanation_id ${JSON.stringify(s.explanation_id)}`);
    }
  }
  const anyHigh = record.scopes.some((s) => s.risk_class === "high");
  if (anyHigh && record.sampled !== undefined) {
    reasons.push(`sampled_forbidden_on_high_record: record "${label}" has a high-risk scope and must not carry sampled`);
  }
  if (!anyHigh && record.sampled !== true) {
    reasons.push(`sampled_required_on_low_record: record "${label}" has only low-risk scopes and must carry sampled: true`);
  }
  return dedupe(reasons);
}

function checkIngestEntry(id, entry) {
  if (!isPlainObject(entry)) return [`ingest_entry_invalid: ingest["${id}"] is not an object`];
  const reasons = [];
  const extra = Object.keys(entry).filter((k) => k !== "commit_oid" && k !== "path");
  if (extra.length > 0) reasons.push(`ingest_entry_invalid: ingest["${id}"] has unexpected key(s) [${extra}]`);
  if (typeof entry.commit_oid !== "string" || !COMMIT_OID_PATTERN.test(entry.commit_oid)) {
    reasons.push(`ingest_entry_invalid: ingest["${id}"].commit_oid must be 40 lowercase hex characters`);
  }
  const p = entry.path;
  if (typeof p !== "string" || p.length === 0 || p.startsWith("/") || p.split("/").includes("..")) {
    reasons.push(`ingest_entry_invalid: ingest["${id}"].path must be a non-empty repo-relative path without ".." (got ${JSON.stringify(p)})`);
  }
  return reasons;
}

// Input boundary. Returns problems; any problem means the fixture itself is broken.
export function preflightComposite(composite, { approvalFixturesDir = RELEASE_APPROVAL_FIXTURES_DIR } = {}) {
  if (!isPlainObject(composite)) return ["composite_shape: composite is not an object"];
  const problems = [];
  const keys = Object.keys(composite);
  const extra = keys.filter((k) => !COMPOSITE_KEYS.includes(k));
  const missing = COMPOSITE_KEYS.filter((k) => !keys.includes(k));
  if (extra.length > 0 || missing.length > 0) {
    problems.push(`composite_shape: composite must have exactly [${COMPOSITE_KEYS}] (extra [${extra}], missing [${missing}])`);
  }
  if (!Array.isArray(composite.approval_events)) problems.push("composite_shape: approval_events must be an array");
  if (!Array.isArray(composite.ack_records)) problems.push("composite_shape: ack_records must be an array");
  if (!isPlainObject(composite.ingest)) problems.push("composite_shape: ingest must be an object");
  const source = composite.approval_source;
  if (typeof source !== "string" || !APPROVAL_SOURCE_PATTERN.test(source)) {
    problems.push(`approval_source_invalid: ${JSON.stringify(source)} is not a release-approval/v0 accept-composite-*.json file name`);
    return problems;
  }
  const sourcePath = path.join(approvalFixturesDir, source);
  if (!existsSync(sourcePath)) {
    problems.push(`approval_source_missing: release-approval/v0 fixture "${source}" does not exist`);
    return problems;
  }
  const verified = JSON.parse(readFileSync(sourcePath, "utf-8")).approval_events;
  if (canonicalize(verified) !== canonicalize(composite.approval_events)) {
    problems.push(`approval_source_mismatch: approval_events are not JCS-identical to "${source}"'s approval_events`);
  }
  return problems;
}

/**
 * The ack ledger's own verdict -- and nothing else. There is deliberately no field about the
 * approval: whether an approval is valid is release-approval/v0's question alone.
 * @returns {{verdict: "accept" | "reject", problems: string[]}}
 */
export function checkAckLedger(composite) {
  const problems = [];
  const records = composite.ack_records;
  // C1: no ack, nothing to judge -- whatever the approval events are.
  if (records.length === 0) return { verdict: "accept", problems };

  const eventIds = composite.approval_events.map((e) => (isPlainObject(e) ? e.event_id : undefined));
  const resolvable = new Map();
  const unresolvable = new Map();
  composite.approval_events.forEach((event, i) => {
    const id = eventIds[i];
    if (typeof id !== "string") return;
    const why = [];
    if (eventIds.filter((x) => x === id).length > 1) why.push("duplicate event_id");
    const schemaErrors = validateApprovalEvent(RELEASE_APPROVAL_SCHEMA, event);
    if (schemaErrors.length > 0) why.push(`schema: ${schemaErrors.join("; ")}`);
    else if (computeEventId(event) !== id) why.push("event_id does not match its recomputed JCS sha256");
    if (why.length > 0) unresolvable.set(id, why);
    else resolvable.set(id, event);
  });

  const recordIds = records.map((r) => (isPlainObject(r) ? r.record_id : undefined));
  for (const dup of dedupe(recordIds.filter((id, i) => recordIds.indexOf(id) !== i))) {
    problems.push(`duplicate_record_id: record_id "${dup}" appears more than once`);
  }

  const ingest = composite.ingest;
  const knownIds = new Set([...eventIds, ...recordIds].filter((x) => typeof x === "string"));
  for (const [id, entry] of Object.entries(ingest)) {
    if (!knownIds.has(id)) problems.push(`ingest_extraneous_entry: ingest["${id}"] matches no approval event or ack record in this composite`);
    problems.push(...checkIngestEntry(id, entry));
  }

  const acksPerApproval = new Map();
  for (const record of records) {
    const recordProblems = checkRecord(record);
    problems.push(...recordProblems);
    if (recordProblems.some((r) => r.startsWith("schema_invalid") || r.startsWith("numeric_value_forbidden"))) continue;

    const rid = record.record_id;
    const aid = record.approval_event_id;
    acksPerApproval.set(aid, (acksPerApproval.get(aid) ?? 0) + 1);

    // C2
    if (unresolvable.has(aid)) {
      problems.push(`approval_unresolvable: record "${rid}" references approval event "${aid}", which fails release-approval/v0's schema/event_id check (${unresolvable.get(aid).join("; ")})`);
      continue;
    }
    const approval = resolvable.get(aid);
    if (!approval) {
      problems.push(`approval_event_dangling: record "${rid}" references approval event "${aid}", which is not in approval_events`);
      continue;
    }
    // C3
    if (canonicalize(record.principal) !== canonicalize(approval.principal)) {
      problems.push(`principal_mismatch: record "${rid}" principal ${canonicalize(record.principal)} is not the referenced approval's principal ${canonicalize(approval.principal)}`);
    }
    // C4
    if (record.self_report !== "acknowledged" && !NON_APPROVING_KINDS.has(approval.kind)) {
      problems.push(`self_report_kind_contradiction: record "${rid}" self_report "${record.self_report}" accompanies a "${approval.kind}" event`);
    }
    // C5: same-commit binding through the ingester's envelope, and no ack after the approval.
    const ackIngest = ingest[rid];
    const approvalIngest = ingest[aid];
    if (ackIngest === undefined) problems.push(`ingest_missing_for_record: no ingest entry for record "${rid}"`);
    if (approvalIngest === undefined) problems.push(`ingest_missing_for_approval: no ingest entry for approval event "${aid}"`);
    if (isPlainObject(ackIngest) && isPlainObject(approvalIngest) && ackIngest.commit_oid !== approvalIngest.commit_oid) {
      problems.push(`ingest_commit_mismatch: record "${rid}" was ingested from commit ${ackIngest.commit_oid}, its approval event from ${approvalIngest.commit_oid}`);
    }
    if (isRealUtcTimestamp(record.occurred_at) && Date.parse(record.occurred_at) > Date.parse(approval.occurred_at)) {
      problems.push(`ack_after_approval: record "${rid}" occurred_at ${record.occurred_at} is after the approval's ${approval.occurred_at}`);
    }
  }
  // C6
  for (const [aid, n] of acksPerApproval) {
    if (n > 1) problems.push(`multiple_acks_for_approval: ${n} ack records reference approval event "${aid}" (related scopes belong in one record)`);
  }
  // C7 (acknowledged with explanation_present:false is fine) and C8 (no coverage check) are
  // rules about what is NOT checked here.
  const unique = dedupe(problems);
  return { verdict: unique.length > 0 ? "reject" : "accept", problems: unique };
}

function walkFiles(p) {
  if (!statSync(p).isDirectory()) return [p];
  return readdirSync(p, { withFileTypes: true }).flatMap((e) => walkFiles(path.join(p, e.name)));
}

export function checkAuthorityIndependence(repoRoot = REPO_ROOT) {
  const problems = [];
  for (const rel of AUTHORITY_PATHS) {
    const abs = path.join(repoRoot, rel);
    if (!existsSync(abs)) {
      problems.push(`authority_path_missing: ${rel} does not exist (update AUTHORITY_PATHS deliberately, never silently)`);
      continue;
    }
    for (const file of walkFiles(abs)) {
      if (readFileSync(file).includes(FORBIDDEN_MENTION)) {
        problems.push(`authority_references_cognitive_ack: ${path.relative(repoRoot, file)} mentions "${FORBIDDEN_MENTION}" -- authority contracts and shared helpers must not depend on this contract`);
      }
    }
  }
  return problems;
}

export function checkReleaseApprovalSchemaPin(schemaDir = RELEASE_APPROVAL_DIR) {
  const actual = sha256hex(readFileSync(path.join(schemaDir, RELEASE_APPROVAL_SCHEMA)));
  if (actual === RELEASE_APPROVAL_SCHEMA_SHA256) return [];
  return [
    `release_approval_schema_drift: release-approval/v0's ${RELEASE_APPROVAL_SCHEMA} changed (sha256 ${actual}, pinned ${RELEASE_APPROVAL_SCHEMA_SHA256}); follow it in contracts/cognitive-ack/v0/CHANGELOG.md and update RELEASE_APPROVAL_SCHEMA_SHA256`,
  ];
}

// Schema-level R4: no `type` anywhere in this contract's schema may admit number or integer.
export function checkSchemaAdmitsNoNumbers(node = JSON.parse(readFileSync(path.join(HERE, RECORD_SCHEMA), "utf-8")), at = "#") {
  if (Array.isArray(node)) return node.flatMap((n, i) => checkSchemaAdmitsNoNumbers(n, `${at}/${i}`));
  if (!isPlainObject(node)) return [];
  const problems = [];
  const types = [node.type].flat();
  if (types.includes("number") || types.includes("integer")) {
    problems.push(`schema_admits_number: ${RECORD_SCHEMA} ${at} has type ${JSON.stringify(node.type)}`);
  }
  for (const [k, v] of Object.entries(node)) problems.push(...checkSchemaAdmitsNoNumbers(v, `${at}/${k}`));
  return problems;
}

function runFixture(entry) {
  const data = read(entry.files);
  if (entry.type === "record") {
    const reasons = checkRecord(data);
    return { category: reasons.length ? "reject" : "accept", reasons };
  }
  if (entry.type === "composite") {
    const preflight = preflightComposite(data);
    if (preflight.length > 0) return { invalid: true, reasons: preflight };
    const { verdict, problems } = checkAckLedger(data);
    return { category: verdict, reasons: problems };
  }
  return { invalid: true, reasons: [`unknown fixture type "${entry.type}"`] };
}

function main() {
  const guards = [...checkAuthorityIndependence(), ...checkReleaseApprovalSchemaPin(), ...checkSchemaAdmitsNoNumbers()];
  if (guards.length > 0) {
    for (const g of guards) console.error(`[FAIL] ${g}`);
    process.exit(1);
  }

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
  console.log(`cognitive-ack:v0 fixture verification (${manifest.fixtures.length} fixtures)\n`);
  for (const entry of manifest.fixtures) {
    const result = runFixture(entry);
    if (result.invalid) {
      failures++;
      console.log(`[FAIL] ${entry.files}  (fixture invalid -- not a verdict)`);
      for (const r of result.reasons) console.log(`        ${r}`);
      continue;
    }
    let ok = result.category === entry.expected;
    if (ok && entry.expected === "reject" && entry.reason_code) {
      ok = result.reasons.some((r) => reasonMatches(r, entry.reason_code));
    }
    if (!ok) failures++;
    console.log(`[${ok ? "PASS" : "FAIL"}] ${entry.files}  (expected=${entry.expected}, got=${result.category})`);
    if (!ok) for (const r of result.reasons) console.log(`        ${r}`);
  }
  console.log(`\n${manifest.fixtures.length - failures}/${manifest.fixtures.length} fixtures behave as declared.`);
  process.exit(failures > 0 ? 1 : 0);
}

// realpath: a symlinked path (e.g. macOS /var -> /private/var) must still count as "run directly".
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main();
