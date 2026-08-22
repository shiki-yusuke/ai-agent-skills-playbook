# release-evidence/v0 — DRAFT

> **Status: DRAFT, deliberately unfrozen.** v1 freezes only after the first deploy adapter has
> been exercised against a real deployment (the Pages adapter against the agent-metrics
> dashboard, per the 2026-08-22 re-plan). Freezing an implementation-shaped contract before any
> implementation has consumed it is the premise_evidence mistake this repo's own history warns
> about. This draft has had one architect review round (sol, 2026-08-22: 11 must / 4 should /
> 4 ask, all reflected below); it has had zero implementations consume it, which is exactly why
> it is not v1.

Normative protocol for D5's **deployment state machine v1**: the Release Evidence Bundle sealed
before any deploy, and the append-only event ledger that carries one bundle's digest through
preview → (staging) → production. `release-observation/v0` (observation-only, no state machine)
remains valid and untouched for releases that happened outside this machine.

Conformance fixtures: [`contracts/release-evidence/v0/`](../../contracts/release-evidence/v0/)
— run `node contracts/release-evidence/v0/verify-fixtures.mjs` (zero dependencies, no network).

## Identity: release, attempt, seal

- A **release** is named by `release_id` (same identity release-observation/v0 uses).
- An **attempt** is `(release_id, bundle_digest)` — the unit the state machine folds over.
- A bundle is **sealed at `prepared`**: `bundle_digest` = sha256 over the bundle's JCS
  (RFC 8785) canonical bytes, and the bundle never changes afterward. A new tree, a corrected
  field, a deviation discovered late — each is a **new attempt starting at `prepared`**, never
  an edit. D5's own words ("a changed tree means release prepare starts over") are what make
  the attempt, not the release, the digest-invariant unit: the same version legitimately gets a
  second attempt after a failure, and folding per release would make that unrepresentable.
- JCS canonicalizes object keys but **preserves array order**, so array order is normative:
  `artifacts[]` sorted ascending by digest, `known_deviations[]` sorted ascending, duplicates
  forbidden in both (collection-checked). Two producers enumerating the same set must reach the
  same digest.

## Late evidence: the `attested` event

Some evidence structurally cannot exist at seal time: a lane's Phase-5 done overlay does not
exist while the PR is unmerged, and D5 itself puts preview at Phase 4 and production at
Phase 5. Editing the sealed bundle when that evidence arrives would change its digest and
restart the attempt — so late evidence arrives as an **`attested` event** (environment-less,
state-preserving) pinned to the same `bundle_digest`. v0 defines one attestation kind,
`lane_done_overlay`. The production gate for a lane-backed bundle is: a `lane_done_overlay`
attestation must precede `deployed|production` in the ledger (collection-checked).

`known_deviations` therefore means **deviations known at seal time only**. Anything discovered
later must not edit the bundle; v0 defines no late-deviation record yet (v1 will, informed by
the first real case — inventing its shape before one exists would be exactly the
fixture-before-evidence mistake).

## The state machine (enforced at collection level, per attempt)

```
(none) → prepared → preview_deployed → preview_verified
             │                            ├→ staging_deployed → staging_verified ┐
             │ (preview_skipped)          └──────────────────────────────────────┴→ production_deployed
             └────────────────────────────────────────────────────────────────────→ production_deployed
production_deployed → production_verified | failed | rolled_back
production_verified → failed | rolled_back
failed → rolled_back            (only if this attempt had reached production)
attested                        (legal anywhere after prepared; state unchanged)
failed, rolled_back             (otherwise terminal)
```

- **`failed` carries `failure_phase`** (`deploy` | `verification` | `post_verification`), and
  the fold checks it against the state the attempt was actually in: a deploy attempt itself can
  fail straight out of `prepared`/`preview_verified`/`staging_verified` (phase `deploy`); after
  a successful deploy the failure is `verification`; after `production_verified` it is
  `post_verification`. One overloaded kind with a machine-checkable phase, rather than three
  kinds, keeps the graph small while keeping release-observation's `verification_status`
  derivable.
- **`failed` does not erase the rollback record**: `failed → rolled_back` is legal when the
  attempt had reached production, and `rolled_back` requires `reason` so the withdrawal never
  loses its cause.
- **Staging is optional topology, but the skip is a recorded fact** (D5): a
  `preview_verified → production` jump requires `staging_skipped: true` on the deployed event,
  and the flag is forbidden when staging was actually used.
