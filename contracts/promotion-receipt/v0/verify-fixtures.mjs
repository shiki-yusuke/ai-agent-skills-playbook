#!/usr/bin/env node
// Verifies contracts/promotion-receipt/v0/fixtures/* against promotion-receipt.schema.json plus
// the semantic MUSTs the schema alone cannot express (docs/protocols/promotion-receipt-v0.md):
//
//   draft_revision 2: every receipt fixture is an evaluation ENVELOPE {context:
//   {expected_promotion_id}, receipt, findings, session_ledger}, checked by evaluateReceipt() in
//   ./evaluate.mjs (independence evaluation against the frozen policy + session ledger; the
//   ledger comes from inlineStubResolver, the fixture-only resolver). `type: "policy"` fixtures
//   are candidate independence policies checked by checkPolicy(); the frozen
//   policy/independence-policy.json itself must pass checkPolicy() or this script fails.
//   checkReceipt() below stays the receipt-only checker evaluateReceipt() calls first.
//
//   verdict derivation (R10 + draft_revision 2): applicable contradicted (>=1) or any declared
//   independence check unsatisfied -> ineligible; else applicable unknown (>=1) or any declared
//   independence check unknown -> abstained; else ready_for_approval. A declared verdict that
//   does not match this derivation is rejected regardless of what the fixture claims.
//   evidence_refs identity: the same {kind, ref, digest} may appear at most once per predicate.
//
//   semantic_digest recomputation (R12): sha256 of the JCS canonical bytes of the receipt with
//   evaluated_at, receipt_id, and semantic_digest itself removed. A mismatch is rejected -- this
//   is the TOCTOU identity the release-approval/v0 composite fixture later compares against.
//
//   personal-dimension scan + numeric-confidence scan, same discipline as every contract in
//   this repo (no open params bag exists in this schema today, but the scan runs regardless so
//   a future field addition cannot silently reintroduce either).
//
//   predicate-set completeness (R21, sol architect must-1): a pre_promotion receipt must carry
//   all six pre_promotion predicate_ids exactly once (no fewer, no duplicates); a post_deploy
//   receipt must carry deployed_artifact_readback exactly once. The three always-on
//   pre_promotion predicates (artifact_identity, review_admissibility, verification_coverage)
//   and post_deploy's own deployed_artifact_readback must be applicability=applicable -- this
//   closes the escape hatch ask-2 flagged: marking every predicate not_applicable used to derive
//   ready_for_approval (deriveVerdict sees zero applicable predicates and defaults favorably).
//
//   resolvable evidence kind (R9, sol architect must-2a, structural half): a satisfied or
//   contradicted predicate must cite at least one evidence_refs entry whose kind is
//   review_finding or release_evidence -- "other" alone is auxiliary information and can never
//   by itself back a satisfied/contradicted status. This is the half of R9 checkable without a
//   ledger: whether the cited evidence ACTUALLY resolves to something real is release-approval/
//   v0's composite fixture's job (it alone carries the referenced records/bundles).
//
//   real-date semantics: the UTC-Z pattern in the schema accepts syntactically well-formed but
//   calendar-nonsensical strings (e.g. "2026-99-99T00:00:00Z", or "2026-02-29T00:00:00Z" /
//   "2026-04-31T00:00:00Z", which Date.parse silently rolls into the next month);
//   isRealUtcTimestamp() rejects every one of them.
//
//   fixture_format_version 2 manifest rows (`type: "envelope"`) may also carry:
//     expected_promotion_id -- the caller-supplied expected id (default: the fixture's own
//       context.expected_promotion_id); lets a fixture's context disagree with the caller.
//     resolver -- "inline" (default: inlineStubResolver), "throw" (a resolver that throws), or
//       "other_ledger" (returns the fixture's top-level session_ledger_from_resolver, which is
//       stripped from the envelope before evaluation).
//
// Zero npm dependencies by design. Usage: node verify-fixtures.mjs (no args, no network).

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createValidator } from "../../shared/schema-validator.mjs";
import { scanPersonalDimensions } from "../../shared/personal-dimensions.mjs";
import { canonicalize, sha256hex } from "../../shared/jcs.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(HERE, "fixtures");
const { validate } = createValidator(HERE);

