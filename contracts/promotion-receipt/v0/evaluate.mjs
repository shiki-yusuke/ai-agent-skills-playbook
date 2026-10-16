// promotion-receipt/v0 draft_revision 2: deterministic independence evaluation (B1).
//
// evaluateReceipt(envelope, { expectedPromotionId, resolveLedger, policy }) is the one checker a
// consumer calls with the WHOLE evaluation input -- receipt + the review-findings records it cites
// + the session ledger -- never a bare receipt. checkReceipt() in ./verify-fixtures.mjs remains
// the receipt-only structural/self-consistency checker and is called from here first; it cannot,
// on its own, tell whether a declared independence check is TRUE (that needs the records, the
// ledger, and the frozen policy). docs/protocols/promotion-receipt-v0.md "Independence evaluation"
// is the normative text for every rule below:
//
//   1. envelope.context.expected_promotion_id and receipt.promotion_id must both equal the
//      caller-supplied expectedPromotionId (JCS); the ledger is resolved with
//      resolveLedger(expectedPromotionId, receipt.session_ledger_digest) -- the namespace is the
//      EXPECTED id, never the receipt's own.
//   2. resolver null (unavailable / not found) -> every orchestrator_observed attestation is
//      unknown. A resolver that throws, or returns anything other than null or a plain object,
//      is REJECTED (ledger_resolver_error / ledger_resolver_invalid_response). A resolved ledger that is malformed, schema-invalid, of an unsupported version,
//      whose JCS digest differs from receipt.session_ledger_digest, whose promotion_id differs
//      from the expected one, or that differs from a carried inline copy, is REJECTED (corrupt
//      input, not "unavailable"). The inline copy is never a fallback.
//   3. verified attestation: orchestrator_observed only when the ledger has the entry for the
//      record's exact JCS digest (and that entry agrees on session_ref and independence_code --
//      an entry that disagrees is a corrupt ledger and rejected); self_reported stays
//      self_reported; anything else is unknown.
//   4. observed/required/check are re-derived per (predicate x evidence_ref) and must equal the
//      receipt's declared values exactly.
//   5. check order: unclassified code -> reject; unknown attestation -> unknown; principal code ->
//      unknown; technical code -> satisfied iff {code, attestation} is in the rule's acceptable
//      set, else unsatisfied.
//   6. one verdict derivation (deriveVerdict): unsatisfied / contradicted -> ineligible; else
//      unknown (check or status) -> abstained; else ready_for_approval.
//   7. blockers: applicable predicates whose status is contradicted/unknown or that carry an
//      unsatisfied/unknown independence check.
//
// Zero npm dependencies by design.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createValidator } from "../../shared/schema-validator.mjs";
import { canonicalize, sha256hex } from "../../shared/jcs.mjs";
import { checkRecord } from "../../review-findings/v1/verify-fixtures.mjs";
import { checkReceipt, deriveVerdict, isRealUtcTimestamp } from "./verify-fixtures.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const POLICY_DIR = path.join(HERE, "policy");
const { validate } = createValidator(HERE);
const { validate: validatePolicy } = createValidator(POLICY_DIR);

export const FROZEN_POLICY_PATH = path.join(POLICY_DIR, "independence-policy.json");

// Rule-key manifest: the COMPLETE set of (effective_risk, predicate_id) keys the frozen policy
// must carry -- no more, no fewer. Without it, deleting a rule from the policy file would silently
// mean "no independence requirement" (fail-open). Adding or removing a key is a contract change:
// edit this list AND the policy together, and record both in CHANGELOG.md.
export const INDEPENDENCE_RULE_KEYS = Object.freeze([
  "high|review_admissibility",
  "medium|review_admissibility",
  "low|review_admissibility",
]);

const dedupe = (a) => [...new Set(a)];
export const jcsDigestOf = (obj) => `sha256:${sha256hex(canonicalize(obj))}`;
const sameJcs = (a, b) => canonicalize(a) === canonicalize(b);
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const ruleKey = (risk, predicateId) => `${risk}|${predicateId}`;

export function loadFrozenPolicy() {
  return JSON.parse(readFileSync(FROZEN_POLICY_PATH, "utf-8"));
}

