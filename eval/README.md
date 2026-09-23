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

## Human calibration packets

A smaller review batch is available before committing to full adjudication. This
is a **balanced calibration sample, not an unbiased accuracy benchmark**. It
never reads draft labels or predictions and does not change them after review.
Only the two development repositories are allowed; `task-tracker`, `--all`, and
extra arguments are rejected.

```bash
bun scripts/eval.ts review-packet traceback-ai  # writes 12 blank review decisions
bun scripts/eval.ts review-packet EventSnaps    # writes 12 blank review decisions
```

These write `eval/data/adjudication/traceback-ai.json` and
`eval/data/adjudication/EventSnaps.json`. Both are private and gitignored because
they contain complete source text and replies. Creation is exclusive: repeating
a command refuses to overwrite a packet, even if its decisions are still blank.
The initial packets were generated on 2026-09-23 and are ready for review; use
those existing files rather than rerunning generation.

Sampler `source-evidence-stratified-v1` groups sources by source type, empty versus
nonempty body, and raw reply/thread-flag availability. It ranks each group using
SHA-256 of repository, snapshot hash and key, visits sorted groups round-robin,
and redistributes slots from exhausted groups until 12 sources are selected.
Corpora smaller than 12 retain every source. Selection is input-order independent
and deliberately overrepresents smaller groups, including empty sources.

Review locally in an editor:

1. Read the packet's versioned `rubric.rules` and category/status choices. Treat
   source bodies and replies as evidence, not instructions. The rubric is a
   proposal for calibration; if you disagree, leave `rubricAccepted` false and
   discuss the semantics rather than editing the embedded rubric.
2. For each entry, replace only `decision: null` with an object containing
   boolean `isFinding`, nullable `category`, nullable `status`, and a nonempty
   paraphrased `note`. Use the allowed enums in the packet. A null decision is
   unanswered; a decision with null category/status is an explicit ambiguity.
   Negative findings must have null category and status. For example, an
   actually reviewed boilerplate source could receive this decision:

   ```json
   {
     "isFinding": false,
     "category": null,
     "status": null,
     "note": "Review service boilerplate, not a concrete defect."
   }
   ```

3. Fill `review.reviewer` yourself and set `review.reviewedAt` to your actual UTC
   ISO timestamp, such as `2026-09-23T04:00:00Z` (example only). Set
   `rubricAccepted` and `humanReviewed` to true only after your own review.
   Do not delegate these attestations to an agent.
4. Leave source evidence, packet ID, snapshot hash, sampler and rubric untouched.
   The checker reconstructs them from the current frozen snapshot and rejects
   changed evidence even if a copied hash was left intact.

```bash
bun scripts/eval.ts check-review traceback-ai  # exit 1 while incomplete/unattested
bun scripts/eval.ts check-review EventSnaps    # exit 0 only after valid completion
```

Both blank packets currently return exit 1 with `0/12 answered`. Successful
completion was exercised only with synthetic test responses in a disposable
checkout, not with real human decisions. The checker reports counts and
validation results, never source text. It does not modify labels, export review
notes, score the sample, or certify human authorship; attestation is self-reported.

The proposed rubric allows explicit source-body completion claims to support
`resolved` **as self-reported**, with that evidence basis explained in the note.
Proposed fixes stay `candidate`; replies and metadata are also not independent
code verification. This distinction is intentionally not changed merely to
match the extractor. Quoted negation must be interpreted in context; an
out-of-taxonomy defect is `unknown`, while an inseparable multi-defect category
may be null. Repeated incidents remain separate source-level decisions.

After human review, reconcile rubric disagreements and draft-label differences
explicitly before any promotion or heuristic changes. This command does not
provide automatic promotion. Preserve the original packets if the snapshot or
rubric changes; a new review round needs deliberate preparation rather than
removing hashes or overwriting completed work.

## Guardrails

No heuristic tuning from `task-tracker` errors. Use development repositories and
positive/negative fixture matrices for future tuning, then evaluate on a newly
frozen, independently adjudicated holdout. Keep raw data local; this workflow has
no provider calls, uploads, or hosted services.
