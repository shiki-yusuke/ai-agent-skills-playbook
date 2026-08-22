#!/usr/bin/env node
// Verifies contracts/release-approval/v0/fixtures/* against release-approval-event.schema.json
// plus the semantic MUSTs the schema alone cannot express (docs/protocols/release-approval-v0.md):
//
//   event-level:   event_id recomputed as sha256(JCS(event without event_id)) (R18); a
//                  declared value that does not match is rejected.
//   ledger-level:  duplicate event_id across the ledger is rejected (R18).
//   composite:     the ONLY place this repo can check the cross-contract truths TEST-06/TEST-09
//                  actually require -- a composite fixture bundles review-findings records, one
//                  promotion-receipt, and a release-approval ledger together, and this verifier:
//                    - re-validates each embedded record/receipt against ITS OWN contract's
//                      checker (imported, not reimplemented -- checkRecord from review-findings,
//                      checkReceipt from promotion-receipt);
//                    - recomputes the REAL JCS sha256 of the embedded receipt and requires every
//                      approval event's subject.receipt_digest to resolve to it (a repeated
//                      string proves nothing -- same discipline as release-evidence/v0's
//                      bundle_digest check, sol must-2 there; TEST-06 here);
//                    - requires subject.receipt_semantic_digest / bundle_digest /
//                      selection_manifest_digest / target to match the embedded receipt's OWN
//                      current values -- any drift is a stale approval binding (TEST-05);
//                    - resolves each `review_finding` evidence_ref in the receipt's predicates
//                      against the embedded findings by record_id, and requires the ref's digest
//                      to equal that record's ACTUAL subject.digest -- a finding recorded against
//                      a different (e.g. pre-fix) subject digest cannot back the predicate
//                      (TEST-09).
//
// Zero npm dependencies by design. Usage: node verify-fixtures.mjs (no args, no network).

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createValidator } from "../../shared/schema-validator.mjs";
import { scanPersonalDimensions } from "../../shared/personal-dimensions.mjs";
import { canonicalize, sha256hex } from "../../shared/jcs.mjs";
import { checkRecord } from "../../review-findings/v1/verify-fixtures.mjs";
import { checkReceipt } from "../../promotion-receipt/v0/verify-fixtures.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(HERE, "fixtures");
const { validate } = createValidator(HERE);

const read = (f) => JSON.parse(readFileSync(path.join(FIXTURES_DIR, f), "utf-8"));
const dedupe = (a) => [...new Set(a)];

function scanNumericConfidence(value, pathStr = "") {
  const violations = [];
  if (Array.isArray(value)) {
    value.forEach((item, i) => violations.push(...scanNumericConfidence(item, `${pathStr}[${i}]`)));
    return violations;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, val] of Object.entries(value)) {
      const here = pathStr ? `${pathStr}.${key}` : key;
      if (key === "confidence" && typeof val === "number") violations.push(here);
      violations.push(...scanNumericConfidence(val, here));
    }
  }
  return violations;
}

// R18: event_id = sha256(JCS(event without event_id)).
function computeEventId(event) {
  const { event_id, ...rest } = event;
  return `sha256:${sha256hex(canonicalize(rest))}`;
}

function jcsDigestOf(obj) {
  return `sha256:${sha256hex(canonicalize(obj))}`;
}

function checkEventSchemaAndId(event) {
  const reasons = [];
  reasons.push(...validate("release-approval-event.schema.json", event));
  reasons.push(...scanPersonalDimensions(event).map((v) => `personal_dimension_forbidden_key: ${v}`));
  reasons.push(...scanNumericConfidence(event).map((v) => `numeric_confidence_forbidden_field: ${v}`));
  if (reasons.length > 0) return dedupe(reasons);

  const expectedId = computeEventId(event);
  if (event.event_id !== expectedId) {
    reasons.push(`event_id_mismatch: event declares "${event.event_id}", recomputed "${expectedId}"`);
  }
  return dedupe(reasons);
}

function checkLedger(events, problems) {
  const ids = events.map((e) => e.event_id);
  for (const dup of dedupe(ids.filter((id, i) => ids.indexOf(id) !== i))) {
    problems.push(`duplicate_event_id: "${dup}" appears more than once in the ledger`);
  }
}