export function computePolicyDigest(policy) {
  return jcsDigestOf(policy);
}

// Schema + the set-semantics the schema cannot express. Returns reasons (empty = valid).
export function checkPolicy(policy) {
  const schemaReasons = validatePolicy("independence-policy.schema.json", policy);
  if (schemaReasons.length > 0) return schemaReasons.map((r) => `policy_schema_invalid: ${r}`);

  const reasons = [];
  const { technical, principal } = policy.code_classes;
  for (const [name, codes] of [["technical", technical], ["principal", principal]]) {
    for (const dup of dedupe(codes.filter((c, i) => codes.indexOf(c) !== i))) {
      reasons.push(`policy_code_duplicate: "${dup}" appears more than once in code_classes.${name}`);
    }
  }
  for (const c of dedupe(technical.filter((c) => principal.includes(c)))) {
    reasons.push(`policy_code_in_both_classes: "${c}" is in both code_classes.technical and code_classes.principal`);
  }

  const keys = policy.rules.map((r) => ruleKey(r.effective_risk, r.predicate_id));
  for (const dup of dedupe(keys.filter((k, i) => keys.indexOf(k) !== i))) {
    reasons.push(`policy_rule_key_duplicate: rule key "${dup}" appears more than once (rules are an exact-key set, never first-match)`);
  }
  for (const k of INDEPENDENCE_RULE_KEYS) {
    if (!keys.includes(k)) reasons.push(`policy_rule_key_missing: manifest key "${k}" has no rule (a dropped rule would silently mean "no requirement")`);
  }
  for (const k of dedupe(keys.filter((k) => !INDEPENDENCE_RULE_KEYS.includes(k)))) {
    reasons.push(`policy_rule_key_not_in_manifest: rule key "${k}" is not in INDEPENDENCE_RULE_KEYS`);
  }

  for (const r of policy.rules) {
    const key = ruleKey(r.effective_risk, r.predicate_id);
    const tuples = r.acceptable.map((a) => canonicalize(a));
    for (const dup of dedupe(tuples.filter((t, i) => tuples.indexOf(t) !== i))) {
      reasons.push(`policy_acceptable_duplicate: rule "${key}" lists ${dup} more than once`);
    }
    for (const a of r.acceptable) {
      if (principal.includes(a.code)) {
        reasons.push(`policy_acceptable_code_principal: rule "${key}" accepts principal-class code "${a.code}", which can never be satisfied in draft_revision 2`);
      } else if (!technical.includes(a.code)) {
        reasons.push(`policy_acceptable_code_unclassified: rule "${key}" accepts code "${a.code}", which is in no code_classes entry`);
      }
    }
  }
  return dedupe(reasons);
}

// Exact-key lookup only: no risk fallback, no ordering between risks, no inheritance.
function ruleFor(policy, effectiveRisk, predicateId) {
  return policy.rules.find((r) => r.effective_risk === effectiveRisk && r.predicate_id === predicateId) ?? null;
}

export function checkSessionLedger(ledger) {
  const reasons = validate("orchestrator-session-ledger.schema.json", ledger);
  if (reasons.length > 0) return reasons;
  const out = [];
  for (const [i, e] of ledger.entries.entries()) {
    if (!isRealUtcTimestamp(e.started_at)) out.push(`invalid_calendar_timestamp: ledger entries[${i}].started_at "${e.started_at}" is not a real calendar date/time`);
  }
  const digests = ledger.entries.map((e) => e.review_record_digest);
  for (const dup of dedupe(digests.filter((d, i) => digests.indexOf(d) !== i))) {
    out.push(`ledger_duplicate_record_digest: review_record_digest ${dup.slice(0, 18)}... has more than one entry (one record, at most one session)`);
  }
  const bySession = new Map();
  for (const e of ledger.entries) {
    const tuple = canonicalize({ started_at: e.started_at, args_digest: e.args_digest });
    if (bySession.has(e.session_id) && bySession.get(e.session_id) !== tuple) {
      out.push(`ledger_ambiguous_session_id: session_id "${e.session_id}" appears with different (started_at, args_digest)`);
    }
    bySession.set(e.session_id, tuple);
  }
  for (let i = 1; i < digests.length; i++) {
    if (!(digests[i - 1] < digests[i])) {
      out.push("ledger_entries_not_sorted: entries must be strictly ascending by review_record_digest (canonical representation)");
      break;
    }
  }
  return dedupe(out);
}

