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
//               notice (best effort, network).
//
// Security posture (sol review, round 1 must): consumers.json carries DATA ONLY (shas, dates,
// manifests). Repository names and every command executed live in the fixed ALLOWLIST below, so
// a PR that edits consumers.json cannot make CI check out an arbitrary repository or run
// arbitrary commands. Every subprocess has a fixed timeout and is started in its own process
// group so a hang is killed as a group (round 2 must). Only CONSUMER_CONFORMANCE_TIMEOUT_SCALE
// (1..3) is honoured from the environment.
//
// Usage:
//   node contracts/shared/consumer-conformance.mjs --validate
//   node contracts/shared/consumer-conformance.mjs --print-pin --consumer <name>
//   node contracts/shared/consumer-conformance.mjs --consumer <name> --checkout <dir> [--base <sha>] [--break-contract]
//
// Exit codes: 0 all checks passed, 1 at least one check failed, 2 usage / configuration error.
// Node stdlib only (no npm deps, like the rest of contracts/).

import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createValidator } from "./schema-validator.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLAYBOOK = resolve(HERE, "..", "..");
const CONTRACTS = join(PLAYBOOK, "contracts");
const CONSUMERS_JSON = join(CONTRACTS, "consumers.json");
const SHA40 = /^[0-9a-f]{40}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CONTRACT_REF = /^(?:[a-z0-9-]+\/v\d+|shared)$/;
const PIN_MAX_AGE_DAYS = 90;

const scaleRaw = Number(process.env.CONSUMER_CONFORMANCE_TIMEOUT_SCALE ?? "1");
const SCALE = Number.isFinite(scaleRaw) && scaleRaw >= 1 && scaleRaw <= 3 ? scaleRaw : 1;
const TIMEOUT_MS = { git: 60_000 * SCALE, install: 600_000 * SCALE, test: 300_000 * SCALE, network: 60_000 * SCALE };

// Fixed allowlist. `name` and `repository` in consumers.json must match these exactly; the
// install / test command lines are not configurable from data on purpose.
const ALLOWLIST = {
  "release-evidence": {
    repository: "shiki-yusuke/release-evidence",
    kind: "live",
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
  "spec-lane": { repository: "shiki-yusuke/spec-lane", kind: "vendored" },
  "agent-metrics-harvester": { repository: "shiki-yusuke/agent-metrics-harvester", kind: "vendored" },
};

let failures = 0;
const fail = (msg) => {
  failures += 1;
  console.log(`::error::${msg}`);
};
const warn = (msg) => console.log(`::warning::${msg}`);
const notice = (msg) => console.log(`::notice::${msg}`);
const ok = (msg) => console.log(`ok: ${msg}`);

// ---------------------------------------------------------------------------------------------
// subprocess with a hard timeout and process-group kill
function runStep(name, cmd, args, { cwd, env, timeoutMs, capture = false } = {}) {
  return new Promise((resolveStep) => {
    const detached = process.platform !== "win32";
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...(env ?? {}) },
      stdio: capture ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"],
      detached,
    });
    const out = [];
    const err = [];
    if (capture) {
      child.stdout.on("data", (b) => out.push(b));
      child.stderr.on("data", (b) => err.push(b));
    }
    let timedOut = false;
    const killGroup = (signal) => {
      try {
        if (detached) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        /* already gone */
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      console.log(`::error::timeout step=${name} after ${Math.round(timeoutMs / 1000)}s -- killing process group`);
      killGroup("SIGTERM");
      setTimeout(() => killGroup("SIGKILL"), 5_000).unref();
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolveStep({ code: 127, timedOut, stdout: Buffer.concat(out), stderr: `${e.message}` });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolveStep({
        code: timedOut ? 124 : code ?? (signal ? 128 : 1),
        timedOut,
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(err).toString("utf8"),
      });
    });
  });
}