- **Some deploy targets have no preview tier at all** — the FIRST real adapter exercise
  surfaced this within hours of the draft merging: a scheduled GitHub Pages dashboard rebuild
  deploys straight to its production URL, with no preview environment in existence. Pretending
  the CI workspace is a "preview environment" would be a fabricated tier, so the graph instead
  admits `prepared → production` **only** when the event records `preview_skipped: true` plus a
  closed `preview_skipped_code` (same design as `staging_skipped`, same rationale as the
  bundle's omission codes: a gate can allowlist codes, not prose). This jump skips staging by
  definition, so `staging_skipped` is forbidden alongside it — one flag tells the whole story.
- **Rollback targets resolve**: `rollback_to_release_id` must name a *different* release that
  reached production *earlier in the same ledger*; a bundle's `rollback.previous_release_id`
  must differ from its own release and resolve within the checked collection.

## Cross-record truth: the digest is checked against the real bundle

A `bundle_digest` that merely repeats across events proves nothing. The
`release-collection` fixture type carries bundles and events together, and the verifier
recomputes each bundle's JCS sha256 and requires every event to resolve to a real bundle with a
matching `release_id`. Implementations MUST do the same: an event ledger without its bundles is
not evidence, it is a list of strings.

## Production gates (v0's checkable set)

At `deployed|production`, collection-checked: (1) lane-backed bundle ⇒ prior
`lane_done_overlay` attestation; (2) `review.decision = "commented"` is not a pass; (3) the
transition itself requires `preview_verified`/`staging_verified` (the graph). Gates that need
live systems (tree-digest equality against the actual merged branch, artifact read-back) are
the deploy adapter's job and are pinned by the adapter's own tests, not expressible in fixtures.

## Omission is coded, not prosed

`lane_ref: null` and `review: null` require structured `{code, note}` omission records with
**closed code enums** (`no_lane_scheduled_rebuild`, `multiple_contributing_lanes`,
`legacy_release_predates_contract`, …). A bare free-text reason would let any release opt out
of evidence by writing a sentence, and collapses "no lane exists" with "many lanes contributed"
— a distinction release-observation/v0 already documented as a known limit. A production-gate
policy can allowlist codes; it cannot allowlist prose.

## Relationship to release-observation/v0 — a projection, NOT a superset

An earlier draft of this document claimed naming was "a strict superset by construction." That
was **wrong** (sol must-1) and is withdrawn: fields were renamed and restructured. What holds
instead is a **defined projection** from `(bundle, ledger)` to observation events:

| observation/v0 field | derived from |
|---|---|
| `release_id` | `bundle.release_id` |
| `source_tree_digest` | `bundle.source.tree_digest` |
| `source_ref.{repo,ref,resolution}` | `bundle.source.{repo,ref,resolution}` (`ref` must be present to project) |
| `artifact_digest` / `artifact_ref` | the single projected artifact's `digest` / `artifact_ref` — a multi-artifact bundle projects **one observation event per artifact** |
| `environment` | the event's `environment` |
| `deployed_at` | the `deployed` event's `occurred_at` (UTC-Z on both sides by construction) |
| `verification_status` | `verified` ⇒ `verified`; `failed(verification)` ⇒ `failed`; deployed-but-never-verified ⇒ `not_measured` |
| `quality_status` | `failed(post_verification)` ⇒ `fail`; otherwise `not_measured` (v0's machine does not measure quality) |
| `rollback_of` | on the *replacement* release's observation: the `rolled_back` event's own release (note the direction: observation's `rollback_of` points from the new release to the one it replaces; the ledger's `rollback_to_release_id` points from the withdrawn release to its restore target — they are different edges of the same triangle and are NOT the same field) |
| `lane_id` | `bundle.lane_ref.lane_id` (absent when lane_ref is null) |

Projection preconditions: `bundle.source.ref` present; artifact has an `artifact_ref` when its
digest is real. A bundle that cannot satisfy them cannot be projected — that is a property of
the release's evidence, not a defect in the projection.

## Static-site content manifest (canonical form)

For `kind: static_site`, the deployed artifact's identity is a **manifest**: a single JSON
object mapping each file's path to `"sha256:<hex>"` of its bytes, where paths are relative,
POSIX-separated (`/`), NFC-normalized, contain no `.` or `..` segments and no leading slash,
and **exclude `release-manifest.json` itself** (it cannot contain its own digest). The
artifact `digest` is sha256 over the manifest object's JCS bytes; `content_manifest_digest` is
sha256 over the bytes of the `release-manifest.json` file actually placed into the site and
read back after deploy. Symlinks are not followed; a site that needs them fails preparation.
This section is normative for every implementation and every adapter; the first Pages adapter
exercise replaces the synthetic fixture values with measured ones.

## What v0 deliberately leaves out

- **Automatic anything.** `actor` has no `agent` member; automatic promotion and rollback are
  out of scope exactly as D5 defers them.
- **Signed integrity**, SLSA, SBOM — until the CI/deploy trust domains separate
  (`integrity.level` stays `digest_only`, `signature` stays null).
- **A late-deviation record** (see above) and **a supersession/current-production relation**:
  the fold is per release-attempt; "which release currently owns the production target" is a
  v1 question that needs a target identity v0 does not define.
- **trace/v1 relation promotion.** `incident_observed` / `rolled_back_to` stay reserved names
  in trace/v1 documentation; giving them shape is trace/v2 work.

## Fixture provenance

`accept-bundle-spec-lane-0-6-0.json` carries **real measured values** (2026-08-22: git
commit/tree from the `v0.6.0` tag, npm tarball sha256 fetched and hashed live, recipe/toolchain
digests hashed from the tag's own files). Static-site values and all event fixtures are
**synthetic shapes** — except that every `bundle_digest` inside a `release-collection` fixture
is the *real* JCS sha256 of the fixture's own bundle (the verifier recomputes it; a fabricated
digest cannot pass). The first Pages adapter exercise replaces the synthetic static-site values
with measured ones — the same exercise that gates v1.
