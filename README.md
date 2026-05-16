# Traceback AI

Traceback AI converts AI mistakes, fixes, and PR noise into useful local signal for
future agent instructions. Milestone 1 is intentionally small: a repo-local CLI
that imports recent GitHub pull request data into local files.

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
```

After building, the bundled CLI is available at `dist/cli.js`:

```bash
bun run build
./dist/cli.js init
./dist/cli.js import --prs 5
./dist/cli.js report
```

## Commands

### `traceback init`

Creates the local Traceback AI working directory:

```text
.agentfail/
├── imports/
├── records/
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

- raw GitHub data in `.agentfail/imports/pr-<number>.json`
- normalized local records in `.agentfail/records/pr-<number>.json`

Imported data includes PR metadata, issue comments, review comments, reviews,
basic diff/file stats, and simple candidate AI/agent markers found in bodies,
comments, reviews, and authors.

### `traceback report`

Reads `.agentfail/records/` and writes:

```text
.agentfail/reports/import-summary.md
```

The report summarizes imported PR counts, merged PRs, comments, reviews, review
comments, and candidate AI/agent markers.

## Privacy Model

Traceback AI Milestone 1 is local-only:

- Raw data stays under `.agentfail/`.
- Nothing is uploaded by Traceback AI.
- No LLM calls are made.
- No hosted service, GitHub App, local web UI, or TUI is started.
- Repo instruction files such as `AGENTS.md` are not generated or modified.

`.agentfail/` is ignored by git because imported PR data can contain private
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
- Milestone 1 does not infer failure records or generate prevention rules.

## Next Steps

- Add analysis that converts imported PR evidence into failure records.
- Track accepted, rejected, contested, and resolved review findings.
- Generate proposed repo-specific agent instructions for user review.
- Add a tiny local review UI after the local file loop proves useful.
