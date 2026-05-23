# Traceback Execution State

Last updated: 2026-05-23

Read this file first in future sessions. It is the living operational tracker for
what to build next, what is out of scope, and what must be updated after work is
done.

For broader product direction, read `docs/roadmap.md`.

## Current Milestone

Tiny local read-only review UI.

Status: first UI slice implemented; provider-rich dogfood artifacts now
available; export output now emits instruction-ready `Traceback Learnings`;
thread-aware outcome/status detection implemented for GitHub review replies,
resolved review threads, and outdated review threads; first taxonomy tuning pass
implemented from the refreshed dogfood run.

## Why This Is Next

Traceback now produces many local artifacts:

- imported PR records
- deterministic failure candidates
- analysis inputs and prompts
- AI-enriched records and clusters
- review decisions
- draft rules
- rule decisions
- proposed exports

Reviewing those through raw JSON and Markdown works for early development, but
it is already friction. The UI should make the evidence chain visible before
Traceback adds any apply workflow, hosted service, or broader product surface.

## Target Command

```bash
traceback ui
```

## Current Scope

Build a local-only UI served from the current repo.

The first UI is read-only. Editing rule decisions is useful, but not part of the
completed first slice.

The UI should read from `.traceback/` and show:

- runs overview and pipeline status
- failure candidates
- AI clusters
- review decisions
- draft rules
- rule decisions
- proposed exports

## Initial Screens

### Runs Overview

Show available runs and their pipeline state:

- imported PR count
- extracted candidate count
- analysis run status
- review decision count
- draft rule count
- rule decision count
- export status

### Failure Candidates

Show deterministic candidates grouped by:

- PR
- category
- confidence
- source type
- status

Each candidate should show source PR/comment links when available.

### AI Clusters

Show AI-enriched clusters with:

- title
- summary
- source candidates
- prevention rule
- confidence
- source PRs/comments

If a run has only dry-run artifacts and no provider output, show that clearly.

### Review Decisions

Show conservative review output:

- accepted
- accepted singleton
- needs validation
- needs cluster
- needs review
- rejected
- edited

### Rules And Exports

Show:

- draft rules
- rule decisions
- proposed `AGENTS.md` export
- export summary and warnings

## Non-Goals

- Do not call an LLM.
- Do not upload data.
- Do not add login.
- Do not build a hosted backend.
- Do not build a GitHub App.
- Do not implement apply/auto-commit.
- Do not modify root `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, or source files.
- Do not add session recorder commands in this milestone.

## Acceptance Criteria

- `traceback ui` starts a local UI. Done.
- The UI reads `.traceback/` from the current repo. Done.
- The UI can display the latest dogfood run. Done:
  `.traceback/analysis/runs/2026-05-22T12-59-06Z/`.
- Missing stages are visible rather than treated as errors. Done.
- The UI works without `OPENAI_API_KEY`. Done.
- Existing CLI behavior and tests still pass. Done.

Suggested verification:

```bash
bun test
bun run check
bun run build
./dist/cli.js ui --help
```

Browser smoke verified desktop and mobile-sized viewports.

## Status Detection Quality

Thread-aware outcome/status detection is now implemented for imported GitHub PR
records when `GITHUB_TOKEN` or `GH_TOKEN` is available.

Current behavior:

- Import writes normalized v3 records with `reviewThreads`.
- No-token imports continue with `reviewThreads: []`.
- Extraction rejects older v2 records with a re-import message.
- Same-thread replies can infer `resolved`, `accepted`, `rejected`, and
  `contested`.
- GitHub `isResolved` infers `resolved` when no stronger reply signal exists.
- GitHub `isOutdated` infers `superseded` when no stronger signal exists.
- PR merge alone does not mark a candidate resolved or accepted.

Remaining quality work:

- Improve candidate review UI filters/search/status evidence.
- Add evidence quality scoring after status/category quality is trustworthy.
- Validate on an external repository after the local loop feels sharper and less
  noisy.

## Return Path To Original MVP

The original black-box-recorder MVP is not abandoned. It is deferred until the
current intelligence pipeline is easier to inspect and trust.

Future session-capture commands:

```bash
traceback start "task description"
traceback mark "notable failure or correction"
traceback stop
traceback session report
```

The session recorder should eventually feed the same downstream candidate,
analysis, review, rules, and export pipeline.

## Last Verified State

Verified on 2026-05-23:

- `bun test` passed with 97 tests.
- `bun run check` passed.
- `bun run build` passed.
- `AGENTS.md` now includes curated Traceback learnings from the dogfood run.
- `docs/artifacts.md` documents `.traceback/rules/`,
  `.traceback/exports/`, and rule decision state semantics.
- `AGENTS.proposed.md` export now emits clean, paste-or-review-ready
  `Traceback Learnings`; provenance stays in export manifests, summaries, and
  rule artifacts.
- Fresh dogfood imported 8 merged PRs from `vivekmaru/traceback-ai`.
- Fresh dogfood extracted 31 failure candidates.
- Fresh dry-run analysis wrote
  `.traceback/analysis/runs/2026-05-22T12-59-06Z/`.
- Provider analysis wrote
  `.traceback/analysis/runs/2026-05-22T22-58-51Z/`.
- That provider run produced 31 enriched records and 6 clusters.
- Conservative review produced 6 review decisions:
  5 accepted and 1 needs validation.
- Draft-rule generation produced 5 draft rules and excluded 1 review decision.
- Conservative rule review accepted 5 rules.
- Export wrote 5 proposed `agents-md` rules to
  `.traceback/exports/2026-05-22T22-58-51Z/AGENTS.proposed.md`.
- The export reported no warnings and did not modify root repo instruction
  files.
- UI API smoke on `http://127.0.0.1:4322/api/state` showed the provider run as
  latest with provider output, 31 enriched records, 6 clusters, 6 review
  decisions, 5 draft rules, 5 rule decisions, and 5 exported rules.
