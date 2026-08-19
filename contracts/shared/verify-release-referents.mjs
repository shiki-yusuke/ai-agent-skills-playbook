#!/usr/bin/env node
// Verifies that release-observation/v0's two pointer objects (`source_ref`, `artifact_ref`)
// actually resolve to something checkable -- and, opt-in only, that they resolve to the TRUTH,
// not merely to a well-shaped pointer.
//
// This module exists for the same reason contracts/shared/verify-artifact-digests.mjs exists for
// decision/v1's content_digest+uri: a digest with no recorded referent can be neither verified
// NOR falsified by anyone. Before this module, release-observation/v0's `source_tree_digest` and
// `artifact_digest` were exactly that -- a 40/64-hex string and a `sha256:...` string with no repo,
// ref, registry, or distribution recorded beside them. The schema (release-observation-event.schema.json)
// now makes `source_ref` / `artifact_ref` structurally required alongside those digests; this
// module is the independent re-check of that same rule (useful standalone against arbitrary JSON
// that was never run through the schema validator, matching verify-artifact-digests.mjs's own
// stated reason for re-checking uri-required-when-content_digest-present on its own) PLUS the
// actual resolution logic the schema itself cannot express: running `git rev-parse` against a
// local checkout, or comparing against live registry metadata.
//
// STRUCTURAL CHECKS (always run, no network, no local repo access -- what CI runs on every push):
//   - source_tree_digest present -> source_ref present
//   - artifact_digest (a string, not null) present -> artifact_ref present
//   - artifact_ref.registry === "pypi" -> artifact_ref.distribution present
//   - artifact_ref.verifiability === "unverifiable" -> artifact_ref.unverifiable_reason present,
//     non-empty
//   - artifact_ref.registry in {oci, other} -> artifact_ref.verifiability !== "registry_metadata"
// Every one of these is already enforced by the schema's own `required`/`allOf` -- this module's
// own structural pass is deliberately redundant with it, not a replacement for it.
//
// ONLINE CHECKS (opt-in only; never required for CI to pass; never run unless explicitly asked):
//   - source_tree_digest: checked against a LOCAL checkout only, never fetched over the network.
//     Only runs when the caller supplies a local path for that ref's `repo` (via `repoPaths` /
//     `--repo-path <repo>=<path>` / `RELEASE_OBSERVATION_REPO_PATHS` JSON env var below) --
//     `git -C <path> rev-parse <ref>^{tree}` is run and compared byte-for-byte.
//   - artifact_digest: checked against LIVE REGISTRY METADATA, over the network, ONLY for
//     `verifiability: "registry_metadata"` refs -- gated behind `verifyRegistry` /
//     `--verify-registry` / `RELEASE_OBSERVATION_VERIFY_REGISTRY=1`. Today this module only knows
//     how to resolve `registry: "pypi"` this way (PyPI's own JSON API publishes a per-file sha256
//     at `urls[].digests.sha256`, keyed by `urls[].filename` -- confirmed live against both real
//     PyPI fixtures in this directory). `requires_fetch` refs (today: npm, whose registry metadata
//     exposes only sha1/sha512, never sha256) are NEVER fetched by this module, in CI or manually
//     through the default CLI flags -- downloading and hashing an entire published tarball on
//     every run would make this repo's build depend on an external registry's uptime and the
//     tarball's continued availability, and a transient failure there says nothing about whether
//     THIS repo's own contract is correct. The schema itself already forbids `npm`/`oci`/`other`
//     from claiming `verifiability: "registry_metadata"` at all (structural check above), so in
//     practice a `registry_metadata` ref reaching this online step should always be `pypi` --
//     this resolver still guards the case anyway (i.e. anything other than pypi is reported
//     UNVERIFIABLE with an explicit "no resolver implemented" reason, never silently skipped and
//     never treated as a pass), so this module stays correct even when run against raw JSON that
//     was never schema-validated first.
//
// Every record that could not be resolved is counted and listed as UNVERIFIABLE, never silently
// treated as "fine" -- same principle verify-artifact-digests.mjs's own header states: "cannot be
// checked" is not a neutral state, and must never be confused with "checked and correct".
//
// Zero npm dependencies by design, same as every verify-fixtures.mjs / shared module in this repo.
// The online registry check uses the platform's built-in `fetch` (Node >= 18; this repo's CI runs
// Node 22), no HTTP client dependency.
//
// Usage as a library:
//   import { verifyReleaseReferents } from "./verify-release-referents.mjs";
//   const { errors, unverifiable, verified } =
//     await verifyReleaseReferents([{ label, record }], { repoPaths, verifyRegistry });
//
// Usage as a CLI:
//   node verify-release-referents.mjs [--repo-path <repo-id>=<local-path> ...] [--verify-registry] <file.json> [<file.json> ...]
// `--repo-path` may be repeated. Structural checks always run (no flags needed, no network, no
// local repo access). `--verify-registry` is required before ANY network call is made; without
// it, every registry_metadata ref is reported unverifiable rather than silently skipped.

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// Structural checks (no network, no local repo access)
// ---------------------------------------------------------------------------

