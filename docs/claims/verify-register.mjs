#!/usr/bin/env node
// Validates docs/claims/register.json against register.schema.json plus the semantic rules the
// schema cannot express, then renders docs/prior-art.md from it.
//
//   node docs/claims/verify-register.mjs          # validate + fail if prior-art.md is stale
//   node docs/claims/verify-register.mjs --write  # validate + regenerate prior-art.md
//
// Semantic rules: every prior_art.source names a registered source; withdrawn_claims.replaced_by
// names registered elements; an approved element must name its human_reviewer; a source whose
// date_basis is unresolved must have published null and vice versa; every date is a real calendar
// date (the regex in the schema cannot tell 2026-02-31 from a real day, and dates drive the
// earlier/later column); no field named *confidence* holds a number (the schema's enum covers the
// known field; the scan guards fields added later). Earlier/later is computed here from dates and is
// never stored in the register. Zero npm dependencies by design; no network.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createValidator } from "../../contracts/shared/schema-validator.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REGISTER = path.join(HERE, "register.json");
const OUT = path.join(HERE, "..", "prior-art.md");
const { validate } = createValidator(HERE);

const reg = JSON.parse(readFileSync(REGISTER, "utf-8"));
const errors = validate("register.schema.json", reg).map((e) => (typeof e === "string" ? e : JSON.stringify(e)));

const realDate = (d) => d === null || d === undefined || (typeof d === "string" && !Number.isNaN(Date.parse(d + "T00:00:00Z")) && new Date(d + "T00:00:00Z").toISOString().slice(0, 10) === d);
for (const s of reg.sources) for (const k of ["published", "retrieved_at"]) if (!realDate(s[k])) errors.push(`source ${s.id}: ${k} is not a real calendar date`);
for (const c of reg.claim_elements) for (const k of ["last_candidate_triage_at", "last_comprehensive_search_at"]) if (!realDate(c[k])) errors.push(`${c.id}: ${k} is not a real calendar date`);
for (const c of reg.claim_elements) if (!realDate(c.date_basis.date)) errors.push(`${c.id}: date_basis.date is not a real calendar date`);
for (const w of reg.withdrawn_claims) if (!realDate(w.withdrawn_at)) errors.push(`withdrawn claim: withdrawn_at is not a real calendar date`);
if (!realDate(reg.updated_at)) errors.push("updated_at is not a real calendar date");
const sourceById = new Map(reg.sources.map((s) => [s.id, s]));
const elementIds = new Set(reg.claim_elements.map((c) => c.id));
for (const s of reg.sources) {
  if ((s.date_basis === "unresolved") !== (s.published === null)) errors.push(`source ${s.id}: date_basis unresolved <=> published null`);
}
for (const c of reg.claim_elements) {
  for (const p of c.prior_art) if (!sourceById.has(p.source)) errors.push(`${c.id}: unknown source ${p.source}`);
  if (new Set(c.prior_art.map((p) => p.source)).size !== c.prior_art.length) errors.push(`${c.id}: duplicate prior_art source`);
  if (c.review_status === "approved" && !c.human_reviewer) errors.push(`${c.id}: approved without human_reviewer`);
  if (c.status === "withdrawn" && !reg.withdrawn_claims.some((w) => w.replaced_by.includes(c.id) || w.claim.includes(c.id))) errors.push(`${c.id}: withdrawn without withdrawn_claims entry`);
  if ((c.date_basis.kind === "unresolved") !== (c.date_basis.date === null)) errors.push(`${c.id}: date_basis unresolved <=> date null`);
}
for (const w of reg.withdrawn_claims) for (const id of w.replaced_by) if (!elementIds.has(id)) errors.push(`withdrawn claim replaced_by unknown ${id}`);
if (new Set(reg.claim_elements.map((c) => c.id)).size !== reg.claim_elements.length) errors.push("duplicate claim element id");
if (new Set(reg.sources.map((s) => s.id)).size !== reg.sources.length) errors.push("duplicate source id");
(function scanNumericConfidence(node, p) {
  if (Array.isArray(node)) node.forEach((v, i) => scanNumericConfidence(v, `${p}[${i}]`));
  else if (node && typeof node === "object") for (const [k, v] of Object.entries(node)) {
    if (/confidence/i.test(k) && typeof v === "number") errors.push(`numeric confidence at ${p}.${k}`);
    scanNumericConfidence(v, `${p}.${k}`);
  }
})(reg, "$");

if (errors.length) {
  console.error(`register.json: ${errors.length} error(s)`);
  for (const e of errors) console.error("  - " + e);
  process.exit(1);
}

