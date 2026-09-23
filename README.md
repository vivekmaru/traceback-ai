# Traceback AI

Traceback AI converts AI mistakes, fixes, and PR noise into useful local signal for
future agent instructions. The current CLI imports recent GitHub pull request
data into local files, then extracts deterministic candidate failure records
without calling an LLM. It can optionally enrich those deterministic candidates
with an OpenAI analysis run.

For product direction and planning, see [docs/roadmap.md](docs/roadmap.md),
[docs/execution-state.md](docs/execution-state.md), and the point-in-time
[docs/current-state.md](docs/current-state.md) snapshot. For local artifact
semantics, see [docs/artifacts.md](docs/artifacts.md).

## Requirements

- Bun 1.2+
- A git repository with an `origin` remote pointing at GitHub
- Optional: `GITHUB_TOKEN` or `GH_TOKEN` for private repositories, higher API
  rate limits, and GitHub review-thread status metadata

## Setup

```bash
bun install
```

## Usage

This is a source-built local preview, not a published production package. Build
from the Traceback checkout after setup:

```bash
bun run build                  # creates executable dist/cli.js
./dist/cli.js --help            # lists available commands
./dist/cli.js --version         # prints 0.1.0
```

To inspect another repository, invoke this bundle by its absolute path **while
your shell is inside the target git repository**. In the examples below,
`traceback` means that executable (or a shell alias pointing to it). The
`bun run traceback` shortcut works only in the Traceback checkout, not in an
arbitrary target repository. Bun must remain installed to run the bundle.

Start with `traceback init`, then `traceback import --prs 5` (GitHub read access),
`traceback report`, `traceback extract`, and `traceback analyze --dry-run`.
These create local artifacts without sending evidence to an AI provider. Open
`traceback ui` to inspect them. Import reports its PR count; extraction reports
its candidate count; dry-run prints the new analysis-run directory.

**Stop before provider mode unless you approve sharing the selected evidence.**
Review the generated `input.json` and `prompt.md` first. Optional provider mode
requires `OPENAI_API_KEY` and sends current candidates to OpenAI; it creates a
new run rather than replaying the inspected dry run.

Review, rule generation, and export require a completed provider run. Replace
`<runId>` in their command examples with the directory name printed by that
provider analysis, not a dry-run ID. These downstream stages are local-only and
write proposals; they do not apply instructions to your repository.

The bundled offline flow is exercised in `tests/cli-smoke.test.ts` from a fresh
repository using synthetic provider output. No live provider call is made by
that test.

## Commands

### `traceback init`

Creates the local Traceback AI working directory:

```text
.traceback/
├── imports/
├── records/
│   └── failures/
├── analysis/
│   └── runs/
└── reports/
```

### `traceback import --prs <number>`

Detects the git repo root, reads `remote.origin.url`, infers the GitHub
`owner/repo`, and imports the most recently updated pull requests.

Supported remote formats:

- `https://github.com/owner/repo.git`
- `https://github.com/owner/repo`
- `git@github.com:owner/repo.git`
- `ssh://git@github.com/owner/repo.git`

For each PR, Traceback AI stores:

- raw GitHub data in `.traceback/imports/pr-<number>.json`
- normalized local records in `.traceback/records/pr-<number>.json`

Imported data includes PR metadata, issue comments, review comments, reviews,
basic diff/file stats, and simple candidate AI/agent markers found in bodies,
comments, reviews, and authors. When `GITHUB_TOKEN` or `GH_TOKEN` is available,
Traceback also imports GitHub review-thread metadata from GraphQL, including
resolved/outdated state and review comment IDs. Without a token, import keeps
working and records `reviewThreads: []`.

For private repositories, export a GitHub token before importing. Traceback AI
reads either `GITHUB_TOKEN` or `GH_TOKEN`, so you can use whichever environment
variable already fits your workflow. If you are already authenticated with the
GitHub CLI, this is usually enough:

```bash
gh auth status
export GITHUB_TOKEN="$(gh auth token)"
traceback import --prs 20
```

`GH_TOKEN` works too:

```bash
export GH_TOKEN="$(gh auth token)"
traceback import --prs 20
```

When running the built CLI directly, use the absolute `dist/cli.js` path from
your Traceback checkout in place of `traceback`, keeping the target repository
as your working directory. Prefer supplying tokens only to the import process
rather than persisting them in repository files.

If import returns a GitHub 404 for a repository that exists, the token may be
missing access to a private repository. Re-run `gh auth status`, export
`GITHUB_TOKEN` or `GH_TOKEN` with a token that can access the repo, and retry the
import. Traceback AI does not perform OAuth, browser login, GitHub App auth, or
credential storage.

