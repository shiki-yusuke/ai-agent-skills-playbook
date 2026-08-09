#!/usr/bin/env node
// Verifies contracts/impact-scan/v1/fixtures/* against impact-scan.schema.json, operating at
// the markdown-report text level (not a bare parsed JSON object) -- each fixture is a .md
// file containing a fenced ```impact-scan:v1 code block, mirroring exactly how a real report
// carries this block and how a real consumer (spec-lane's packages/core/src/impact-scan.ts,
// extractFencedBlocks) extracts it. Extracting at the text level (rather than only validating
// an already-parsed object) is what lets this fixture set actually exercise the "exactly one
// block per report" rule -- zero or two-or-more matching fences is itself a failure mode a
// bare-object fixture can never represent.
//
// Beyond schema validation (relation... no wait, impact-scan has no relation -- beyond the
// closed shape and additionalProperties:false), two semantic checks neither the fence
// extraction nor the schema alone can express (sol architect-review must7): candidate_paths
// and candidate_layers must each be sorted ascending (uniqueItems:true is schema-enforced;
// sortedness across sibling array elements is not).
//
// Zero npm dependencies by design, same as every other contract in this repo: the JSON
// Schema subset validator comes from contracts/shared/.
//
// Usage: node verify-fixtures.mjs   (no arguments, no install step)

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createValidator } from "../../shared/schema-validator.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(HERE, "fixtures");
const { validate } = createValidator(HERE);

const IMPACT_SCAN_FENCE_TAG = "impact-scan:v1";

// Mirrors spec-lane's packages/core/src/impact-scan.ts extractFencedBlocks: matches a fenced
// code block whose info string *starts with* the literal tag "impact-scan:v1", tolerating
// trailing whitespace/attributes after the whole tag token, while (?![\w-]) keeps a longer
// tag like "impact-scan:v10" from being mistaken for this one. A fence tagged something else
// entirely (e.g. "impact-scan:v2") simply never matches -- indistinguishable from a report
// carrying zero v1 blocks, which is the correct outcome (see invalid-wrong-info-string).
function extractFencedBlocks(markdown, tag) {
  const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`\`\`\`${escapedTag}(?![\\w-])[^\\n]*\\r?\\n([\\s\\S]*?)\`\`\``, "g");
  const blocks = [];
  for (const match of markdown.matchAll(pattern)) {
    blocks.push(match[1] ?? "");
  }
  return blocks;
}

function isSortedAscending(arr) {
  for (let i = 1; i < arr.length; i++) {
    if (arr[i - 1] > arr[i]) return false;
  }
  return true;
}

function dedupe(arr) {
  return [...new Set(arr)];
}

// Full check pipeline for one report's raw markdown text: fence extraction, then (if exactly
// one candidate block was found) schema validation + sortedness.
function checkReport(markdown) {
  const blocks = extractFencedBlocks(markdown, IMPACT_SCAN_FENCE_TAG);

  if (blocks.length === 0) {
    return ["no_impact_scan_block_found: no ```impact-scan:v1 fenced block found in the report"];
  }
  if (blocks.length > 1) {
    return [
      `multiple_impact_scan_blocks_found: found ${blocks.length} \`\`\`impact-scan:v1 blocks; exactly one is required`,
    ];
  }

  let instance;
  try {
    instance = JSON.parse(blocks[0]);
  } catch (err) {
    return [`block_not_valid_json: ${err instanceof Error ? err.message : String(err)}`];
  }

  const reasons = [];
  reasons.push(...validate("impact-scan.schema.json", instance));

  if (Array.isArray(instance.candidate_paths) && !isSortedAscending(instance.candidate_paths)) {
    reasons.push("paths_not_sorted: candidate_paths must be sorted ascending (lexicographic)");
  }
  if (Array.isArray(instance.candidate_layers) && !isSortedAscending(instance.candidate_layers)) {
    reasons.push("layers_not_sorted: candidate_layers must be sorted ascending (lexicographic)");
  }

  return dedupe(reasons);
}

function readFixtureText(filename) {
  return readFileSync(path.join(FIXTURES_DIR, filename), "utf-8");
}

function readFixtureJson(filename) {
  return JSON.parse(readFixtureText(filename));
}

function reasonCodesOf(reasons) {
  return reasons.map((r) => r.split(":")[0].trim());
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

  console.log(`impact-scan:v1 fixture verification (${manifest.fixtures.length} fixtures)\n`);

  for (const entry of manifest.fixtures) {
    const markdown = readFixtureText(entry.files.report);
    const reasons = checkReport(markdown);
    const category = reasons.length > 0 ? "reject" : "accept";

    let ok = category === entry.expected;
    if (ok && entry.expected === "reject" && entry.reason_code) {
      ok = reasonCodesOf(reasons).includes(entry.reason_code);
    }

    const status = ok ? "PASS" : "FAIL";
    if (!ok) failures++;
    console.log(`[${status}] ${entry.id}  (expected=${entry.expected}, got=${category})`);
    if (!ok || process.env.VERBOSE) {
      for (const r of reasons) console.log(`         - ${r}`);
    }
  }

  console.log(`\n${manifest.fixtures.length - failures}/${manifest.fixtures.length} fixtures passed.`);
  if (failures > 0) {
    console.error(`\n${failures} fixture(s) FAILED.`);
    process.exit(1);
  }
}

main();