async function git(args, { cwd = PLAYBOOK, timeoutMs = TIMEOUT_MS.git } = {}) {
  return runStep(`git ${args[0]}`, "git", args, { cwd, timeoutMs, capture: true });
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
  const { validate } = createValidator(CONTRACTS);
  const schemaErrors = validate("consumers.schema.json", doc).map((e) => (typeof e === "string" ? e : JSON.stringify(e)));
  const errors = [...schemaErrors];
  const seen = new Set();
  for (const c of doc.consumers ?? []) {
    const where = `consumer ${JSON.stringify(c.name)}`;
    const allowed = ALLOWLIST[c.name];
    if (!allowed) errors.push(`${where}: not in the fixed allowlist (${Object.keys(ALLOWLIST).join(", ")})`);
    else if (c.repository !== allowed.repository) errors.push(`${where}: repository must be ${allowed.repository}`);
    if (seen.has(c.name)) errors.push(`${where}: listed twice`);
    seen.add(c.name);
    if (!SHA40.test(c.sha ?? "")) errors.push(`${where}: sha must be 40 lowercase hex`);
    if (!ISO_DATE.test(c.pinned_at ?? "")) errors.push(`${where}: pinned_at must be YYYY-MM-DD`);
    for (const ref of c.contracts ?? []) {
      if (!CONTRACT_REF.test(ref)) errors.push(`${where}: contracts entry ${JSON.stringify(ref)} is not <name>/vN or shared`);
    }
    for (const v of c.vendored ?? []) {
      const vw = `${where} vendored ${JSON.stringify(v.upstream)}`;
      if (!/^contracts\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(v.upstream ?? "")) errors.push(`${vw}: upstream must be a path under contracts/`);
      if (!SHA40.test(v.pinned_commit ?? "")) errors.push(`${vw}: pinned_commit must be 40 lowercase hex`);
      if (v.consumer_recorded_commit !== undefined && !SHA40.test(v.consumer_recorded_commit)) errors.push(`${vw}: consumer_recorded_commit must be 40 lowercase hex`);
      if (!isSafeRelative(v.consumer_path ?? "")) errors.push(`${vw}: consumer_path must be a safe relative path`);
      const files = new Set();
      for (const m of v.manifest ?? []) {
        if (!isSafeRelative(m.file ?? "")) errors.push(`${vw}: manifest file ${JSON.stringify(m.file)} is not a safe relative path`);
        if (files.has(m.file)) errors.push(`${vw}: manifest lists ${m.file} twice`);
        files.add(m.file);
        const hasUp = typeof m.upstream_file === "string";
        if (hasUp === Boolean(m.consumer_only)) errors.push(`${vw}: ${m.file} must have exactly one of upstream_file / consumer_only:true`);
        if (hasUp && !m.upstream_file.startsWith("contracts/")) errors.push(`${vw}: ${m.file} upstream_file must be under contracts/`);
      }
      if ((v.manifest ?? []).length === 0) errors.push(`${vw}: manifest is empty`);
    }
  }
  if (errors.length > 0) throw new UsageError(`contracts/consumers.json invalid:\n  - ${errors.join("\n  - ")}`);
  return doc;
}

function isSafeRelative(p) {
  if (typeof p !== "string" || p.length === 0 || p.startsWith("/") || p.includes("\\")) return false;
  return p.split("/").every((seg) => seg.length > 0 && seg !== "." && seg !== "..");
}

class UsageError extends Error {}

// ---------------------------------------------------------------------------------------------
async function resolveBase(explicit) {
  const candidate = explicit || process.env.CONSUMER_CONFORMANCE_BASE || "";
  if (candidate) {
    if (!SHA40.test(candidate)) throw new UsageError(`base ${JSON.stringify(candidate)} is not a 40-hex sha`);
    const r = await git(["cat-file", "-e", `${candidate}^{commit}`]);
    if (r.code !== 0) throw new UsageError(`base ${candidate} is not a commit in this checkout (fetch-depth: 0 needed)`);
    return candidate;
  }
  const mb = await git(["merge-base", "origin/main", "HEAD"]);
  if (mb.code !== 0) throw new UsageError("base unknown: pass --base <sha> or set CONSUMER_CONFORMANCE_BASE (origin/main not available)");
  return mb.stdout.toString("utf8").trim();
}

