#!/usr/bin/env node
// Verifies contracts/impact-scan/v1/fixtures/* against impact-scan.schema.json. Single-layer
// verification (schema validate only) -- unlike agent-metrics/v1, trace/v1, and
// attribution/v1, this contract has no identity/upsert concept and no personal-dimension
// surface (it is a raw-observations block: file paths and layer names, not telemetry about
// who did what). additionalProperties:false on its own is the whole enforcement mechanism
// for this contract's two design principles (no aggregate score field, no digest field) --
// see impact-scan.schema.json's description.
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

function readFixtureJson(filename) {
  return JSON.parse(readFileSync(path.join(FIXTURES_DIR, filename), "utf-8"));
}

function reasonCodesOf(reasons) {
  return reasons.map((r) => r.split(":")[0].trim());
}

function main() {
  const manifest = readFixtureJson("expected-results.json");
  let failures = 0;

  console.log(`impact-scan:v1 fixture verification (${manifest.fixtures.length} fixtures)\n`);

  for (const entry of manifest.fixtures) {
    const instance = readFixtureJson(entry.files.block);
    const reasons = validate("impact-scan.schema.json", instance);
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
