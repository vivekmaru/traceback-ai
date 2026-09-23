# Traceback Improvement Plan

Prepared: 2026-09-21

## Findings and corrections

- The latest local run is a dry run; useful provider output exists in an older run.
- Candidate counts describe the current extracted corpus, while clusters and rules
  describe a selected historical run. The UI must make that distinction explicit.
- A high resolved ratio is not evidence of a bug. GitHub thread resolution is an
  observed workflow state, not independent proof that code is correct.
- The UI currently attributes status to any latest reply, even a neutral reply.
  Inference and evidence presentation must use the same decision logic.
- Draft-rule learning scope is omitted by the UI projection; older artifacts are
  not necessarily missing the field.
- Taxonomy changes need held-out evaluation, not an endless series of adjustments
  to the same dogfood examples.

## Phase 1 — Usable, honest inspection (implement now)

1. Prefer the latest provider run with response and parsed analysis artifacts;
   fall back to the latest run when none is usable. Keep all runs chronological
   and manually selectable, and explain when an older run is selected.
2. Use readable mode/provider/count labels with exact run IDs still visible.
   Clearly distinguish current corpus counts from selected-run counts.
3. Show dry-run analysis as prepared, not completed. Block downstream commands
   until their prerequisites exist. Explain that provider analysis creates a new
   run, uses current candidates, and sends data only when explicitly invoked.
4. Display saved learning scopes, including an explicit unknown state when absent.
5. Return status provenance from the shared inference function: matching reply,
   GitHub resolution/outdated metadata, source uncertainty, or no outcome signal.
   Show matching and latest replies separately and flag stored-status mismatches.
   Keep extraction confidence distinct from outcome evidence; do not invent a
   numerical probability or silently rewrite persisted candidates in the UI.
6. Harden acknowledgement heuristics with positive/negative fixtures for negated,
   planned, conditional and neutral wording. Preserve thread-local inference,
   explicit-reply precedence, and valid GitHub resolution semantics.

Acceptance:

- Provider-first selection, dry-run-only and empty repositories behave sensibly.
- Neutral latest replies are never represented as confirmation; older matching
  replies and metadata-only outcomes are attributed correctly.
- Human decisions and existing artifacts remain untouched.
- Tests, typecheck and build pass; desktop/mobile browser checks exercise run
  switching, filters/reset/no-results, exports and missing-stage states.
- No new runtime dependencies, provider calls, uploads, root instruction changes,
  commits or deployment are part of this slice.

## Phase 2 — Measure signal quality before scoring

Status on 2026-09-23: local snapshots, full-text blind worksheets, draft agent
annotations, strict coverage/schema checks, snapshot hashes and provisional
baselines exist for Traceback, EventSnaps and held-out task-tracker. Human
adjudication and useful-rule validation are still open; Phase 2 has not met its
exit criteria. The focused hardening slice adds pre-provider candidate
validation, read-only UI boundaries and offline package/browser checks, not new
heuristic tuning or session capture. See `eval/README.md` for the evaluation
contract and `docs/execution-state.md` for verification and release gates.

- Build a manually labeled evaluation set from Traceback and at least two
  sufficiently different repositories, with authorized local imports.
- Split by repository/PR so related comments do not leak between tuning and
  held-out evaluation. Include missed findings as well as extracted candidates.
- Measure extraction precision/recall, category confusion and status accuracy
  separately. Report explicit replies and metadata-only outcomes separately.
- Audit whole heuristic families with positive/negative pairs before tuning.
- Complete provider-backed EventSnaps validation only with explicit approval to
  send the data and an ephemeral API key. Compare clusters, review decisions,
  rule usefulness and scope separation against the existing dry-run baseline.
- Introduce evidence tiers or calibrated scores only after labeled evaluation
  supports their meaning. Measure accepted useful rules, review time and repeat
  failures rather than treating candidate/export counts as success metrics.

Exit: a reproducible baseline, documented errors and evidence that new rules help
rather than merely increase output. Add run-list pagination only after observed
history size makes browsing cumbersome.

## Phase 3 — Local session capture

After the inspection/evaluation baseline, implement a separate vertical slice:

- `traceback start <task>`, `traceback mark <note>`, `traceback stop`, and
  `traceback session report`.
- Capture repo/branch, timestamps, task, git status boundaries, changed filenames,
  diff statistics and explicit user marks. No command interception, full diff or
  transcript ingestion by default.
- Define session-source provenance before adapting marks into the existing
  candidate → analysis → review → rules pipeline; do not fabricate PR identities.
- Test active-session lifecycle, duplicate starts, interrupted sessions, wrong-repo
  commands and secret boundaries. Keep capture tool-agnostic and local-only.

Exit: one real marked session produces a traceable, reviewable prevention lesson
through the same downstream pipeline without switching coding tools.

## Phase 4 — Controlled application and broader surfaces

- First show an export-to-instruction diff, redundancy/conflict warnings and
  explicit review. No automatic instruction edits, commits or pushes.
- Before any write/apply milestone, require backups and explicit confirmation.
- Add export formats only when users need them. Gate sharing/team services and a
  GitHub App on redaction tests, permission design and demonstrated local value.
- Consider an anonymized dataset or benchmark only with opt-in evidence and
  validated provenance; neither hosted infrastructure nor a public index is next.

## Delivery notes

Update `docs/execution-state.md` with actual implementation and verification
results. Future phases above are sequenced proposals, not completed features.
