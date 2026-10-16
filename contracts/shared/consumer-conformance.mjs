#!/usr/bin/env node
// contracts/shared/consumer-conformance.mjs -- hub-side half of the bidirectional conformance
// check (frozen decision D, 2026-10-16; sol architect review x3, converged).
//
// The hub (this repo) owns the contracts; consumers either read a contracts directory at test
// time ("live") or carry byte-for-byte copies ("vendored"). On every contract PR this script
// re-checks each consumer at the commit pinned in contracts/consumers.json:
//
//   live     -> install the consumer at its pinned commit and run ONLY its contract-dependent
//               tests against THIS checkout's contracts directory. A breaking contract change
//               turns the hub PR red here. `--break-contract` is the negative probe: the same
//               tests are run against a deliberately broken copy of the contract and MUST fail,
//               so the check is known to be live, not vacuously green.
//   gate     -> before anything reads the checkout: HEAD == sha, origin is the allowlisted
//               GitHub repository, and sha is an ancestor of the consumer's default branch HEAD
//               (`git ls-remote origin HEAD` + fetch). A sha reachable only from a PR ref is
//               rejected, because consumers.json is editable from a PR (ancestry gate).
//   vendored -> (i) the consumer's pinned upstream commit is an ancestor of HEAD, (ii) every
//               file under the consumer's vendored path is listed in the manifest and is
//               byte-identical to `git show <pinned_commit>:<upstream_file>` (consumer-only
//               files must merely exist; unlisted files fail), (iii) if THIS PR (base..HEAD)
//               touches the vendored upstream path a ::warning:: is emitted (not a failure:
//               a fixed vendor copy does not consume the PR, which is what makes
//               add -> migrate -> remove possible), (iv) pin drift since the pinned commit is
//               reported as a ::notice::.
//   all      -> deprecation gate: a contract directory that the consumer referenced in the
//               BASE revision's consumers.json must still exist at HEAD (the base-side read is
//               deliberate: dropping the reference and the directory in the same PR must not
//               bypass "migrate the consumer first"). Pin freshness: pinned_at older than
//               PIN_MAX_AGE_DAYS warns; a consumer default branch that moved past `sha` is a
//               notice (reuses the default branch HEAD resolved by the ancestry gate).
//
// Security posture (sol review, round 1 must): consumers.json carries DATA ONLY (shas, dates,
// manifests). Repository names, every command executed and the vendored skeleton (upstream,
// consumer_path, consumer-only files) live in the fixed ALLOWLIST below, so
// a PR that edits consumers.json cannot make CI check out an arbitrary repository or run
// arbitrary commands. Every subprocess has a fixed timeout and is started in its own process
// group so a hang is killed as a group (round 2 must). Only CONSUMER_CONFORMANCE_TIMEOUT_SCALE
// (1..3) is honoured from the environment.
//
// Usage:
//   node contracts/shared/consumer-conformance.mjs --validate
//   node contracts/shared/consumer-conformance.mjs --print-pin --consumer <name>
//   node contracts/shared/consumer-conformance.mjs --consumer <name> --checkout <dir> --gate-only
//   node contracts/shared/consumer-conformance.mjs --consumer <name> --checkout <dir> [--base <sha>] [--break-contract]
//
// Exit codes: 0 all checks passed, 1 at least one check failed, 2 usage / configuration error.
// Node stdlib only (no npm deps, like the rest of contracts/).

import { spawn } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createValidator } from "./schema-validator.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLAYBOOK = resolve(HERE, "..", "..");
const CONTRACTS = join(PLAYBOOK, "contracts");
const CONSUMERS_JSON = join(CONTRACTS, "consumers.json");
const SHA40 = /^[0-9a-f]{40}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CONTRACT_REF = /^(?:[a-z0-9-]+\/v\d+|shared)$/;
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;
const PIN_MAX_AGE_DAYS = 90;
const KILL_GRACE_MS = 5_000;
const CLOSE_GRACE_MS = 10_000;

const scaleRaw = Number(process.env.CONSUMER_CONFORMANCE_TIMEOUT_SCALE ?? "1");
const SCALE = Number.isFinite(scaleRaw) && scaleRaw >= 1 && scaleRaw <= 3 ? scaleRaw : 1;
const TIMEOUT_MS = { git: 60_000 * SCALE, install: 600_000 * SCALE, test: 300_000 * SCALE, network: 60_000 * SCALE };