### `traceback report`

Reads `.traceback/records/` and writes:

```text
.traceback/reports/import-summary.md
```

The report summarizes imported PR counts, merged PRs, comments, reviews, review
comments, and candidate AI/agent markers.

### `traceback extract`

Reads normalized PR records from `.traceback/records/` and writes deterministic
failure candidates under:

```text
.traceback/records/failures/
```

It also writes:

```text
.traceback/reports/failure-candidates.md
```

Candidate records preserve source references back to the PR and, when available,
the source comment or review URL. The extractor scans PR bodies, issue comments,
review comments, and reviews for conservative keyword findings such as regressions,
lost query state, hardcoded environment contracts, preview/output mismatches,
security/privacy risks, parser permissiveness, and user input loss.

The deterministic extractor is tuned for review findings like renderer output
omissions, user input resets during refetch, sensitive auth/header forwarding,
query state drops, and render-time side effects.

The extraction is intentionally heuristic. It assigns candidate categories,
rough severity when priority badges or priority words are present, confidence,
status hints from same-thread replies and imported review-thread state, and
detected AI/agent markers. Candidate statuses can include `candidate`,
`resolved`, `accepted`, `rejected`, `contested`, `superseded`, and `unknown`.
`superseded` means GitHub marked the review thread outdated without stronger
reply or resolution evidence. Re-running `traceback extract` refreshes
`.traceback/records/failures/` instead of appending duplicates.

Records imported before review-thread support use an older normalized schema.
If extraction asks you to re-import, run `traceback import --prs <number>` again
before `traceback extract`.

### `traceback analyze --dry-run`

Reads deterministic failure candidates from:

```text
.traceback/records/failures/
```

Then writes a fresh local analysis run without calling any model provider:

```text
.traceback/analysis/runs/<runId>/
├── manifest.json
├── input.json
└── prompt.md
```

Dry-run mode is useful for reviewing exactly what would be sent to an AI provider.
It does not read raw PR import data directly; it only packages the deterministic
failure candidates produced by `traceback extract`.

The generated `input.json` is intentionally compact. It includes candidate IDs,
source PR numbers and URLs, source comment URLs when available, source type,
deterministic category/severity/confidence/status, evidence excerpts, detected
agent markers, and a short surrounding summary for grouping.

### `traceback analyze --provider openai`

Reads the current deterministic failure candidates from
`.traceback/records/failures/`, generates a fresh analysis run, sends the generated
prompt/input to OpenAI, and writes the provider response plus split local outputs:

```text
.traceback/analysis/runs/<runId>/
├── manifest.json
├── input.json
├── prompt.md
├── response.json
├── enriched-records.json
├── clusters.json
└── analysis-summary.md
```

Set `OPENAI_API_KEY` before running provider mode:

```bash
export OPENAI_API_KEY="..."
traceback analyze --provider openai
```

`TRACEBACK_OPENAI_MODEL` can override the default model. `OPENAI_MODEL` is also
respected when `TRACEBACK_OPENAI_MODEL` is not set.

Provider mode prints a warning before sending selected local PR/comment evidence
to OpenAI. If `OPENAI_API_KEY` is missing, it fails clearly after preserving the
generated `manifest.json`, `input.json`, and `prompt.md` in the run directory for
debugging.

`enriched-records.json` contains records with:

- `id`
- `sourceCandidateIds`
- `title`
- `failureType`
- `summary`
- `whatTheAgentMissed`
- `evidenceSummary`
- `likelyFixOrCorrection`
- `preventionRule`
- `confidence`
- `sourcePrs`
- `sourceComments`
- `notes`

`clusters.json` contains related candidate groups with:

- `id`
- `title`
- `summary`
- `candidateIds`
- `failureTypes`
- `sourcePrs`
- `evidenceSummary`
- `whatTheAgentMissed`
- `preventionRule`
- `confidence`

Traceback validates that AI outputs only reference known deterministic candidate
IDs before writing the split analysis artifacts.

The analysis report also warns when an enriched record references a source
candidate that is not represented in any cluster. Unclustered records are not
dropped; the review step preserves them as decisions that need clustering.

### `traceback review --run <runId> --policy conservative`

Reads a completed analysis run from:

```text
.traceback/analysis/runs/<runId>/
```

Then writes local, non-interactive review decisions:

```text
.traceback/reviews/<runId>/
├── decisions.json
└── review-summary.md
```

