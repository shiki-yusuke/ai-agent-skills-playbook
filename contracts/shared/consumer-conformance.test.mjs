// Self-test for consumer-conformance.mjs (node:test, no git, no network).
//   node --test contracts/shared/consumer-conformance.test.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { compareVendored, escapeAnnotation, isSafeRelative, validateConsumersDoc, walkFiles } from "./consumer-conformance.mjs";

const CONSUMERS_JSON = join(dirname(fileURLToPath(import.meta.url)), "..", "consumers.json");
const loadDoc = () => JSON.parse(readFileSync(CONSUMERS_JSON, "utf8"));
// Fixed clock for the mutation tests, taken from the committed register itself: noon UTC of the
// latest pinned_at. A hardcoded date made every pin advance fail this file ("pinned_at is in the
// future", 2026-10-19) until someone also edited the test; the CLI --validate path uses the real
// clock, so staleness is still checked where it matters.
const latestPinnedAt = loadDoc().consumers.map((c) => c.pinned_at).sort().at(-1);
const NOW = new Date(`${latestPinnedAt}T12:00:00Z`);

describe("compareVendored / walkFiles", () => {
  let root;
  let upstream;
  const manifest = [
    { file: "a.json", upstream_file: "contracts/x/v1/a.json" },
    { file: "sub/b.json", upstream_file: "contracts/x/v1/sub/b.json" },
    { file: "LOCAL.md", consumer_only: true },
  ];
  const readUpstream = (f) => upstream.get(f) ?? null;
  const put = (rel, body) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cc-selftest-"));
    upstream = new Map([
      ["contracts/x/v1/a.json", Buffer.from('{"a":1}\n')],
      ["contracts/x/v1/sub/b.json", Buffer.from('{"b":2}\n')],
    ]);
    put("a.json", '{"a":1}\n');
    put("sub/b.json", '{"b":2}\n');
    put("LOCAL.md", "consumer-owned\n");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("baseline: identical tree verifies with no errors", () => {
    assert.deepEqual(compareVendored(root, manifest, readUpstream), { verified: 2, errors: [] });
  });

  test("(a) a 1-byte change is an error", () => {
    put("a.json", '{"a":2}\n');
    const r = compareVendored(root, manifest, readUpstream);
    assert.equal(r.verified, 1);
    assert.match(r.errors.join("\n"), /a\.json differs/);
  });

  test("(b) LF vs CRLF is an error", () => {
    put("sub/b.json", '{"b":2}\r\n');
    const r = compareVendored(root, manifest, readUpstream);
    assert.match(r.errors.join("\n"), /sub\/b\.json differs/);
  });

  test("(c) an unlisted file is an error", () => {
    put("extra.json", "{}\n");
    const r = compareVendored(root, manifest, readUpstream);
    assert.match(r.errors.join("\n"), /not listed in the manifest: extra\.json/);
  });

  test("(d) a manifest row whose file is missing is an error", () => {
    rmSync(join(root, "sub/b.json"));
    const r = compareVendored(root, manifest, readUpstream);
    assert.match(r.errors.join("\n"), /manifest file sub\/b\.json missing/);
  });

  test("upstream file absent at the pin is an error", () => {
    upstream.delete("contracts/x/v1/a.json");
    const r = compareVendored(root, manifest, readUpstream);
    assert.match(r.errors.join("\n"), /contracts\/x\/v1\/a\.json does not exist/);
  });

  test("(e) symlinks make walkFiles throw (file, directory, dangling) and compareVendored report it", () => {
    const outside = mkdtempSync(join(tmpdir(), "cc-selftest-outside-"));
    try {
      writeFileSync(join(outside, "t.json"), "{}\n");
      for (const [name, target] of [
        ["file-link.json", join(outside, "t.json")],
        ["dir-link", outside],
        ["dangling.json", join(outside, "nope.json")],
      ]) {
        symlinkSync(target, join(root, name));
        assert.throws(() => walkFiles(root), /symlink not allowed/);
        const r = compareVendored(root, manifest, readUpstream);
        assert.equal(r.verified, 0);
        assert.match(r.errors.join("\n"), /symlink not allowed/);
        rmSync(join(root, name));
      }
      assert.deepEqual(walkFiles(root), ["LOCAL.md", "a.json", "sub/b.json"]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("(f) consumer_only files are not compared", () => {
    put("LOCAL.md", "anything at all\r\n");
    const calls = [];
    const r = compareVendored(root, manifest, (f) => {
      calls.push(f);
      return readUpstream(f);
    });
    assert.deepEqual(r, { verified: 2, errors: [] });
    assert.deepEqual(calls.sort(), ["contracts/x/v1/a.json", "contracts/x/v1/sub/b.json"]);
  });
});

describe("validateConsumersDoc", () => {
  const consumer = (doc, name) => doc.consumers.find((c) => c.name === name);
  const invalid = (mutate, pattern) => {
    const doc = loadDoc();
    mutate(doc);
    const errors = validateConsumersDoc(doc, { now: NOW });
    assert.ok(errors.length > 0, "expected the document to be invalid");
    if (pattern) assert.match(errors.join("\n"), pattern);
  };

  test("the committed consumers.json is valid", () => {
    assert.deepEqual(validateConsumersDoc(loadDoc(), { now: NOW }), []);
  });

  test("repository outside the allowlist", () => {
    invalid((d) => (consumer(d, "spec-lane").repository = "attacker/spec-lane"), /repository must be shiki-yusuke\/spec-lane/);
  });

  test("consumer name outside the allowlist", () => {
    invalid((d) => (consumer(d, "spec-lane").name = "evil"), /not in the fixed allowlist/);
  });

  test("contracts list differs from the allowlist", () => {
    invalid((d) => consumer(d, "spec-lane").contracts.reverse(), /contracts must be exactly/);
  });

  test("vendored entry missing", () => {
    invalid((d) => consumer(d, "spec-lane").vendored.pop(), /is missing/);
  });

  test("vendored entry added", () => {
    invalid((d) => {
      const c = consumer(d, "agent-metrics-harvester");
      c.vendored.push({ ...structuredClone(c.vendored[0]), consumer_path: "test/other" });
    }, /not in the script allowlist/);
  });

  test("consumer_path swapped", () => {
    invalid((d) => (consumer(d, "agent-metrics-harvester").vendored[0].consumer_path = "test/contract/elsewhere"), /not in the script allowlist/);
  });

  test("every manifest row turned consumer_only", () => {
    invalid((d) => {
      for (const m of consumer(d, "agent-metrics-harvester").vendored[0].manifest) {
        delete m.upstream_file;
        m.consumer_only = true;
      }
    }, /no upstream_file row|consumer_only files/);
  });

  test("one extra consumer_only row", () => {
    invalid((d) => {
      const m = consumer(d, "spec-lane").vendored[0].manifest[0];
      delete m.upstream_file;
      m.consumer_only = true;
    }, /consumer_only files/);
  });

  test("pinned_at in the future", () => {
    const tomorrow = new Date(NOW.getTime() + 24 * 3600 * 1000).toISOString().slice(0, 10);
    invalid((d) => (consumer(d, "spec-lane").pinned_at = tomorrow), /in the future/);
  });

  test("pinned_at that is not a calendar date", () => {
    invalid((d) => (consumer(d, "spec-lane").pinned_at = "2026-99-99"), /not a real calendar date/);
    invalid((d) => (consumer(d, "spec-lane").pinned_at = "2026-02-30"), /not a real calendar date/);
  });

  test("control character in a manifest path", () => {
    invalid((d) => (consumer(d, "spec-lane").vendored[0].manifest[0].file = "fixtures/a\nb.json"), /not a safe relative path/);
  });
});

describe("isSafeRelative", () => {
  test("accepts plain relative paths, rejects traversal / absolute / control characters", () => {
    assert.equal(isSafeRelative("a/b.json"), true);
    for (const p of ["", "/a", "../a", "a/./b", "a//b", "a\\b", "a\u0000b", "a\tb", "a\u007fb"]) assert.equal(isSafeRelative(p), false, JSON.stringify(p));
  });
});

describe("escapeAnnotation", () => {
  test("escapes %, CR and LF so data cannot inject a workflow command", () => {
    assert.equal(escapeAnnotation("50% done\r\n::error::forged"), "50%25 done%0D%0A::error::forged");
    assert.equal(escapeAnnotation("plain"), "plain");
  });
});
