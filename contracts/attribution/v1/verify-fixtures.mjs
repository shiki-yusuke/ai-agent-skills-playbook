#!/usr/bin/env node
// Verifies contracts/attribution/v1/fixtures/* against binding-record.schema.json and
// audit-result.schema.json, plus semantic MUSTs neither schema can express on its own
// (see docs/protocols/attribution-v1.md):
//   - a manual_bind binding-record MUST carry actor.kind == "human"
//   - an audit-result MUST have research_eligible == false whenever violations is non-empty
//     (fail-closed, not advisory)
//   - an audit-result's sessions.{exactly_attributed + unbound + mixed + orphan_usage +
//     measurement_incomplete} MUST sum to sessions.measured (no session silently dropped)
//   - an audit-result's tokens.{exact_attributed,total_measured} MUST be null, not 0, when
//     sessions.measured is 0 (null-not-zero)
//
// Zero npm dependencies by design, same as agent-metrics/v1 and trace/v1: JCS canonicalizer
// (unused here directly, but schema validator is) and JSON Schema subset validator both come
// from contracts/shared/.
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

function checkBindingRecord(record) {
  const reasons = [];
  reasons.push(...validate("binding-record.schema.json", record));

  if (record.binding_method === "manual_bind") {
    if (!record.actor || record.actor.kind !== "human") {
      reasons.push(
        "manual_bind_requires_human_actor: a manual_bind binding-record must carry actor.kind == \"human\"",
      );
    }
  }

  return dedupe(reasons);
}

function checkAuditResult(result) {
  const reasons = [];
  reasons.push(...validate("audit-result.schema.json", result));

  const violations = Array.isArray(result.violations) ? result.violations : [];
  if (violations.length > 0 && result.research_eligible !== false) {
    reasons.push(
      "research_eligible_violates_fail_closed_rule: research_eligible must be false whenever violations is non-empty",
    );
  }

  const sessions = result.sessions;
  if (sessions && typeof sessions === "object") {
    const listLengths = ["unbound", "mixed", "orphan_usage", "measurement_incomplete"]
      .map((k) => (Array.isArray(sessions[k]) ? sessions[k].length : 0))
      .reduce((a, b) => a + b, 0);
    const accountedFor = (sessions.exactly_attributed ?? 0) + listLengths;
    if (typeof sessions.measured === "number" && accountedFor !== sessions.measured) {
      reasons.push(
        `sessions_count_mismatch: exactly_attributed(${sessions.exactly_attributed}) + unbound/mixed/orphan_usage/measurement_incomplete(${listLengths}) = ${accountedFor}, expected measured(${sessions.measured})`,
      );
    }

    if (sessions.measured === 0) {
      const tokens = result.tokens ?? {};
      if (tokens.exact_attributed !== null || tokens.total_measured !== null) {
        reasons.push(
          "unattributed_must_be_null_not_zero: sessions.measured is 0, so tokens.exact_attributed and tokens.total_measured must both be null, not 0",
        );
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

function runFixture(entry) {
  const instance = readFixtureJson(entry.files.record);
  const reasons =
    entry.type === "binding-record" ? checkBindingRecord(instance) : checkAuditResult(instance);
  return { category: reasons.length > 0 ? "reject" : "accept", reasons };
}

function main() {
  const manifest = readFixtureJson("expected-results.json");
  let failures = 0;

  console.log(`attribution:v1 fixture verification (${manifest.fixtures.length} fixtures)\n`);

  for (const entry of manifest.fixtures) {
    const result = runFixture(entry);

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