const read = (f) => JSON.parse(readFileSync(path.join(FIXTURES_DIR, f), "utf-8"));
const dedupe = (a) => [...new Set(a)];

// Broadened (sol architect should-4): matches any key whose lowercased name CONTAINS
// "confidence" (e.g. "confidenceScore", "Confidence_Level"), not only an exact "confidence"
// key -- copied identically into review-findings/v1's and release-approval/v0's own
// verify-fixtures.mjs (contracts/shared cannot be touched, so this lives in all three).
export function scanNumericConfidence(value, pathStr = "") {
  const violations = [];
  if (Array.isArray(value)) {
    value.forEach((item, i) => violations.push(...scanNumericConfidence(item, `${pathStr}[${i}]`)));
    return violations;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, val] of Object.entries(value)) {
      const here = pathStr ? `${pathStr}.${key}` : key;
      if (key.toLowerCase().includes("confidence") && typeof val === "number") violations.push(here);
      violations.push(...scanNumericConfidence(val, here));
    }
  }
  return violations;
}

// R21: closed predicate_id sets per phase, and which of them may never be not_applicable.
export const PRE_PROMOTION_PREDICATE_IDS = Object.freeze([
  "artifact_identity",
  "review_admissibility",
  "verification_coverage",
  "preview_verified",
  "rollback_target_valid",
  "privilege_boundary",
]);
export const POST_DEPLOY_PREDICATE_IDS = Object.freeze(["deployed_artifact_readback"]);
export const ALWAYS_APPLICABLE_PREDICATE_IDS = Object.freeze([
  "artifact_identity",
  "review_admissibility",
  "verification_coverage",
  "deployed_artifact_readback",
]);

export function checkPredicateCompleteness(receipt) {
  const reasons = [];
  const expected = receipt.evaluation_phase === "pre_promotion" ? PRE_PROMOTION_PREDICATE_IDS : POST_DEPLOY_PREDICATE_IDS;
  const ids = receipt.predicates.map((p) => p.predicate_id);
  for (const id of expected) {
    if (!ids.includes(id)) reasons.push(`predicate_missing: receipt "${receipt.receipt_id}" is missing required predicate_id "${id}" for phase "${receipt.evaluation_phase}"`);
  }
  for (const dup of dedupe(ids.filter((id, i) => ids.indexOf(id) !== i))) {
    reasons.push(`predicate_duplicate: predicate_id "${dup}" appears more than once in receipt "${receipt.receipt_id}"`);
  }
  for (const p of receipt.predicates) {
    if (ALWAYS_APPLICABLE_PREDICATE_IDS.includes(p.predicate_id) && p.applicability !== "applicable") {
      reasons.push(`predicate_must_be_applicable: "${p.predicate_id}" is always-on and cannot be not_applicable (receipt "${receipt.receipt_id}")`);
    }
  }
  return dedupe(reasons);
}

// R9 structural half: a satisfied/contradicted predicate needs at least one evidence_refs entry
// of a KIND that can in principle be resolved (review_finding or release_evidence) -- "other" is
// auxiliary-only. Whether that entry ACTUALLY resolves is release-approval/v0's composite job.
export function checkResolvableEvidenceKind(receipt) {
  const reasons = [];
  for (const p of receipt.predicates) {
    if (p.status !== "satisfied" && p.status !== "contradicted") continue;
    const hasResolvableKind = p.evidence_refs.some((r) => r.kind === "review_finding" || r.kind === "release_evidence");
    if (!hasResolvableKind) {
      reasons.push(`no_resolvable_evidence_kind: predicate "${p.predicate_id}" is "${p.status}" but cites no review_finding/release_evidence evidence_ref (an "other"-only ref cannot back this status)`);
    }
  }
  return dedupe(reasons);
}