async function deprecationGate(consumer, base) {
  const r = await git(["show", `${base}:contracts/consumers.json`]);
  if (r.code !== 0) {
    notice(`deprecation gate: contracts/consumers.json does not exist at base ${base.slice(0, 7)} (first introduction) -- nothing to gate`);
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
    const dir = join(CONTRACTS, ref);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      fail(`deprecation gate: ${consumer.name} referenced contracts/${ref} at base ${base.slice(0, 7)} but it no longer exists at HEAD. Migrate the consumer and merge the reference removal first; only then remove the contract (add -> migrate -> remove).`);
    } else {
      ok(`deprecation gate: contracts/${ref} still present for ${consumer.name}`);
    }
  }
}

function walkFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else out.push(relative(root, p).split("\\").join("/"));
    }
  };
  walk(root);
  return out;
}

async function checkVendored(consumer, entry, checkout, base) {
  const label = `${consumer.name}: ${entry.upstream} @ ${entry.pinned_commit.slice(0, 7)}`;
  const anc = await git(["merge-base", "--is-ancestor", entry.pinned_commit, "HEAD"]);
  if (anc.code !== 0) {
    fail(`${label}: pinned_commit is not an ancestor of HEAD (unreachable or not merged). Re-pin the consumer to a commit on main.`);
    return;
  }
  ok(`${label}: pinned_commit is an ancestor of HEAD`);
  const root = join(checkout, entry.consumer_path);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    fail(`${label}: consumer path ${entry.consumer_path} missing in checkout`);
    return;
  }
  const listed = new Set(entry.manifest.map((m) => m.file));
  const actual = walkFiles(root);
  const unexpected = actual.filter((f) => !listed.has(f));
  if (unexpected.length > 0) fail(`${label}: file(s) under ${entry.consumer_path} not listed in the manifest: ${unexpected.join(", ")}`);
  let verified = 0;
  for (const m of entry.manifest) {
    const p = join(root, m.file);
    if (!existsSync(p) || !statSync(p).isFile()) {
      fail(`${label}: manifest file ${m.file} missing in consumer checkout`);
      continue;
    }
    if (m.consumer_only) continue;
    const show = await git(["show", `${entry.pinned_commit}:${m.upstream_file}`]);
    if (show.code !== 0) {
      fail(`${label}: ${m.upstream_file} does not exist at ${entry.pinned_commit.slice(0, 7)}`);
      continue;
    }
    if (!show.stdout.equals(readFileSync(p))) {
      fail(`${label}: ${entry.consumer_path}/${m.file} differs from ${m.upstream_file} at ${entry.pinned_commit.slice(0, 7)} (vendored copy modified or mis-pinned)`);
      continue;
    }
    verified += 1;
  }
  ok(`${label}: ${verified} vendored file(s) byte-identical to the pinned upstream, ${entry.manifest.length - verified} consumer-only`);
  if (entry.consumer_recorded_commit && entry.consumer_recorded_commit !== entry.pinned_commit) {
    notice(`${label}: consumer records ${entry.consumer_recorded_commit.slice(0, 7)} in its UPSTREAM file, hub pins ${entry.pinned_commit.slice(0, 7)} (${entry.note ?? "see consumers.json"})`);
  }
  const prDiff = await git(["diff", "--name-only", base, "HEAD", "--", entry.upstream]);
  const prFiles = prDiff.stdout.toString("utf8").trim().split("\n").filter(Boolean);
  if (prDiff.code === 0 && prFiles.length > 0) {
    warn(`${consumer.name} vendors ${entry.upstream} at ${entry.pinned_commit.slice(0, 7)} and this change (base ${base.slice(0, 7)}..HEAD) touches it (${prFiles.length} file(s)). Plan add -> migrate -> remove and re-vendor the consumer.`);
  }
  const drift = await git(["diff", "--name-only", entry.pinned_commit, "HEAD", "--", entry.upstream]);
  const driftFiles = drift.stdout.toString("utf8").trim().split("\n").filter(Boolean);
  if (drift.code === 0 && driftFiles.length > 0) {
    notice(`${label}: ${driftFiles.length} file(s) under ${entry.upstream} changed since the pin (pin drift, informational)`);
  }
}

