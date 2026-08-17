#!/usr/bin/env node
// Verifies contracts/design-options/v1/fixtures/* against design-options.schema.json, plus two
// semantic MUSTs neither schema alone can express (see docs/protocols/design-options-v1.md):
//   1. every `options[].option_id` MUST be unique within one document (this repo's minimal
//      validator subset has no cross-item uniqueness-by-key keyword, only uniqueItems over
//      whole-item equality).
//   2. every `decision_request.option_ids` entry MUST resolve to some `options[].option_id`
//      present in the SAME document (a decision_request asking about an option nobody defined
//      is a typo or a gap, mirroring release-observation/v0's own rollback_of dangling-reference
//      check -- but this one is checkable within a single record, not across a collection).
//   3. every artifact_ref (intent_ref / notes_ref) whose content_digest names a file reachable
//      inside this repo actually matches that file's real sha256
//      (contracts/shared/verify-artifact-digests.mjs) -- see that module's header for the
//      unrecorded-referent incident this closes (a digest with no uri beside it can be neither
//      verified nor refuted). Refs whose uri is absent or points outside
//      this repo are reported as unverifiable, not silently accepted.
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

function checkDuplicateOptionIds(doc) {
  const issues = [];
  if (!Array.isArray(doc.options)) return issues;
  const seen = new Set();
  for (const option of doc.options) {
    const id = option && option.option_id;
    if (typeof id !== "string") continue;
    if (seen.has(id)) {
      issues.push(`duplicate_option_id: "${id}" appears more than once in options[]`);
    }
    seen.add(id);
  }
  return issues;
}

function checkDecisionRequestOptionIdsResolve(doc) {
  const issues = [];
  if (!doc.decision_request || !Array.isArray(doc.decision_request.option_ids)) return issues;
  if (!Array.isArray(doc.options)) return issues;
  const knownOptionIds = new Set(doc.options.map((o) => o && o.option_id).filter((id) => typeof id === "string"));
  for (const id of doc.decision_request.option_ids) {
    if (typeof id !== "string") continue;
    if (!knownOptionIds.has(id)) {
      issues.push(
        `dangling_decision_request_option_id: decision_request.option_ids references "${id}", which does not match any options[].option_id in this document`,
      );
    }
  }
  return issues;
}

// Accumulated across every fixture checked by this run -- see decision/v1's own verify-fixtures.mjs
// for why this is always printed rather than folded silently into pass/fail.
const allUnverifiable = [];
const allWarnings = [];

function checkDocument(doc, label) {
  const reasons = [];
  reasons.push(...validate("design-options.schema.json", doc));
  reasons.push(...scanPersonalDimensions(doc).map((v) => `personal_dimension_forbidden_key: ${v}`));
  reasons.push(...checkDuplicateOptionIds(doc));
  reasons.push(...checkDecisionRequestOptionIdsResolve(doc));

  const digestResult = verifyArtifactDigests([{ label, record: doc }], { repoRoot: REPO_ROOT });
  reasons.push(...digestResult.errors);
  allUnverifiable.push(...digestResult.unverifiable);
  allWarnings.push(...digestResult.warnings);

  return dedupe(reasons);
}

function readFixtureJson(filename) {
  return JSON.parse(readFileSync(path.join(FIXTURES_DIR, filename), "utf-8"));
}

function runFixture(entry) {
  const instance = readFixtureJson(entry.files.record);
  const reasons = checkDocument(instance, entry.id);
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

  console.log(`design-options:v1 fixture verification (${manifest.fixtures.length} fixtures)\n`);

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

  console.log(`\nartifact_ref digest verification: ${allUnverifiable.length} unverifiable, ${allWarnings.length} warning(s).`);
  for (const u of allUnverifiable) console.log(`  [unverifiable] ${u}`);
  for (const w of allWarnings) console.log(`  [warning] ${w}`);

  if (failures > 0) {
    console.error(`\n${failures} fixture(s) FAILED.`);
    process.exit(1);
  }
}

main();
