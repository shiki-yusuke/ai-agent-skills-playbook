#!/usr/bin/env node
// Self-test for contracts/shared/schema-validator.mjs's `oneOf` support
// (I-2026-08-23-shared-validator-oneof, sol architect review, F lane 3rd round finding).
// Exercises, per that spec's R5:
//   (a) inline schema: exactly-one match / zero-match / two-or-more-match
//   (b) `oneOf` composing with a sibling keyword (`required`) on the same schema object --
//       neither keyword short-circuits the other
//   (c) a `oneOf` branch containing `$ref` (a local `#/$defs/...` pointer)
//   (d) error isolation: a non-matching branch's own error text must never leak into the
//       caller's result -- only the `oneOf` summary line should appear
//   (e) a REAL-SCHEMA regression against release-evidence-bundle.schema.json (the only schema
//       this repo owns that relies on bare `oneOf`, at `lane_ref`/`review`): `lane_ref: 42` and
//       `review: 42` must now be invalid, and an existing accept fixture -- read directly from
//       contracts/release-evidence/v0/fixtures/, never copied here -- must stay valid
//
// Zero npm dependencies by design, same as every verify-fixtures.mjs in this repo.
//
// Usage: node contracts/shared/schema-validator.selftest.mjs (standalone, exit 0 on pass, 1 on
// any failure). Also imported and run by contracts/shared/repo-checks.mjs via runSelfTest().

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createValidator } from "./schema-validator.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function runSelfTest() {
  const results = [];
  function check(name, fn) {
    try {
      const detail = fn();
      results.push({ name, ok: true, detail: detail ?? "" });
    } catch (err) {
      results.push({ name, ok: false, detail: err instanceof Error ? err.message : String(err) });
    }
  }
  function assert(condition, message) {
    if (!condition) throw new Error(message);
  }

  // A throwaway validator instance purely to reach `validateAgainst` -- schemaDir is irrelevant
  // to every case below because none of them load a schema FILE by filename; inline schemas are
  // passed directly to validateAgainst, and $ref (case c) resolves against a local #/$defs/...
  // pointer in the same in-memory document, never a file on disk.
  const { validateAgainst } = createValidator(HERE);

  // ---------------------------------------------------------------------------
  // (a) inline schema: exactly-one / zero-match / two-or-more-match  (TEST-01, TEST-02)
  // ---------------------------------------------------------------------------
  check("(a) exactly-one match is valid", () => {
    const schema = { oneOf: [{ type: "string" }, { type: "number" }] };
    const errors = [];
    validateAgainst(schema, "hello", schema, "$", errors);
    assert(errors.length === 0, `expected no errors, got: ${JSON.stringify(errors)}`);
  });

  check("(a) zero-match is invalid, reports matched 0 (TEST-01)", () => {
    const schema = { oneOf: [{ type: "string" }, { type: "number" }] };
    const errors = [];
    validateAgainst(schema, true, schema, "$", errors);
    assert(errors.length === 1, `expected exactly 1 error, got: ${JSON.stringify(errors)}`);
    assert(errors[0] === "$: oneOf expected exactly one subschema to match, matched 0", `unexpected error text: ${errors[0]}`);
  });

  check("(a) two-or-more-match is invalid, reports matched 2 (TEST-02)", () => {
    // 5 is an integer: satisfies {type:"number"} AND satisfies {minimum:0} (which applies no
    // type constraint of its own) -- both branches trial clean, so this instance matches 2.
    const schema = { oneOf: [{ type: "number" }, { minimum: 0 }] };
    const errors = [];
    validateAgainst(schema, 5, schema, "$", errors);
    assert(errors.length === 1, `expected exactly 1 error, got: ${JSON.stringify(errors)}`);
    assert(errors[0] === "$: oneOf expected exactly one subschema to match, matched 2", `unexpected error text: ${errors[0]}`);
  });

  // ---------------------------------------------------------------------------
  // (b) composes with a sibling keyword, does not short-circuit either direction
  // ---------------------------------------------------------------------------
  check("(b) oneOf composes with a sibling `required` -- both apply, neither short-circuits", () => {
    // Each oneOf branch repeats "required": ["kind"] -- validateAgainst only descends into a
    // `properties` entry when the key is actually present on the instance (see its `if (key in
    // instance)` guard), so a branch with `properties` alone would trivially match an instance
    // missing that key. Requiring "kind" inside every branch, plus at the schema's own top level,
    // is what makes an empty instance fail BOTH the sibling "required" check and every oneOf
    // branch -- demonstrating that neither keyword's evaluation short-circuits the other's.
    const schema = {
      type: "object",
      required: ["kind"],
      oneOf: [
        { required: ["kind"], properties: { kind: { const: "a" } } },
        { required: ["kind"], properties: { kind: { const: "b" } } },
      ],
    };
    const missingKind = [];
    validateAgainst(schema, {}, schema, "$", missingKind);
    assert(
      missingKind.some((e) => e.includes('missing required property "kind"')),
      `expected the sibling "required" error to still fire, got: ${JSON.stringify(missingKind)}`,
    );
    assert(
      missingKind.some((e) => e.includes("oneOf expected exactly one subschema to match, matched 0")),
      `expected oneOf to ALSO fire (neither keyword short-circuits the other), got: ${JSON.stringify(missingKind)}`,
    );

    const validKind = [];
    validateAgainst(schema, { kind: "a" }, schema, "$", validKind);
    assert(validKind.length === 0, `expected a fully valid instance to have zero errors, got: ${JSON.stringify(validKind)}`);
  });

  check("(b) the OTHER compose direction: oneOf matches cleanly, sibling `required` still fails on its own", () => {
    // Complements the case above (which composed a oneOf FAILURE with a sibling failure) by
    // fixing the direction sol architect review round 5 asked for directly: oneOf succeeding
    // (matched exactly 1) must never hide an independent sibling keyword's own failure.
    const schema = {
      type: "object",
      required: ["outer_required_field"],
      oneOf: [{ type: "object" }],
    };
    const errors = [];
    validateAgainst(schema, {}, schema, "$", errors);
    assert(
      errors.some((e) => e.includes('missing required property "outer_required_field"')),
      `expected the sibling "required" failure to surface even though oneOf matched exactly one branch, got: ${JSON.stringify(errors)}`,
    );
    assert(
      !errors.some((e) => e.includes("oneOf expected exactly one")),
      `did not expect a oneOf error here -- exactly one branch (the lone {type:"object"}) matches {}, got: ${JSON.stringify(errors)}`,
    );
  });

  // ---------------------------------------------------------------------------
  // (c) a oneOf branch containing $ref to a local #/$defs/... pointer
  // ---------------------------------------------------------------------------
  check("(c) a oneOf branch's $ref resolves against currentDoc correctly", () => {
    const doc = {
      $defs: { nonEmptyString: { type: "string", minLength: 1 } },
      oneOf: [{ $ref: "#/$defs/nonEmptyString" }, { type: "null" }],
    };
    const okString = [];
    validateAgainst(doc, "hi", doc, "$", okString);
    assert(okString.length === 0, `expected "hi" to match the $ref branch cleanly, got: ${JSON.stringify(okString)}`);

    const okNull = [];
    validateAgainst(doc, null, doc, "$", okNull);
    assert(okNull.length === 0, `expected null to match the null branch cleanly, got: ${JSON.stringify(okNull)}`);

    const badEmpty = [];
    validateAgainst(doc, "", doc, "$", badEmpty);
    assert(badEmpty.length === 1, `expected "" to match neither branch (fails minLength via $ref, fails type null), got: ${JSON.stringify(badEmpty)}`);
    assert(badEmpty[0].includes("matched 0"), `unexpected error text: ${badEmpty[0]}`);
  });

  check("(c) a oneOf branch's EXTERNAL-FILE $ref, whose target itself uses a LOCAL #/$defs/... ref, resolves via the correctly switched currentDoc (real schemas, read-only)", () => {
    // agent-metrics/v1's token-usage.schema.json is a real, existing schema that (a) is reached
    // here via an external-file $ref from a oneOf branch, then (b) itself composes a further
    // external-file $ref (envelope.schema.json) AND resolves its own local #/$defs/tokenUsageData
    // -- exercising the resolveRef() `doc` switch propagating correctly across two levels, not
    // just one. Both schema files and the fixture instance below are read directly from
    // contracts/agent-metrics/v1/ (never copied into this test file).
    const { validate, validateAgainst: va } = createValidator(path.join(HERE, "..", "agent-metrics", "v1"));
    const wrapper = { oneOf: [{ $ref: "token-usage.schema.json" }, { type: "null" }] };
    const fixturePath = path.join(HERE, "..", "agent-metrics", "v1", "fixtures", "valid-minimum.json");
    const instance = JSON.parse(readFileSync(fixturePath, "utf-8"));

    const errors = [];
    va(wrapper, instance, wrapper, "$", errors);
    assert(
      errors.length === 0,
      `expected the real accept fixture to match exactly the token-usage.schema.json branch (proving currentDoc switched correctly through its external+local $ref chain), got: ${JSON.stringify(errors)}`,
    );

    // Sanity: confirm independently (outside the oneOf wrapper) that this fixture is genuinely
    // valid against token-usage.schema.json -- otherwise the assertion above would be
    // vacuously true for the wrong reason (e.g. both branches matching).
    const direct = validate("token-usage.schema.json", instance);
    assert(direct.length === 0, `sanity check failed: fixtures/valid-minimum.json is not directly valid against token-usage.schema.json: ${JSON.stringify(direct)}`);
  });

  // ---------------------------------------------------------------------------
  // (d) error isolation: a non-matching branch's own error text must not leak (TEST-04)
  // ---------------------------------------------------------------------------
  check("(d) non-matching branch errors never leak into the result", () => {
    const schema = { oneOf: [{ type: "string" }, { type: "number" }] };
    const errors = [];
    validateAgainst(schema, true, schema, "$.field", errors);
    assert(errors.length === 1, `expected exactly the oneOf summary line, got: ${JSON.stringify(errors)}`);
    assert(!errors[0].includes("expected type"), `a branch's own "expected type" error leaked into the result: ${errors[0]}`);
  });

  // ---------------------------------------------------------------------------
  // (e) real-schema regression against release-evidence-bundle.schema.json (TEST-03)
  // ---------------------------------------------------------------------------
  check("(e) lane_ref: 42 is invalid against the real release-evidence bundle schema", () => {
    const { validate } = createValidator(path.join(HERE, "..", "release-evidence", "v0"));
    const bundle = { ...minimalValidBundle(), lane_ref: 42 };
    delete bundle.lane_ref_omitted; // lane_ref is no longer null, so _omitted must be absent
    const errors = validate("release-evidence-bundle.schema.json", bundle);
    assert(
      errors.some((e) => e.includes("lane_ref") && e.includes("oneOf")),
      `expected a oneOf error mentioning lane_ref, got: ${JSON.stringify(errors)}`,
    );
  });

  check("(e) review: 42 is invalid against the real release-evidence bundle schema", () => {
    const { validate } = createValidator(path.join(HERE, "..", "release-evidence", "v0"));
    const bundle = { ...minimalValidBundle(), review: 42 };
    delete bundle.review_omitted; // review is no longer null, so _omitted must be absent
    const errors = validate("release-evidence-bundle.schema.json", bundle);
    assert(
      errors.some((e) => e.includes("review") && e.includes("oneOf")),
      `expected a oneOf error mentioning review, got: ${JSON.stringify(errors)}`,
    );
  });

  check("(e) an existing release-evidence/v0 accept fixture stays valid (no regression)", () => {
    const { validate } = createValidator(path.join(HERE, "..", "release-evidence", "v0"));
    const fixturePath = path.join(HERE, "..", "release-evidence", "v0", "fixtures", "accept-bundle-agent-metrics-dashboard.json");
    const bundle = JSON.parse(readFileSync(fixturePath, "utf-8"));
    const errors = validate("release-evidence-bundle.schema.json", bundle);
    assert(errors.length === 0, `expected the existing accept fixture to stay valid, got: ${JSON.stringify(errors)}`);
  });

  return results;
}

