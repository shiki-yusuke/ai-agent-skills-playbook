# cognitive-ack/v0 CHANGELOG

Same convention as `contracts/release-approval/v0/CHANGELOG.md`: an entry here records an
**in-place revision of a still-DRAFT contract** and why it was not cut as a new version.

This contract tracks two revisions separately:

- **schema revision** — `cognitive-ack-record.schema.json`, the shape of one record.
  Currently **draft_revision 1**.
- **conformance-profile revision** — what `verify-fixtures.mjs` accepts (record rules R1–R4 and
  composite rules C1–C8 over `{approval_source, approval_events, ack_records, ingest}`).
  Currently **draft_revision 1**.

## Pinned upstream

- `contracts/release-approval/v0/release-approval-event.schema.json`, schema draft_revision 1,
  pinned by content in `verify-fixtures.mjs` as `RELEASE_APPROVAL_SCHEMA_SHA256`:
  `30fc6749e99d097b684baa228ab4feaa28caaad8da31c1a9a2f44539d3541dd3`, computed with
  `shasum -a 256 contracts/release-approval/v0/release-approval-event.schema.json`.
  When that file changes, this verifier exits 1 (`release_approval_schema_drift`) until an entry
  here records the follow-up and the constant is updated. This coupling is intended.

## 2026-10-19: draft_revision 1 — 初版（合意 §F 後半）

Initial schema and conformance profile. authority: none — the contract records the approver's own
self-report inside the approval operation and gates nothing. See
[`docs/protocols/cognitive-ack-v0.md`](../../../docs/protocols/cognitive-ack-v0.md).

- Record: `basis: "self_report"` and `authority: "none"` are constants; no property admits a number.
- Composite verdict is the ack ledger's only (`checkAckLedger -> {verdict, problems}`); nothing in
  the output describes the approval.
- `approval_unresolvable` is covered by `verify-fixtures.test.mjs` (unit tests calling
  `checkAckLedger` directly), not by `expected-results.json`: an approval ledger that fails
  release-approval/v0's schema / event_id check cannot pass this contract's input boundary
  (`approval_source` JCS identity) in the first place.
