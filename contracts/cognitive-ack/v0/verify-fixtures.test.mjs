// node --test contracts/cognitive-ack/v0/verify-fixtures.test.mjs
// Negative-side and non-gating evidence for cognitive-ack/v0 (docs/protocols/cognitive-ack-v0.md):
// every reject fixture turns into accept when its single defect is fixed, a 1-byte edit to an
// accept fixture is caught by record_id recomputation, checkAckLedger has no approval-shaped
// output, and the repo guards (authority independence, release-approval schema pin, input
// boundary) exit 1 when violated. Guard tests run against a throwaway copy of the repo tree.

import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { canonicalize, sha256hex } from "../../shared/jcs.mjs";
import {
  checkAckLedger,
  checkRecord,
  checkSchemaAdmitsNoNumbers,
  computeRecordId,
  preflightComposite,
  scanNumbers,
} from "./verify-fixtures.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, "..", "..", "..");
const FIXTURES_DIR = path.join(HERE, "fixtures");
const load = (f) => JSON.parse(readFileSync(path.join(FIXTURES_DIR, f), "utf-8"));
const manifest = load("expected-results.json");

// Recompute a record's id after an edit and carry its ingest entry over to the new id.
function reseal(composite, i) {
  const record = composite.ack_records[i];
  const oldId = record.record_id;
  record.record_id = computeRecordId(record);
  if (composite.ingest[oldId] !== undefined) {
    composite.ingest[record.record_id] = composite.ingest[oldId];
    delete composite.ingest[oldId];
  }
  return composite;
}
const approvalOf = (c, i = 0) => c.approval_events.find((e) => e.event_id === c.ack_records[i].approval_event_id) ?? c.approval_events[0];
const editRecord = (fn) => (c) => {
  fn(c.ack_records[0], c);
  return reseal(c, 0);
};

// One single-defect fix per reject fixture.
const FIXES = {
  "reject-record-id-mismatch.json": (r) => ({ ...r, record_id: computeRecordId(r) }),
  "reject-record-occurred-at-not-real-date.json": (r) => {
    r.occurred_at = "2026-02-28T10:00:00Z";
    return { ...r, record_id: computeRecordId(r) };
  },
  "reject-record-basis-not-self-report.json": (r) => {
    r.basis = "self_report";
    return { ...r, record_id: computeRecordId(r) };
  },
  "reject-composite-forged-principal.json": editRecord((r, c) => (r.principal = { ...approvalOf(c).principal })),
  "reject-composite-ingest-commit-mismatch.json": (c) => {
    c.ingest[c.ack_records[0].record_id].commit_oid = c.ingest[c.ack_records[0].approval_event_id].commit_oid;
    return c;
  },
  "reject-composite-ingest-missing-for-record.json": (c) => {
    c.ingest[c.ack_records[0].record_id] = { ...c.ingest[c.ack_records[0].approval_event_id] };
    return c;
  },
  "reject-composite-ingest-missing-for-approval.json": (c) => {
    c.ingest[c.ack_records[0].approval_event_id] = { ...c.ingest[c.ack_records[0].record_id] };
    return c;
  },
  "reject-composite-ingest-extraneous-entry.json": (c) => {
    delete c.ingest[`sha256:${"9".repeat(64)}`];
    return c;
  },
  "reject-composite-ingest-empty-path.json": (c) => {
    c.ingest[c.ack_records[0].record_id].path = "approvals/ledger/ack.json";
    return c;
  },
  "reject-composite-ack-after-approval.json": editRecord((r, c) => (r.occurred_at = approvalOf(c).occurred_at)),
  "reject-composite-held-on-granted.json": editRecord((r) => (r.self_report = "acknowledged")),
  "reject-composite-held-on-break-glass.json": editRecord((r) => (r.self_report = "acknowledged")),
  "reject-composite-rejected-on-granted.json": editRecord((r) => (r.self_report = "acknowledged")),
  "reject-composite-rejected-on-break-glass.json": editRecord((r) => (r.self_report = "acknowledged")),
  "reject-composite-dangling-approval.json": editRecord((r, c) => (r.approval_event_id = c.approval_events[0].event_id)),
  "reject-composite-two-acks-one-approval.json": (c) => {
    const [second] = c.ack_records.splice(1, 1);
    delete c.ingest[second.record_id];
    return c;
  },
  "reject-composite-duplicate-record-id.json": (c) => {
    c.ack_records.pop();
    return c;
  },
  "reject-composite-duplicate-scope-digest.json": editRecord((r) => (r.scopes[1].scope_digest = "b".repeat(64))),
  "reject-composite-risk-class-reason-mismatch.json": editRecord((r) => (r.scopes[0].risk_reason = "privilege_boundary")),
  "reject-composite-low-without-sampled.json": editRecord((r) => (r.sampled = true)),
  "reject-composite-high-with-sampled.json": editRecord((r) => delete r.sampled),
  "reject-composite-explanation-present-without-id.json": editRecord((r) => (r.scopes[0].explanation_present = false)),
  "reject-composite-explanation-id-without-present.json": editRecord((r) => (r.scopes[0].explanation_present = true)),
  "reject-composite-numeric-value.json": editRecord((r) => delete r.understanding_score),
  "reject-composite-one-bad-among-many.json": (c) => {
    const bad = c.ack_records[1];
    c.ingest[bad.record_id].commit_oid = c.ingest[bad.approval_event_id].commit_oid;
    return c;
  },
};