// ---- render ----------------------------------------------------------------------------------
const esc = (s) => String(s).replace(/\|/g, "\\|").replace(/\n/g, " ");
const temporal = (src, c) => {
  if (!src.published || !c.date_basis.date) return "unresolved";
  if (src.published < c.date_basis.date) return "earlier";
  if (src.published > c.date_basis.date) return "later";
  return "same day";
};
const approved = reg.claim_elements.filter((c) => c.review_status === "approved").length;
const lines = [];
lines.push("# Prior art and claim register (generated view)");
lines.push("");
lines.push("> **Generated from [`docs/claims/register.json`](claims/register.json) by `docs/claims/verify-register.mjs` — do not edit this file by hand.**");
lines.push(`> Register version ${reg.register_version}, updated ${reg.updated_at}. ${approved} of ${reg.claim_elements.length} elements are human-approved; a pending element is not citable outside this repository.`);
lines.push(">");
lines.push("> This register exists so that nothing in this repository is described as first, novel, or independently");
lines.push("> converged without a dated, falsifiable statement and the prior art it was compared against. The");
lines.push("> earlier / later column is computed from publication dates; the relation column is a content relation only.");
lines.push("");
lines.push("## Policy");
lines.push("");
for (const [k, v] of Object.entries(reg.policy)) lines.push(`- **${k.replace(/_/g, " ")}**: ${v}`);
lines.push("");
lines.push("## Withdrawn claims");
lines.push("");
lines.push("| Claim | Withdrawn | Reason | Replaced by |");
lines.push("|---|---|---|---|");
for (const w of reg.withdrawn_claims) lines.push(`| ${esc(w.claim)} | ${w.withdrawn_at} | ${esc(w.reason)} | ${w.replaced_by.join(", ") || "—"} |`);
lines.push("");
lines.push("## Claim elements");
lines.push("");
lines.push("| Id | Claim | Status | Date basis | Confidence | Review | Last triage | Last comprehensive search |");
lines.push("|---|---|---|---|---|---|---|---|");
for (const c of reg.claim_elements) {
  const db = c.date_basis.date ? `${c.date_basis.kind} ${c.date_basis.date}` : c.date_basis.kind;
  lines.push(`| ${c.id} | ${c.claim} | ${c.status} | ${db} | ${c.confidence} | ${c.review_status}${c.human_reviewer ? ` (${esc(c.human_reviewer)})` : ""} | ${c.last_candidate_triage_at ?? "—"} | ${c.last_comprehensive_search_at ?? "never"} |`);
}
for (const c of reg.claim_elements) {
  lines.push("");
  lines.push(`### ${c.id} — ${c.claim}`);
  lines.push("");
  lines.push(`**Statement.** ${c.statement}`);
  if (c.not_claimed) { lines.push(""); lines.push(`**Not claimed.** ${c.not_claimed}`); }
  lines.push("");
  lines.push("**Evidence.**");
  for (const e of c.evidence_location) lines.push(`- ${e}`);
  if (!c.evidence_location.length) lines.push("- (none recorded)");
  lines.push("");
  lines.push("**Prior art compared.**");
  if (c.prior_art.length) {
    lines.push("");
    lines.push("| Source | Published | Earlier / later than this element | Relation | Note |");
    lines.push("|---|---|---|---|---|");
    for (const p of c.prior_art) {
      const s = sourceById.get(p.source);
      lines.push(`| [${s.identifier || s.id}](${s.url}) | ${s.published ?? "unresolved"} | ${temporal(s, c)} | ${p.relation} | ${esc(p.note)} |`);
    }
  } else lines.push("- (none: see unresolved)");
  if (c.unresolved.length) { lines.push(""); lines.push("**Unresolved.**"); for (const u of c.unresolved) lines.push(`- ${u}`); }
}
lines.push("");
lines.push("## Sources");
lines.push("");
lines.push("| Id | Kind | Title | Authors | Published (basis) | Retrieved | Note |");
lines.push("|---|---|---|---|---|---|---|");
for (const s of reg.sources) lines.push(`| ${s.id} | ${s.kind} | [${esc(s.title)}](${s.url}) | ${esc((s.authors || []).join(", ") || "—")} | ${s.published ?? "unresolved"} (${s.date_basis}) | ${s.retrieved_at ?? "—"} | ${esc(s.note || "")} |`);
lines.push("");
const rendered = lines.join("\n") + "\n";

if (process.argv.includes("--write")) {
  writeFileSync(OUT, rendered);
  console.log(`register.json: ok (${reg.claim_elements.length} elements, ${reg.sources.length} sources); wrote ${path.relative(process.cwd(), OUT)}`);
} else {
  const current = existsSync(OUT) ? readFileSync(OUT, "utf-8") : "";
  if (current !== rendered) {
    console.error("docs/prior-art.md is stale or missing; run: node docs/claims/verify-register.mjs --write");
    process.exit(1);
  }
  console.log(`register.json: ok (${reg.claim_elements.length} elements, ${reg.sources.length} sources); prior-art.md up to date`);
}
