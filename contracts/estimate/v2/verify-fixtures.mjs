#!/usr/bin/env node
// Verifies contracts/estimate/v2/fixtures/* against estimate-decision.schema.json, plus one
// semantic MUST the schema alone cannot express: decision.status == "abstained" requires
// decision.reason_codes to be non-empty (an abstained decision without a stated reason is
// indistinguishable from a silent failure -- v2's whole point is that abstaining is always
// explained).
//
// Zero npm dependencies by design, same as every other contract in this repo: the JSON
// Schema subset validator comes from contracts/shared/.
//
// Usage: node verify-fixtures.mjs   (no arguments, no install step)

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createValidator } from "../../shared/schema-validator.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(HERE, "fixtures");
const { validate } = createValidator(HERE);

function dedupe(arr) {
  return [...new Set(arr)];
}

function checkDecision(instance) {
  const reasons = [];
  reasons.push(...validate("estimate-decision.schema.json", instance));

  const decision = instance.decision;
  if (decision && decision.status === "abstained") {
    const codes = Array.isArray(decision.reason_codes) ? decision.reason_codes : [];
    if (codes.length === 0) {
      reasons.push(
        "abstained_requires_reason_codes: decision.status is \"abstained\" but decision.reason_codes is empty",
      );
    }
  }

  return dedupe(reasons);
}

function reasonCodesOf(reasons) {
  return reasons.map((r) => r.split(":")[0].trim());
}

function readFixtureJson(filename) {
  return JSON.parse(readFileSync(path.join(FIXTURES_DIR, filename), "utf-8"));
}

function main() {
  const manifest = readFixtureJson("expected-results.json");
  let failures = 0;

  console.log(`estimate:v2 fixture verification (${manifest.fixtures.length} fixtures)\n`);

  for (const entry of manifest.fixtures) {
    const instance = readFixtureJson(entry.files.record);
    const reasons = checkDecision(instance);
    const category = reasons.length > 0 ? "reject" : "accept";

    let ok = category === entry.expected;
    if (ok && entry.expected === "reject" && entry.reason_code) {
      ok = reasonCodesOf(reasons).includes(entry.reason_code);
    }

    const status = ok ? "PASS" : "FAIL";
    if (!ok) failures++;
    console.log(`[${status}] ${entry.id}  (expected=${entry.expected}, got=${category})`);
    if (!ok || process.env.VERBOSE) {
      for (const r of reasons) console.log(`         - ${r}`);
    }
  }

  console.log(`\n${manifest.fixtures.length - failures}/${manifest.fixtures.length} fixtures passed.`);
  if (failures > 0) {
    console.error(`\n${failures} fixture(s) FAILED.`);
    process.exit(1);
  }
}

main();