function verdictOf(entry, data) {
  if (entry.type === "record") return checkRecord(data).length === 0 ? "accept" : "reject";
  assert.deepEqual(preflightComposite(data), [], `${entry.files}: preflight must pass`);
  return checkAckLedger(data).verdict;
}

test("every reject fixture has exactly one fix, and fixing that one defect yields accept", () => {
  const rejects = manifest.fixtures.filter((e) => e.expected === "reject");
  assert.deepEqual(rejects.map((e) => e.files).sort(), Object.keys(FIXES).sort());
  for (const entry of rejects) {
    const data = load(entry.files);
    assert.equal(verdictOf(entry, data), "reject", `${entry.files} must reject as-is`);
    assert.equal(verdictOf(entry, FIXES[entry.files](data)), "accept", `${entry.files} must accept once fixed`);
  }
});

test("a 1-byte edit to an accept fixture is rejected by record_id recomputation", () => {
  const file = "accept-composite-ack-granted-related-scopes.json";
  const text = readFileSync(path.join(FIXTURES_DIR, file), "utf-8");
  const at = text.indexOf('"scope_digest": "') + '"scope_digest": "'.length;
  const flipped = text.slice(0, at) + (text[at] === "a" ? "b" : "a") + text.slice(at + 1);
  const { verdict, problems } = checkAckLedger(JSON.parse(flipped));
  assert.equal(verdict, "reject");
  assert.ok(problems.some((p) => p.startsWith("record_id_mismatch")), problems.join("\n"));
});

test("C1/C7: no ack, or an ack whose scope explanation was removed, is accept", () => {
  const files = manifest.fixtures.map((e) => e.files);
  const c1 = files.filter((f) => f.startsWith("accept-composite-no-ack-"));
  assert.ok(c1.length >= 3, "one no-ack fixture per approval kind present in release-approval/v0's accept composites");
  for (const f of [...c1, "accept-composite-ack-no-explanation.json"]) {
    const data = load(f);
    assert.deepEqual(preflightComposite(data), []);
    assert.equal(checkAckLedger(data).verdict, "accept", f);
  }
  const noExp = load("accept-composite-ack-no-explanation.json").ack_records[0];
  assert.equal(noExp.self_report, "acknowledged");
  assert.ok(noExp.scopes.every((s) => s.explanation_present === false && s.explanation_id === null));
});

test("non-gating: checkAckLedger returns only {verdict, problems}, nothing about the approval", () => {
  for (const entry of manifest.fixtures.filter((e) => e.type === "composite")) {
    const result = checkAckLedger(load(entry.files));
    assert.deepEqual(Object.keys(result).sort(), ["problems", "verdict"], entry.files);
    assert.ok(["accept", "reject"].includes(result.verdict));
    assert.ok(Array.isArray(result.problems) && result.problems.every((p) => typeof p === "string"));
  }
});

test("R4: the schema admits no number/integer and no fixture instance contains a number", () => {
  assert.deepEqual(checkSchemaAdmitsNoNumbers(), []);
  assert.ok(checkSchemaAdmitsNoNumbers({ properties: { x: { type: ["string", "integer"] } } }).length === 1);
  for (const f of readdirSync(FIXTURES_DIR)) {
    const data = load(f);
    const numbers = scanNumbers(data);
    if (f === "reject-composite-numeric-value.json") assert.deepEqual(numbers, ["ack_records[0].understanding_score"]);
    else assert.deepEqual(numbers, [], f);
  }
});

