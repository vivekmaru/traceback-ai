# Traceback Roadmap

Last updated: 2026-05-22

This roadmap is the stable product direction for Traceback. Use
`docs/execution-state.md` for the current operational milestone and live handoff
notes.

## Product Thesis

Traceback turns AI coding failures into local, reviewable prevention knowledge.
The long-term asset is a structured dataset and taxonomy of AI coding failure
patterns, backed by real evidence from PRs, reviews, CI, local sessions, and
eventually agent transcripts.

The product should stay local-first until review quality, redaction, and user
control are proven.

## Strategic Stance

Traceback started with a black-box-recorder CLI idea: capture a local AI coding
session, let the user mark failures, and generate a report plus prevention rule.

The current implementation deliberately validated the intelligence layer first
through GitHub PR/review evidence. That path is useful because existing PRs
already contain high-signal human review feedback, follow-up fixes, and merge
outcomes.

These are not competing directions. The current GitHub-import pipeline is the
backbone for failure intelligence; local session capture is the return path to
the original MVP.

## Current Mainline

The implemented pipeline is:

```text
import
-> extract
-> analyze
-> review
-> draft rules
-> rule review/edit decisions
-> proposed export artifact
```

The next product goal is to make this pipeline easier to inspect and trust before
adding apply automation or broader product surfaces.

## Phase 1: Validate Failure Intelligence

Status: mostly complete.

Built:

- Repo-local GitHub PR import.
- Normalized local records under `.traceback/`.
- Deterministic failure candidate extraction.
- Optional OpenAI enrichment over deterministic candidates.
- Conservative review decisions.
- Draft rule generation.
- Rule review/edit decision files.
- Controlled `AGENTS.md` proposal export.

Exit criteria:

- The pipeline can mine a known repo and produce useful failure candidates.
- The pipeline can generate reviewable prevention rules without modifying root
  instruction files.
- The pipeline remains local by default.

Remaining quality gaps:

- Category mapping is useful but noisy.
- Reviewing JSON and Markdown artifacts is too manual.

## Phase 2: Make Review Usable

Status: next.

Milestone: tiny local read-only review UI.

Goal:

Expose the pipeline's evidence chain in a local UI so users can inspect runs,
candidates, clusters, decisions, rules, and exports without hand-opening many
JSON and Markdown files.

Expected command:

```bash
traceback ui
```

Scope:

- Serve a local-only UI from the current repo.
- Read `.traceback/` artifacts.
- Show run/pipeline status.
- Show failure candidates grouped by PR, category, confidence, and source type.
- Show AI clusters and source evidence.
- Show review decisions.
- Show draft rules, rule decisions, and proposed exports.

Non-goals:

- No LLM calls.
- No upload.
- No login.
- No hosted backend.
- No GitHub App.
- No apply command.
- No automatic root file edits.

Exit criteria:

- A user can understand a Traceback run from the UI alone.
- The UI makes missing or incomplete pipeline stages obvious.
- The UI can show the current status/outcome quality gap instead of hiding it.

## Phase 3: Improve Trust And Signal Quality

Status: started after the first UI slice.

Milestones:

1. Thread-aware outcome/status detection. Implemented for GitHub review replies,
   resolved threads, and outdated threads.
2. Taxonomy/category tuning from real runs.
3. Evidence quality scoring.
4. Redaction checks for shareable/exportable artifacts.

Outcome/status detection should distinguish:

- `accepted`
- `resolved`
- `contested`
- `rejected`
- `superseded`
- `candidate`
- `unknown`

Exit criteria:

- Candidates are not all left as `candidate` when review replies and GitHub
  review-thread state provide stronger signal.
- Reports and UI views make uncertainty explicit.
- Status detection works on at least Traceback's own PRs and one richer external
  repo.

## Phase 4: Return To Local Session Capture

Status: future return to the original MVP.

Goal:

Add local black-box-recorder primitives that capture an AI coding session before
it becomes a PR.

Candidate commands:

```bash
traceback start "task description"
traceback mark "notable failure or correction"
traceback stop
traceback session report
```

Captured data should start small:

- Repo root.
- Branch.
- Start/end time.
- User task description.
- Git status before/after.
- Changed file list.
- Diff summary.
- Manual marks.

Later capture:

- Full diff, opt-in.
- Command outcomes.
- Agent transcript references where available.
- Package/framework metadata.

Exit criteria:

- A local session can produce failure candidates and prevention rules through the
  same downstream pipeline as PR imports.
- Session capture stays local and does not require users to switch AI coding
  tools.

## Phase 5: Controlled Application Workflow

Status: future, after review and trust improve.

Goal:

Help users compare proposed exports to existing instruction files without
silently modifying the repo.

Possible milestone:

- Controlled apply preview: show a diff between `.traceback/exports/<runId>/`
  and existing `AGENTS.md`.

Non-goals until explicitly approved:

- No automatic apply.
- No auto-commit.
- No push.
- No PR creation.

Exit criteria:

- Users can decide whether a proposed rule belongs in repo instructions.
- Backups and explicit confirmation exist before any file-writing apply command.

## Phase 6: Broader Product Surfaces

Status: later.

Possible surfaces:

- More export targets: `CLAUDE.md`, `.cursorrules`, Codex custom instructions.
- Private local/team dashboard.
- Redacted sharing workflow.
- GitHub App.
- Public anonymized failure index.
- Benchmark/eval dataset.

These are intentionally not next. They should be built only after the local
review loop produces trustworthy, useful artifacts.

## Operating Rules

- Build the next milestone only.
- Keep `.traceback/` as the local data boundary.
- Do not modify root instruction files unless a milestone explicitly permits it.
- Prefer reviewable artifacts over automation.
- Dogfood on real PRs and sessions before expanding scope.
- Update `docs/execution-state.md` after meaningful work.