// Fixed allowlist. `name` and `repository` in consumers.json must match these exactly; the
// install / test command lines are not configurable from data on purpose. `contracts` and the
// vendored skeleton (which upstream directory is copied to which consumer path, and which files
// in that path are consumer-only) are fixed here too: consumers.json may only carry the shas and
// the per-file manifest, so a PR cannot shrink what is compared (e.g. by re-pointing
// consumer_path or flagging every file consumer_only).
export const ALLOWLIST = {
  "release-evidence": {
    repository: "shiki-yusuke/release-evidence",
    kind: "live",
    contracts: ["release-evidence/v0", "shared"],
    vendored: [
      {
        upstream: "contracts/shared",
        consumer_path: "vendor/playbook-shared",
        consumer_only: ["VENDORED.md", "jcs.d.mts", "personal-dimensions.d.mts", "schema-validator.d.mts"],
      },
    ],
    contractsSubdir: "release-evidence/v0",
    probeSchema: "release-evidence-bundle.schema.json",
    envVar: "RELEASE_EVIDENCE_CONTRACTS_DIR",
    install: ["pnpm", ["install", "--frozen-lockfile", "--ignore-scripts"]],
    // Only the contract-dependent files (those that read RELEASE_EVIDENCE_CONTRACTS_DIR via
    // test/helpers.ts). The consumer's unrelated tests must not be able to turn a hub PR red.
    test: [
      "pnpm",
      [
        "exec",
        "vitest",
        "run",
        "test/conformance.test.ts",
        "test/bundle.test.ts",
        "test/ledger-concurrency.test.ts",
        "test/cli.test.ts",
        "test/ledger.test.ts",
        "test/shadow-conformance.test.ts",
        "test/shadow-replay-pack.test.ts",
      ],
    ],
  },
  "spec-lane": {
    repository: "shiki-yusuke/spec-lane",
    kind: "vendored",
    contracts: ["measure/v1", "design-options/v1", "shared"],
    vendored: [
      { upstream: "contracts/measure/v1", consumer_path: "packages/adapters/test/fixtures/measure/v1", consumer_only: [] },
      { upstream: "contracts/design-options/v1", consumer_path: "packages/schemas/test/fixtures/design-options/v1", consumer_only: [] },
      { upstream: "contracts/shared", consumer_path: "packages/core/src/vendor/derive-independence/v1", consumer_only: ["derive-independence.d.mts"] },
    ],
  },
  "agent-metrics-harvester": {
    repository: "shiki-yusuke/agent-metrics-harvester",
    kind: "vendored",
    contracts: ["agent-metrics/v1"],
    vendored: [{ upstream: "contracts/agent-metrics/v1", consumer_path: "test/contract/vendor", consumer_only: ["UPSTREAM.md"] }],
  },
};

// GitHub workflow commands end at a newline and treat `%` as an escape; data echoed into an
// annotation (paths, git stderr) must not be able to forge a second command.
export function escapeAnnotation(msg) {
  return String(msg).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

let failures = 0;
const fail = (msg) => {
  failures += 1;
  console.log(`::error::${escapeAnnotation(msg)}`);
};
const warn = (msg) => console.log(`::warning::${escapeAnnotation(msg)}`);
const notice = (msg) => console.log(`::notice::${escapeAnnotation(msg)}`);
const ok = (msg) => console.log(`ok: ${msg}`);

// ---------------------------------------------------------------------------------------------
// subprocess with a hard timeout and process-group kill
function runStep(name, cmd, args, { cwd, env, timeoutMs, capture = false } = {}) {
  return new Promise((resolveStep) => {
    const detached = process.platform !== "win32";
    const out = [];
    const err = [];
    let settled = false;
    let timedOut = false;
    let timer;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveStep({ stdout: Buffer.concat(out), spawnError: false, signal: null, ...result, timedOut });
    };
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...(env ?? {}) },
      stdio: capture ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"],
      detached,
    });
    if (capture) {
      child.stdout.on("data", (b) => out.push(b));
      child.stderr.on("data", (b) => err.push(b));
    }
    const killGroup = (signal) => {
      try {
        if (detached) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        /* already gone */
      }
    };
    timer = setTimeout(() => {
      timedOut = true;
      console.log(`::error::${escapeAnnotation(`timeout step=${name} after ${Math.round(timeoutMs / 1000)}s -- killing process group`)}`);
      killGroup("SIGTERM");
      setTimeout(() => {
        killGroup("SIGKILL");
        // A grandchild holding the stdio pipes can keep `close` from ever firing; do not wait on it.
        setTimeout(() => settle({ code: 124, stderr: Buffer.concat(err).toString("utf8") }), CLOSE_GRACE_MS).unref();
      }, KILL_GRACE_MS).unref();
    }, timeoutMs);
    child.on("error", (e) => settle({ code: 127, spawnError: true, stderr: `${e.message}` }));
    child.on("close", (code, signal) =>
      settle({
        code: timedOut ? 124 : code ?? (signal ? 128 : 1),
        signal: signal ?? null,
        stderr: Buffer.concat(err).toString("utf8"),
      }),
    );
  });
}

