#!/usr/bin/env node
// Verifies contracts/decision/v1/fixtures/* against decision.schema.json, plus semantic MUSTs
// neither schema alone can express (see docs/protocols/decision-v1.md):
//   1. every `retractions[].retracted_item_ref` MUST match some `decision_items[].item_id` in
//      the SAME record, and that item's `status` MUST be "retracted" (a dangling/inconsistent
//      reference otherwise -- i-shadow-record-01's own 'finding 1' partial-retraction case is
//      exactly what this exists to keep honest).
//   2. every `decision_items[]` entry whose `status` is "retracted" MUST have a corresponding
//      `retractions[]` entry pointing at it (the symmetric direction of check 1 -- an item
//      marked retracted with no retraction record explaining why is just as dishonest as a
//      dangling retraction).
//   3. every `conflicts_with[].conflicting_decision_ref` MUST resolve to some OTHER record's
//      `decision_id` within the same checked collection of records -- only checkable across
//      more than one record at a time, the same reason release-observation/v0 has its own
//      rollback_of dangling-reference check (a "collection" fixture type).
//   4. every artifact_ref (intent_ref / options_ref / critic_ref / estimate_refs[]) whose
//      content_digest names a file reachable inside this repo actually matches that file's real
//      sha256 (contracts/shared/verify-artifact-digests.mjs) -- the check this contract was
//      missing when its own fixtures carried content_digest values with no uri recorded beside
//      them, leaving a reviewer unable to verify OR refute them (sol architect-review must-fix 1;
//      see that module's header for what actually went wrong). Refs whose uri is absent or points
//      outside this repo (e.g. the living-twin fixtures below) are reported as unverifiable, not
//      silently accepted -- see that module's own header for the full null-not-zero rationale.
//
// Zero npm dependencies by design, same as every verify-fixtures.mjs in this repo.
//
// Usage: node verify-fixtures.mjs   (no arguments, no install step)

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createValidator } from "../../shared/schema-validator.mjs";
import { FORBIDDEN_PERSONAL_DIMENSION_KEYS, scanPersonalDimensions } from "../../shared/personal-dimensions.mjs";
import { verifyArtifactDigests } from "../../shared/verify-artifact-digests.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(HERE, "fixtures");
const REPO_ROOT = path.join(HERE, "..", "..", "..");
const { validate } = createValidator(HERE);

function dedupe(arr) {
  return [...new Set(arr)];
}

function checkRetractionsResolveAndAreConsistent(record) {
  const issues = [];
  if (!Array.isArray(record.decision_items) || !Array.isArray(record.retractions)) return issues;

  const itemsById = new Map();
  for (const item of record.decision_items) {
    if (item && typeof item.item_id === "string") itemsById.set(item.item_id, item);
  }

  const retractedRefsSeen = new Set();
  for (const retraction of record.retractions) {
    const ref = retraction && retraction.retracted_item_ref;
    if (typeof ref !== "string") continue;
    retractedRefsSeen.add(ref);
    const item = itemsById.get(ref);
    if (!item) {
      issues.push(
        `dangling_retracted_item_ref: retractions[].retracted_item_ref "${ref}" does not match any decision_items[].item_id in this record`,
      );
    } else if (item.status !== "retracted") {
      issues.push(
        `retracted_item_ref_status_mismatch: retractions[].retracted_item_ref "${ref}" points at a decision_items[] entry whose status is "${item.status}", expected "retracted"`,
      );
    }
  }

  for (const item of record.decision_items) {
    if (item && item.status === "retracted" && typeof item.item_id === "string" && !retractedRefsSeen.has(item.item_id)) {
      issues.push(
        `unretracted_item_marked_retracted: decision_items[] entry "${item.item_id}" has status "retracted" but no retractions[] entry references it`,
      );
    }
  }

  return issues;
}

// Accumulated across every fixture checked by this run (not per-fixture) so main() can print the
// required always-on unverifiable/warning summary at the end -- null-not-zero: "checked, none
// found" and "never actually checked" must stay visibly different, the same reason
// contracts/shared/verify-artifact-digests.mjs itself never folds these into pass/fail.
const allUnverifiable = [];
const allWarnings = [];

function checkRecord(record, label) {
  const reasons = [];
  reasons.push(...validate("decision.schema.json", record));
  reasons.push(...scanPersonalDimensions(record).map((v) => `personal_dimension_forbidden_key: ${v}`));
  reasons.push(...checkRetractionsResolveAndAreConsistent(record));

  const digestResult = verifyArtifactDigests([{ label, record }], { repoRoot: REPO_ROOT });
  reasons.push(...digestResult.errors);
  allUnverifiable.push(...digestResult.unverifiable);
  allWarnings.push(...digestResult.warnings);

  return dedupe(reasons);
}

