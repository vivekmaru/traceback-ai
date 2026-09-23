import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { extractFailureCandidates, inferStatus } from "../src/extract";
import { FAILURE_CANDIDATE_CATEGORIES, FAILURE_CANDIDATE_STATUSES } from "../src/types";
import type { FailureCandidate, FailureCandidateCategory, FailureCandidateStatus, NormalizedPullRequestRecord } from "../src/types";

const REPOS = ["traceback-ai", "EventSnaps", "task-tracker"] as const;
const ROOT = path.resolve(import.meta.dir, "..");
const DATA = path.join(ROOT, "eval/data");
const LABELS = path.join(ROOT, "eval/labels");
const REPORTS = path.join(ROOT, "eval/reports");
const CATEGORIES = FAILURE_CANDIDATE_CATEGORIES;
const STATUSES = FAILURE_CANDIDATE_STATUSES;
const KEY_PATTERN = /^(review_comment|issue_comment|review|pr_body):\d+$/;

type SourceType = FailureCandidate["sourceType"];
export type EvalSource = {
  key: string;
  pr: number;
  sourceType: SourceType;
  body: string;
  replies: { body: string; author: string | null }[];
  threadResolved: boolean | null;
  threadOutdated: boolean | null;
};
export type LabelEntry = {
  key: string;
  isFinding: boolean;
  category: FailureCandidateCategory | null;
  status: FailureCandidateStatus | null;
  note?: string;
};
export type LabelFile = {
  repo: string;
  labeledAt: string;
  labeler: string;
  schemaVersion?: 1;
  snapshotHash?: string;
  entries: LabelEntry[];
};
export type Prediction = {
  key: string;
  category: FailureCandidateCategory;
  status: FailureCandidateStatus;
  basis: ReturnType<typeof inferStatus>["basis"];
};

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateLabels(value: unknown, repo: string): asserts value is LabelFile {
  if (!object(value) || value.repo !== repo || typeof value.labeler !== "string" || !value.labeler.trim() ||
      typeof value.labeledAt !== "string" || !Number.isFinite(Date.parse(value.labeledAt)) ||
      !Array.isArray(value.entries) || (value.schemaVersion !== undefined && value.schemaVersion !== 1)) {
    throw new Error("Invalid label metadata or repository mismatch");
  }
  if (value.snapshotHash !== undefined && (typeof value.snapshotHash !== "string" || !/^[a-f0-9]{64}$/.test(value.snapshotHash))) {
    throw new Error("Invalid label snapshot hash");
  }
  const seen = new Set<string>();
  for (const entry of value.entries) {
    if (!object(entry) || typeof entry.key !== "string" || !KEY_PATTERN.test(entry.key) ||
        typeof entry.isFinding !== "boolean" ||
        (entry.category !== null && !CATEGORIES.includes(entry.category as FailureCandidateCategory)) ||
        (entry.status !== null && !STATUSES.includes(entry.status as FailureCandidateStatus)) ||
        (entry.note !== undefined && typeof entry.note !== "string") ||
        (!entry.isFinding && (entry.category !== null || entry.status !== null))) {
      throw new Error("Invalid label entry (key, finding, category, status or note)");
    }
    if (seen.has(entry.key)) throw new Error(`Duplicate label key: ${entry.key}`);
    seen.add(entry.key);
  }
}

function uniqueByKey<T extends { key: string }>(entries: T[], label: string): Map<string, T> {
  const map = new Map<string, T>();
  for (const entry of entries) {
    if (map.has(entry.key)) throw new Error(`Duplicate ${label} key: ${entry.key}`);
    map.set(entry.key, entry);
  }
  return map;
}

export function hashSnapshot(files: { name: string; text: string }[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
    hash.update(JSON.stringify([file.name, file.text]));
  }
  return hash.digest("hex");
}

export function assertSnapshot(labels: LabelFile, snapshotHash: string): void {
  if (labels.schemaVersion !== 1 || labels.snapshotHash !== snapshotHash) {
    throw new Error("Labels are unbound or snapshot changed. Audit labels against the exact snapshot before sealing; do not silently rebind.");
  }
}

async function readJson(file: string): Promise<unknown> {
  const text = await readFile(file, "utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON in ${path.basename(file)}`);
  }
}

