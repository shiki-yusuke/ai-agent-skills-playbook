#!/usr/bin/env node
// Verifies that an $defs/artifact_ref's content_digest actually matches the bytes of the file its
// uri points at (sol architect-review must-fix 1): schema validation alone can only check the
// SHAPE `^sha256:[0-9a-f]{64}$`, never whether that hash is the truth about any actual file.
//
// The incident that motivated this module was not invented or false digest values. This repo's
// own fixtures once carried content_digest values with NO uri recorded alongside them. A reviewer
// could not tell which file each hash was about, guessed at a search scope, failed to find a
// match, wrongly concluded the values were false, and overwrote correct data with incorrect data.
// The digests were real the whole time. The lesson is narrower and more useful than "people write
// false hashes": a pointer whose referent is not recorded can be neither verified NOR refuted, and
// "cannot be checked" is not a neutral state -- it invites a confident wrong answer. The prose
// explaining the provenance did exist, in a fixture description and a protocol doc, and was not
// consulted during verification. A machine check reads fields, not paragraphs.
//
// This module closes that gap for artifact_ref specifically
// (decision/v1's own $defs/decision_ref is a different, non-content-hashed reference type and is
// never scanned here -- see decision.schema.json's own $defs/decision_ref description for why).
//
// What this checks, for every artifact_ref-shaped object found anywhere in a given JSON record
// (detected structurally -- see collectArtifactRefs below -- not via schema awareness, matching
// this repo's existing contracts/shared/personal-dimensions.mjs style):
//
//   1. content_digest present + no uri -> ERROR. The schema itself requires uri whenever
//      content_digest is present (added after a real incident: a reviewer, unable to tell what an
//      undocumented digest was FOR, had to brute-force sha256-scan an external repo to guess it --
//      and misattributed one, overwriting a correct value with a wrong one). This module re-checks
//      it independently of schema validation so it still catches the case when used standalone
//      (see CLI below) against JSON that was never schema-validated at all.
//   2. content_digest present + uri present + `source_repo` present -> UNVERIFIABLE, always,
//      regardless of whether `uri` happens to also resolve to something inside this repo root by
//      coincidence -- `source_repo` is a declaration that `uri` is relative to a DIFFERENT repo,
//      so resolving it against THIS repo's root would either find nothing or find the wrong file.
//   3. content_digest present + uri present + no source_repo + uri resolves to a real file INSIDE
//      the given repo root -> the file is actually read and sha256'd; a mismatch is an ERROR.
//   4. content_digest present + uri present + no source_repo + uri resolves inside the repo root
//      but no such file exists there -> ERROR (an internal ref that claims to be checkable but is
//      not is a broken ref, not merely an unverifiable external one).
//   5. content_digest present + uri present + no source_repo + uri resolves OUTSIDE the repo root
//      -> UNVERIFIABLE (a uri that names an external path without declaring `source_repo` is still
//      honestly unverifiable, never silently accepted). Deliberately independent of what happens to
//      exist on the machine running this script: verifiability must not depend on the runner's
//      local disk layout, only on the declared shape of the ref itself.
//   6. digest_omitted_reason present -> not subject to digest verification at all, but the reason
//      text itself must be non-empty (defense in depth: the schema's own minLength:1 already
//      guarantees this when going through full schema validation, but this module is also meant
//      to be usable standalone against arbitrary JSON, see CLI below).
//   7. Within one record, the SAME content_digest attached to two DIFFERENT logical_id values is
//      reported as a WARNING (never an error) -- this is legitimate when two refs really do point
//      at the same underlying document (decision/v1's own options_ref/critic_ref consolidation
//      note), but it is also the shape a digest copy-pasted from a neighbouring field would take,
//      so it is always surfaced rather than only detected by accident.
//   8. Within one record, the SAME logical_id attached to two DIFFERENT content_digest values is
//      an ERROR, not a warning (unlike check 7's reverse direction): two refs claiming to be the
//      SAME logical thing cannot honestly have two different real contents at once -- this is the
//      exact failure mode of treating an identifier as "a field to fill in" rather than a name for
//      a specific real document -- the identifier-side version of the same root cause this module's
//      header describes: a reference whose referent was never pinned down.
//
// Zero npm dependencies by design, same as every verify-fixtures.mjs in this repo.
//
// Every string in the returned `errors` array is already prefixed with a stable reason-code
// token before its first colon (`artifact_digest_mismatch`, `artifact_ref_uri_missing_file`,
// `artifact_digest_omitted_reason_empty`, `artifact_ref_digest_without_uri`, or
// `artifact_ref_logical_id_digest_conflict`) -- callers can push these straight into a reasons
// list that uses this repo's existing `reasonCodesOf` convention (split on the first colon)
// without re-wrapping them in another prefix.
//
// Usage as a library:
//   import { verifyArtifactDigests } from "./verify-artifact-digests.mjs";
//   const { errors, unverifiable, warnings, verifiedCount } =
//     verifyArtifactDigests([{ label: "some-fixture.json", record }], { repoRoot });
//
// Usage as a CLI (no install step, no network access):
//   node verify-artifact-digests.mjs [--root <dir>] <file.json> [<file.json> ...]
// `--root` defaults to this repo's own root (two directories up from contracts/shared/) -- pass
// it explicitly to point at a different tree (e.g. an external repo, for an ad hoc manual check;
// see docs/protocols/decision-v1.md's own Verification section for why the committed fixtures
// intentionally do NOT wire this at anything other than this repo's own root).

import { readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sha256hex } from "./jcs.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.join(HERE, "..", "..");

// Structural detection, not schema-aware: any plain object carrying a string `logical_id` AND
// either a `content_digest` or a `digest_omitted_reason` is treated as an artifact_ref. A
// decision_ref-shaped object (logical_id only, per decision.schema.json's own additionalProperties
// closure) never has either field, so it is never matched here -- this is what keeps this module
// from needing to know which field name in which schema is which $defs type.
export function collectArtifactRefs(value, pathStr = "$", out = []) {
  if (Array.isArray(value)) {
    value.forEach((item, i) => collectArtifactRefs(item, `${pathStr}[${i}]`, out));
    return out;
  }
  if (value !== null && typeof value === "object") {
    const hasLogicalId = typeof value.logical_id === "string";
    const hasDigest = typeof value.content_digest === "string";
    const hasOmittedReason = typeof value.digest_omitted_reason === "string";
    if (hasLogicalId && (hasDigest || hasOmittedReason)) {
      out.push({ path: pathStr, ref: value });
    }
    for (const [key, child] of Object.entries(value)) {
      collectArtifactRefs(child, `${pathStr}.${key}`, out);
    }
  }
  return out;
}

// Resolves a ref's `uri` against `repoRoot`, and reports whether the resolved absolute path is
// actually inside that root. `~/`-prefixed and absolute uris are honored (so a ref can honestly
// name where an external artifact lives) but are only ever treated as "inside the repo" if they
// truly land inside `repoRoot` after resolution -- which an external path, by construction, never
// does. This is intentionally the SAME rule regardless of whether the external path happens to
// exist on this machine: verifiability must not depend on the runner's local disk.
export function resolveUri(uri, repoRoot) {
  let abs;
  if (uri.startsWith("~/") || uri === "~") {
    abs = path.join(os.homedir(), uri.slice(1));
  } else if (path.isAbsolute(uri)) {
    abs = uri;
  } else {
    abs = path.join(repoRoot, uri);
  }
  const relToRoot = path.relative(repoRoot, abs);
  const withinRepo = relToRoot === "" || (!relToRoot.startsWith("..") && !path.isAbsolute(relToRoot));
  return { abs, withinRepo };
}

function sha256OfFile(absPath) {
  return "sha256:" + sha256hex(readFileSync(absPath));
}