async function git(args, { cwd = PLAYBOOK, timeoutMs = TIMEOUT_MS.git } = {}) {
  return runStep(`git ${args[0]}`, "git", args, { cwd, timeoutMs, capture: true });
}

// One-line reason for a failed step, distinguishing "could not run" from "ran and said no".
function why(r) {
  if (r.spawnError) return `could not start (${r.stderr.trim()})`;
  if (r.timedOut) return "timed out";
  const detail = r.stderr ? r.stderr.trim().split("\n")[0] : "";
  return `exit ${r.code}${detail ? `: ${detail}` : ""}`;
}

// ---------------------------------------------------------------------------------------------
// consumers.json: schema (types) + structural rules the shared validator does not express
function loadConsumers() {
  let doc;
  try {
    doc = JSON.parse(readFileSync(CONSUMERS_JSON, "utf8"));
  } catch (e) {
    throw new UsageError(`contracts/consumers.json: ${e instanceof Error ? e.message : String(e)}`);
  }
  const errors = validateConsumersDoc(doc);
  if (errors.length > 0) throw new UsageError(`contracts/consumers.json invalid:\n  - ${errors.join("\n  - ")}`);
  return doc;
}

export function validateConsumersDoc(doc, { now = new Date() } = {}) {
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return ["document must be a JSON object"];
  const { validate } = createValidator(CONTRACTS);
  const errors = validate("consumers.schema.json", doc).map((e) => (typeof e === "string" ? e : JSON.stringify(e)));
  const today = now.toISOString().slice(0, 10);
  const seen = new Set();
  for (const c of Array.isArray(doc.consumers) ? doc.consumers : []) {
    if (c === null || typeof c !== "object") continue; // reported by the schema
    const where = `consumer ${JSON.stringify(c.name)}`;
    const allowed = Object.hasOwn(ALLOWLIST, c.name) ? ALLOWLIST[c.name] : undefined;
    if (!allowed) errors.push(`${where}: not in the fixed allowlist (${Object.keys(ALLOWLIST).join(", ")})`);
    else if (c.repository !== allowed.repository) errors.push(`${where}: repository must be ${allowed.repository}`);
    if (seen.has(c.name)) errors.push(`${where}: listed twice`);
    seen.add(c.name);
    if (!SHA40.test(c.sha ?? "")) errors.push(`${where}: sha must be 40 lowercase hex`);
    const pinErr = pinnedAtError(c.pinned_at, today);
    if (pinErr) errors.push(`${where}: ${pinErr}`);
    for (const ref of Array.isArray(c.contracts) ? c.contracts : []) {
      if (!CONTRACT_REF.test(ref)) errors.push(`${where}: contracts entry ${JSON.stringify(ref)} is not <name>/vN or shared`);
    }
    if (allowed && JSON.stringify(c.contracts) !== JSON.stringify(allowed.contracts)) {
      errors.push(`${where}: contracts must be exactly ${JSON.stringify(allowed.contracts)} (fixed in the script allowlist)`);
    }
    const vendored = Array.isArray(c.vendored) ? c.vendored : [];
    const keyOf = (v) => `${v.upstream} -> ${v.consumer_path}`;
    if (allowed) {
      const want = new Map(allowed.vendored.map((v) => [keyOf(v), v]));
      const got = new Set();
      for (const v of vendored) {
        const k = keyOf(v);
        if (!want.has(k)) errors.push(`${where}: vendored entry ${k} is not in the script allowlist`);
        if (got.has(k)) errors.push(`${where}: vendored entry ${k} listed twice`);
        got.add(k);
      }
      for (const k of want.keys()) if (!got.has(k)) errors.push(`${where}: vendored entry ${k} (fixed in the script allowlist) is missing`);
    }
    for (const v of vendored) {
      const vw = `${where} vendored ${JSON.stringify(v.upstream)}`;
      if (!/^contracts\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(v.upstream ?? "")) errors.push(`${vw}: upstream must be a path under contracts/`);
      if (!SHA40.test(v.pinned_commit ?? "")) errors.push(`${vw}: pinned_commit must be 40 lowercase hex`);
      if (v.consumer_recorded_commit !== undefined && !SHA40.test(v.consumer_recorded_commit)) errors.push(`${vw}: consumer_recorded_commit must be 40 lowercase hex`);
      if (!isSafeRelative(v.consumer_path ?? "")) errors.push(`${vw}: consumer_path must be a safe relative path`);
      const manifest = Array.isArray(v.manifest) ? v.manifest : [];
      const files = new Set();
      const consumerOnly = new Set();
      let upstreamRows = 0;
      for (const m of manifest) {
        if (m === null || typeof m !== "object") continue; // reported by the schema
        if (!isSafeRelative(m.file ?? "")) errors.push(`${vw}: manifest file ${JSON.stringify(m.file)} is not a safe relative path`);
        if (files.has(m.file)) errors.push(`${vw}: manifest lists ${m.file} twice`);
        files.add(m.file);
        const hasUp = typeof m.upstream_file === "string";
        if (hasUp === Boolean(m.consumer_only)) errors.push(`${vw}: ${m.file} must have exactly one of upstream_file / consumer_only:true`);
        if (hasUp && (!m.upstream_file.startsWith("contracts/") || !isSafeRelative(m.upstream_file))) errors.push(`${vw}: ${m.file} upstream_file must be a safe path under contracts/`);
        if (hasUp) upstreamRows += 1;
        if (m.consumer_only) consumerOnly.add(m.file);
      }
      if (manifest.length === 0) errors.push(`${vw}: manifest is empty`);
      if (upstreamRows === 0) errors.push(`${vw}: manifest has no upstream_file row (nothing would be compared)`);
      const fixed = allowed?.vendored.find((a) => keyOf(a) === keyOf(v));
      if (fixed) {
        const wantOnly = [...fixed.consumer_only].sort();
        const gotOnly = [...consumerOnly].sort();
        if (JSON.stringify(wantOnly) !== JSON.stringify(gotOnly)) {
          errors.push(`${vw}: consumer_only files ${JSON.stringify(gotOnly)} must be exactly ${JSON.stringify(wantOnly)} (fixed in the script allowlist)`);
        }
      }
    }
  }
  return errors;
}