function checkComposite({ findings, receipt, approval_events }, problems) {
  const findingsById = new Map();
  for (const [i, record] of (findings ?? []).entries()) {
    const reasons = checkRecord(record);
    if (reasons.length > 0) {
      problems.push(`findings[${i}] not individually valid: ${reasons.join("; ")}`);
    } else {
      findingsById.set(record.record_id, record);
    }
  }

  const receiptReasons = checkReceipt(receipt);
  if (receiptReasons.length > 0) {
    problems.push(`receipt not individually valid: ${receiptReasons.join("; ")}`);
  }

  const eventProblems = [];
  for (const [i, ev] of (approval_events ?? []).entries()) {
    const reasons = checkEventSchemaAndId(ev);
    if (reasons.length > 0) eventProblems.push(`approval_events[${i}] not individually valid: ${reasons.join("; ")}`);
  }
  problems.push(...eventProblems);
  if (problems.length > 0) return;

  checkLedger(approval_events, problems);

  // TEST-06: receipt_digest must resolve to the REAL JCS sha256 of the embedded receipt -- a
  // repeated placeholder string is not evidence.
  const realReceiptDigest = jcsDigestOf(receipt);
  for (const ev of approval_events) {
    if (ev.subject.receipt_digest !== realReceiptDigest) {
      problems.push(
        `receipt_digest_unresolved: event "${ev.event_id}" carries receipt_digest ${ev.subject.receipt_digest.slice(0, 18)}..., which is not the JCS sha256 of the receipt in this ledger`,
      );
      continue;
    }
    // TEST-05 (and the wider exact-binding rule R19): every subject field must match the
    // embedded receipt's OWN current values. Any drift is a stale approval, regardless of which
    // field drifted -- the approval no longer describes the receipt it claims to.
    if (ev.subject.receipt_semantic_digest !== receipt.semantic_digest) {
      problems.push(
        `stale_approval_binding: event "${ev.event_id}" receipt_semantic_digest does not match the receipt's current semantic_digest`,
      );
    }
    if (ev.subject.bundle_digest !== receipt.subject.bundle_digest) {
      problems.push(
        `stale_approval_binding: event "${ev.event_id}" bundle_digest ${ev.subject.bundle_digest.slice(0, 18)}... does not match the receipt's subject.bundle_digest`,
      );
    }
    if (ev.subject.selection_manifest_digest !== receipt.subject.selection_manifest_digest) {
      problems.push(`stale_approval_binding: event "${ev.event_id}" selection_manifest_digest does not match the receipt's`);
    }
    if (ev.subject.target !== receipt.subject.target) {
      problems.push(`stale_approval_binding: event "${ev.event_id}" target "${ev.subject.target}" does not match the receipt's target "${receipt.subject.target}"`);
    }
  }
  if (problems.length > 0) return;

  // TEST-09: a review_finding evidence_ref only backs a predicate when its digest equals the
  // ACTUAL subject.digest of the named record -- not merely when a record with that record_id
  // exists. Two records for the same logical finding at different subject digests (e.g. before
  // and after a fix) are NOT the same subject; resolving against the wrong one is rejected.
  for (const p of receipt.predicates) {
    for (const ref of p.evidence_refs) {
      if (ref.kind !== "review_finding") continue;
      const recordId = ref.ref.split("#")[0];
      const record = findingsById.get(recordId);
      if (!record) {
        problems.push(`evidence_ref_unresolved: predicate "${p.predicate_id}" references review_finding "${ref.ref}", which is not among the ledger's findings records`);
        continue;
      }
      if (record.subject.digest !== ref.digest) {
        problems.push(
          `evidence_ref_digest_mismatch: predicate "${p.predicate_id}" references review_finding "${ref.ref}" at digest ${ref.digest.slice(0, 18)}..., but record "${recordId}"'s actual subject.digest is ${record.subject.digest.slice(0, 18)}... -- a finding recorded against a different subject cannot back this predicate`,
        );
      }
    }
  }
}

function runFixture(entry) {
  const problems = [];
  const data = read(entry.files);
  if (entry.type === "event") {
    problems.push(...checkEventSchemaAndId(data));
  } else if (entry.type === "ledger") {
    for (const [i, ev] of data.entries()) {
      const reasons = checkEventSchemaAndId(ev);
      if (reasons.length > 0) problems.push(`event[${i}] not individually valid: ${reasons.join("; ")}`);
    }
    if (problems.length === 0) checkLedger(data, problems);
  } else if (entry.type === "composite") {
    checkComposite(data, problems);
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
  console.log(`release-approval:v0 fixture verification (${manifest.fixtures.length} fixtures)\n`);
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