- The UI now defaults to the latest run, scopes clusters/reviews/rules/exports
  to the selected run, shows pipeline-stage status with next commands for
  missing stages, and renders the proposed `Traceback Learnings` export text.
- Browser smoke on `http://127.0.0.1:4323/` confirmed the provider run is
  selected by default, the rules/export tab shows the `Traceback Learnings`
  proposal, desktop and mobile-sized viewports avoid horizontal overflow, and
  the temporary browser viewport was reset.
- `./dist/cli.js ui --help` passed.
- Browser smoke loaded `http://127.0.0.1:4321/`, confirmed summary counts,
  warnings, tab switching, missing cluster/review empty states, and no console
  errors or warnings.
- Thread-aware status detection slice added GitHub GraphQL review-thread import,
  normalized record schema v3, `superseded` candidate status, and UI status
  distribution.
- `bun test` passed with 106 tests.
- `bun run check` passed.
- `bun run build` passed.
- Fresh dogfood import with `GITHUB_TOKEN="$(gh auth token)" ./dist/cli.js
  import --prs 8` wrote v3 records with review-thread metadata.
- Fresh `./dist/cli.js extract` generated 31 candidates with status
  distribution: 28 `resolved`, 3 `candidate`.
- `./dist/cli.js ui --help` passed.
- UI API smoke on `http://127.0.0.1:4324/api/state` showed
  `statusCounts: { resolved: 28, candidate: 3 }` and no global warnings.
- Browser smoke confirmed the candidate tab renders the status distribution,
  the old all-candidate warning is absent, and desktop layout has no horizontal
  overflow.
- Refreshed downstream dogfood run from the current 31 candidates with
  thread-aware statuses.
- Fresh dry-run analysis wrote
  `.traceback/analysis/runs/2026-05-23T11-59-47Z/` with 28 `resolved` and 3
  `candidate` inputs.
- Provider analysis wrote
  `.traceback/analysis/runs/2026-05-23T12-02-59Z/`.
- That provider run produced 31 enriched records and 6 clusters.
- Conservative review again produced 6 review decisions:
  5 accepted and 1 needs validation.
- Draft-rule generation again produced 5 draft rules and excluded the
  low-confidence informational PR-body cluster.
- Conservative rule review accepted 5 rules.
- Export wrote 5 proposed `agents-md` rules to
  `.traceback/exports/2026-05-23T12-02-59Z/AGENTS.proposed.md`.
- Compared with the old provider run `2026-05-22T22-58-51Z`: counts were
  stable, but the new run more clearly labels the PR-body candidates from PRs
  #5, #7, and #8 as low-confidence informational records. The exported
  `Traceback Learnings` are clearer but substantively similar.
- Taxonomy/category tuning added explicit categories for human-editable
  artifact validation, identifier collision/record loss, status inference
  errors, and pagination boundary errors.
- Feature-summary PR bodies such as Traceback's own `## Summary` sections are
  no longer extracted as failure candidates unless they include explicit failure
  language.
- Local dogfood extraction after the taxonomy pass generated 28 review-comment
  candidates, 0 PR-body candidates, and 0 `unknown` categories from the current
  imported Traceback records.
- `bun test` passed with 111 tests.
- `bun run check` passed.
- `bun run build` passed.
- `./dist/cli.js extract` passed and wrote refreshed local failure candidates.
- `./dist/cli.js ui --help` passed.
- PR #11 follow-up tightened taxonomy signals that were still too broad:
  bare `rule-decisions`/`draft-rules` artifact mentions, bare
  `mapRecordsByCandidateId`, generic review-thread replies UI wording, and
  requested-PR/table truncation language no longer score the new Traceback
  categories without the relevant validation, collision, inference, or import
  boundary context.
- Regression coverage was added for those four false-positive shapes.
- `bun test` passed with 111 tests.
- `bun run check` passed.
- `bun run build` passed.
- `./dist/cli.js extract` passed and wrote refreshed local failure candidates.
- `./dist/cli.js ui --help` passed.
- Follow-up self-audit after PR #11 review churn tightened the remaining broad
  taxonomy signals found by applying the same learned rule across the pattern
  family: bare `accepted/edited`, generic `duplicate IDs`, overwrite/existing
  language, and `preserve sourceCandidateIds` no longer score the new taxonomy
  categories without artifact-validation or collision/record-loss context.
- `AGENTS.md` now documents the taxonomy guardrail: new category signals need a
  positive/negative fixture matrix, artifact/function/field names cannot score
  alone, and repeated review comments in one heuristic family should trigger a
  full-family audit before another push.
- PR #11 follow-up preserved categorized failure-cue PR summaries in the
  feature-summary suppression gate, so summaries such as parser failures on
  malformed input are not dropped just because they lack the narrower
  summary-specific wording.

Environment note:

- `OPENAI_API_KEY` is not stored in repo files or `.traceback/` artifacts.
- The user provided a temporary key for the refreshed provider run and plans to
  rotate it after use.

## Next Suggested Step

Build candidate review UI polish: filters, search, sorting, and status/evidence
visibility for the candidate list. Keep it read-only and local-only; the goal is
to make the tuned candidate set easier to inspect before evidence scoring or
external repo validation.

## Update Rules

Update this file after meaningful work.

Keep updates short and practical:

- current milestone status
- completed files or commands
- verification evidence
- blockers
- next suggested step

Update `docs/roadmap.md` only when product direction changes.
