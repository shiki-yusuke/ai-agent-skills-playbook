#!/usr/bin/env node
// Verifies contracts/attribution/v1/fixtures/* against binding-record.schema.json and
// audit-result.schema.json, plus semantic MUSTs neither schema can fully express on its own
// (see docs/protocols/attribution-v1.md):
//   - a manual_bind binding-record MUST carry actor.kind == "human" (also schema-enforced via
//     if/then now -- this check stays as a defense-in-depth backstop, sol architect-review must5)
//   - no session_id may have more than one binding-record with binding_status=="bound" at the
//     same time (multiple active bindings for one session)
//   - an audit-result MUST have research_eligible == false whenever violations is non-empty
//     (fail-closed, not advisory)
//   - an audit-result's five `sessions` lists (exactly_attributed's session_ids plus the four
//     plain lists) MUST be pairwise disjoint
//   - every session_id in unbound/mixed/orphan_usage/measurement_incomplete MUST have a
//     matching violations[] entry with the corresponding reason_code (and vice versa -- no
//     violation may reference a session absent from its list)
//   - tokens.exact_attributed MUST equal the sum of sessions.exactly_attributed[].tokens
//   - tokens.{exact_attributed,total_measured} MUST be null, not 0, when all five `sessions`
//     lists are empty (null-not-zero)
//   - the personal-dimension scan (contracts/shared/personal-dimensions.mjs)
//
// Zero npm dependencies by design, same as agent-metrics/v1 and trace/v1: JSON Schema subset
// validator and the personal-dimension scan both come from contracts/shared/.
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

function checkBindingRecord(record) {
  const reasons = [];
  reasons.push(...validate("binding-record.schema.json", record));
  reasons.push(...scanPersonalDimensions(record).map((v) => `personal_dimension_forbidden_key: ${v}`));

  if (record.binding_method === "manual_bind") {
    if (!record.actor || record.actor.kind !== "human") {
      reasons.push(
        "manual_bind_requires_human_actor: a manual_bind binding-record must carry actor.kind == \"human\"",
      );
    }
  }

  return dedupe(reasons);
}

// sol architect-review must4: reason_code each of the four plain session lists corresponds to.
const REASON_CODE_FOR_LIST = {
  unbound: "UNBOUND_SESSION",
  mixed: "MULTI_TASK_BINDING",
  orphan_usage: "ORPHAN_USAGE",
  measurement_incomplete: "MEASUREMENT_INCOMPLETE",
};

// Cross-checks the five `sessions` lists against each other and against `violations`:
// disjointness (no session_id in more than one list) and bidirectional list<->violation
// correspondence (every listed session has a matching violation, and no violation references
// a session absent from its corresponding list). Neither is expressible as a JSON Schema
// constraint -- both compare sibling array contents against each other.
function checkSessionsPartition(sessions, violations) {
  const issues = [];
  const listNames = Object.keys(REASON_CODE_FOR_LIST);
  const exactIds = (Array.isArray(sessions.exactly_attributed) ? sessions.exactly_attributed : []).map(
    (e) => e.session_id,
  );
  const groups = { exactly_attributed: exactIds };
  for (const name of listNames) groups[name] = Array.isArray(sessions[name]) ? sessions[name] : [];

  const seenIn = new Map();
  for (const [group, ids] of Object.entries(groups)) {
    for (const id of ids) {
      if (seenIn.has(id)) {
        issues.push(`sessions_not_disjoint: session_id "${id}" appears in both "${seenIn.get(id)}" and "${group}"`);
      } else {
        seenIn.set(id, group);
      }
    }
  }

  for (const listName of listNames) {
    const reasonCode = REASON_CODE_FOR_LIST[listName];
    for (const sid of groups[listName]) {
      const hasMatch = violations.some((v) => v.reason_code === reasonCode && v.session_id === sid);
      if (!hasMatch) {
        issues.push(
          `missing_violation_for_session: session_id "${sid}" is in sessions.${listName} but has no matching violations[] entry with reason_code ${reasonCode}`,
        );
      }
    }
  }
  for (const v of violations) {
    const listName = Object.entries(REASON_CODE_FOR_LIST).find(([, code]) => code === v.reason_code)?.[0];
    if (listName && v.session_id !== undefined && !groups[listName].includes(v.session_id)) {
      issues.push(
        `orphaned_violation: a violation (reason_code=${v.reason_code}, session_id=${v.session_id}) does not correspond to any session_id in sessions.${listName}`,
      );
    }
  }

  return issues;
}

