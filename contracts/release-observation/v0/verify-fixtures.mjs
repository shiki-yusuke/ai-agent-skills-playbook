#!/usr/bin/env node
// Verifies contracts/release-observation/v0/fixtures/* against
// release-observation-event.schema.json, plus one semantic MUST neither schema alone can
// express (see docs/protocols/release-observation-v0.md):
//   - a `rollback_of` value MUST match some OTHER event's `release_id` within the same checked
//     collection of events (a dangling reference -- a release claiming to roll back a release
//     nobody has recorded is either a typo or a recording gap, either way not a fact this
//     contract should silently accept) -- only checkable across more than one event at a time,
//     mirroring attribution/v1's own "binding-collection" fixture type for exactly the same
//     reason (a cross-record check no single-record validation can express).
//
// Zero npm dependencies by design, same as every verify-fixtures.mjs in this repo.
//
// Usage: node verify-fixtures.mjs   (no arguments, no install step)

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createValidator } from "../../shared/schema-validator.mjs";
import { FORBIDDEN_PERSONAL_DIMENSION_KEYS, scanPersonalDimensions } from "../../shared/personal-dimensions.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(HERE, "fixtures");
const { validate } = createValidator(HERE);

function dedupe(arr) {
  return [...new Set(arr)];
}

function checkEvent(event) {
  const reasons = [];
  reasons.push(...validate("release-observation-event.schema.json", event));
  reasons.push(...scanPersonalDimensions(event).map((v) => `personal_dimension_forbidden_key: ${v}`));
  return dedupe(reasons);
}

// A `rollback_of` reference MUST resolve to some other event's release_id within the same
// collection -- v0's release ledger is expected to stay small and locally complete (unlike
// trace/v1's supersedes_event_id, which explicitly tolerates an unresolved cross-segment
// reference; see this schema's own rollback_of description for why the two are not analogous).
function checkRollbackReferencesResolve(records) {
  const issues = [];
  const knownReleaseIds = new Set(records.map((r) => r && r.release_id).filter((id) => typeof id === "string"));
  for (const record of records) {
    if (!record || typeof record.rollback_of !== "string") continue;
    if (!knownReleaseIds.has(record.rollback_of)) {
      issues.push(
        `dangling_rollback_of_reference: release_id "${record.release_id}" has rollback_of "${record.rollback_of}", which does not match any release_id in the checked collection`,
      );
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

  for (const record of records) {
    const reasons = checkEvent(record);
    if (reasons.length > 0) problems.push(`record not individually valid: ${reasons.join("; ")}`);
  }
  problems.push(...checkRollbackReferencesResolve(records));

  return { category: problems.length > 0 ? "reject" : "accept", reasons: problems };
}

function runFixture(entry) {
  if (entry.type === "collection") {
    return runCollectionFixture(entry);
  }
  const instance = readFixtureJson(entry.files.record);
  const reasons = checkEvent(instance);
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

  console.log(`release-observation:v0 fixture verification (${manifest.fixtures.length} fixtures)\n`);

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
  if (failures > 0) {
    console.error(`\n${failures} fixture(s) FAILED.`);
    process.exit(1);
  }
}

main();
