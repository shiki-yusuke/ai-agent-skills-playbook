#!/usr/bin/env node
// Verifies that a cohort.cohort_provenance block (estimate/v2's honest-referent record for its
// three cohort digest fields -- see estimate-decision.schema.json's own description of
// `cohort_provenance` and `$defs/digest_provenance_entry`) actually backs up what it claims,
// the same way contracts/shared/verify-artifact-digests.mjs backs up decision/v1's artifact_ref:
// schema validation alone can only check the SHAPE of each entry (kind is one of three values,
// the field its kind requires is present), never whether an `inline` entry's `object` actually
// hashes to the sibling digest field it is supposed to justify.
//
// What this checks, for each of the three digest fields (routing_policy_digest,
// prompt_policy_digest, execution_profile_digest) on a given cohort:
//
//   1. cohort_provenance has an entry for the field at all -> ERROR if missing. (Normally
//      already caught by schema `required`; re-checked here so this module is also useful
//      standalone against JSON that was never schema-validated, matching
//      verify-artifact-digests.mjs's own stated design.)
//   2. entry.kind == "inline" and no `object` -> ERROR.
//   3. entry.kind == "locator" and no `uri` -> ERROR.
//   4. entry.kind == "unavailable" and no `reason` -> ERROR.
//   5. entry.kind == "inline": sha256(JCS(entry.object)) (contracts/shared/jcs.mjs) is actually
//      recomputed and compared against the sibling cohort digest field's value (stripped of its
//      "sha256:" prefix). A mismatch is an ERROR. This is the one check that needs neither
//      filesystem nor network access, so -- like verify-artifact-digests.mjs's own in-repo
//      byte-for-byte check -- it runs unconditionally in CI, never gated behind a flag.
//   6. entry.kind == "locator" or "unavailable" -> reported as UNVERIFIABLE, always (never
//      silently skipped, never folded into pass/fail): a locator names something CI cannot fetch
//      or re-hash from a JCS-normalized-object digest, and an unavailable entry says outright
//      that nothing can be checked.
//
// Zero npm dependencies by design, same as every verify script in this repo.
//
// Every string in the returned `errors` array is prefixed with a stable reason-code token before
// its first colon (`cohort_provenance_missing_entry`, `cohort_provenance_inline_without_object`,
// `cohort_provenance_locator_without_uri`, `cohort_provenance_unavailable_without_reason`,
// `cohort_provenance_inline_digest_mismatch`) -- callers can push these straight into a reasons
// list that uses this repo's existing `reasonCodesOf` convention (split on the first colon).
//
// Usage as a library:
//   import { verifyCohortProvenance } from "./verify-cohort-provenance.mjs";
//   const { errors, unverifiable, verifiedCount } =
//     verifyCohortProvenance([{ label: "some-fixture.json", cohort: record.cohort }]);
//
// Usage as a CLI (no install step, no network access):
//   node verify-cohort-provenance.mjs <file.json> [<file.json> ...]
// Each file is read as a full estimate/v2 decision record; its top-level `cohort` is checked.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { canonicalize, sha256hex } from "./jcs.mjs";

const DIGEST_FIELDS = ["routing_policy_digest", "prompt_policy_digest", "execution_profile_digest"];
const SHA256_PREFIX_PATTERN = /^sha256:([0-9a-f]{64})$/;

// `records`: an array of { label, cohort } -- `label` is just what this record is called in
// error/unverifiable messages (a fixture filename, a decision_id, whatever the caller has on
// hand). `cohort` is the cohort object itself (not the whole decision record).
export function verifyCohortProvenance(records) {
  const errors = [];
  const unverifiable = [];
  let verifiedCount = 0;

  for (const { label, cohort } of records) {
    if (!cohort || typeof cohort !== "object") continue;
    const provenance = cohort.cohort_provenance;

    for (const field of DIGEST_FIELDS) {
      const where = `${label} cohort.cohort_provenance.${field}`;
      const entry = provenance && typeof provenance === "object" ? provenance[field] : undefined;

      if (!entry || typeof entry !== "object") {
        errors.push(`cohort_provenance_missing_entry: ${where}: no cohort_provenance entry recorded for this digest field`);
        continue;
      }

      if (entry.kind === "inline") {
        if (entry.object === undefined || entry.object === null || typeof entry.object !== "object") {
          errors.push(`cohort_provenance_inline_without_object: ${where}: kind is "inline" but no object is present to recompute a digest from`);
          continue;
        }
        const digestValue = cohort[field];
        const match = typeof digestValue === "string" ? digestValue.match(SHA256_PREFIX_PATTERN) : null;
        if (!match) {
          // The sibling digest field itself is malformed -- schema validation (pattern
          // `^sha256:[0-9a-f]{64}$`) already catches this independently; nothing further for
          // this module to check against.
          continue;
        }
        const expectedHex = match[1];
        const actualHex = sha256hex(canonicalize(entry.object));
        if (actualHex !== expectedHex) {
          errors.push(
            `cohort_provenance_inline_digest_mismatch: ${where}: recomputed sha256(JCS(object)) = ${actualHex}, but ${field} = sha256:${expectedHex}`,
          );
        } else {
          verifiedCount++;
        }
        continue;
      }

      if (entry.kind === "locator") {
        if (typeof entry.uri !== "string" || entry.uri.length === 0) {
          errors.push(`cohort_provenance_locator_without_uri: ${where}: kind is "locator" but no uri is present`);
          continue;
        }
        unverifiable.push(`${where}: kind "locator", uri ${JSON.stringify(entry.uri)}${entry.source_repo ? ` (source_repo ${JSON.stringify(entry.source_repo)})` : ""} -- named but not digest-verifiable by this repo's CI`);
        continue;
      }

      if (entry.kind === "unavailable") {
        if (typeof entry.reason !== "string" || entry.reason.length === 0) {
          errors.push(`cohort_provenance_unavailable_without_reason: ${where}: kind is "unavailable" but no reason is present`);
          continue;
        }
        unverifiable.push(`${where}: kind "unavailable", reason ${JSON.stringify(entry.reason)}`);
        continue;
      }

      // An unrecognized `kind` is already caught by schema validation (`enum`); this module has
      // nothing further to add for it.
    }
  }

  return { errors, unverifiable, verifiedCount };
}

function isMainModule() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}

function runCli() {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error("Usage: node verify-cohort-provenance.mjs <file.json> [<file.json> ...]");
    process.exit(1);
  }

  const records = files.map((f) => {
    const record = JSON.parse(readFileSync(f, "utf-8"));
    return { label: f, cohort: record && record.cohort };
  });
  const { errors, unverifiable, verifiedCount } = verifyCohortProvenance(records);

  console.log(`verify-cohort-provenance: ${files.length} file(s)\n`);
  console.log(`verified:     ${verifiedCount}`);
  console.log(`unverifiable: ${unverifiable.length}`);
  for (const u of unverifiable) console.log(`  - ${u}`);
  console.log(`errors:       ${errors.length}`);
  for (const e of errors) console.log(`  - ${e}`);

  if (errors.length > 0) process.exit(1);
}

if (isMainModule()) {
  runCli();
}