async function runLive(consumer, allowed, checkout, { contractsDir, expectFailure = false, stage }) {
  const [installCmd, installArgs] = allowed.install;
  const [testCmd, testArgs] = allowed.test;
  if (!expectFailure) {
    const inst = await runStep("install", installCmd, installArgs, { cwd: checkout, timeoutMs: TIMEOUT_MS.install });
    if (inst.code !== 0) {
      fail(`${consumer.name}: install failed (exit ${inst.code}${inst.timedOut ? ", timeout" : ""})`);
      return false;
    }
  }
  const env = { [allowed.envVar]: contractsDir };
  const t = await runStep(stage, testCmd, testArgs, { cwd: checkout, env, timeoutMs: TIMEOUT_MS.test });
  if (expectFailure) {
    if (t.code === 0) {
      fail(`${consumer.name}: negative probe did NOT fail -- the contract-dependent tests are not actually exercising the contract directory`);
      return false;
    }
    ok(`${consumer.name}: negative probe failed as required (exit ${t.code}) -- the live check is known to bite`);
    return true;
  }
  if (t.code !== 0) {
    fail(`${consumer.name}: contract-dependent tests failed against ${relative(PLAYBOOK, contractsDir)} (exit ${t.code}${t.timedOut ? ", timeout" : ""})`);
    return false;
  }
  ok(`${consumer.name}: contract-dependent tests passed against ${relative(PLAYBOOK, contractsDir)}`);
  return true;
}

function brokenCopy(contractsDir, probeSchema) {
  const tmp = mkdtempSync(join(tmpdir(), "consumer-conformance-probe-"));
  cpSync(contractsDir, tmp, { recursive: true });
  const schemaPath = join(tmp, probeSchema);
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  schema.required = [...(Array.isArray(schema.required) ? schema.required : []), "__conformance_probe__"];
  writeFileSync(schemaPath, `${JSON.stringify(schema, null, 2)}\n`);
  return tmp;
}

async function freshness(consumer) {
  const pinned = new Date(`${consumer.pinned_at}T00:00:00Z`);
  const ageDays = Math.floor((Date.now() - pinned.getTime()) / 86_400_000);
  if (ageDays > PIN_MAX_AGE_DAYS) warn(`${consumer.name}: pin is ${ageDays} days old (pinned_at ${consumer.pinned_at}, max ${PIN_MAX_AGE_DAYS}) -- advance sha/pinned_at (contracts/CONSUMERS.md)`);
  else ok(`${consumer.name}: pin age ${ageDays} day(s)`);
  const r = await git(["ls-remote", `https://github.com/${consumer.repository}.git`, "HEAD"], { timeoutMs: TIMEOUT_MS.network });
  if (r.code !== 0) return; // network is best effort
  const head = r.stdout.toString("utf8").split(/\s+/)[0] ?? "";
  if (SHA40.test(head) && head !== consumer.sha) notice(`${consumer.name}: default branch HEAD is ${head.slice(0, 7)}, hub pins ${consumer.sha.slice(0, 7)}`);
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

  const base = await resolveBase(opts.base);
  console.log(`consumer-conformance: ${consumer.name} @ ${consumer.sha.slice(0, 7)} (${allowed.kind}), base ${base.slice(0, 7)}, timeout scale ${SCALE}`);
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
  } else if (opts.breakContract) {
    throw new UsageError(`--break-contract only applies to live consumers (${consumer.name} is vendored)`);
  }
  await freshness(consumer);
  console.log(failures === 0 ? `consumer-conformance: ${consumer.name} passed` : `consumer-conformance: ${consumer.name} FAILED (${failures})`);
  return failures === 0 ? 0 : 1;
}

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