function pinnedAtError(value, today) {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return "pinned_at must be YYYY-MM-DD";
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) return `pinned_at ${value} is not a real calendar date`;
  if (value > today) return `pinned_at ${value} is in the future (today ${today} UTC)`;
  return null;
}

export function isSafeRelative(p) {
  if (typeof p !== "string" || p.length === 0 || p.startsWith("/") || p.includes("\\") || CONTROL_CHARS.test(p)) return false;
  return p.split("/").every((seg) => seg.length > 0 && seg !== "." && seg !== "..");
}

class UsageError extends Error {}

// ---------------------------------------------------------------------------------------------
async function resolveBase(explicit) {
  const candidate = explicit || process.env.CONSUMER_CONFORMANCE_BASE || "";
  if (candidate) {
    if (!SHA40.test(candidate)) throw new UsageError(`base ${JSON.stringify(candidate)} is not a 40-hex sha`);
    const r = await git(["cat-file", "-e", `${candidate}^{commit}`]);
    if (r.code !== 0) throw new UsageError(`base ${candidate} is not a commit in this checkout (fetch-depth: 0 needed; ${why(r)})`);
    return candidate;
  }
  const mb = await git(["merge-base", "origin/main", "HEAD"]);
  if (mb.code !== 0) throw new UsageError(`base unknown: pass --base <sha> or set CONSUMER_CONFORMANCE_BASE (origin/main not available; ${why(mb)})`);
  return mb.stdout.toString("utf8").trim();
}

