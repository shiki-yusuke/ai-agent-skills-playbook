#!/usr/bin/env node
// Verifies contracts/measure/v1/fixtures/* against measure-output.schema.json, plus semantic
// MUSTs neither schema alone can express (see docs/protocols/measure-v1.md and the schema's own
// description field):
//   - every row's tokens MUST equal priced_tokens + unpriced_tokens
//   - a row's pricing_status MUST be "unpriced" if and only if its unpriced_tokens > 0
//     (agent_cost/aggregate.py's build_rows: unpriced is the worst status and wins outright the
//     moment any one fact in the bucket is unpriced)
//   - a `totals` object (a session's or the top-level `total`'s) MUST equal the recomputed sum
//     of its own `rows`
//   - the top-level `total.totals` MUST equal the sum, across every requested session, of that
//     session's own `totals` (measure's `total` is the union of exactly the requested sessions)
//   - `session_ids` and the keys of `sessions` MUST be the same set
//   - `data_quality.unpriced_tokens` MUST equal the sum of `total.rows[].unpriced_tokens`
//   - a session entry with matched:false MUST have an empty rows array and all-zero totals
//     (sol review must2: "no usage matched" and "usage matched but netted to zero" are
//     different facts, and nothing above compares `matched` against its own siblings)
//   - the top-level total.rows MUST equal the (agent, model, token_kind)-dimensional
//     re-aggregation of every sessions[*].rows, not just a scalar totals sum (sol review must2:
//     two payloads can share identical total.totals scalars while total.rows attributes the
//     same tokens to the wrong agent/model/token_kind bucket -- the totals-sum check above
//     cannot see that, only a per-dimension recomputation can)
//   - the personal-dimension scan (contracts/shared/personal-dimensions.mjs) -- measure/v1
//     carries no per-actor identity at all, so any forbidden key anywhere is a contamination
//
// token_kind is deliberately OPEN (see the schema's own description and
// docs/protocols/measure-v1.md) -- an unrecognized value is logged as a warning below, never
// pushed into `reasons`, so it can never cause a fixture to be rejected (sol review must3).
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

const EPSILON = 1e-9;
function approxEqual(a, b) {
  return Math.abs(a - b) < EPSILON;
}

// Currently-known token_kind values (agent_cost/facts.py's TOKEN_KINDS) -- informational only.
// token_kind is an OPEN string in the schema (sol review must3): an unrecognized value here is
// a console.warn, never a `reasons` push, so it can never flip a fixture's accept/reject call.
const KNOWN_TOKEN_KINDS = new Set([
  "input_nocache",
  "cache_read",
  "cache_write_5m",
  "cache_write_1h",
  "cache_write_unknown",
  "output",
]);

const PRICING_STATUS_RANK = { unpriced: 0, lower_bound: 1, priced: 2 };

// Groups a list of rows by the (agent, model, token_kind) dimensions measure always groups by,
// summing the numeric fields and taking the worst pricing_status per bucket (mirrors
// agent_cost/aggregate.py's build_rows own bucketing/ranking logic) -- used to recompute what
// `total.rows` MUST equal from the union of every session's own rows.
function aggregateRowsByDimension(rows) {
  const buckets = new Map();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const key = JSON.stringify([row.agent, row.model, row.token_kind]);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        agent: row.agent,
        model: row.model,
        token_kind: row.token_kind,
        tokens: 0,
        priced_tokens: 0,
        unpriced_tokens: 0,
        estimated_cost_usd: 0,
        credits: 0,
        pricing_status: "priced",
      };
      buckets.set(key, bucket);
    }
    if (typeof row.tokens === "number") bucket.tokens += row.tokens;
    if (typeof row.priced_tokens === "number") bucket.priced_tokens += row.priced_tokens;
    if (typeof row.unpriced_tokens === "number") bucket.unpriced_tokens += row.unpriced_tokens;
    if (typeof row.estimated_cost_usd === "number") bucket.estimated_cost_usd += row.estimated_cost_usd;
    if (typeof row.credits === "number") bucket.credits += row.credits;
    const rank = PRICING_STATUS_RANK[row.pricing_status];
    if (rank !== undefined && rank < PRICING_STATUS_RANK[bucket.pricing_status]) {
      bucket.pricing_status = row.pricing_status;
    }
  }
  return buckets;
}

