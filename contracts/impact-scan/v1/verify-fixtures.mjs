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
// Beyond schema validation and fence extraction, this contract has no further semantic
// checks: uniqueItems (no duplicate paths/layers) is schema-enforced, and sort order is
// deliberately NOT required at all (sol architect-review 2nd round must C, main裁定) --
// skills/pre-implementation-impact-scan/SKILL.md's own literal example is not sorted
// ascending, so requiring sort here would contradict the normative spec this schema mirrors.
// A consumer computing a reproducibility digest is responsible for its own sort+dedup before
// hashing; see impact-scan.schema.json's candidate_paths description.
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

// sol architect-review 2nd round must C, main裁定: EXACT info-string match only, per
// skills/pre-implementation-impact-scan/SKILL.md's literal wording ("開始フェンスのinfo
// stringは文字列 impact-scan:v1 そのもの" -- the info string IS the literal tag itself,
// nothing else). The previous round tolerated trailing content after the tag (mirroring a
// leniency spec-lane's OWN consumer happens to have chosen to apply) -- that leniency is
// spec-lane's implementation choice, not something this wire contract itself grants. Only
// trailing whitespace up to the newline is tolerated (that's line-ending normalization, not
// "attribute" content); anything else after the tag (a language hint, a key=value attribute,
// even one extra character) means this fence does NOT count as a valid impact-scan:v1 block.
function extractFencedBlocks(markdown, tag) {
  const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`\`\`\`${escapedTag}[ \\t]*\\r?\\n([\\s\\S]*?)\`\`\``, "g");
  const blocks = [];
  for (const match of markdown.matchAll(pattern)) {
    blocks.push(match[1] ?? "");
  }
  return blocks;
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
