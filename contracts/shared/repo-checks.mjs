#!/usr/bin/env node
// Repo-wide structural checks that complement (but don't replace) each contract's own
// verify-fixtures.mjs -- run as an extra CI step, in addition to the per-contract loop, not
// instead of it (sol architect-review 2nd round should):
//
//   1. Discovery-count floor: fail if fewer than 5 verify-fixtures.mjs scripts are found under
//      contracts/ (a refactor that accidentally stopped a contract's script from being
//      discovered should fail loudly, not silently run fewer checks than intended).
//   2. Orphan-fixture detection: every actual file in a contract's fixtures/ directory must be
//      referenced by at least one fixture entry's `files` field in that directory's
//      expected-results.json (a fixture created but never wired into the manifest, or left
//      behind after a rename, is dead weight nobody is actually running -- catch it before it
//      accumulates). Scoped to `files` only (sol architect-review 3rd round should) -- an
//      earlier version scanned every field on a fixture entry (id, notes, reason_code, ...),
//      which could accidentally treat an unrelated string coincidentally matching a filename
//      as a "reference," masking a real gap.
//   3. Schema structural check: every *.schema.json file must be valid JSON and declare
//      "$schema": "https://json-schema.org/draft/2020-12/schema". Renamed from "meta-validation"
//      (sol architect-review 3rd round should) -- that name overclaimed: this is JSON.parse
//      plus a string-equality check on one field, not real draft 2020-12 meta-schema
//      validation (this repo's shared validator is a documented subset, not a general
//      implementation, so it cannot check "does every keyword conform to the meta-schema").
//
// Zero npm dependencies by design, same as every verify-fixtures.mjs in this repo.
//
// Usage: node contracts/shared/repo-checks.mjs   (no arguments, no install step)

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, "..", "..");
const CONTRACTS_DIR = path.join(REPO_ROOT, "contracts");
const MIN_VERIFY_SCRIPTS = 5;

let failures = 0;
function fail(msg) {
  console.error(`[FAIL] ${msg}`);
  failures++;
}
function ok(msg) {
  console.log(`[OK] ${msg}`);
}
function rel(p) {
  return path.relative(REPO_ROOT, p);
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const allFiles = walk(CONTRACTS_DIR);

// ---------------------------------------------------------------------------
// 1. Discovery-count floor
// ---------------------------------------------------------------------------
const verifyScripts = allFiles.filter((f) => f.endsWith("verify-fixtures.mjs"));
if (verifyScripts.length < MIN_VERIFY_SCRIPTS) {
  fail(
    `only ${verifyScripts.length} verify-fixtures.mjs script(s) discovered under contracts/, expected >= ${MIN_VERIFY_SCRIPTS}`,
  );
} else {
  ok(`${verifyScripts.length} verify-fixtures.mjs scripts discovered (>= ${MIN_VERIFY_SCRIPTS})`);
}

// ---------------------------------------------------------------------------
// 2. Orphan-fixture detection
// ---------------------------------------------------------------------------
function collectReferencedFilenames(value, out) {
  if (typeof value === "string") {
    out.add(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectReferencedFilenames(v, out);
  } else if (value !== null && typeof value === "object") {
    for (const v of Object.values(value)) collectReferencedFilenames(v, out);
  }
}

const manifestPaths = allFiles.filter((f) => path.basename(f) === "expected-results.json");
for (const manifestPath of manifestPaths) {
  const dir = path.dirname(manifestPath);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));

  const referenced = new Set();
  for (const entry of manifest.fixtures ?? []) {
    collectReferencedFilenames(entry?.files, referenced);
  }

  const actualFiles = readdirSync(dir).filter((f) => f !== "expected-results.json");
  const orphans = actualFiles.filter((f) => !referenced.has(f));
  if (orphans.length > 0) {
    fail(`${rel(dir)}: orphan fixture file(s) not referenced by expected-results.json: ${orphans.join(", ")}`);
  } else {
    ok(`${rel(dir)}: all ${actualFiles.length} fixture file(s) referenced by expected-results.json`);
  }
}

// ---------------------------------------------------------------------------
// 3. Schema structural check
// ---------------------------------------------------------------------------
const schemaFiles = allFiles.filter((f) => f.endsWith(".schema.json"));
for (const schemaFile of schemaFiles) {
  let doc;
  try {
    doc = JSON.parse(readFileSync(schemaFile, "utf-8"));
  } catch (err) {
    fail(`${rel(schemaFile)}: not valid JSON (${err instanceof Error ? err.message : String(err)})`);
    continue;
  }
  if (doc.$schema !== "https://json-schema.org/draft/2020-12/schema") {
    fail(`${rel(schemaFile)}: $schema is not "https://json-schema.org/draft/2020-12/schema" (got ${JSON.stringify(doc.$schema)})`);
  } else {
    ok(`${rel(schemaFile)}: valid JSON, declares draft 2020-12`);
  }
}

console.log(`\n${failures === 0 ? "All repo-checks passed." : `${failures} repo-check(s) FAILED.`}`);
if (failures > 0) process.exit(1);