async function readCorpus(repo: string) {
  const dir = path.join(DATA, repo);
  const names = (await readdir(dir)).filter((name) => /^pr-\d+\.json$/.test(name)).sort();
  if (!names.length) throw new Error(`${repo}: no snapshot records`);
  const files = await Promise.all(names.map(async (name) => ({ name, text: await readFile(path.join(dir, name), "utf8") })));
  const records: NormalizedPullRequestRecord[] = [];
  const prs = new Set<number>();
  for (const file of files) {
    let value: unknown;
    try { value = JSON.parse(file.text); } catch { throw new Error(`Invalid JSON in ${repo}/${file.name}`); }
    if (!object(value) || value.schemaVersion !== 3 || !object(value.repository) ||
        value.repository.owner !== "vivekmaru" || value.repository.repo !== repo ||
        !Number.isSafeInteger(value.prNumber) || value.prNumber !== Number(file.name.slice(3, -5)) ||
        typeof value.body !== "string" ||
        ![value.reviewComments, value.issueComments, value.reviews, value.reviewThreads].every(Array.isArray)) {
      throw new Error(`Invalid normalized snapshot record: ${repo}/${file.name}`);
    }
    const record = value as unknown as NormalizedPullRequestRecord;
    if (prs.has(record.prNumber)) throw new Error("Duplicate PR in snapshot");
    prs.add(record.prNumber);
    for (const comment of [...record.reviewComments, ...record.issueComments, ...record.reviews]) {
      if (!object(comment) || !Number.isSafeInteger(comment.id) || typeof comment.body !== "string") {
        throw new Error(`Invalid source in ${repo}/${file.name}`);
      }
    }
    for (const comment of record.reviewComments) {
      if (!Object.hasOwn(comment, "inReplyToId") || (comment.inReplyToId !== null && !Number.isSafeInteger(comment.inReplyToId))) {
        throw new Error(`Invalid reply reference in ${repo}/${file.name}`);
      }
    }
    for (const thread of record.reviewThreads) {
      if (!object(thread) || typeof thread.isResolved !== "boolean" || typeof thread.isOutdated !== "boolean" ||
          !Array.isArray(thread.commentIds) || !thread.commentIds.every((id) => typeof id === "string")) {
        throw new Error(`Invalid thread in ${repo}/${file.name}`);
      }
    }
    records.push(record);
  }
  const sources = records.flatMap(topLevelSources);
  uniqueByKey(sources, "source");
  return { records, sources, snapshotHash: hashSnapshot(files) };
}

export function topLevelSources(record: NormalizedPullRequestRecord): EvalSource[] {
  const sources: EvalSource[] = [];
  const push = (sourceType: SourceType, id: number, body: string) => {
    const thread = sourceType === "review_comment"
      ? record.reviewThreads.find((item) => item.commentIds.includes(String(id))) : null;
    const replies = sourceType === "review_comment" ? record.reviewComments
      .filter((comment) => comment.inReplyToId === id)
      .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""))
      .map(({ body, author }) => ({ body, author })) : [];
    sources.push({ key: `${sourceType}:${id}`, pr: record.prNumber, sourceType, body, replies,
      threadResolved: thread?.isResolved ?? null, threadOutdated: thread?.isOutdated ?? null });
  };
  for (const comment of record.reviewComments) {
    if (comment.inReplyToId === null) push("review_comment", comment.id, comment.body);
  }
  for (const comment of record.issueComments) push("issue_comment", comment.id, comment.body);
  for (const review of record.reviews) push("review", review.id, review.body);
  push("pr_body", record.prNumber, record.body);
  return sources;
}

function ratio(correct: number, total: number): number | null {
  return total ? correct / total : null;
}