// Ancestry gate. consumers.json is editable from a PR, and a PR ref's commit can be checked out
// by sha, so the pinned sha is only trusted once it is proven to be on the consumer's default
// branch. Returns the default branch HEAD, or null after fail() (callers must stop).
async function ancestryGate(consumer, allowed, checkout) {
  const label = `ancestry gate: ${consumer.name}`;
  const top = await git(["-C", checkout, "rev-parse", "--show-toplevel"]);
  if (top.code !== 0) {
    fail(`${label}: ${checkout} is not a git checkout (${why(top)})`);
    return null;
  }
  let topReal;
  let checkoutReal;
  try {
    topReal = realpathSync(top.stdout.toString("utf8").trim());
    checkoutReal = realpathSync(checkout);
  } catch (e) {
    fail(`${label}: cannot resolve ${checkout}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
  if (topReal !== checkoutReal) {
    fail(`${label}: ${checkout} is inside another repository (${topReal}), not a checkout root`);
    return null;
  }
  const head = await git(["-C", checkout, "rev-parse", "HEAD"]);
  const headSha = head.stdout.toString("utf8").trim();
  if (head.code !== 0 || headSha !== consumer.sha) {
    fail(`${label}: checkout HEAD ${head.code === 0 ? headSha : `unknown (${why(head)})`} is not the pinned sha ${consumer.sha}`);
    return null;
  }
  const url = await git(["-C", checkout, "remote", "get-url", "origin"]);
  const originUrl = url.stdout.toString("utf8").trim();
  const repoRe = allowed.repository.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (url.code !== 0 || !new RegExp(`^(https://github\\.com/|git@github\\.com:)${repoRe}(\\.git)?$`).test(originUrl)) {
    fail(`${label}: origin ${url.code === 0 ? JSON.stringify(originUrl) : `unknown (${why(url)})`} is not github.com/${allowed.repository}`);
    return null;
  }
  // Not best effort: this is a security gate, an unreachable remote fails the check.
  const ls = await git(["-C", checkout, "ls-remote", "origin", "HEAD"], { timeoutMs: TIMEOUT_MS.network });
  const defaultHead = ls.stdout.toString("utf8").slice(0, 40);
  if (ls.code !== 0 || !SHA40.test(defaultHead)) {
    fail(`${label}: cannot resolve the default branch HEAD of origin (${ls.code === 0 ? "no HEAD advertised" : why(ls)})`);
    return null;
  }
  const fetch = await git(["-C", checkout, "fetch", "--no-tags", "origin", defaultHead]);
  if (fetch.code !== 0) {
    fail(`${label}: git fetch origin ${defaultHead.slice(0, 7)} failed (${why(fetch)})`);
    return null;
  }
  const anc = await git(["-C", checkout, "merge-base", "--is-ancestor", consumer.sha, defaultHead]);
  if (anc.code !== 0) {
    fail(`${label}: pinned sha ${consumer.sha.slice(0, 7)} is not an ancestor of the default branch HEAD ${defaultHead.slice(0, 7)} (${anc.code === 1 ? "e.g. a PR-only commit" : why(anc)}). Pin a commit merged to the default branch.`);
    return null;
  }
  ok(`${label}: HEAD is the pinned sha, origin is ${allowed.repository}, sha is an ancestor of default branch HEAD ${defaultHead.slice(0, 7)}`);
  return defaultHead;
}

async function deprecationGate(consumer, base) {
  const ls = await git(["ls-tree", base, "--", "contracts/consumers.json"]);
  if (ls.code !== 0) {
    fail(`deprecation gate: git ls-tree at base ${base.slice(0, 7)} failed (${why(ls)})`);
    return;
  }
  if (ls.stdout.toString("utf8").trim() === "") {
    notice(`deprecation gate: contracts/consumers.json does not exist at base ${base.slice(0, 7)} (first introduction) -- nothing to gate`);
    return;
  }
  const r = await git(["show", `${base}:contracts/consumers.json`]);
  if (r.code !== 0) {
    fail(`deprecation gate: cannot read contracts/consumers.json at base ${base.slice(0, 7)} (${why(r)})`);
    return;
  }
  let baseDoc;
  try {
    baseDoc = JSON.parse(r.stdout.toString("utf8"));
  } catch {
    fail(`deprecation gate: contracts/consumers.json at base ${base.slice(0, 7)} is not valid JSON`);
    return;
  }
  const baseEntry = (baseDoc.consumers ?? []).find((c) => c.name === consumer.name);
  if (!baseEntry) {
    notice(`deprecation gate: ${consumer.name} not present at base -- nothing to gate`);
    return;
  }
  for (const ref of baseEntry.contracts ?? []) {
    if (!CONTRACT_REF.test(ref)) {
      fail(`deprecation gate: base consumers.json lists contracts entry ${JSON.stringify(ref)} for ${consumer.name}, which is not <name>/vN or shared`);
      continue;
    }
    const dir = join(CONTRACTS, ref);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      fail(`deprecation gate: ${consumer.name} referenced contracts/${ref} at base ${base.slice(0, 7)} but it no longer exists at HEAD. Migrate the consumer and merge the reference removal first; only then remove the contract (add -> migrate -> remove).`);
    } else {
      ok(`deprecation gate: contracts/${ref} still present for ${consumer.name}`);
    }
  }
}

// Every regular file under root, as sorted root-relative POSIX paths. Throws on a symlink (file,
// directory or dangling) or any other non-regular entry: a vendored tree must be plain files, and
// following a link would compare something other than what the consumer ships.
export function walkFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      const rel = relative(root, p).split("\\").join("/");
      const st = lstatSync(p);
      if (st.isSymbolicLink()) throw new Error(`symlink not allowed: ${rel}`);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) out.push(rel);
      else throw new Error(`not a regular file: ${rel}`);
    }
  };
  walk(root);
  return out;
}