/**
 * FIXTURE-ONLY resolver -- NOT a production path. Returns the envelope's own inline
 * session_ledger when asked for the envelope's context.expected_promotion_id namespace, null
 * otherwise. A production verifier must never ground orchestrator_observed in a ledger the
 * receipt producer carried alongside the receipt; it must inject a resolver that reads the
 * wrapper-only, append-only store keyed by the caller's expected_promotion_id (see
 * docs/protocols/promotion-receipt-v0.md "Trust boundary"). This is the single injection point
 * the conformance fixtures use.
 */
export function inlineStubResolver(envelope) {
  const namespace = envelope?.context?.expected_promotion_id;
  return (expectedPromotionId) => {
    if (!isPlainObject(namespace) || !isPlainObject(expectedPromotionId)) return null;
    return sameJcs(namespace, expectedPromotionId) ? envelope.session_ledger ?? null : null;
  };
}

function checkEnvelopeShape(envelope) {
  if (!isPlainObject(envelope)) return ["envelope_shape: evaluation input must be an object {context, receipt, findings, session_ledger}"];
  const reasons = [];
  const allowed = ["context", "receipt", "findings", "session_ledger"];
  for (const k of Object.keys(envelope)) if (!allowed.includes(k)) reasons.push(`envelope_shape: unexpected key "${k}"`);
  for (const k of allowed) if (!(k in envelope)) reasons.push(`envelope_shape: missing key "${k}"`);
  if (!isPlainObject(envelope.context) || Object.keys(envelope.context).join() !== "expected_promotion_id") {
    reasons.push("envelope_shape: context must be exactly {expected_promotion_id}");
  }
  if (!Array.isArray(envelope.findings)) reasons.push("envelope_shape: findings must be an array of review-findings/v1 records");
  if (envelope.session_ledger !== null && !isPlainObject(envelope.session_ledger)) reasons.push("envelope_shape: session_ledger must be an object or null");
  return reasons;
}

function isPromotionId(v) {
  return (
    isPlainObject(v) &&
    Object.keys(v).sort().join() === "run_attempt,run_id" &&
    typeof v.run_id === "string" &&
    v.run_id.length > 0 &&
    Number.isInteger(v.run_attempt) &&
    v.run_attempt >= 1
  );
}

// Rule 7. Exported so release-approval/v0 can compare break-glass bypass sets against it.
export function deriveBlockers(predicates) {
  return predicates
    .filter((p) => p.applicability === "applicable")
    .filter(
      (p) =>
        p.status === "contradicted" ||
        p.status === "unknown" ||
        p.evidence_refs.some((r) => r.independence && (r.independence.check === "unsatisfied" || r.independence.check === "unknown")),
    )
    .map((p) => p.predicate_id);
}

