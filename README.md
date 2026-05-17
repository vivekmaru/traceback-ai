# Traceback AI

Traceback AI converts AI mistakes, fixes, and PR noise into useful local signal for
future agent instructions. The current CLI imports recent GitHub pull request
data into local files, then extracts deterministic candidate failure records
without calling an LLM.

## Requirements

- Bun 1.2+
- A git repository with an `origin` remote pointing at GitHub
- Optional: `GITHUB_TOKEN` or `GH_TOKEN` for private repositories or higher API
  rate limits

## Setup

```bash
bun install
```

## Usage

Run commands from inside the repository you want to inspect.

```bash
bun run traceback init
bun run traceback import --prs 5
bun run traceback report
bun run traceback extract
```

After building, the bundled CLI is available at `dist/cli.js`:

```bash
bun run build
./dist/cli.js init
./dist/cli.js import --prs 5
./dist/cli.js report
./dist/cli.js extract
```

## Commands

### `traceback init`

Creates the local Traceback AI working directory:

```text
.traceback/
├── imports/
├── records/
│   └── failures/
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
comments, reviews, and authors.

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

The extraction is intentionally heuristic. It assigns candidate categories,
rough severity when priority badges or priority words are present, confidence,
status hints from nearby replies, and detected AI/agent markers. Re-running
`traceback extract` refreshes `.traceback/records/failures/` instead of appending
duplicates.

## Privacy Model

Traceback AI is local-only:

- Raw data stays under `.traceback/`.
- Nothing is uploaded by Traceback AI.
- No LLM calls are made.
- No hosted service, GitHub App, local web UI, or TUI is started.
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

- GitHub API access is read-only and best-effort.
- Large repositories may hit unauthenticated rate limits without a token.
- The importer fetches recent PRs by GitHub's updated ordering.
- Candidate AI/agent markers are heuristics, not classification.
- Failure candidates are deterministic signals, not final AI classification.
- Traceback does not generate prevention rules yet.

## Next Steps

- Add AI-assisted analysis that converts candidate evidence into reviewed failure records.
- Improve accepted, rejected, contested, and resolved status detection from review threads.
- Generate proposed repo-specific agent instructions for user review.
- Add a tiny local review UI after the local file loop proves useful.
