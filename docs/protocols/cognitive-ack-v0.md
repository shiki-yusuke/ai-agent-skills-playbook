# cognitive-ack/v0

> **Status: DRAFT — NOT FROZEN. authority: none.** Schema **draft_revision 1**, conformance
> profile **draft_revision 1** (see [`CHANGELOG.md`](../../contracts/cognitive-ack/v0/CHANGELOG.md)).
> Part of the Evidence-Closed Delivery Shadow Evidence Contracts (agreement §F, second half).

Normative protocol for a **cognitive-ack record**: the approver's own self-report, recorded inside
the same approval operation as a [`release-approval/v0`](release-approval-v0.md) event, about one or
more related high-risk scopes of the change being approved.

Conformance fixtures: [`contracts/cognitive-ack/v0/`](../../contracts/cognitive-ack/v0/) — run
`node contracts/cognitive-ack/v0/verify-fixtures.mjs` and
`node --test contracts/cognitive-ack/v0/verify-fixtures.test.mjs` (zero dependencies, no network).

## Purpose and non-purpose

- An ack **records what the approver said** — `acknowledged`, `held`, or `rejected` — and nothing
  more. It is a self-report, **not proof of understanding**, and is never described as one
  (`basis` is the constant `"self_report"`).
- **The only judge is the approver.** No generator, scoring model, or reviewer has a veto; there is
  no field that can carry a score or confidence (no property admits a number, R4).
- **It gates nothing.** A `release-approval/v0` approval completes with no ack record at all, and
  with an ack whose scope explanations (evidence-docs `explanation`, F1) were removed (C1, C7).
  Stopping because of non-understanding is the approver's own `held` / `rejected` — expressed as a
  release-approval/v0 rejection or revocation, never by this contract.
- **Target**: high-risk scopes — `privilege_boundary`, `authority_dag`, `contract_change`,
  `impact_scan_deviation`. Related scopes are asked as one question: one record, several `scopes`.
  Low-risk scopes are recorded only as sampled calibration (`sampled: true`).

## Trust boundary — what the verifier can and cannot show

- That an ack is the approver's own self-report **cannot be proven from the record**. The assurance
  sits on the **same boundary as release-approval/v0**: the approval event and the ack record land
  on `main` in the same commit (`operation.commit_oid`), and the ledger is written only by the
  workflow (B1b). An ingester — the same role as release-evidence's `authority_ingested` — records
  which commit and path it read each item from; that envelope is `ingest` in the composite and lives
  outside the record (a record cannot carry the hash of the commit that contains it).
- This verifier checks only that the declared commits match (C5) and that the principal equals the
  approval's (C3). It makes no claim about authentication or identity. A generator that copies the
  principal to forge an ack needs the same write access as forging the approval itself — the same
  threat as release-approval/v0, not a weakness specific to acks.
- **Input boundary = a verified ledger.** A consumer MUST pass only an approval ledger that
  release-approval/v0's own verifier accepted. Fixtures declare this as `approval_source` (a
  release-approval/v0 `accept-composite-*.json` file name); the verifier reads that file and requires
  `approval_events` to be JCS-identical (whole array). A mismatch or a missing file is a **broken
  fixture** (exit 1), not a reject — this is an input check, not an approval judgement.
- The verifier **never judges the approval**. Composite approval events are only used to resolve
  references: they are re-validated against release-approval/v0's schema with the shared
  `createValidator` and their `event_id` is recomputed with the shared JCS helper. An ack pointing
  at an event that fails this (schema, `event_id`, duplicate `event_id`) is rejected as
  `approval_unresolvable` — a verdict on the ack, not on the approval.
- **Drift**: the verifier pins release-approval/v0's event schema by the sha256 of its bytes
  (`RELEASE_APPROVAL_SCHEMA_SHA256`). Any change to that schema stops CI here until this contract's
  CHANGELOG follows it — an intended coupling. Semantic drift of release-approval/v0's verifier
  surfaces through the `approval_source` identity check when its accept fixtures change.

## Record shape (`cognitive-ack-record.schema.json`)

`schema_version` (`"cognitive-ack/v0"`), `record_id` (`"sha256:" + sha256hex(JCS(record without
record_id))`, recomputed), `authority` (`"none"`), `approval_event_id`, `principal`
(`{principal_id, issuer, role_snapshot}`, same shape as release-approval/v0), `occurred_at` (UTC
`Z`, real calendar date), `self_report`, `basis` (`"self_report"`), `scopes[]`
(`{kind: "impact-scan:v1", scope_digest, risk_class, risk_reason, explanation_id, explanation_present}`),
optional `sampled`. `additionalProperties: false` at every level.

