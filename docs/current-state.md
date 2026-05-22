# Traceback Current State

Last reviewed: 2026-05-22

This document summarizes the current repo state against the Notion plan
`AgentFail - AI Coding Failure Intelligence` and its current Traceback milestone
page.

## Product Thesis

The idea remains valid: AI coding agents produce repeatable failure patterns, and
those patterns can be captured, classified, reviewed, and turned into reusable
prevention rules.

The strongest current wedge is not a broad public failure index. It is a
local-first workflow that mines known, high-signal development evidence and
produces reviewable prevention artifacts.

## Current Execution Path

The repo now implements this pipeline:

```text
import
-> extract
-> analyze
-> review
-> draft rules
-> rule review/edit decisions
-> proposed export artifact
```

Supported commands:

```bash
traceback init
traceback import --prs <number>
traceback report
traceback extract
traceback analyze --dry-run
traceback analyze --provider openai
traceback review --run <runId> --policy conservative
traceback rules --run <runId>
traceback rules review --run <runId> --policy conservative
traceback rules export --run <runId> --target agents-md
```

This path is coherent with the strategy reset in the plan: use GitHub PR/review
history as a fast validation path while keeping data local, keeping outputs
reviewable, and avoiding automatic edits to repo instruction files.

## Completion Assessment

These percentages are directional, not a release promise.

| Scope | Completion | Notes |
| --- | ---: | --- |
| Current Traceback pipeline through reviewed rule export | 80% | The CLI path exists and is tested. The remaining work is mostly quality, UX, and outcome detection. |
| Original local black-box-recorder CLI MVP | 25% | The original `start`, `mark`, `stop`, command capture, and session capture workflow is not implemented. The repo intentionally validated via GitHub import first. |
| Broader product vision | 30% | CLI data pipeline exists, but no local UI, hosted/team surface, public index, redaction workflow, benchmark dataset, or deep agent/session telemetry exists yet. |

## Validation Evidence

Fresh local dogfood against this repo on 2026-05-22:

- Imported 8 merged PRs from `vivekmaru/traceback-ai`.
- Generated an import report with 8 PRs, 8 issue comments, 44 review comments,
  16 reviews, and 42 candidate AI/agent markers.
- Extracted 31 failure candidates.
- Generated a dry-run analysis package at
  `.traceback/analysis/runs/2026-05-22T12-59-06Z/` without calling an LLM.
- `bun test`, `bun run check`, and `bun run build` passed.

This validates that the current path is operational and useful for mining known
agent PR history.

## Main Gaps

1. Status and outcome detection is still weak. The fresh extraction marked all 31
   candidates as `candidate`, even though many review findings were later fixed
   and merged.
2. Category mapping is useful but noisy. Some rule-review and validation issues
   are currently classified as preview/output or stale-intent failures because
   the heuristic vocabulary is still broad.
3. The pipeline is file-based and developer-readable, but not ergonomic. A small
   local review UI would make review decisions and rule editing much easier.
4. The original local session recorder remains mostly unbuilt. That is
   acceptable for the current GitHub-first validation path, but it should be
   called out as a separate future track.
5. The repo has no redaction/export sharing workflow beyond local-only proposed
   artifacts.

## Recommended Next Work

1. Build the tiny local read-only review UI next. The current pipeline produces
   enough artifacts that JSON/Markdown review is becoming the main usability
   friction.
2. Track thread-aware outcome/status detection as the highest-value quality gap.
   Resolved, contested, accepted, rejected, and superseded states will materially
   improve report trust, but the first UI should make this gap visible rather
   than wait for it to be solved.
3. Keep `agents-md` as the only export target until the review loop proves
   durable. Add `CLAUDE.md` or `.cursorrules` export later, not now.
4. Treat the black-box-recorder commands (`start`, `mark`, `stop`) as a separate
   milestone after the GitHub-import workflow is demonstrably useful.
5. Periodically dogfood Traceback on its own PRs and one richer external repo
   before widening the taxonomy.

## Documentation Notes

The Notion current milestone page still labels Milestone 3.4 as in progress, but
the repo currently includes `traceback rules review` and PR #8 is merged. The
repo should be treated as the current source of implementation truth until the
Notion plan is updated.