export function evaluate(sources: EvalSource[], predictions: Prediction[], labels: LabelFile) {
  validateLabels(labels, labels.repo);
  const sourceMap = uniqueByKey(sources, "source");
  const labelMap = uniqueByKey(labels.entries, "label");
  const predictionMap = uniqueByKey(predictions, "prediction");
  if (!sources.length) throw new Error("Cannot evaluate an empty corpus");
  for (const key of sourceMap.keys()) {
    if (!labelMap.has(key)) throw new Error(`Unlabeled source: ${key}`);
  }
  for (const key of [...labelMap.keys(), ...predictionMap.keys()]) {
    if (!sourceMap.has(key)) throw new Error(`Unknown source key: ${key}`);
  }
  let tp = 0, fp = 0, fn = 0, tn = 0;
  let categoryCorrect = 0, categoryTotal = 0, statusCorrect = 0, statusTotal = 0;
  const statusByBasis: Record<string, { correct: number; total: number; excluded: number }> = {};
  const categoryConfusion: Record<string, number> = {};
  const errors: { key: string; kind: string; expected?: string; predicted?: string }[] = [];
  for (const source of sources) {
    const label = labelMap.get(source.key)!;
    const prediction = predictionMap.get(source.key);
    if (prediction && label.isFinding) {
      tp++;
      if (label.category !== null) {
        categoryTotal++;
        const pair = `${label.category} -> ${prediction.category}`;
        categoryConfusion[pair] = (categoryConfusion[pair] ?? 0) + 1;
        if (label.category === prediction.category) categoryCorrect++;
        else errors.push({ key: source.key, kind: "category", expected: label.category, predicted: prediction.category });
      }
      const bucket = statusByBasis[prediction.basis] ??= { correct: 0, total: 0, excluded: 0 };
      if (label.status === null) bucket.excluded++;
      else {
        statusTotal++;
        bucket.total++;
        if (label.status === prediction.status) { statusCorrect++; bucket.correct++; }
        else errors.push({ key: source.key, kind: "status", expected: label.status, predicted: prediction.status });
      }
    } else if (prediction) {
      fp++;
      errors.push({ key: source.key, kind: "FP" });
    } else if (label.isFinding) {
      fn++;
      errors.push({ key: source.key, kind: "FN" });
    } else tn++;
  }
  return {
    sources: sources.length, extracted: predictions.length, tp, fp, fn, tn,
    precision: ratio(tp, tp + fp), recall: ratio(tp, tp + fn), f1: ratio(2 * tp, 2 * tp + fp + fn),
    categoryCorrect, categoryTotal, categoryExcluded: tp - categoryTotal,
    categoryAccuracy: ratio(categoryCorrect, categoryTotal), categoryConfusion,
    statusCorrect, statusTotal, statusExcluded: tp - statusTotal,
    statusAccuracy: ratio(statusCorrect, statusTotal), statusByBasis, errors,
  };
}

async function run(repo: string) {
  const corpus = await readCorpus(repo);
  const labelFile = path.join(LABELS, `${repo}.json`);
  const labelText = await readFile(labelFile, "utf8");
  let labels: unknown;
  try {
    labels = JSON.parse(labelText);
  } catch {
    throw new Error(`Invalid JSON in ${labelFile}`);
  }
  validateLabels(labels, repo);
  assertSnapshot(labels, corpus.snapshotHash);
  const sourceMap = uniqueByKey(corpus.sources, "source");
  const predictions = extractFailureCandidates(corpus.records).map((candidate): Prediction => {
    const match = candidate.id.match(/^failure-pr-\d+-(review_comment|issue_comment|review|pr_body)-(\d+)$/);
    if (!match) throw new Error("Invalid extracted candidate ID");
    const key = `${match[1]}:${match[2]}`;
    const source = sourceMap.get(key);
    if (!source) throw new Error(`Candidate outside corpus: ${key}`);
    const inference = inferStatus(source.body, source.replies.map((reply) => reply.body), source.threadResolved === null
      ? null : { isResolved: source.threadResolved, isOutdated: source.threadOutdated! });
    return { key, category: candidate.candidateCategory, status: candidate.status, basis: inference.basis };
  });
  return { repo, role: repo === "task-tracker" ? "holdout (no tuning)" : "development",
    snapshotHash: corpus.snapshotHash, labeler: labels.labeler,
    labelsHash: createHash("sha256").update(labelText).digest("hex"),
    ...evaluate(corpus.sources, predictions, labels) };
}