function checkTotalRowsMatchDimensionalAggregate(sessions, totalRows, reasons) {
  const allSessionRows = [];
  for (const entry of Object.values(sessions)) {
    if (entry && Array.isArray(entry.rows)) allSessionRows.push(...entry.rows);
  }
  const expected = aggregateRowsByDimension(allSessionRows);
  const actual = aggregateRowsByDimension(Array.isArray(totalRows) ? totalRows : []);

  const allKeys = new Set([...expected.keys(), ...actual.keys()]);
  for (const key of allKeys) {
    const [agent, model, tokenKind] = JSON.parse(key);
    const label = `agent=${agent}, model=${model}, token_kind=${tokenKind}`;
    const exp = expected.get(key);
    const act = actual.get(key);
    if (!exp) {
      reasons.push(
        `total_rows_dimension_mismatch: total.rows has a bucket (${label}) not present in the union of sessions[*].rows`,
      );
      continue;
    }
    if (!act) {
      reasons.push(
        `total_rows_dimension_mismatch: total.rows is missing a bucket (${label}) present in the union of sessions[*].rows`,
      );
      continue;
    }
    for (const field of ["tokens", "priced_tokens", "unpriced_tokens"]) {
      if (exp[field] !== act[field]) {
        reasons.push(
          `total_rows_dimension_mismatch: total.rows (${label}).${field} = ${act[field]}, expected ${exp[field]} (recomputed from the union of sessions[*].rows)`,
        );
      }
    }
    for (const field of ["estimated_cost_usd", "credits"]) {
      if (!approxEqual(exp[field], act[field])) {
        reasons.push(
          `total_rows_dimension_mismatch: total.rows (${label}).${field} = ${act[field]}, expected ${exp[field]} (recomputed from the union of sessions[*].rows)`,
        );
      }
    }
    if (exp.pricing_status !== act.pricing_status) {
      reasons.push(
        `total_rows_dimension_mismatch: total.rows (${label}).pricing_status = "${act.pricing_status}", expected "${exp.pricing_status}"`,
      );
    }
  }
}

// A matched:false session entry MUST have an empty rows array and all-zero totals -- "no usage
// matched" and "usage matched but netted to zero" are different facts (sol review must2).
function checkMatchedFalseIsEmpty(label, entry, reasons) {
  if (entry.matched !== false) return;
  if (Array.isArray(entry.rows) && entry.rows.length > 0) {
    reasons.push(`matched_false_must_have_no_rows: ${label}.matched is false but rows has ${entry.rows.length} entrie(s)`);
  }
  if (entry.totals && typeof entry.totals === "object") {
    for (const key of ["tokens", "priced_tokens", "unpriced_tokens", "estimated_cost_usd", "credits"]) {
      if (typeof entry.totals[key] === "number" && entry.totals[key] !== 0) {
        reasons.push(`matched_false_must_have_zero_totals: ${label}.matched is false but totals.${key} = ${entry.totals[key]}`);
      }
    }
  }
}

// Recomputes a `totals` dict (rows_totals()'s 5 keys) from a list of rows and compares against
// the declared one. `label` becomes part of the emitted reason so a failure names which totals
// object (a specific session's, or the top-level `total`'s) disagreed with its own rows.
function checkTotalsMatchRows(label, rows, totals, reasons) {
  if (!Array.isArray(rows) || !totals || typeof totals !== "object") return;
  const recomputed = { tokens: 0, priced_tokens: 0, unpriced_tokens: 0, estimated_cost_usd: 0, credits: 0 };
  for (const row of rows) {
    if (typeof row.tokens === "number") recomputed.tokens += row.tokens;
    if (typeof row.priced_tokens === "number") recomputed.priced_tokens += row.priced_tokens;
    if (typeof row.unpriced_tokens === "number") recomputed.unpriced_tokens += row.unpriced_tokens;
    if (typeof row.estimated_cost_usd === "number") recomputed.estimated_cost_usd += row.estimated_cost_usd;
    if (typeof row.credits === "number") recomputed.credits += row.credits;
  }
  for (const key of ["tokens", "priced_tokens", "unpriced_tokens"]) {
    if (typeof totals[key] === "number" && totals[key] !== recomputed[key]) {
      reasons.push(
        `totals_sum_mismatch: ${label}.totals.${key}(${totals[key]}) does not equal the sum of ${label}.rows[].${key} (${recomputed[key]})`,
      );
    }
  }
  for (const key of ["estimated_cost_usd", "credits"]) {
    if (typeof totals[key] === "number" && !approxEqual(totals[key], recomputed[key])) {
      reasons.push(
        `totals_sum_mismatch: ${label}.totals.${key}(${totals[key]}) does not equal the sum of ${label}.rows[].${key} (${recomputed[key]})`,
      );
    }
  }
}

function checkRows(label, rows, reasons) {
  if (!Array.isArray(rows)) return;
  rows.forEach((row, i) => {
    if (
      typeof row.tokens === "number" &&
      typeof row.priced_tokens === "number" &&
      typeof row.unpriced_tokens === "number" &&
      row.tokens !== row.priced_tokens + row.unpriced_tokens
    ) {
      reasons.push(
        `row_tokens_sum_mismatch: ${label}.rows[${i}].tokens(${row.tokens}) != priced_tokens(${row.priced_tokens}) + unpriced_tokens(${row.unpriced_tokens})`,
      );
    }
    if (typeof row.unpriced_tokens === "number" && typeof row.pricing_status === "string") {
      const shouldBeUnpriced = row.unpriced_tokens > 0;
      const isUnpriced = row.pricing_status === "unpriced";
      if (shouldBeUnpriced !== isUnpriced) {
        reasons.push(
          `row_pricing_status_inconsistent: ${label}.rows[${i}] has unpriced_tokens=${row.unpriced_tokens} but pricing_status="${row.pricing_status}" (must be "unpriced" if and only if unpriced_tokens > 0)`,
        );
      }
    }
    // token_kind is OPEN (sol review must3) -- an unrecognized value is informational only,
    // never a rejection reason.
    if (typeof row.token_kind === "string" && !KNOWN_TOKEN_KINDS.has(row.token_kind)) {
      console.warn(
        `[warn] ${label}.rows[${i}].token_kind "${row.token_kind}" is not in the currently-known set (${[...KNOWN_TOKEN_KINDS].join(", ")}) -- informational only, not a rejection (agent-cost may add a token_kind additively within measure/v1).`,
      );
    }
  });
}