function checkAuditResult(result) {
  const reasons = [];
  reasons.push(...validate("audit-result.schema.json", result));
  reasons.push(...scanPersonalDimensions(result).map((v) => `personal_dimension_forbidden_key: ${v}`));

  const violations = Array.isArray(result.violations) ? result.violations : [];
  if (violations.length > 0 && result.research_eligible !== false) {
    reasons.push(
      "research_eligible_violates_fail_closed_rule: research_eligible must be false whenever violations is non-empty",
    );
  }

  const sessions = result.sessions;
  if (sessions && typeof sessions === "object") {
    reasons.push(...checkSessionsPartition(sessions, violations));

    const exactList = Array.isArray(sessions.exactly_attributed) ? sessions.exactly_attributed : [];
    const totalSessions =
      exactList.length +
      ["unbound", "mixed", "orphan_usage", "measurement_incomplete"]
        .map((k) => (Array.isArray(sessions[k]) ? sessions[k].length : 0))
        .reduce((a, b) => a + b, 0);

    const tokens = result.tokens ?? {};
    if (totalSessions === 0) {
      if (tokens.exact_attributed !== null || tokens.total_measured !== null) {
        reasons.push(
          "unattributed_must_be_null_not_zero: every sessions list is empty, so tokens.exact_attributed and tokens.total_measured must both be null, not 0",
        );
      }
    } else {
      const exactSum = exactList.reduce((sum, e) => sum + (typeof e.tokens === "number" ? e.tokens : 0), 0);
      if (tokens.exact_attributed !== exactSum) {
        reasons.push(
          `exact_attributed_sum_mismatch: tokens.exact_attributed(${tokens.exact_attributed}) does not equal the sum of sessions.exactly_attributed[].tokens (${exactSum})`,
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

// sol architect-review should: a "binding-collection" fixture kind (an array of
// binding-records considered together) to catch the same session_id having more than one
// simultaneously-active ("bound", not "superseded") binding-record -- a cross-record check no
// single-record validation can express.
function runBindingCollectionFixture(entry) {
  const records = entry.files.records.map(readFixtureJson);
  const problems = [];

  for (const record of records) {
    const reasons = checkBindingRecord(record);
    if (reasons.length > 0) problems.push(`record not individually valid: ${reasons.join("; ")}`);
  }

  const activeCountBySession = new Map();
  for (const record of records) {
    if (record.binding_status === "bound") {
      activeCountBySession.set(record.session_id, (activeCountBySession.get(record.session_id) ?? 0) + 1);
    }
  }
  for (const [sessionId, count] of activeCountBySession) {
    if (count > 1) {
      problems.push(
        `multiple_active_bindings_for_session: session_id "${sessionId}" has ${count} binding-records with binding_status=="bound" at once`,
      );
    }
  }

  return { category: problems.length > 0 ? "reject" : "accept", reasons: problems };
}

function runFixture(entry) {
  if (entry.type === "binding-collection") {
    return runBindingCollectionFixture(entry);
  }
  const instance = readFixtureJson(entry.files.record);
  const reasons = entry.type === "binding-record" ? checkBindingRecord(instance) : checkAuditResult(instance);
  return { category: reasons.length > 0 ? "reject" : "accept", reasons };
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

  console.log(`attribution:v1 fixture verification (${manifest.fixtures.length} fixtures)\n`);

  for (const entry of manifest.fixtures) {
    const result = runFixture(entry);

    let ok = result.category === entry.expected;
    if (ok && entry.expected === "reject" && entry.reason_code) {
      const codes = reasonCodesOf(result.reasons);
      ok = codes.includes(entry.reason_code);
    }
    if (ok && entry.all_forbidden_keys_flagged) {
      // sol architect-review should: a single regression fixture proving every one of the 11
      // forbidden personal-dimension keys is individually caught, not just whichever one a
      // fixture happens to pick -- iterates the SAME list the scanner itself uses, so this
      // check always covers however many keys are canonically forbidden, even if that set is
      // ever extended.
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