function formatMetrics(result: Awaited<ReturnType<typeof run>>): string {
  const pct = (value: number | null) => value === null ? "N/A" : `${(value * 100).toFixed(1)}%`;
  return [
    `## ${result.repo} — ${result.role}`, "",
    `- Snapshot SHA-256: ${result.snapshotHash}`,
    `- Labels SHA-256: ${result.labelsHash}`,
    `- Sources: ${result.sources}; extracted: ${result.extracted}; TP=${result.tp} FP=${result.fp} FN=${result.fn} TN=${result.tn}`,
    `- Extraction precision=${pct(result.precision)} recall=${pct(result.recall)} F1=${pct(result.f1)}`,
    `- Category accuracy (detected findings only): ${result.categoryCorrect}/${result.categoryTotal} (${pct(result.categoryAccuracy)}); excluded=${result.categoryExcluded}`,
    `- Status accuracy (detected findings only): ${result.statusCorrect}/${result.statusTotal} (${pct(result.statusAccuracy)}); unknown labels excluded=${result.statusExcluded}`,
    "", "### Status by predicted evidence basis", "",
    ...Object.entries(result.statusByBasis).map(([basis, count]) => `- ${basis}: ${count.correct}/${count.total}; excluded=${count.excluded}`),
    "", "### Category confusion (expected -> predicted)", "",
    ...Object.entries(result.categoryConfusion).sort().map(([pair, count]) => `- ${pair}: ${count}`),
    "", "### Error keys (no source text)", "",
    ...result.errors.map((error) => `- ${error.kind} ${error.key}${error.expected ? `: ${error.expected} -> ${error.predicted}` : ""}`), "",
  ].join("\n");
}

export async function main(args: string[]): Promise<void> {
  const [command, target, ...flags] = args;
  if (command === "--help") {
    console.log("bun scripts/eval.ts <worksheet|seal|run> <traceback-ai|EventSnaps|task-tracker|--all> [--report]");
    return;
  }
  if (!["worksheet", "seal", "run"].includes(command) || !target ||
      (target !== "--all" && !REPOS.includes(target as typeof REPOS[number])) ||
      flags.length > 1 || flags.some((flag) => flag !== "--report" || command !== "run")) {
    throw new Error("Invalid eval arguments. Use --help.");
  }
  const repos = target === "--all" ? REPOS : [target];
  if (command === "worksheet") {
    const outDir = path.join(DATA, "worksheets");
    await mkdir(outDir, { recursive: true });
    for (const repo of repos) {
      const corpus = await readCorpus(repo);
      await writeFile(path.join(outDir, `${repo}.jsonl`), corpus.sources
        .map((source) => JSON.stringify({ snapshotHash: corpus.snapshotHash, ...source })).join("\n") + "\n");
      console.log(`${repo}: ${corpus.sources.length} full-text sources, predictions withheld (gitignored)`);
    }
    return;
  }
  if (command === "seal") {
    for (const repo of repos) {
      const corpus = await readCorpus(repo);
      const file = path.join(LABELS, `${repo}.json`);
      const labels = await readJson(file);
      validateLabels(labels, repo);
      evaluate(corpus.sources, [], labels);
      if (labels.snapshotHash && labels.snapshotHash !== corpus.snapshotHash) throw new Error("Refusing to rebind changed snapshot");
      await writeFile(file, JSON.stringify({ ...labels, schemaVersion: 1, snapshotHash: corpus.snapshotHash }, null, 2) + "\n");
      console.log(`${repo}: labels bound to ${corpus.snapshotHash}; this is not human approval`);
    }
    return;
  }
  const results = [];
  for (const repo of repos) results.push(await run(repo));
  const extractorHash = createHash("sha256").update(await readFile(path.join(ROOT, "src/extract.ts"))).digest("hex");
  const report = [
    "# Traceback provisional extraction evaluation", "",
    `Generated: ${new Date().toISOString()}`,
    `Extractor SHA-256: ${extractorHash}`, "",
    "Agent-reviewed draft labels, not independently human-adjudicated ground truth. These numbers are diagnostic, not release acceptance evidence.",
    "Holdout was not used to tune heuristics. Earlier holdout drafts were prediction-exposed; blind relabeling reduces but cannot erase that history.",
    "Unit of measurement: top-level source, not unique incident. Repeated PRs may describe the same problem. Only the imported PR windows are covered.",
    "Status means scoped reply/metadata inference, not independently verified correctness. Category/status accuracy excludes missed findings; inspect recall separately.", "",
    ...results.map(formatMetrics),
  ].join("\n");
  console.log(report);
  if (flags.includes("--report")) {
    await mkdir(REPORTS, { recursive: true });
    const name = `baseline-${target === "--all" ? "all" : target}-${Date.now()}.md`;
    await writeFile(path.join(REPORTS, name), report + "\n", { flag: "wx" });
    console.log(`Wrote eval/reports/${name}`);
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
