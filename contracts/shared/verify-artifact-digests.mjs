#!/usr/bin/env node
// Verifies that an $defs/artifact_ref's content_digest actually matches the bytes of the file its
// uri points at -- the check this repo was missing when a real PR's fixtures were found to carry
// formally-valid-but-fabricated content_digest values (sol architect-review must-fix 1): schema
// validation alone can only check the SHAPE `^sha256:[0-9a-f]{64}$`, never whether that hash is
// the truth about any actual file. This module closes that gap for artifact_ref specifically
// (decision/v1's own $defs/decision_ref is a different, non-content-hashed reference type and is
// never scanned here -- see decision.schema.json's own $defs/decision_ref description for why).
//
// What this checks, for every artifact_ref-shaped object found anywhere in a given JSON record
// (detected structurally -- see collectArtifactRefs below -- not via schema awareness, matching
// this repo's existing contracts/shared/personal-dimensions.mjs style):
//
//   1. content_digest present + uri present + uri resolves to a real file INSIDE the given repo
//      root -> the file is actually read and sha256'd; a mismatch is an ERROR.
//   2. content_digest present + uri present + uri resolves inside the repo root but no such file
//      exists there -> ERROR (an internal ref that claims to be checkable but is not is a broken
//      ref, not merely an unverifiable external one).
//   3. content_digest present + (uri absent, OR uri resolves outside the repo root) -> UNVERIFIABLE,
//      not an error and not silently dropped -- null-not-zero (this repo's own recurring
//      principle): "nobody could check this" and "it checked out fine" must never collapse into
//      the same silent non-report. Deliberately independent of what happens to exist on the
//      machine running this script: a uri outside the repo root is unverifiable in CI even if it
//      happens to resolve locally, so the verdict does not depend on the runner's disk layout.
//   4. digest_omitted_reason present -> not subject to digest verification at all, but the reason
//      text itself must be non-empty (defense in depth: the schema's own minLength:1 already
//      guarantees this when going through full schema validation, but this module is also meant
//      to be usable standalone against arbitrary JSON, see CLI below).
//   5. Within one record, the SAME content_digest attached to two DIFFERENT logical_id values is
//      reported as a WARNING (never an error) -- this is legitimate when two refs really do point
//      at the same underlying document (decision/v1's own options_ref/critic_ref consolidation
//      note), but it is also the exact shape a fabricated-by-copy-paste digest takes, so it is
//      always surfaced rather than only detected by accident.
//
// Zero npm dependencies by design, same as every verify-fixtures.mjs in this repo.
//
// Every string in the returned `errors` array is already prefixed with a stable reason-code
// token before its first colon (`artifact_digest_mismatch`, `artifact_ref_uri_missing_file`, or
// `artifact_digest_omitted_reason_empty`) -- callers can push these straight into a reasons list
// that uses this repo's existing `reasonCodesOf` convention (split on the first colon) without
// re-wrapping them in another prefix.
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

    // Check 5: same content_digest, different logical_id, within this one record.
    const entriesByDigest = new Map();
    for (const { path: refPath, ref } of refs) {
      if (typeof ref.content_digest !== "string") continue;
      const list = entriesByDigest.get(ref.content_digest) ?? [];
      list.push({ path: refPath, logical_id: ref.logical_id });
      entriesByDigest.set(ref.content_digest, list);
    }
    for (const [digest, entries] of entriesByDigest) {
      const distinctLogicalIds = new Set(entries.map((e) => e.logical_id));
      if (distinctLogicalIds.size > 1) {
        warnings.push(
          `${label}: content_digest ${digest} is shared by different logical_id values (${[...distinctLogicalIds].join(", ")}) at ${entries.map((e) => e.path).join(", ")} -- legitimate only if these really are the same underlying document.`,
        );
      }
    }

    // Checks 1-4, per ref.
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
        unverifiable.push(`${where}: content_digest ${ref.content_digest} given but no uri -- cannot check`);
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