// A minimal, schema-shaped release-evidence/v0 bundle used ONLY to isolate the lane_ref/review
// defect in cases (e) above -- this is a fresh object built for this self-test, not a copy of
// any file under contracts/release-evidence/**.
function minimalValidBundle() {
  const hex = (seed, n = 64) => seed.repeat(Math.ceil(n / seed.length)).slice(0, n);
  return {
    schema_version: "release-evidence/v0",
    release_id: "selftest@0.0.0",
    source: { repo: "shiki-yusuke/selftest", commit_sha: hex("a", 40), tree_digest: hex("b", 40), resolution: "git_tree" },
    lane_ref: null,
    lane_ref_omitted: { code: "legacy_release_predates_contract", note: "selftest placeholder" },
    review: null,
    review_omitted: { code: "legacy_release_predates_contract", note: "selftest placeholder" },
    artifacts: [{ kind: "package", digest: `sha256:${hex("c")}`, artifact_ref: { registry: "npm", package: "selftest-pkg", version: "0.0.0", verifiability: "requires_fetch" } }],
    build: { recipe_digest: `sha256:${hex("d")}`, toolchain_digest: `sha256:${hex("e")}` },
    known_deviations: [],
    rollback: { previous_release_id: null },
    integrity: { level: "digest_only", signature: null },
  };
}

function isMainModule() {
  return process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
}

if (isMainModule()) {
  const results = runSelfTest();
  console.log("schema-validator selftest (oneOf)\n");
  let failures = 0;
  for (const r of results) {
    console.log(`[${r.ok ? "PASS" : "FAIL"}] ${r.name}`);
    if (!r.ok) {
      console.log(`        ${r.detail}`);
      failures++;
    }
  }
  console.log(`\n${results.length - failures}/${results.length} selftest cases passed.`);
  process.exit(failures > 0 ? 1 : 0);
}