export function evaluateReceipt(envelope, { expectedPromotionId, resolveLedger, policy = loadFrozenPolicy() } = {}) {
  const reasons = [];
  const fail = () => ({ ok: false, reasons: dedupe(reasons), blockers: [], derivedVerdict: null });

  reasons.push(...checkEnvelopeShape(envelope));
  if (reasons.length > 0) return fail();
  const { receipt, findings } = envelope;

  reasons.push(...checkReceipt(receipt));
  if (reasons.length > 0) return fail();

  reasons.push(...checkPolicy(policy));
  if (reasons.length > 0) return fail();
  const policyDigest = computePolicyDigest(policy);
  if (receipt.independence_policy_digest !== policyDigest) {
    reasons.push(`independence_policy_digest_mismatch: receipt declares ${receipt.independence_policy_digest}, the frozen policy's JCS digest is ${policyDigest}`);
    return fail();
  }

  // Rule 1.
  if (!isPromotionId(expectedPromotionId)) {
    reasons.push("expected_promotion_id_invalid: the caller must supply {run_id, run_attempt} (never read from the receipt)");
    return fail();
  }
  if (!sameJcs(envelope.context.expected_promotion_id, expectedPromotionId)) {
    reasons.push(`context_promotion_id_mismatch: envelope context.expected_promotion_id ${canonicalize(envelope.context.expected_promotion_id)} is not the caller's expected ${canonicalize(expectedPromotionId)}`);
    return fail();
  }
  if (!sameJcs(receipt.promotion_id, expectedPromotionId)) {
    reasons.push(`promotion_id_mismatch: receipt promotion_id ${canonicalize(receipt.promotion_id)} is not the expected ${canonicalize(expectedPromotionId)}`);
    return fail();
  }
  if (typeof resolveLedger !== "function") {
    reasons.push("ledger_resolver_missing: evaluateReceipt needs a resolveLedger(expectedPromotionId, digest) function");
    return fail();
  }

  const findingsById = new Map();
  const ids = findings.map((r) => r?.record_id);
  for (const dup of dedupe(ids.filter((id, i) => ids.indexOf(id) !== i))) {
    reasons.push(`duplicate_record_id: record_id "${dup}" appears more than once in findings (references would depend on input order)`);
  }
  for (const [i, record] of findings.entries()) {
    const r = checkRecord(record);
    if (r.length > 0) reasons.push(`findings[${i}] not individually valid: ${r.join("; ")}`);
    else findingsById.set(record.record_id, record);
  }
  if (reasons.length > 0) return fail();

  // Rule 2.
  const inline = envelope.session_ledger;
  if (inline !== null) {
    for (const r of checkSessionLedger(inline)) reasons.push(`session_ledger_invalid: inline copy: ${r}`);
  }
  if (reasons.length > 0) return fail();
  // Only null means "unavailable". A throwing resolver or any other non-ledger value (undefined,
  // a Promise, an array, a class instance) is a broken adapter, never silently "unknown".
  let resolved;
  try {
    resolved = resolveLedger(expectedPromotionId, receipt.session_ledger_digest);
  } catch (err) {
    reasons.push(`ledger_resolver_error: ${err instanceof Error ? err.message : String(err)}`);
    return fail();
  }
  const isJsonObject = (v) => isPlainObject(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
  if (resolved !== null && !isJsonObject(resolved)) {
    const got = resolved === undefined ? "undefined" : Array.isArray(resolved) ? "an array" : typeof resolved.then === "function" ? "a Promise (the resolver must be synchronous)" : typeof resolved;
    reasons.push(`ledger_resolver_invalid_response: resolver returned ${got}; it must return a ledger object or null`);
    return fail();
  }
  const entriesByDigest = new Map();
  if (resolved !== null) {
    for (const x of checkSessionLedger(resolved)) reasons.push(`session_ledger_invalid: ${x}`);
    if (reasons.length > 0) return fail();
    const resolvedDigest = jcsDigestOf(resolved);
    if (resolvedDigest !== receipt.session_ledger_digest) {
      reasons.push(`session_ledger_digest_mismatch: receipt declares ${receipt.session_ledger_digest}, resolved ledger's JCS digest is ${resolvedDigest}`);
    }
    if (inline !== null && jcsDigestOf(inline) !== resolvedDigest) {
      reasons.push("inline_ledger_copy_mismatch: the carried session_ledger copy differs from the resolver's ledger (the copy is transport only, never authority)");
    }
    if (!sameJcs(resolved.promotion_id, expectedPromotionId)) {
      reasons.push(`session_ledger_promotion_id_mismatch: ledger promotion_id ${canonicalize(resolved.promotion_id)} is not the expected ${canonicalize(expectedPromotionId)}`);
    }
    if (reasons.length > 0) return fail();
    for (const e of resolved.entries) entriesByDigest.set(e.review_record_digest, e);

    // An entry naming one of these records must agree with it -- the record's digest covers its
    // own session_ref and code, so a disagreement can only mean a corrupt ledger.
    for (const record of findingsById.values()) {
      const entry = entriesByDigest.get(jcsDigestOf(record));
      if (!entry) continue;
      const { code, params } = record.assessor.independence;
      if (entry.independence_code !== code) {
        reasons.push(`ledger_entry_code_mismatch: ledger entry for record "${record.record_id}" says independence_code "${entry.independence_code}", the record says "${code}"`);
      }
      if (params.attestation !== "orchestrator_observed") {
        reasons.push(`ledger_entry_attestation_mismatch: ledger has an entry for record "${record.record_id}", whose attestation is "${params.attestation}" (no session_ref to match)`);
        continue;
      }
      for (const f of ["session_id", "started_at", "args_digest"]) {
        if (entry[f] !== params.session_ref[f]) {
          reasons.push(`ledger_entry_session_ref_mismatch: record "${record.record_id}" session_ref.${f} does not match its ledger entry`);
        }
      }
    }
    if (reasons.length > 0) return fail();
  }

  // Rule 3.
  const verifiedAttestation = (record) => {
    const declared = record.assessor.independence.params.attestation;
    if (declared === "self_reported") return "self_reported";
    if (declared === "orchestrator_observed" && entriesByDigest.has(jcsDigestOf(record))) return "orchestrator_observed";
    return "unknown";
  };

  // Rules 4-5.
  const technical = new Set(policy.code_classes.technical);
  const principal = new Set(policy.code_classes.principal);
  for (const p of receipt.predicates) {
    const rule = p.applicability === "applicable" ? ruleFor(policy, receipt.effective_risk, p.predicate_id) : null;
    for (const [i, ref] of p.evidence_refs.entries()) {
      const where = `predicate "${p.predicate_id}" evidence_refs[${i}]`;
      if (!rule) {
        if (ref.independence !== undefined) reasons.push(`independence_not_allowed: ${where} carries independence, but the policy has no rule for (${receipt.effective_risk}, ${p.predicate_id}) or the predicate is not applicable`);
        continue;
      }
      if (ref.independence === undefined) {
        reasons.push(`independence_missing: ${where} has no independence check, but the policy requires one for (${receipt.effective_risk}, ${p.predicate_id})`);
        continue;
      }
      const required = rule.acceptable;
      let observed = null;
      let check = "unknown";
      if (ref.kind === "review_finding") {
        const recordId = ref.ref.split("#")[0];
        const record = findingsById.get(recordId);
        if (!record) {
          reasons.push(`independence_record_missing: ${where} cites record "${recordId}", which is not in findings -- independence cannot be evaluated`);
          continue;
        }
        if (jcsDigestOf(record) !== ref.digest) {
          reasons.push(`independence_record_digest_mismatch: ${where} digest does not match record "${recordId}"'s JCS sha256`);
          continue;
        }
        const code = record.assessor.independence.code;
        if (!technical.has(code) && !principal.has(code)) {
          reasons.push(`independence_code_unclassified: ${where} record "${recordId}" code "${code}" is in no code class of the frozen policy`);
          continue;
        }
        const attestation = verifiedAttestation(record);
        observed = { code, attestation };
        if (attestation === "unknown" || principal.has(code)) check = "unknown";
        else check = required.some((a) => a.code === code && a.attestation === attestation) ? "satisfied" : "unsatisfied";
      }
      if (!sameJcs(ref.independence.required, required)) {
        reasons.push(`independence_required_mismatch: ${where} required is not the policy rule's acceptable set for (${receipt.effective_risk}, ${p.predicate_id})`);
      }
      if (!sameJcs(ref.independence.observed, observed)) {
        reasons.push(`independence_observed_mismatch: ${where} declares observed ${canonicalize(ref.independence.observed)}, derived ${canonicalize(observed)}`);
      }
      if (ref.independence.check !== check) {
        reasons.push(`independence_check_mismatch: ${where} declares check "${ref.independence.check}", derived "${check}"`);
      }
    }
  }
  if (reasons.length > 0) return fail();

  // Rule 6 (declared checks now equal derived ones, so deriveVerdict sees the derived vector).
  const derivedVerdict = deriveVerdict(receipt.predicates);
  if (receipt.verdict !== derivedVerdict) {
    reasons.push(`verdict_derivation_mismatch: receipt declares "${receipt.verdict}", derived "${derivedVerdict}"`);
    return fail();
  }
  return { ok: true, reasons: [], blockers: deriveBlockers(receipt.predicates), derivedVerdict };
}