// Compares a vendored tree with its manifest. readUpstream(upstream_file) returns the pinned
// upstream bytes (Buffer) or null when the file does not exist at the pin. No git, no network.
export function compareVendored(root, manifest, readUpstream) {
  const errors = [];
  let st;
  try {
    st = lstatSync(root);
  } catch {
    return { verified: 0, errors: [`vendored root ${root} is missing`] };
  }
  if (st.isSymbolicLink() || !st.isDirectory()) return { verified: 0, errors: [`vendored root ${root} must be a real directory (not a symlink)`] };
  let actual;
  try {
    actual = new Set(walkFiles(root));
  } catch (e) {
    return { verified: 0, errors: [e instanceof Error ? e.message : String(e)] };
  }
  const listed = new Set(manifest.map((m) => m.file));
  const unexpected = [...actual].filter((f) => !listed.has(f));
  if (unexpected.length > 0) errors.push(`file(s) not listed in the manifest: ${unexpected.join(", ")}`);
  let verified = 0;
  for (const m of manifest) {
    if (!actual.has(m.file)) {
      errors.push(`manifest file ${m.file} missing in consumer checkout`);
      continue;
    }
    if (m.consumer_only) continue;
    const upstream = readUpstream(m.upstream_file);
    if (upstream === null || upstream === undefined) {
      errors.push(`${m.upstream_file} does not exist at the pinned commit`);
      continue;
    }
    if (!Buffer.from(upstream).equals(readFileSync(join(root, m.file)))) {
      errors.push(`${m.file} differs from ${m.upstream_file} at the pinned commit (vendored copy modified or mis-pinned)`);
      continue;
    }
    verified += 1;
  }
  return { verified, errors };
}

async function checkVendored(consumer, entry, checkout, base) {
  const label = `${consumer.name}: ${entry.upstream} @ ${entry.pinned_commit.slice(0, 7)}`;
  const anc = await git(["merge-base", "--is-ancestor", entry.pinned_commit, "HEAD"]);
  if (anc.code !== 0) {
    fail(`${label}: pinned_commit is not an ancestor of HEAD (${anc.code === 1 ? "unreachable or not merged" : why(anc)}). Re-pin the consumer to a commit on main.`);
    return;
  }
  ok(`${label}: pinned_commit is an ancestor of HEAD`);
  // No component of consumer_path may be a symlink either (it could point outside the checkout).
  let cur = checkout;
  for (const seg of entry.consumer_path.split("/")) {
    cur = join(cur, seg);
    let st;
    try {
      st = lstatSync(cur);
    } catch {
      fail(`${label}: consumer path ${entry.consumer_path} missing in checkout`);
      return;
    }
    if (st.isSymbolicLink() || !st.isDirectory()) {
      fail(`${label}: ${relative(checkout, cur)} must be a real directory (symlinks are not allowed in a vendored path)`);
      return;
    }
  }
  const upstreamBytes = new Map();
  for (const m of entry.manifest) {
    if (m.consumer_only) continue;
    const show = await git(["show", `${entry.pinned_commit}:${m.upstream_file}`]);
    if (show.spawnError || show.timedOut) {
      fail(`${label}: git show ${m.upstream_file} ${why(show)}`);
      return;
    }
    upstreamBytes.set(m.upstream_file, show.code === 0 ? show.stdout : null);
  }
  const root = join(checkout, entry.consumer_path);
  const { verified, errors } = compareVendored(root, entry.manifest, (f) => upstreamBytes.get(f) ?? null);
  for (const e of errors) fail(`${label}: ${entry.consumer_path}: ${e}`);
  ok(`${label}: ${verified} vendored file(s) byte-identical to the pinned upstream, ${entry.manifest.filter((m) => m.consumer_only).length} consumer-only`);
  if (entry.consumer_recorded_commit && entry.consumer_recorded_commit !== entry.pinned_commit) {
    notice(`${label}: consumer records ${entry.consumer_recorded_commit.slice(0, 7)} in its UPSTREAM file, hub pins ${entry.pinned_commit.slice(0, 7)} (${entry.note ?? "see consumers.json"})`);
  }
  const prDiff = await git(["diff", "--name-only", base, "HEAD", "--", entry.upstream]);
  if (prDiff.code !== 0) {
    fail(`${label}: git diff ${base.slice(0, 7)}..HEAD -- ${entry.upstream} failed (${why(prDiff)})`);
  } else {
    const prFiles = prDiff.stdout.toString("utf8").trim().split("\n").filter(Boolean);
    if (prFiles.length > 0) {
      warn(`${consumer.name} vendors ${entry.upstream} at ${entry.pinned_commit.slice(0, 7)} and this change (base ${base.slice(0, 7)}..HEAD) touches it (${prFiles.length} file(s)). Plan add -> migrate -> remove and re-vendor the consumer.`);
    }
  }
  const drift = await git(["diff", "--name-only", entry.pinned_commit, "HEAD", "--", entry.upstream]);
  if (drift.code !== 0) {
    warn(`${label}: pin drift could not be computed (${why(drift)})`);
  } else {
    const driftFiles = drift.stdout.toString("utf8").trim().split("\n").filter(Boolean);
    if (driftFiles.length > 0) notice(`${label}: ${driftFiles.length} file(s) under ${entry.upstream} changed since the pin (pin drift, informational)`);
  }
}

