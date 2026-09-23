# Traceback extraction evaluation

Measures finding detection, category, and status against **agent-reviewed draft
annotations**, not human-adjudicated ground truth. These are diagnostic baselines,
not release acceptance evidence. Phase 2 of `docs/improvement-plan.md` measures
quality before more heuristic tuning or numerical evidence scoring.

## Corpora

| Repo | Role | Frozen sources | Notes |
| --- | --- | ---: | --- |
| `traceback-ai` | Development | 223 | Source of most heuristic families. |
| `EventSnaps` | Development | 163 | Previously used for tuning; current PR window differs from May's validation. |
| `task-tracker` | Holdout, no tuning | 87 | Earlier draft labels were prediction-exposed; a full-text blind relabel does not erase that history. |

## Local data and versionable outputs

- `eval/data/<repo>/pr-*.json`: private normalized v3 snapshots, gitignored.
- `eval/data/worksheets/<repo>.jsonl`: complete source text and same-thread
  context with predictions withheld, gitignored.
- `eval/labels/<repo>.json`: draft annotations intended for version control.
  Keys are `<sourceType>:<id>` (`pr_body:<prNumber>` for PR bodies); notes are
  paraphrases, never verbatim private source content. Review notes for sensitive
  details before sharing.
- `eval/reports/`: aggregate metrics and error IDs, without source text or label
  notes. Reports identify exact snapshot, label, and extractor hashes.

Raw data is deliberately not distributed. Labels alone cannot reproduce these
baselines. A fresh GitHub import can contain changed comments or a different PR
window; it is not a replacement for the frozen snapshot. Preserve an existing
snapshot and its labels before creating a new dataset. Do not combine multiple
repositories into one data directory or remove snapshot hashes to bypass a
mismatch.

## Verified workflow

Run from the Traceback checkout with the matching local snapshots available:

```bash
bun scripts/eval.ts --help                # prints supported commands and repos
bun scripts/eval.ts worksheet --all       # writes 223 / 163 / 87 full-text sources
```

Label every worksheet source into its repository's label file before continuing.
Keep prediction output hidden from annotators. Metadata requires `repo`, an ISO
`labeledAt` timestamp, and a `labeler` describing who reviewed it and whether human
adjudication is pending. Entries require `key`, boolean `isFinding`, and nullable
`category` / `status`; optional `note` must be a string.

```bash
bun scripts/eval.ts seal --all            # validates coverage and binds snapshot hashes
bun scripts/eval.ts run --all --report    # prints metrics and writes a timestamped report
```

`seal` means snapshot binding, **not human approval**. It refuses to rebind a
changed snapshot. Evaluation rejects missing/duplicate/orphan labels and invalid
enums. The commands above were exercised locally on 2026-09-23 without provider
calls or uploads. Hermetic evaluator tests also run under `bun test` without
private snapshots.

## Annotation and measurement contract

- Label all top-level review comments, issue comments, reviews, and PR bodies,
  including empty bodies and sources the extractor misses. Replies are context,
  not separate detection targets.
- `isFinding` means the source reports a concrete defect, omission, or regression,
  not merely a feature summary or automated review boilerplate.
- Choose a category for the actual defect, not incidental domain tokens or code
  examples. Use the taxonomy's `unknown` for findings outside its categories;
  use `null` when category cannot be adjudicated, such as an inseparable
  multi-defect source. Negative sources require null category and status.
- Status describes the outcome supported by source text, same-thread replies,
  and thread metadata at the snapshot time. PR merge alone is not resolution.
  `candidate` is an unresolved finding; `null` means unadjudicated. A resolved
  thread does not independently prove a correct code fix.
- Human adjudication is still required, especially for source-body self-reported
  fixes versus reply-confirmed resolution, semantic rebuttals, quoted negation,
  multi-defect PR bodies, and repeated reports of the same incident. Current
  labels are preserved rather than rewritten to match predictions.
- Precision/recall/F1 score source detection. Category/status accuracy is measured
  only on correctly detected findings; null labels are excluded and zero
  denominators are N/A. Accuracy does not compensate for missed findings.
- Counts are per source, not unique incident; repeated sources can overweight a
  problem. The holdout has no explicit-reply examples, so its status accuracy
  does not establish reply-inference quality.

## Guardrails

No heuristic tuning from `task-tracker` errors. Use development repositories and
positive/negative fixture matrices for future tuning, then evaluate on a newly
frozen, independently adjudicated holdout. Keep raw data local; this workflow has
no provider calls, uploads, or hosted services.
