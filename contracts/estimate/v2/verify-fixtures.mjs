#!/usr/bin/env node
// Verifies contracts/estimate/v2/fixtures/* against estimate-decision.schema.json, plus
// several semantic MUSTs the schema alone cannot fully express (sol architect-review must6/7):
//   - decision.status == "abstained" requires at least one BLOCKING reason_code (DRIFT_WARNING,
//     the one ADVISORY code, does not by itself justify withholding a point estimate)
//   - decision.status == "predicted" must not carry any BLOCKING reason_code
//   - predicted.p50 <= predicted.p80
//   - prediction_interval.lower <= prediction_interval.upper (when status == "available")
//   - population.eligible_count <= population.candidate_count
//   - population.excluded_by_reason: every key is one of the 12 reason_codes, every value a
//     non-negative integer
//   - the personal-dimension scan (contracts/shared/personal-dimensions.mjs)
//
// Zero npm dependencies by design, same as every other contract in this repo: the JSON
// Schema subset validator and the personal-dimension scan both come from contracts/shared/.
//
// Usage: node verify-fixtures.mjs   (no arguments, no install step)

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createValidator } from "../../shared/schema-validator.mjs";
import { scanPersonalDimensions } from "../../shared/personal-dimensions.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(HERE, "fixtures");
const { validate } = createValidator(HERE);

// sol architect-review must6: the 12-code closed set split into 11 BLOCKING (abstain-forcing)
// codes and 1 ADVISORY code. DRIFT_WARNING is the only member of the latter -- it may
// accompany a `predicted` decision, but on its own never satisfies "abstained requires a
// reason."
const ADVISORY_REASON_CODES = new Set(["DRIFT_WARNING"]);
const ALL_REASON_CODES = new Set([
  "INSUFFICIENT_POPULATION",
  "INSUFFICIENT_COMPARABLE_NEIGHBORS",
  "DISTANCE_ABOVE_THRESHOLD",
  "TOKEN_BASIS_MISMATCH",
  "MODEL_GENERATION_MISMATCH",
  "ROUTING_PROFILE_MISMATCH",
  "PREDICTOR_SCHEMA_MISMATCH",
  "NOVEL_SURFACE_UNKNOWN",
  "OUT_OF_DOMAIN",
  "MIXED_OR_UNATTRIBUTED_USAGE",
  "DRIFT_WARNING",
  "TARGET_BASIS_UNSUPPORTED",
]);
const BLOCKING_REASON_CODES = new Set([...ALL_REASON_CODES].filter((c) => !ADVISORY_REASON_CODES.has(c)));

function dedupe(arr) {
  return [...new Set(arr)];
}

function checkDecision(instance) {
  const reasons = [];
  reasons.push(...validate("estimate-decision.schema.json", instance));
  reasons.push(...scanPersonalDimensions(instance).map((v) => `personal_dimension_forbidden_key: ${v}`));

  const decision = instance.decision;
  if (decision) {
    const codes = Array.isArray(decision.reason_codes) ? decision.reason_codes : [];
    const blockingPresent = codes.filter((c) => BLOCKING_REASON_CODES.has(c));

    if (decision.status === "abstained" && blockingPresent.length === 0) {
      reasons.push(
        "abstained_requires_blocking_reason_code: decision.status is \"abstained\" but reason_codes contains no BLOCKING code (DRIFT_WARNING alone does not justify an abstain)",
      );
    }
    if (decision.status === "predicted" && blockingPresent.length > 0) {
      reasons.push(
        `predicted_with_blocking_reason_code: decision.status is "predicted" but reason_codes carries BLOCKING code(s) ${blockingPresent.join(", ")} -- only the advisory DRIFT_WARNING may accompany a prediction`,
      );
    }
  }

  const predicted = instance.predicted;
  if (predicted && typeof predicted.p50 === "number" && typeof predicted.p80 === "number") {
    if (predicted.p50 > predicted.p80) {
      reasons.push(`predicted_quantiles_inverted: p50 (${predicted.p50}) must be <= p80 (${predicted.p80})`);
    }
  }

  const interval = instance.prediction_interval;
  if (interval?.status === "available" && typeof interval.lower === "number" && typeof interval.upper === "number") {
    if (interval.lower > interval.upper) {
      reasons.push(
        `prediction_interval_inverted: lower (${interval.lower}) must be <= upper (${interval.upper})`,
      );
    }
  }

  const population = instance.population;
  if (population) {
    if (
      typeof population.eligible_count === "number" &&
      typeof population.candidate_count === "number" &&
      population.eligible_count > population.candidate_count
    ) {
      reasons.push(
        `eligible_exceeds_candidate: population.eligible_count (${population.eligible_count}) must be <= population.candidate_count (${population.candidate_count})`,
      );
    }
    const excludedByReason = population.excluded_by_reason;
    if (excludedByReason && typeof excludedByReason === "object") {
      for (const [key, value] of Object.entries(excludedByReason)) {
        if (!ALL_REASON_CODES.has(key)) {
          reasons.push(`excluded_by_reason_unknown_key: "${key}" is not one of the 12 reason_codes`);
        }
        if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
          reasons.push(`excluded_by_reason_invalid_value: excluded_by_reason["${key}"] must be a non-negative integer, got ${JSON.stringify(value)}`);
        }
      }
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
  // sol architect-review should: refuse to report a false-green success if the manifest
  // declares zero fixtures (e.g. a botched refactor that emptied the array) -- 0/0 passed
  // must never print the same shape of success line as an intentional, populated run.
  if (!Array.isArray(manifest.fixtures) || manifest.fixtures.length === 0) {
    console.error("expected-results.json declares zero fixtures -- refusing to report success.");
    process.exit(1);
  }
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