async function runLive(consumer, allowed, checkout, { contractsDir, expectFailure = false, stage }) {
  const [installCmd, installArgs] = allowed.install;
  const [testCmd, testArgs] = allowed.test;
  if (!expectFailure) {
    const inst = await runStep("install", installCmd, installArgs, { cwd: checkout, timeoutMs: TIMEOUT_MS.install });
    if (inst.code !== 0) {
      fail(`${consumer.name}: install failed (${inst.spawnError ? `could not start ${installCmd}: ${inst.stderr}` : `exit ${inst.code}${inst.timedOut ? ", timeout" : ""}`})`);
      return false;
    }
  }
  const env = { [allowed.envVar]: contractsDir };
  const t = await runStep(stage, testCmd, testArgs, { cwd: checkout, env, timeoutMs: TIMEOUT_MS.test });
  if (expectFailure) {
    // Only vitest's own "tests failed" exit (1) proves the contract is exercised; a crash, a
    // timeout or a missing binary would make the probe look red for the wrong reason.
    if (t.timedOut) fail(`${consumer.name}: negative probe timed out -- a hang is not evidence that the contract is exercised`);
    else if (t.spawnError) fail(`${consumer.name}: negative probe could not start ${testCmd} (${t.stderr})`);
    else if (t.signal) fail(`${consumer.name}: negative probe was killed by ${t.signal} -- not a test failure`);
    else if (t.code === 0) fail(`${consumer.name}: negative probe did NOT fail -- the contract-dependent tests are not actually exercising the contract directory`);
    else if (t.code !== 1) fail(`${consumer.name}: negative probe exited ${t.code}, expected 1 (vitest test failure) -- the runner itself broke`);
    else {
      ok(`${consumer.name}: negative probe failed as required (exit 1) -- the live check is known to bite`);
      return true;
    }
    return false;
  }
  if (t.code !== 0) {
    fail(`${consumer.name}: contract-dependent tests failed against ${relative(PLAYBOOK, contractsDir)} (${t.spawnError ? `could not start ${testCmd}: ${t.stderr}` : `exit ${t.code}${t.timedOut ? ", timeout" : ""}`})`);
    return false;
  }
  ok(`${consumer.name}: contract-dependent tests passed against ${relative(PLAYBOOK, contractsDir)}`);
  return true;
}