// conflicts_with[].conflicting_decision_ref MUST resolve to some other record's decision_id
// within the same collection -- only checkable across more than one record at a time.
function checkConflictReferencesResolve(records) {
  const issues = [];
  const knownDecisionIds = new Set(records.map((r) => r && r.decision_id).filter((id) => typeof id === "string"));
  for (const record of records) {
    if (!record || !Array.isArray(record.conflicts_with)) continue;
    for (const conflict of record.conflicts_with) {
      const ref = conflict && conflict.conflicting_decision_ref;
      const logicalId = ref && ref.logical_id;
      if (typeof logicalId !== "string") continue;
      if (!knownDecisionIds.has(logicalId)) {
        issues.push(
          `dangling_conflicting_decision_ref: decision_id "${record.decision_id}" has conflicts_with[].conflicting_decision_ref.logical_id "${logicalId}", which does not match any decision_id in the checked collection`,
        );
      }
    }
  }
  return issues;
}

function readFixtureJson(filename) {
  return JSON.parse(readFileSync(path.join(FIXTURES_DIR, filename), "utf-8"));
}

function runCollectionFixture(entry) {
  const records = entry.files.records.map(readFixtureJson);
  const problems = [];

  records.forEach((record, i) => {
    const reasons = checkRecord(record, `${entry.id} [${entry.files.records[i]}]`);
    if (reasons.length > 0) problems.push(`record not individually valid: ${reasons.join("; ")}`);
  });
  problems.push(...checkConflictReferencesResolve(records));

  return { category: problems.length > 0 ? "reject" : "accept", reasons: problems };
}

function runFixture(entry) {
  if (entry.type === "collection") {
    return runCollectionFixture(entry);
  }
  const instance = readFixtureJson(entry.files.record);
  const reasons = checkRecord(instance, entry.id);
  return { category: reasons.length > 0 ? "reject" : "accept", reasons };
}

function reasonCodesOf(reasons) {
  return reasons.map((r) => r.split(":")[0].trim());
}

function main() {
  const manifest = readFixtureJson("expected-results.json");
  if (!Array.isArray(manifest.fixtures) || manifest.fixtures.length === 0) {
    console.error("expected-results.json declares zero fixtures -- refusing to report success.");
    process.exit(1);
  }
  let failures = 0;

  console.log(`decision:v1 fixture verification (${manifest.fixtures.length} fixtures)\n`);

  for (const entry of manifest.fixtures) {
    const result = runFixture(entry);

    let ok = result.category === entry.expected;
    if (ok && entry.expected === "reject" && entry.reason_code) {
      const codes = reasonCodesOf(result.reasons);
      ok = codes.includes(entry.reason_code);
    }
    if (ok && entry.all_forbidden_keys_flagged) {
      ok = [...FORBIDDEN_PERSONAL_DIMENSION_KEYS].every((key) =>
        result.reasons.includes(`personal_dimension_forbidden_key: ${key}`),
      );
    }

    const status = ok ? "PASS" : "FAIL";
    if (!ok) failures++;
    console.log(`[${status}] ${entry.id}  (expected=${entry.expected}, got=${result.category})`);
    if (!ok || process.env.VERBOSE) {
      for (const r of result.reasons) console.log(`         - ${r}`);
    }
  }

  console.log(`\n${manifest.fixtures.length - failures}/${manifest.fixtures.length} fixtures passed.`);

  // Always printed -- null-not-zero: a zero count here must be visibly "checked, zero found",
  // never mistaken for "not checked" (contracts/shared/verify-artifact-digests.mjs's own header).
  // Deduped: a record shared between an individual fixture and a "collection" fixture (e.g.
  // decision-03/decision-04, also reused verbatim by accept-conflict-resolves-collection) is
  // digest-checked once per fixture it appears in, so the same finding can otherwise repeat.
  const uniqueUnverifiable = dedupe(allUnverifiable);
  const uniqueWarnings = dedupe(allWarnings);
  console.log(`\nartifact_ref digest verification: ${uniqueUnverifiable.length} unverifiable, ${uniqueWarnings.length} warning(s).`);
  for (const u of uniqueUnverifiable) console.log(`  [unverifiable] ${u}`);
  for (const w of uniqueWarnings) console.log(`  [warning] ${w}`);

  if (failures > 0) {
    console.error(`\n${failures} fixture(s) FAILED.`);
    process.exit(1);
  }
}

main();