// `records`: an array of { label, record } -- `label` is just what this record is called in
// error/warning/unverifiable messages (a fixture filename, a decision_id, whatever the caller has
// on hand). `repoRoot` defaults to this repo's own root.
export function verifyArtifactDigests(records, { repoRoot = DEFAULT_REPO_ROOT } = {}) {
  const errors = [];
  const unverifiable = [];
  const warnings = [];
  let verifiedCount = 0;

  for (const { label, record } of records) {
    const refs = collectArtifactRefs(record);

    // Check 7: same content_digest, different logical_id, within this one record.
    const entriesByDigest = new Map();
    // Check 8: same logical_id, different content_digest, within this one record.
    const entriesByLogicalId = new Map();
    for (const { path: refPath, ref } of refs) {
      if (typeof ref.content_digest !== "string") continue;
      const byDigest = entriesByDigest.get(ref.content_digest) ?? [];
      byDigest.push({ path: refPath, logical_id: ref.logical_id });
      entriesByDigest.set(ref.content_digest, byDigest);

      const byLogicalId = entriesByLogicalId.get(ref.logical_id) ?? [];
      byLogicalId.push({ path: refPath, content_digest: ref.content_digest });
      entriesByLogicalId.set(ref.logical_id, byLogicalId);
    }
    for (const [digest, entries] of entriesByDigest) {
      const distinctLogicalIds = new Set(entries.map((e) => e.logical_id));
      if (distinctLogicalIds.size > 1) {
        warnings.push(
          `${label}: content_digest ${digest} is shared by different logical_id values (${[...distinctLogicalIds].join(", ")}) at ${entries.map((e) => e.path).join(", ")} -- legitimate only if these really are the same underlying document.`,
        );
      }
    }
    for (const [logicalId, entries] of entriesByLogicalId) {
      const distinctDigests = new Set(entries.map((e) => e.content_digest));
      if (distinctDigests.size > 1) {
        errors.push(
          `artifact_ref_logical_id_digest_conflict: ${label}: logical_id ${JSON.stringify(logicalId)} has ${distinctDigests.size} different content_digest values (${entries.map((e) => `${e.path}=${e.content_digest}`).join(", ")}) within the same record -- the same logical_id cannot honestly name two different real contents at once.`,
        );
      }
    }

    // Checks 1-6, per ref.
    for (const { path: refPath, ref } of refs) {
      const where = `${label} ${refPath} (logical_id=${JSON.stringify(ref.logical_id)})`;

      if (typeof ref.digest_omitted_reason === "string") {
        if (ref.digest_omitted_reason.trim().length === 0) {
          errors.push(`artifact_digest_omitted_reason_empty: ${where}: digest_omitted_reason is present but empty`);
        }
        continue;
      }
      if (typeof ref.content_digest !== "string") continue;

      const uri = typeof ref.uri === "string" ? ref.uri : null;
      if (!uri) {
        errors.push(`artifact_ref_digest_without_uri: ${where}: content_digest ${ref.content_digest} given but no uri -- cannot be verified OR falsified by anyone`);
        continue;
      }
      const sourceRepo = typeof ref.source_repo === "string" ? ref.source_repo : null;
      if (sourceRepo) {
        unverifiable.push(
          `${where}: uri ${JSON.stringify(uri)} is relative to source_repo ${JSON.stringify(sourceRepo)}, not this repo -- cannot check`,
        );
        continue;
      }
      const { abs, withinRepo } = resolveUri(uri, repoRoot);
      if (!withinRepo) {
        unverifiable.push(`${where}: uri ${JSON.stringify(uri)} resolves outside repo root (${abs}) -- cannot check`);
        continue;
      }
      if (!existsSync(abs) || !statSync(abs).isFile()) {
        errors.push(
          `artifact_ref_uri_missing_file: ${where}: uri ${JSON.stringify(uri)} resolves inside repo root to ${abs}, but no such file exists`,
        );
        continue;
      }
      const actual = sha256OfFile(abs);
      if (actual !== ref.content_digest) {
        errors.push(
          `artifact_digest_mismatch: ${where}: content_digest ${ref.content_digest} does not match computed ${actual} for ${abs}`,
        );
      } else {
        verifiedCount++;
      }
    }
  }

  return { errors, unverifiable, warnings, verifiedCount };
}

function isMainModule() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}

function runCli() {
  const args = process.argv.slice(2);
  let repoRoot = DEFAULT_REPO_ROOT;
  const files = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--root") {
      repoRoot = path.resolve(args[++i]);
    } else {
      files.push(args[i]);
    }
  }
  if (files.length === 0) {
    console.error("Usage: node verify-artifact-digests.mjs [--root <dir>] <file.json> [<file.json> ...]");
    process.exit(1);
  }

  const records = files.map((f) => ({ label: f, record: JSON.parse(readFileSync(f, "utf-8")) }));
  const { errors, unverifiable, warnings, verifiedCount } = verifyArtifactDigests(records, { repoRoot });

  console.log(`verify-artifact-digests: ${files.length} file(s), repo root = ${repoRoot}\n`);
  console.log(`verified:     ${verifiedCount}`);
  console.log(`unverifiable: ${unverifiable.length}`);
  for (const u of unverifiable) console.log(`  - ${u}`);
  console.log(`warnings:     ${warnings.length}`);
  for (const w of warnings) console.log(`  - ${w}`);
  console.log(`errors:       ${errors.length}`);
  for (const e of errors) console.log(`  - ${e}`);

  if (errors.length > 0) process.exit(1);
}

if (isMainModule()) {
  runCli();
}