// --- input boundary and approval_unresolvable (not expressible as expected-results fixtures) ---

test("preflight: a 5th composite key or approval_events that differ from approval_source fail", () => {
  const c = load("accept-composite-ack-granted-related-scopes.json");
  assert.ok(preflightComposite({ ...c, approval_verdict: "accept" }).some((p) => p.startsWith("composite_shape")));
  const tampered = structuredClone(c);
  tampered.approval_events[0].expires_at = "2026-08-25T21:10:00Z";
  assert.ok(preflightComposite(tampered).some((p) => p.startsWith("approval_source_mismatch")));
  assert.ok(preflightComposite({ ...c, approval_source: "../v0/fixtures/accept-composite-happy.json" }).some((p) => p.startsWith("approval_source_invalid")));
  assert.ok(preflightComposite({ ...c, approval_source: "accept-composite-does-not-exist.json" }).some((p) => p.startsWith("approval_source_missing")));
});

function unresolvable(mutate) {
  const c = load("accept-composite-ack-granted-related-scopes.json");
  mutate(c);
  const { verdict, problems } = checkAckLedger(c);
  assert.equal(verdict, "reject");
  assert.ok(problems.some((p) => p.startsWith("approval_unresolvable")), problems.join("\n"));
}

test("approval_unresolvable: ack referencing a schema-invalid approval event (event_id recomputed)", () => {
  unresolvable((c) => {
    const ev = c.approval_events[0];
    const oldId = ev.event_id;
    ev.kind = "approval_maybe";
    const { event_id, ...rest } = ev;
    ev.event_id = `sha256:${sha256hex(canonicalize(rest))}`;
    c.ingest[ev.event_id] = c.ingest[oldId];
    delete c.ingest[oldId];
    c.ack_records[0].approval_event_id = ev.event_id;
    reseal(c, 0);
  });
});

test("approval_unresolvable: ack referencing an approval event whose event_id does not recompute", () => {
  unresolvable((c) => (c.approval_events[0].occurred_at = "2026-08-23T21:11:00Z"));
});

test("approval_unresolvable: ack referencing a duplicated event_id", () => {
  unresolvable((c) => c.approval_events.push(structuredClone(c.approval_events[0])));
});

// --- repo guards, exercised on a throwaway copy of the tree ---

function withRepoCopy(mutate) {
  const root = mkdtempSync(path.join(tmpdir(), "cognitive-ack-"));
  try {
    cpSync(path.join(REPO_ROOT, "contracts"), path.join(root, "contracts"), { recursive: true });
    cpSync(path.join(REPO_ROOT, "docs", "protocols"), path.join(root, "docs", "protocols"), { recursive: true });
    mutate(root);
    return spawnSync(process.execPath, [path.join(root, "contracts/cognitive-ack/v0/verify-fixtures.mjs")], { encoding: "utf-8" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("guard baseline: an unmodified copy of the tree exits 0", () => {
  const r = withRepoCopy(() => {});
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /fixtures behave as declared/);
});

test("guard: an authority-contract file mentioning this contract makes the verifier exit 1", () => {
  const r = withRepoCopy((root) => writeFileSync(path.join(root, "contracts/release-approval/probe.md"), "import from cognitive-ack\n"));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /authority_references_cognitive_ack: contracts\/release-approval\/probe\.md/);
});

test("guard: a 1-byte change to release-approval/v0's schema makes the verifier exit 1 (drift)", () => {
  const r = withRepoCopy((root) => {
    const p = path.join(root, "contracts/release-approval/v0/release-approval-event.schema.json");
    const text = readFileSync(p, "utf-8");
    writeFileSync(p, text.replace("DRAFT", "DRAFt"));
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /release_approval_schema_drift/);
});

test("guard: approval_events that drift from approval_source make the harness exit 1 (not a reject)", () => {
  const r = withRepoCopy((root) => {
    const p = path.join(root, "contracts/cognitive-ack/v0/fixtures/accept-composite-ack-break-glass.json");
    const c = JSON.parse(readFileSync(p, "utf-8"));
    c.approval_events[0].occurred_at = "2026-01-01T00:00:00Z";
    writeFileSync(p, JSON.stringify(c, null, 2));
  });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /fixture invalid -- not a verdict[\s\S]*approval_source_mismatch/);
});
