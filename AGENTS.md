# Traceback Agent Instructions

This repo is Traceback AI. Older planning notes may call the project
`AgentFail`; treat that as historical naming unless a task explicitly asks about
the old name. User-facing CLI/package/docs should use `Traceback`,
`traceback-ai`, `traceback`, and `.traceback/`.

## Planning Docs

Read these docs before starting non-trivial work:

1. `docs/execution-state.md`
   - Read first.
   - This is the living operational tracker.
   - It identifies the current milestone, exact scope, non-goals, acceptance
     criteria, verification expectations, known quality gaps, and next handoff
     notes.
2. `docs/roadmap.md`
   - Read when product direction, milestone order, or scope boundaries matter.
   - This is the stable product roadmap, not a per-task checklist.
   - It explains why the current GitHub-import pipeline exists, why the tiny UI
     is next, where status detection fits, and how local session capture returns
     to the original MVP.
3. `docs/current-state.md`
   - Use as a point-in-time audit snapshot.
   - Do not treat it as the live tracker.
   - Update it only when doing a new explicit state audit or when a stale
     recommendation would mislead future work.
4. `docs/artifacts.md`
   - Read when changing `.traceback/rules/`, `.traceback/exports/`, rule
     decision semantics, or export output.
   - This explains which files are working artifacts, which are delivery
     artifacts, and which rule states are exportable.

The intended workflow is:

```text
read docs/execution-state.md
consult docs/roadmap.md for strategic context
build only the current milestone
update docs/execution-state.md after meaningful work
```

## Current Direction

The next milestone is the tiny local read-only review UI exposed as:

```bash
traceback ui
```

That milestone should make the existing evidence chain inspectable across
imports, candidates, analysis runs, clusters, review decisions, draft rules, rule
decisions, and exports.

The highest-value quality gap is thread-aware outcome/status detection. Do not
let it displace the first UI milestone unless the user explicitly changes the
plan. The UI should make status quality visible so the next decision is grounded
in real usage.

The original black-box-recorder MVP is deferred, not abandoned. The return path
is later session capture:

```bash
traceback start "task description"
traceback mark "notable failure or correction"
traceback stop
traceback session report
```

## Traceback Learnings

When editing Traceback:

- Treat human-edited persisted artifacts as untrusted. Validate run IDs, schema
  versions, enum values, and duplicate IDs before normalizing or exporting them.
- When generating IDs from model/provider output, guard against collisions and
  preserve multiple records that share the same source ID.
- When tuning extraction heuristics, test standalone and contextual examples.
  Prefer multi-token/contextual signals over broad single-word category matches.
- For taxonomy/category changes, create a positive/negative fixture matrix before
  pushing. Every new category signal should include at least one positive
  contextual example and at least one negative example where the same artifact,
  function, field, or domain token appears without the failure context.
- Do not let artifact names, function names, field names, or generic nouns score
  a category on their own. Pair them with the actual failure semantics, such as
  validation, collision, record loss, status inference, or import pagination
  boundary terms.
- Treat broad nouns such as `security`, `request`, `runId`, `record`,
  `decision`, and generic `IDs` as suspicious in extraction heuristics. They
  need domain-specific failure verbs around them, not just nearby product nouns.
- If PR review finds multiple comments in the same heuristic family, pause and
  audit the whole pattern family before pushing another one-comment fix.
- Keep status inference thread-local and negation-aware. Do not infer candidate
  outcomes from unrelated PR-level context.
- Keep pagination and platform-specific shell behavior explicit; test page
  boundaries and avoid Unix-only assumptions in package scripts.

## Scope Boundaries

Default to local-first behavior:

- Store Traceback data under `.traceback/`.
- Do not upload data unless explicitly requested.
- Do not add hosted services, login, telemetry, or a GitHub App unless the
  roadmap/execution state and user request both support it.
- Do not auto-apply generated rules to root instruction files.
- Do not modify root `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, or source files as
  part of generated export behavior.

Direct user requests to edit repo docs or instruction files override the export
automation boundary. For example, if the user explicitly asks to update
`AGENTS.md`, make that doc edit normally.

## Updating Docs

Update `docs/execution-state.md` after meaningful work, especially when:

- a milestone starts, finishes, or changes scope
- acceptance criteria change
- verification commands or outcomes change
- blockers are found
- the next suggested step changes

Keep execution-state updates short and operational:

- current milestone status
- files or commands changed
- verification evidence
- blockers or risks
- next suggested step

Update `docs/roadmap.md` only when the product direction or milestone sequence
changes.

Update `docs/current-state.md` only for state-audit snapshots or to correct stale
snapshot guidance.

After substantial multi-step work, write a short breadcrumb note under
`/Users/vivek/Documents/wiki/agents/` and remind the user to run:

```bash
qmd update && qmd embed
```

## Development

Prefer Bun for this TypeScript CLI.

Useful checks:

```bash
bun test
bun run check
bun run build
```

Use `rtk` for verbose shell commands when practical.