// Returns an array of error strings, each prefixed with a stable reason-code token before its
// first colon, matching this repo's existing `reasonCodesOf` convention (split on first colon).
export function checkStructural(record) {
  const errors = [];
  if (!record || typeof record !== "object") return errors;

  const hasSourceTreeDigest = typeof record.source_tree_digest === "string";
  const hasSourceRef = record.source_ref !== undefined && record.source_ref !== null;
  if (hasSourceTreeDigest && !hasSourceRef) {
    errors.push(
      "source_tree_digest_without_source_ref: source_tree_digest is present but source_ref is missing -- the digest names no repo/ref and cannot be independently reproduced by anyone.",
    );
  }

  const hasArtifactDigest = typeof record.artifact_digest === "string";
  const hasArtifactRef = record.artifact_ref !== undefined && record.artifact_ref !== null;
  if (hasArtifactDigest && !hasArtifactRef) {
    errors.push(
      "artifact_digest_without_artifact_ref: artifact_digest is a real digest string but artifact_ref is missing -- the digest names no registry/package/file and cannot be independently checked by anyone.",
    );
  }

  if (hasArtifactRef && typeof record.artifact_ref === "object") {
    const ref = record.artifact_ref;
    if (ref.registry === "pypi" && typeof ref.distribution !== "string") {
      errors.push(
        "artifact_ref_pypi_without_distribution: registry is \"pypi\" but distribution is missing -- a PyPI release's wheel and sdist can have different sha256 values under the same package+version, so artifact_digest does not resolve to one file without it.",
      );
    }
    if (ref.verifiability === "unverifiable" && (typeof ref.unverifiable_reason !== "string" || ref.unverifiable_reason.trim().length === 0)) {
      errors.push(
        "artifact_ref_unverifiable_without_reason: verifiability is \"unverifiable\" but unverifiable_reason is missing or empty -- 'nobody has tried yet' and 'cannot be done, and here is why' must never share a spelling.",
      );
    }
    if ((ref.registry === "oci" || ref.registry === "other") && ref.verifiability === "registry_metadata") {
      errors.push(
        `artifact_ref_unsupported_registry_metadata_claim: registry ${JSON.stringify(ref.registry)} claims verifiability "registry_metadata", but neither oci nor other has a repo-characterized metadata shape known to be sha256-comparable without a fetch.`,
      );
    }
    if (ref.registry === "npm" && ref.verifiability === "registry_metadata") {
      errors.push(
        `artifact_ref_npm_registry_metadata_unsupported: registry "npm" claims verifiability "registry_metadata", but npm's own registry metadata exposes only dist.shasum (sha1) and dist.integrity (sha512), never a sha256 -- and artifact_digest is fixed to sha256, so no fetch-free comparison against npm's metadata can honestly be made today (this may be revisited if npm's registry ever starts publishing a per-file sha256).`,
      );
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Online check: source_tree_digest against a local checkout
// ---------------------------------------------------------------------------

// Never touches the network. Only runs `git rev-parse` against a path the caller explicitly
// supplied for this exact repo id -- no repo is ever guessed at or defaulted.
export function resolveSourceRefLocally(record, repoPaths) {
  const ref = record && record.source_ref;
  if (!ref || typeof ref !== "object") return null;
  if (ref.resolution !== "git_tree") {
    return { status: "unverifiable", reason: `resolution ${JSON.stringify(ref.resolution)} is not a resolution kind this module knows how to check` };
  }
  const localPath = repoPaths && repoPaths[ref.repo];
  if (!localPath) {
    return { status: "unverifiable", reason: `no local checkout path given for repo ${JSON.stringify(ref.repo)} (pass --repo-path ${ref.repo}=<path>)` };
  }
  const result = spawnSync("git", ["-C", localPath, "rev-parse", `${ref.ref}^{tree}`], { encoding: "utf-8" });
  if (result.status !== 0) {
    return { status: "error", reason: `git rev-parse ${ref.ref}^{tree} failed in ${localPath}: ${(result.stderr || "").trim()}` };
  }
  const actual = result.stdout.trim();
  const expected = record.source_tree_digest;
  if (actual !== expected) {
    return { status: "error", reason: `source_tree_digest mismatch: record says ${expected}, git -C ${localPath} rev-parse ${ref.ref}^{tree} says ${actual}` };
  }
  return { status: "verified", reason: `git -C ${localPath} rev-parse ${ref.ref}^{tree} === ${expected}` };
}

// ---------------------------------------------------------------------------
// Online check: artifact_digest against live registry metadata (registry_metadata refs only)
// ---------------------------------------------------------------------------

async function resolvePypiRegistryMetadata(record, registryUrl) {
  const ref = record.artifact_ref;
  const base = registryUrl || "https://pypi.org";
  const url = `${base.replace(/\/$/, "")}/pypi/${encodeURIComponent(ref.package)}/${encodeURIComponent(ref.version)}/json`;
  let body;
  try {
    const resp = await fetch(url);
    if (!resp.ok) {
      return { status: "error", reason: `GET ${url} -> HTTP ${resp.status}` };
    }
    body = await resp.json();
  } catch (err) {
    return { status: "error", reason: `GET ${url} failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  const urls = Array.isArray(body.urls) ? body.urls : [];
  const match = urls.find((u) => u.filename === ref.distribution);
  if (!match) {
    return { status: "error", reason: `${url} has no urls[] entry with filename ${JSON.stringify(ref.distribution)}` };
  }
  const registrySha256 = match.digests && match.digests.sha256;
  if (typeof registrySha256 !== "string") {
    return { status: "error", reason: `${url}'s urls[] entry for ${JSON.stringify(ref.distribution)} has no digests.sha256` };
  }
  const expected = `sha256:${registrySha256}`;
  if (expected !== record.artifact_digest) {
    return { status: "error", reason: `artifact_digest mismatch: record says ${record.artifact_digest}, ${url} says ${expected}` };
  }
  return { status: "verified", reason: `${url} urls[].digests.sha256 for ${ref.distribution} === ${registrySha256}` };
}

// Never touches the network unless `verifyRegistry` is true.
export async function resolveArtifactRefOnline(record, verifyRegistry) {
  const ref = record && record.artifact_ref;
  if (!ref || typeof ref !== "object") return null;

  if (ref.verifiability === "unverifiable") {
    return { status: "unverifiable", reason: `verifiability is "unverifiable": ${ref.unverifiable_reason || "(no reason recorded)"}` };
  }
  if (ref.verifiability === "requires_fetch") {
    return {
      status: "unverifiable",
      reason: `verifiability is "requires_fetch" -- this module deliberately never fetches the artifact itself (see this file's own header for why CI must not depend on downloading and hashing a tarball on every run)`,
    };
  }
  // verifiability === "registry_metadata" from here on.
  if (!verifyRegistry) {
    return { status: "unverifiable", reason: `verifiability is "registry_metadata" but online registry verification was not enabled (pass --verify-registry)` };
  }
  if (ref.registry === "pypi") {
    return resolvePypiRegistryMetadata(record, ref.registry_url);
  }
  return {
    status: "unverifiable",
    reason: `verifiability is "registry_metadata" for registry ${JSON.stringify(ref.registry)}, but this module has no resolver implemented for that registry (only pypi today)`,
  };
}

// ---------------------------------------------------------------------------
// Top-level entry point combining structural + (optionally) online checks
// ---------------------------------------------------------------------------

// `records`: array of { label, record }. `repoPaths`: { [repoId]: localPath }, only consulted for
// source_ref resolution -- absent/empty means "no local checkouts available," never an error on
// its own. `verifyRegistry`: boolean, gates ALL network calls at once.
export async function verifyReleaseReferents(records, { repoPaths = {}, verifyRegistry = false } = {}) {
  const errors = [];
  const unverifiable = [];
  const verified = [];

  for (const { label, record } of records) {
    for (const structuralError of checkStructural(record)) {
      errors.push(`${label}: ${structuralError}`);
    }

    const sourceResult = resolveSourceRefLocally(record, repoPaths);
    if (sourceResult) {
      const where = `${label} source_ref (repo=${JSON.stringify(record.source_ref && record.source_ref.repo)}, ref=${JSON.stringify(record.source_ref && record.source_ref.ref)})`;
      if (sourceResult.status === "verified") verified.push(`${where}: ${sourceResult.reason}`);
      else if (sourceResult.status === "unverifiable") unverifiable.push(`${where}: ${sourceResult.reason}`);
      else errors.push(`source_ref_verification_failed: ${where}: ${sourceResult.reason}`);
    }

    const artifactResult = await resolveArtifactRefOnline(record, verifyRegistry);
    if (artifactResult) {
      const where = `${label} artifact_ref (registry=${JSON.stringify(record.artifact_ref && record.artifact_ref.registry)}, package=${JSON.stringify(record.artifact_ref && record.artifact_ref.package)}, version=${JSON.stringify(record.artifact_ref && record.artifact_ref.version)})`;
      if (artifactResult.status === "verified") verified.push(`${where}: ${artifactResult.reason}`);
      else if (artifactResult.status === "unverifiable") unverifiable.push(`${where}: ${artifactResult.reason}`);
      else errors.push(`artifact_ref_verification_failed: ${where}: ${artifactResult.reason}`);
    }
  }

  return { errors, unverifiable, verified };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function isMainModule() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}

function parseRepoPathsFromEnv() {
  const raw = process.env.RELEASE_OBSERVATION_REPO_PATHS;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error(`RELEASE_OBSERVATION_REPO_PATHS is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

async function runCli() {
  const args = process.argv.slice(2);
  const repoPaths = parseRepoPathsFromEnv();
  let verifyRegistry = process.env.RELEASE_OBSERVATION_VERIFY_REGISTRY === "1";
  const files = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--repo-path") {
      const pair = args[++i] || "";
      const eq = pair.indexOf("=");
      if (eq === -1) {
        console.error(`--repo-path expects <repo-id>=<local-path>, got ${JSON.stringify(pair)}`);
        process.exit(1);
      }
      repoPaths[pair.slice(0, eq)] = path.resolve(pair.slice(eq + 1));
    } else if (args[i] === "--verify-registry") {
      verifyRegistry = true;
    } else {
      files.push(args[i]);
    }
  }

  if (files.length === 0) {
    console.error("Usage: node verify-release-referents.mjs [--repo-path <repo-id>=<local-path> ...] [--verify-registry] <file.json> [<file.json> ...]");
    process.exit(1);
  }

  const records = files.map((f) => ({ label: f, record: JSON.parse(readFileSync(f, "utf-8")) }));
  const { errors, unverifiable, verified } = await verifyReleaseReferents(records, { repoPaths, verifyRegistry });

  console.log(`verify-release-referents: ${files.length} file(s)`);
  console.log(`  local repo checkouts supplied: ${Object.keys(repoPaths).length > 0 ? Object.keys(repoPaths).join(", ") : "(none)"}`);
  console.log(`  online registry verification: ${verifyRegistry ? "ENABLED" : "disabled (pass --verify-registry to enable)"}\n`);

  console.log(`verified:     ${verified.length}`);
  for (const v of verified) console.log(`  - ${v}`);
  console.log(`unverifiable: ${unverifiable.length}`);
  for (const u of unverifiable) console.log(`  - ${u}`);
  console.log(`errors:       ${errors.length}`);
  for (const e of errors) console.log(`  - ${e}`);

  if (errors.length > 0) process.exit(1);
}

if (isMainModule()) {
  runCli().catch((err) => {
    console.error(err instanceof Error ? err.stack : String(err));
    process.exit(1);
  });
}