// Real-calendar UTC timestamp check. Date.parse alone is not enough: V8 rolls day overflow within
// 1..31 into the next month ("2026-02-29T00:00:00Z" and "2026-04-31T00:00:00Z" both parse), so the
// string is split into its fields and the fields Date.UTC() normalizes them to must equal the
// input. Leap seconds (":60") and years 0000-0099 (Date.UTC maps them to 19xx) are rejected.
// Duplicated identically in review-findings/v1, promotion-receipt/v0 and release-approval/v0's
// verify-fixtures.mjs (contracts/shared cannot be touched) -- keep the three bodies identical; the
// promotion-receipt/v0 copy is exported because evaluate.mjs uses it for ledger started_at.
export function isRealUtcTimestamp(s) {
  if (typeof s !== "string") return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?Z$/.exec(s);
  if (!m) return false;
  const [y, mo, d, h, mi, sec] = m.slice(1, 7).map(Number);
  const t = new Date(Date.UTC(y, mo - 1, d, h, mi, sec));
  return (
    t.getUTCFullYear() === y &&
    t.getUTCMonth() === mo - 1 &&
    t.getUTCDate() === d &&
    t.getUTCHours() === h &&
    t.getUTCMinutes() === mi &&
    t.getUTCSeconds() === sec
  );
}

// R12: excludes evaluated_at, receipt_id, semantic_digest from the digested object.
export function computeSemanticDigest(receipt) {
  const { evaluated_at, receipt_id, semantic_digest, ...rest } = receipt;
  return `sha256:${sha256hex(canonicalize(rest))}`;
}

// R10 + draft_revision 2: the verdict a receipt's own predicate vector and its (declared)
// independence checks imply. Independence is a separate vector: it never rewrites a predicate's
// status, it only joins the aggregation (unsatisfied wins over unknown wins over satisfied).
// evaluate.mjs re-derives every check before trusting this aggregation.
export function deriveVerdict(predicates) {
  const applicable = predicates.filter((p) => p.applicability === "applicable");
  const checks = applicable.flatMap((p) => p.evidence_refs.filter((r) => r.independence).map((r) => r.independence.check));
  if (applicable.some((p) => p.status === "contradicted") || checks.includes("unsatisfied")) return "ineligible";
  if (applicable.some((p) => p.status === "unknown") || checks.includes("unknown")) return "abstained";
  return "ready_for_approval";
}

// draft_revision 2: an evidence_ref's identity within a predicate is {kind, ref, digest}; a
// repeat would make "predicate_id x evidence_ref" checks ambiguous.
export function checkEvidenceRefIdentity(receipt) {
  const reasons = [];
  for (const p of receipt.predicates) {
    const keys = p.evidence_refs.map((r) => canonicalize({ kind: r.kind, ref: r.ref, digest: r.digest }));
    if (keys.some((k, i) => keys.indexOf(k) !== i)) {
      reasons.push(`evidence_ref_duplicate: predicate "${p.predicate_id}" cites the same {kind, ref, digest} more than once`);
    }
  }
  return reasons;
}

export function checkReceipt(receipt) {
  const reasons = [];
  reasons.push(...validate("promotion-receipt.schema.json", receipt));
  reasons.push(...scanPersonalDimensions(receipt).map((v) => `personal_dimension_forbidden_key: ${v}`));
  reasons.push(...scanNumericConfidence(receipt).map((v) => `numeric_confidence_forbidden_field: ${v}`));
  if (reasons.length > 0) return dedupe(reasons);

  if (!isRealUtcTimestamp(receipt.evaluated_at)) {
    reasons.push(`invalid_calendar_timestamp: receipt "${receipt.receipt_id}" evaluated_at "${receipt.evaluated_at}" is not a real calendar date/time`);
  }

  reasons.push(...checkPredicateCompleteness(receipt));
  reasons.push(...checkResolvableEvidenceKind(receipt));
  reasons.push(...checkEvidenceRefIdentity(receipt));
  if (reasons.length > 0) return dedupe(reasons);

  const expectedDigest = computeSemanticDigest(receipt);
  if (receipt.semantic_digest !== expectedDigest) {
    reasons.push(
      `semantic_digest_mismatch: receipt "${receipt.receipt_id}" declares ${receipt.semantic_digest}, recomputed ${expectedDigest}`,
    );
  }

  const derived = deriveVerdict(receipt.predicates);
  if (receipt.verdict !== derived) {
    reasons.push(
      `verdict_derivation_mismatch: receipt "${receipt.receipt_id}" declares verdict "${receipt.verdict}" but the predicate vector derives "${derived}"`,
    );
  }

  return dedupe(reasons);
}