function checkMeasureOutput(payload) {
  const reasons = [];
  reasons.push(...validate("measure-output.schema.json", payload));
  reasons.push(...scanPersonalDimensions(payload).map((v) => `personal_dimension_forbidden_key: ${v}`));

  const sessions = payload.sessions && typeof payload.sessions === "object" ? payload.sessions : {};
  const sessionIds = Array.isArray(payload.session_ids) ? payload.session_ids : [];

  // session_ids <-> sessions key correspondence (both directions).
  const sessionKeySet = new Set(Object.keys(sessions));
  const sessionIdSet = new Set(sessionIds);
  for (const id of sessionIds) {
    if (!sessionKeySet.has(id)) {
      reasons.push(`session_ids_sessions_key_mismatch: session_ids contains "${id}" but sessions has no matching key`);
    }
  }
  for (const key of sessionKeySet) {
    if (!sessionIdSet.has(key)) {
      reasons.push(`session_ids_sessions_key_mismatch: sessions has key "${key}" not present in session_ids`);
    }
  }

  for (const [sid, entry] of Object.entries(sessions)) {
    if (!entry || typeof entry !== "object") continue;
    const label = `sessions.${sid}`;
    checkRows(label, entry.rows, reasons);
    checkTotalsMatchRows(label, entry.rows, entry.totals, reasons);
    checkMatchedFalseIsEmpty(label, entry, reasons);
  }

  if (payload.total && typeof payload.total === "object") {
    checkRows("total", payload.total.rows, reasons);
    checkTotalsMatchRows("total", payload.total.rows, payload.total.totals, reasons);
    checkTotalRowsMatchDimensionalAggregate(sessions, payload.total.rows, reasons);

    // total.totals MUST equal the sum, across every requested session, of that session's own
    // totals -- measure's `total` is the union of exactly the requested sessions, never a
    // broader report (agent_cost/cli.py builds both from the same `combined_facts`).
    const totalsSum = { tokens: 0, priced_tokens: 0, unpriced_tokens: 0, estimated_cost_usd: 0, credits: 0 };
    for (const entry of Object.values(sessions)) {
      const t = entry && typeof entry === "object" ? entry.totals : undefined;
      if (!t || typeof t !== "object") continue;
      for (const key of Object.keys(totalsSum)) {
        if (typeof t[key] === "number") totalsSum[key] += t[key];
      }
    }
    const declaredTotal = payload.total.totals;
    if (declaredTotal && typeof declaredTotal === "object") {
      for (const key of ["tokens", "priced_tokens", "unpriced_tokens"]) {
        if (typeof declaredTotal[key] === "number" && declaredTotal[key] !== totalsSum[key]) {
          reasons.push(
            `total_totals_not_sum_of_sessions: total.totals.${key}(${declaredTotal[key]}) does not equal the sum across sessions[*].totals.${key} (${totalsSum[key]})`,
          );
        }
      }
      for (const key of ["estimated_cost_usd", "credits"]) {
        if (typeof declaredTotal[key] === "number" && !approxEqual(declaredTotal[key], totalsSum[key])) {
          reasons.push(
            `total_totals_not_sum_of_sessions: total.totals.${key}(${declaredTotal[key]}) does not equal the sum across sessions[*].totals.${key} (${totalsSum[key]})`,
          );
        }
      }
    }

    // data_quality.unpriced_tokens MUST equal the sum of total.rows[].unpriced_tokens.
    if (
      payload.data_quality &&
      typeof payload.data_quality.unpriced_tokens === "number" &&
      Array.isArray(payload.total.rows)
    ) {
      const rowsUnpriced = payload.total.rows.reduce(
        (sum, r) => sum + (typeof r.unpriced_tokens === "number" ? r.unpriced_tokens : 0),
        0,
      );
      if (payload.data_quality.unpriced_tokens !== rowsUnpriced) {
        reasons.push(
          `data_quality_unpriced_tokens_mismatch: data_quality.unpriced_tokens(${payload.data_quality.unpriced_tokens}) does not equal the sum of total.rows[].unpriced_tokens (${rowsUnpriced})`,
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
  const reasons = checkMeasureOutput(instance);
  return { category: reasons.length > 0 ? "reject" : "accept", reasons };
}

function main() {
  const manifest = readFixtureJson("expected-results.json");
  if (!Array.isArray(manifest.fixtures) || manifest.fixtures.length === 0) {
    console.error("expected-results.json declares zero fixtures -- refusing to report success.");
    process.exit(1);
  }
  let failures = 0;

  console.log(`measure:v1 fixture verification (${manifest.fixtures.length} fixtures)\n`);

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