Review does not call an LLM, upload data, modify repository source files, or
generate repo instruction files. It is a deterministic checkpoint between AI
analysis and any future rule-generation command.

The conservative policy writes one decision for each cluster plus singleton
decisions for enriched records that are not represented by any cluster.

Decision values include:

- `accepted`
- `accepted_singleton`
- `needs_validation`
- `needs_cluster`
- `rejected`
- `needs_review`
- `edited`

The current conservative policy is intentionally cautious:

- High-confidence clusters backed by review-comment candidates become `accepted`.
- Low-confidence PR-body-only clusters become `needs_validation`.
- Unclustered enriched records become `needs_cluster`.
- Missing or inconsistent source references become `needs_review`.
- Ambiguous items default to `needs_review` or `needs_validation`, not accepted.

This review command does not generate rules; the separate `rules` command
consumes eligible reviewed decisions.

### `traceback rules --run <runId>`

Reads local review decisions from:

```text
.traceback/reviews/<runId>/decisions.json
```

Then writes draft rule artifacts:

```text
.traceback/rules/<runId>/
├── draft-rules.json
└── draft-rules.md
```

Draft rules are generated only from decisions marked `accepted`,
`accepted_singleton`, or `edited`. Decisions such as `needs_validation`,
`needs_cluster`, `needs_review`, and `rejected` are listed as excluded and are not
converted into draft rules.

This command is still local-only and does not modify `AGENTS.md`, repository
instruction files, source code, GitHub, or hosted services. The generated rules
are reviewable drafts, not applied policy.

### `traceback rules review --run <runId> --policy conservative`

Reads existing draft rule outputs from:

```text
.traceback/rules/<runId>/
├── draft-rules.json
└── draft-rules.md
```

Then writes a local rule-review layer:

```text
.traceback/rules/<runId>/
├── rule-decisions.json
└── rule-review.md
```

Rule review is deterministic and local-only. The conservative policy accepts
high-confidence draft rules that appear to come from accepted clusters and keep
source references intact. It marks low-confidence, singleton, ambiguous, or
incomplete rules as `needs_edit` where detectable. It only rejects rules
automatically when the instruction is empty or source references are missing.

Each rule decision includes:

- `ruleId`
- `runId`
- `decision` (`accepted`, `rejected`, `needs_edit`, or `edited`)
- `title`
- `editedTitle`
- `instruction`
- `editedInstruction`
- `rationale`
- `editedRationale`
- `sourcePrs`
- `sourceCandidateIds`
- `confidence`
- `reason`
- `notes`
- `reviewedAt`

The decision file is intended to be human-editable. You can also normalize a
manually edited decision file back into the run directory:

```bash
traceback rules review --run <runId> --policy conservative --from <path>
```

### `traceback rules export --run <runId> --target agents-md`

Reads existing draft rule outputs from:

```text
.traceback/rules/<runId>/
├── draft-rules.json
└── draft-rules.md
```

When present, export also reads:

```text
.traceback/rules/<runId>/rule-decisions.json
```

Then writes a controlled, human-reviewable export under:

```text
.traceback/exports/<runId>/
├── AGENTS.proposed.md
├── export-summary.md
└── manifest.json
```

The only supported export target is currently `agents-md`.

If rule decisions are present, export considers only decisions marked
`accepted` or `edited`; `rejected` and `needs_edit` rules are excluded. For
edited rules, `editedTitle`, `editedInstruction`, and `editedRationale` are used
when present. If rule decisions do not exist, export falls back to the existing
draft-rule behavior and exports accepted draft rules directly.

`AGENTS.proposed.md` is clean proposed instruction text for repo-level agent
guidance. It is intentionally paste-or-review-ready: source PRs, candidate IDs,
confidence labels, and review-decision metadata stay in `manifest.json`,
`export-summary.md`, and `.traceback/rules/<runId>/`.

Traceback also separates broader lessons from repo-specific guidance. Draft
rules carry a `learningScope` of `repo_specific`, `general_engineering`, or
`process_or_workflow`. Only `repo_specific` rules are emitted to
`AGENTS.proposed.md`; broader engineering and workflow lessons are preserved in
`broader-learnings.md` for review without turning them into repo instruction
text.

If no exportable rules exist, Traceback writes `export-summary.md` and
`manifest.json` with a clear warning and does not create a misleading
`AGENTS.proposed.md`.

Safety boundaries:

- The command does not call an LLM.
- The command does not upload data.
- The command does not modify root `AGENTS.md`.
- The command does not modify root `CLAUDE.md`.
- The command does not write `.cursorrules`.
- The command does not modify source files, GitHub, or hosted services.
- The command does not apply the proposed instructions automatically.

### `traceback ui`

Starts a local, read-only review UI for inspecting Traceback artifacts from the
current repository:

```bash
traceback ui
```

By default, the UI binds to `127.0.0.1:4317`. Only loopback hosts (`127.0.0.1`,
`localhost`, or `::1`) are accepted; this is not a LAN or hosted server. You can
choose another local port:

```bash
traceback ui --host 127.0.0.1 --port 4321
```

The UI reads `.traceback/` and shows:

- pipeline summary counts
- candidate status distribution
- selectable analysis runs and missing-stage guidance
- deterministic failure candidates
- selected-run AI clusters when provider output exists
- selected-run review decisions
- selected-run draft rules, rule decisions, and exports
- proposed `Traceback Learnings` text from `AGENTS.proposed.md` when present

Safety boundaries:

- The UI does not call an LLM.
- The UI does not upload data.
- The UI does not modify root instruction files or source files.
- The UI does not apply proposed rules automatically.
- Requests must target a loopback authority on the server port. Foreign origins
  and non-read methods are rejected; artifact responses are not cached.
- The UI rejects symlinks under `.traceback/`, including the data directory
  itself, and unsafe manifest filenames. This is not a sandbox against
  concurrent local filesystem mutation or other software running as you.

## Privacy Model

Traceback AI is local-first, with an explicit provider-upload mode:

- Raw data stays under `.traceback/`.
- `traceback init`, `traceback import`, `traceback report`, `traceback extract`,
  and `traceback analyze --dry-run` do not send failure candidates to an LLM.
- `traceback analyze --provider openai` sends only the deterministic failure
  candidates and generated prompt for the current run to OpenAI.
- Provider mode never replays an arbitrary old dry-run prompt; it generates a
  fresh run from current `.traceback/records/failures/` state.
- `traceback review` is local and non-interactive; it only reads analysis files
  and writes review files under `.traceback/reviews/`.
- `traceback rules` is local; it only reads review decisions and writes draft
  rule files under `.traceback/rules/`.
- `traceback rules review` is local; it only reads draft rules and writes
  review decisions under `.traceback/rules/<runId>/`.
- `traceback rules export` is local; it reads draft rules and optional rule
  decisions, then writes proposed output under `.traceback/exports/<runId>/`.
- `traceback ui` starts a local-only read-only UI for inspecting `.traceback/`
  artifacts.
- No hosted service, GitHub App, or TUI is started.
- Repo instruction files such as `AGENTS.md` are not generated or modified.

`.traceback/` is ignored by git because imported PR data can contain private
code, comments, diffs, and review context.

## Development

```bash
bun test
bun run check
bun run build
```

## Known Limitations

- Evaluation labels remain agent-reviewed drafts pending human adjudication;
  provisional holdout precision is 85% and recall is 50%, with category accuracy
  only 35.3% on detected findings. This is not production-readiness evidence.
- Clean build and portable-tarball execution were verified on macOS arm64 with
  Bun 1.3.6. Linux, Windows, and installed-package workflows remain unverified.
- Persisted candidate input is validated before analysis; full runtime schemas
  for every historical UI artifact remain incomplete.
- GitHub API access is read-only and best-effort.
- Large repositories may hit unauthenticated rate limits without a token.
- GitHub review-thread metadata requires `GITHUB_TOKEN` or `GH_TOKEN`; without a
  token, statuses can still use REST review-comment replies but not
  resolved/outdated thread state.
- The importer fetches recent PRs by GitHub's updated ordering.
- Candidate AI/agent markers are heuristics, not classification.
- Failure candidates are deterministic signals, not final AI classification.
- Traceback generates proposed instruction artifacts, but does not apply them
  to root repo instruction files.
- OpenAI analysis output is written locally for review; it is not treated as an
  automatic source of repo instructions.
- Rule review is file-based and non-interactive; the local UI can inspect rule
  decisions but does not edit them yet.

## Next Steps

- Human-adjudicate the provisional three-repository evaluation before treating
  metrics as release gates; see [eval/README.md](eval/README.md).
- Improve extraction recall and category accuracy on development sets, without
  tuning against held-out errors. Defer numerical evidence scoring.
- Validate live provider behavior only with explicit data-sharing approval, and
  verify supported platforms before expanding distribution.
- Keep editable review, session capture, and guarded apply workflows deferred
  until the read-only evidence loop is trustworthy.