// reason_code matching: a machine code (snake_case) must match the reason's leading code exactly
// (`<code>:` or the whole reason), so `promotion_id_mismatch` cannot be satisfied by
// `context_promotion_id_mismatch`; free-text reason codes (legacy, e.g. "not in enum") stay substrings.
function reasonMatches(reason, code) {
  if (/^[a-z][a-z0-9_]*$/.test(code)) {
    // whole-token match: the code may be nested (`outer_code: inner_code: ...`) but may not be a
    // suffix of a longer identifier (`context_promotion_id_mismatch` must not satisfy `promotion_id_mismatch`)
    return reason === code || new RegExp(`(^|[^a-z0-9_])${code}(:|$)`).test(reason);
  }
  return reason.includes(code);
}

function fixtureResolver(entry, data, envelope, inlineStubResolver) {
  switch (entry.resolver ?? "inline") {
    case "inline":
      return inlineStubResolver(envelope);
    case "throw":
      return () => {
        throw new Error("fixture resolver: ledger store unreachable");
      };
    case "other_ledger":
      return () => data.session_ledger_from_resolver;
    default:
      return null;
  }
}

function runFixture(entry, { evaluateReceipt, inlineStubResolver, checkPolicy, frozenPolicy }) {
  const data = read(entry.files);
  let problems;
  if (entry.type === "policy") {
    problems = checkPolicy(data);
  } else if (entry.type === "envelope") {
    const envelope = { ...data };
    if (entry.resolver === "other_ledger") delete envelope.session_ledger_from_resolver;
    const resolveLedger = fixtureResolver(entry, data, envelope, inlineStubResolver);
    problems = resolveLedger
      ? evaluateReceipt(envelope, {
          expectedPromotionId: "expected_promotion_id" in entry ? entry.expected_promotion_id : data?.context?.expected_promotion_id,
          resolveLedger,
          policy: frozenPolicy,
        }).reasons
      : [`unknown fixture resolver "${entry.resolver}"`];
  } else {
    problems = [`unknown fixture type "${entry.type}"`];
  }
  return { category: problems.length ? "reject" : "accept", reasons: problems };
}

async function main() {
  // Dynamic import: evaluate.mjs imports checkReceipt/deriveVerdict from this module.
  const evaluator = await import("./evaluate.mjs");
  const frozenPolicy = evaluator.loadFrozenPolicy();
  const policyProblems = evaluator.checkPolicy(frozenPolicy);
  if (policyProblems.length > 0) {
    console.error(`frozen policy/independence-policy.json is invalid:\n  ${policyProblems.join("\n  ")}`);
    process.exit(1);
  }

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
  console.log(`promotion-receipt:v0 fixture verification (${manifest.fixtures.length} fixtures)\n`);
  console.log(`[PASS] policy/independence-policy.json  (frozen policy, ${evaluator.computePolicyDigest(frozenPolicy)})`);
  for (const entry of manifest.fixtures) {
    const result = runFixture(entry, { ...evaluator, frozenPolicy });
    let ok = result.category === entry.expected;
    if (ok && entry.expected === "reject" && entry.reason_code) {
      ok = result.reasons.some((r) => reasonMatches(r, entry.reason_code));
    }
    const status = ok ? "PASS" : "FAIL";
    if (!ok) failures++;
    console.log(`[${status}] ${entry.files}  (expected=${entry.expected}, got=${result.category})`);
    if (!ok) for (const r of result.reasons) console.log(`        ${r}`);
  }
  console.log(`\n${manifest.fixtures.length - failures}/${manifest.fixtures.length} fixtures behave as declared.`);
  process.exit(failures > 0 ? 1 : 0);
}

function isMainModule() {
  return process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
}

if (isMainModule()) main();