function brokenCopy(contractsDir, probeSchema) {
  try {
    walkFiles(contractsDir);
  } catch (e) {
    throw new UsageError(`${relative(PLAYBOOK, contractsDir)}: ${e instanceof Error ? e.message : String(e)} (refusing to copy for the negative probe)`);
  }
  const tmp = mkdtempSync(join(tmpdir(), "consumer-conformance-probe-"));
  try {
    cpSync(contractsDir, tmp, { recursive: true });
    const schemaPath = join(tmp, probeSchema);
    if (!lstatSync(schemaPath).isFile()) throw new UsageError(`probe schema ${probeSchema} is not a regular file`);
    const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
    schema.required = [...(Array.isArray(schema.required) ? schema.required : []), "__conformance_probe__"];
    writeFileSync(schemaPath, `${JSON.stringify(schema, null, 2)}\n`);
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  return tmp;
}

function freshness(consumer, defaultHead) {
  const pinned = new Date(`${consumer.pinned_at}T00:00:00Z`);
  const ageDays = Math.floor((Date.now() - pinned.getTime()) / 86_400_000);
  if (ageDays > PIN_MAX_AGE_DAYS) warn(`${consumer.name}: pin is ${ageDays} days old (pinned_at ${consumer.pinned_at}, max ${PIN_MAX_AGE_DAYS}) -- advance sha/pinned_at (contracts/CONSUMERS.md)`);
  else ok(`${consumer.name}: pin age ${ageDays} day(s)`);
  if (defaultHead !== consumer.sha) notice(`${consumer.name}: default branch HEAD is ${defaultHead.slice(0, 7)}, hub pins ${consumer.sha.slice(0, 7)}`);
}

// ---------------------------------------------------------------------------------------------
function parseArgs(argv) {
  const opts = { validate: false, printPin: false, breakContract: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new UsageError(`${a} needs a value`);
      return argv[i];
    };
    if (a === "--validate") opts.validate = true;
    else if (a === "--print-pin") opts.printPin = true;
    else if (a === "--break-contract") opts.breakContract = true;
    else if (a === "--gate-only") opts.gateOnly = true;
    else if (a === "--consumer") opts.consumer = next();
    else if (a === "--checkout") opts.checkout = next();
    else if (a === "--base") opts.base = next();
    else throw new UsageError(`unknown argument ${a}`);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const doc = loadConsumers();
  if (opts.validate) {
    console.log(`contracts/consumers.json valid: ${doc.consumers.length} consumer(s), allowlist ${Object.keys(ALLOWLIST).join(", ")}`);
    return 0;
  }
  if (!opts.consumer) throw new UsageError("--consumer <name> is required");
  const consumer = doc.consumers.find((c) => c.name === opts.consumer);
  if (!consumer) throw new UsageError(`consumer ${opts.consumer} not in contracts/consumers.json`);
  const allowed = ALLOWLIST[consumer.name];
  if (opts.printPin) {
    console.log(`repository=${consumer.repository}\nsha=${consumer.sha}`);
    return 0;
  }
  if (!opts.checkout) throw new UsageError("--checkout <dir> is required");
  const checkout = resolve(opts.checkout);
  if (!existsSync(checkout) || !statSync(checkout).isDirectory()) throw new UsageError(`checkout ${checkout} is not a directory`);
  if (opts.breakContract && allowed.kind !== "live") throw new UsageError(`--break-contract only applies to live consumers (${consumer.name} is vendored)`);

  console.log(`consumer-conformance: ${consumer.name} @ ${consumer.sha.slice(0, 7)} (${allowed.kind}), timeout scale ${SCALE}`);
  // Nothing reads, installs or runs the checkout before the ancestry gate passes.
  const defaultHead = await ancestryGate(consumer, allowed, checkout);
  if (opts.gateOnly) {
    // CI runs this right after the consumer checkout, BEFORE any toolchain setup reads files
    // from that checkout (pnpm/action-setup reads consumer/package.json). A PR-only commit is
    // therefore rejected before anything derived from it is used.
    console.log(failures === 0 ? `consumer-conformance: ${consumer.name} ancestry gate passed (--gate-only)` : `consumer-conformance: ${consumer.name} FAILED (ancestry gate)`);
    return failures === 0 ? 0 : 1;
  }
  if (defaultHead === null) {
    console.log(`consumer-conformance: ${consumer.name} FAILED (ancestry gate)`);
    return 1;
  }
  const base = await resolveBase(opts.base);
  console.log(`consumer-conformance: base ${base.slice(0, 7)}`);
  await deprecationGate(consumer, base);
  for (const entry of consumer.vendored ?? []) await checkVendored(consumer, entry, checkout, base);
  if (allowed.kind === "live") {
    const contractsDir = join(CONTRACTS, allowed.contractsSubdir);
    if (opts.breakContract) {
      const tmp = brokenCopy(contractsDir, allowed.probeSchema);
      try {
        await runLive(consumer, allowed, checkout, { contractsDir: tmp, expectFailure: true, stage: "negative probe" });
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    } else {
      await runLive(consumer, allowed, checkout, { contractsDir, stage: "contract tests" });
    }
  }
  freshness(consumer, defaultHead);
  console.log(failures === 0 ? `consumer-conformance: ${consumer.name} passed` : `consumer-conformance: ${consumer.name} FAILED (${failures})`);
  return failures === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      if (e instanceof UsageError) {
        console.error(`consumer-conformance: ${e.message}`);
        process.exit(2);
      }
      console.error(e);
      process.exit(2);
    },
  );
}
