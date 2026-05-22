# Traceback Execution State

Last updated: 2026-05-23

Read this file first in future sessions. It is the living operational tracker for
what to build next, what is out of scope, and what must be updated after work is
done.

For broader product direction, read `docs/roadmap.md`.

## Current Milestone

Tiny local read-only review UI.

Status: first slice implemented; provider-rich dogfood artifacts now available;
export output now emits instruction-ready `Traceback Learnings`.

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

## Known Quality Gap To Track

Thread-aware outcome/status detection is the highest-value quality gap.

The 2026-05-22 dogfood run extracted 31 candidates from Traceback's own merged
PRs, but all were still marked `candidate`. The tool is underusing the strongest
GitHub signals: review replies, resolved threads, contested findings, follow-up
commits, and merge outcomes.

This should not block the first UI milestone. Instead, the UI should make this
gap visible. After the first UI slice, status detection is a likely next
milestone.

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
- `./dist/cli.js ui --help` passed.
- Browser smoke loaded `http://127.0.0.1:4321/`, confirmed summary counts,
  warnings, tab switching, missing cluster/review empty states, and no console
  errors or warnings.

Environment note:

- `OPENAI_API_KEY` was not set in the Codex shell, but the user ran provider
  analysis successfully from their terminal.
- Dry-run analysis is still enough for local artifact-flow testing; provider
  output is now available for richer UI validation.

## Next Suggested Step

Use the read-only UI against
`.traceback/analysis/runs/2026-05-22T22-58-51Z/` and its review/rule/export
artifacts so the AI clusters, review decisions, and rules tabs can be checked
with richer data. After that, decide whether the next slice should be editable
rule review or thread-aware outcome/status detection.

## Update Rules

Update this file after meaningful work.

Keep updates short and practical:

- current milestone status
- completed files or commands
- verification evidence
- blockers
- next suggested step

Update `docs/roadmap.md` only when product direction changes.