## Rules

Record-level:

- **R1** schema; `record_id` recomputation; `occurred_at` is a real calendar timestamp.
- **R2** `risk_class == "high"` ⇔ `risk_reason != "none"`; `scope_digest` unique within a record; an
  all-low record MUST carry `sampled: true`; a record with any high scope MUST NOT carry `sampled`.
- **R3** `explanation_present == (explanation_id !== null)`.
- **R4** no number value anywhere in the record, whatever its key.

Composite (`{approval_source, approval_events, ack_records, ingest}`, closed; evaluated per ack
record, and one violating record makes the composite's ack verdict `reject`):

- **C1** no veto / no gate: empty `ack_records` is `accept` whatever the approval events are. Other
  approval events without an ack never affect the verdict. Fixtures exist for the kinds present in
  release-approval/v0's accept composites (`approval_granted`, `break_glass_approve`,
  `approval_revoked`); `approval_rejected` has no such fixture and follows the same rule.
- **C2** `approval_event_id` resolves within `approval_events` (dangling → reject). An approval that
  was revoked away or never ingested leaves the ack an orphan, rejected here — the treatment of a
  non-atomic write.
- **C3** `principal` is JCS-equal to the referenced approval's `principal`.
- **C4** `acknowledged` pairs with any kind; `held` / `rejected` pair only with `approval_rejected`
  or `approval_revoked` (saying "hold" while approving is a contradiction).
- **C5** `ingest[record_id]` and `ingest[approval_event_id]` both exist with equal `commit_oid`
  (40 hex); every `ingest` key belongs to an approval event or ack record of the composite; `path` is
  a non-empty repo-relative path without `..`; the ack's `occurred_at` is not after the approval's.
  There is no lower time bound: "within the operation" rests on the same-commit binding.
- **C6** at most one ack record per `approval_event_id`; no duplicate `record_id`.
- **C7** `acknowledged` with `explanation_present: false` scopes is `accept`.
- **C8** coverage — whether every high-risk scope of a release has an ack — is **not** checked: the
  release's scope set lives in the lane, not here. Coverage is an F3 measurement.

## One verdict, about the ack ledger only

`checkAckLedger(composite)` returns exactly `{verdict: "accept" | "reject", problems}` — the ack
ledger's quality. There is no field about the approval; approval validity is release-approval/v0's
alone. Consumers **MUST NOT** use this verdict (or the absence of an ack) to block, delay, or
condition a promotion, an approval, or a promotion-receipt predicate.

## What the verifier never does

- It does not score or grade understanding.
- It does not affect release-approval/v0 or promotion outcomes.
- Authority contracts and shared helpers do not read it: the verifier exits 1 if any file under
  `contracts/release-approval/`, `contracts/promotion-receipt/`, `contracts/release-evidence/`,
  `contracts/shared/`, or the protocol docs of those three contracts contains the string
  `cognitive-ack`. Mentions are allowed only in `contracts/cognitive-ack/**`, this document, the
  addendum of `docs/evidence-closed-delivery-frozen-decisions.md`, and this contract's CHANGELOG.

## What v0 cannot guarantee

1. A consumer **outside** this repository's authority contracts and shared helpers could still gate
   on `checkAckLedger().verdict`; v0 stops that only by the dependency scan and this document's
   MUST NOT. A static test in release-evidence asserting it never references this contract is a
   follow-up (separate PR).
2. "Inside the approval operation" is guaranteed only up to the same-commit binding of the
   ingester's envelope; v0 has no authenticated operation ID. Re-wrapping an old self-report into
   the current commit requires the same write access as the approvals ledger.
3. The record's content does not prove who wrote it.

## Inputs to F3

`occurred_at`, `scopes[].risk_class`, `self_report`, `scopes[].explanation_present` (and coverage,
C8, computed there against the lane's scope set).

## Deliberately left out of v0

- Who selects high-risk scopes: the approver transcribes the lane estimate's `risk_class`.
- The sampling rate for low-risk calibration.
- Any ack UI.

## Why release-approval/v0 is not changed

release-approval/v0 is still DRAFT, but B1b agreed it would not change for this. This contract
pins that schema's draft_revision 1 by content and follows any drift in its own CHANGELOG; nothing
in release-approval/v0, promotion-receipt/v0, or release-evidence/v0 refers back here.
