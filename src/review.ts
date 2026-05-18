import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { findAnalysisValidationWarnings } from "./analyze";
import { assertSafeRunId } from "./run-id";
import { getTracebackPaths } from "./storage";
import type {
  AnalysisOutput,
  AnalysisValidationWarning,
  EnrichedFailureRecord,
  FailureCluster,
} from "./analyze";

export type ReviewPolicy = "conservative";

export type ReviewDecisionValue =
  | "accepted"
  | "accepted_singleton"
  | "needs_validation"
  | "needs_cluster"
  | "rejected"
  | "needs_review"
  | "edited";

export type ReviewItemType = "cluster" | "enriched_record" | "singleton" | "warning";

export type ReviewDecision = {
  id: string;
  runId: string;
  itemType: ReviewItemType;
  sourceClusterId: string | null;
  sourceEnrichedRecordId: string | null;
  sourceCandidateIds: string[];
  sourcePrs: number[];
  sourceComments: string[];
  title: string;
  preventionRule: string;
  confidence: "low" | "medium" | "high" | "unknown";
  decision: ReviewDecisionValue;
  reason: string;
  editedTitle: string | null;
  editedPreventionRule: string | null;
  notes: string[];
  reviewedAt: string;
};

export type ReviewDecisionsFile = {
  schemaVersion: 1;
  runId: string;
  policy: ReviewPolicy;
  reviewedAt: string;
  source: {
    manifest: string;
    enrichedRecords: string;
    clusters: string;
  };
  decisions: ReviewDecision[];
};

export type RunReviewOptions = {
  runId: string;
  policy: ReviewPolicy;
  now?: Date;
};

export type ReviewRunResult = {
  reviewDir: string;
  decisionsPath: string;
  summaryPath: string;
};

type AnalysisManifest = {
  runId: string;
  mode: string;
  provider: string | null;
};

export async function runReview(
  repoRoot: string,
  options: RunReviewOptions,
): Promise<ReviewRunResult> {
  if (options.policy !== "conservative") {
    throw new Error("Only --policy conservative is supported.");
  }
  assertSafeRunId(options.runId);

  const paths = getTracebackPaths(repoRoot);
  const runDir = path.join(paths.analysisRuns, options.runId);
  const reviewedAt = (options.now ?? new Date()).toISOString();
  const manifest = await readJson<AnalysisManifest>(path.join(runDir, "manifest.json"));
  const enrichedRecords = await readJson<EnrichedFailureRecord[]>(
    path.join(runDir, "enriched-records.json"),
  );
  const clusters = await readJson<FailureCluster[]>(path.join(runDir, "clusters.json"));
  const warnings = findAnalysisValidationWarnings({ enrichedRecords, clusters, summary: emptySummary() });
  const decisions = buildConservativeDecisions({
    runId: options.runId,
    reviewedAt,
    enrichedRecords,
    clusters,
    warnings,
  });

  const reviewDir = path.join(paths.reviews, options.runId);
  await mkdir(reviewDir, { recursive: true });

  const decisionsFile: ReviewDecisionsFile = {
    schemaVersion: 1,
    runId: options.runId,
    policy: options.policy,
    reviewedAt,
    source: {
      manifest: path.relative(reviewDir, path.join(runDir, "manifest.json")),
      enrichedRecords: path.relative(reviewDir, path.join(runDir, "enriched-records.json")),
      clusters: path.relative(reviewDir, path.join(runDir, "clusters.json")),
    },
    decisions,
  };

  const decisionsPath = path.join(reviewDir, "decisions.json");
  const summaryPath = path.join(reviewDir, "review-summary.md");
  await writeJson(decisionsPath, decisionsFile);
  await writeFile(
    summaryPath,
    generateReviewSummaryMarkdown({
      manifest,
      policy: options.policy,
      reviewedAt,
      decisions,
    }),
    "utf8",
  );

  return { reviewDir, decisionsPath, summaryPath };
}

function buildConservativeDecisions({
  runId,
  reviewedAt,
  enrichedRecords,
  clusters,
  warnings,
}: {
  runId: string;
  reviewedAt: string;
  enrichedRecords: EnrichedFailureRecord[];
  clusters: FailureCluster[];
  warnings: AnalysisValidationWarning[];
}): ReviewDecision[] {
  const recordsByCandidateId = mapRecordsByCandidateId(enrichedRecords);
  const decisions = clusters.map((cluster) =>
    decisionFromCluster({ runId, reviewedAt, cluster, recordsByCandidateId }),
  );
  const emittedEnrichedRecordIds = new Set<string>();
  const warningsByRecordId = groupWarningsByRecordId(warnings);

  for (const [enrichedRecordId, recordWarnings] of warningsByRecordId) {
    const record = enrichedRecords.find((item) => item.id === enrichedRecordId);
    if (!record) {
      for (const warning of recordWarnings) {
        decisions.push(decisionFromWarning({ runId, reviewedAt, warning }));
      }
      continue;
    }

    decisions.push(decisionFromUnclusteredRecord({ runId, reviewedAt, record }));
    emittedEnrichedRecordIds.add(record.id);
  }

  for (const record of enrichedRecords) {
    if (record.sourceCandidateIds.length > 0 || emittedEnrichedRecordIds.has(record.id)) {
      continue;
    }

    decisions.push(decisionFromSourcelessRecord({ runId, reviewedAt, record }));
  }

  return decisions;
}

function decisionFromCluster({
  runId,
  reviewedAt,
  cluster,
  recordsByCandidateId,
}: {
  runId: string;
  reviewedAt: string;
  cluster: FailureCluster;
  recordsByCandidateId: Map<string, EnrichedFailureRecord>;
}): ReviewDecision {
  const relatedRecords = cluster.candidateIds
    .map((candidateId) => recordsByCandidateId.get(candidateId))
    .filter((record): record is EnrichedFailureRecord => Boolean(record));
  const sourceComments = uniqueStrings(relatedRecords.flatMap((record) => record.sourceComments));
  const hasInvalidReference = relatedRecords.length !== cluster.candidateIds.length;
  const decision = decideCluster(cluster, hasInvalidReference);

  return {
    id: `review-cluster-${cluster.id}`,
    runId,
    itemType: "cluster",
    sourceClusterId: cluster.id,
    sourceEnrichedRecordId: null,
    sourceCandidateIds: cluster.candidateIds,
    sourcePrs: cluster.sourcePrs,
    sourceComments,
    title: cluster.title,
    preventionRule: cluster.preventionRule,
    confidence: cluster.confidence,
    decision: decision.value,
    reason: decision.reason,
    editedTitle: null,
    editedPreventionRule: null,
    notes: [],
    reviewedAt,
  };
}

function decisionFromUnclusteredRecord({
  runId,
  reviewedAt,
  record,
}: {
  runId: string;
  reviewedAt: string;
  record: EnrichedFailureRecord;
}): ReviewDecision {
  return {
    id: `review-singleton-${record.id}`,
    runId,
    itemType: "singleton",
    sourceClusterId: null,
    sourceEnrichedRecordId: record.id,
    sourceCandidateIds: record.sourceCandidateIds,
    sourcePrs: record.sourcePrs,
    sourceComments: record.sourceComments,
    title: record.title,
    preventionRule: record.preventionRule,
    confidence: record.confidence,
    decision: "needs_cluster",
    reason: `Enriched record ${record.id} is not represented in any cluster.`,
    editedTitle: null,
    editedPreventionRule: null,
    notes: ["Unclustered enriched record preserved for review; no rule generation should consume it yet."],
    reviewedAt,
  };
}

function decisionFromSourcelessRecord({
  runId,
  reviewedAt,
  record,
}: {
  runId: string;
  reviewedAt: string;
  record: EnrichedFailureRecord;
}): ReviewDecision {
  return {
    id: `review-enriched-record-${record.id}`,
    runId,
    itemType: "enriched_record",
    sourceClusterId: null,
    sourceEnrichedRecordId: record.id,
    sourceCandidateIds: [],
    sourcePrs: record.sourcePrs,
    sourceComments: record.sourceComments,
    title: record.title,
    preventionRule: record.preventionRule,
    confidence: record.confidence,
    decision: "needs_review",
    reason: `Enriched record ${record.id} does not reference any source candidates.`,
    editedTitle: null,
    editedPreventionRule: null,
    notes: ["Record preserved because it cannot be traced back to deterministic candidates."],
    reviewedAt,
  };
}

function decisionFromWarning({
  runId,
  reviewedAt,
  warning,
}: {
  runId: string;
  reviewedAt: string;
  warning: AnalysisValidationWarning;
}): ReviewDecision {
  return {
    id: `review-warning-${warning.sourceCandidateId}`,
    runId,
    itemType: "warning",
    sourceClusterId: null,
    sourceEnrichedRecordId: warning.enrichedRecordId,
    sourceCandidateIds: [warning.sourceCandidateId],
    sourcePrs: [],
    sourceComments: [],
    title: "Analysis validation warning",
    preventionRule: "",
    confidence: "unknown",
    decision: "needs_review",
    reason: warning.message,
    editedTitle: null,
    editedPreventionRule: null,
    notes: [warning.code],
    reviewedAt,
  };
}

function decideCluster(
  cluster: FailureCluster,
  hasInvalidReference: boolean,
): { value: ReviewDecisionValue; reason: string } {
  if (hasInvalidReference) {
    return {
      value: "needs_review",
      reason: "Cluster references candidate IDs that are missing from enriched records.",
    };
  }

  if (cluster.confidence === "low" && cluster.candidateIds.every(isPrBodyCandidateId)) {
    return {
      value: "needs_validation",
      reason: "Low-confidence PR-body-only evidence needs validation before acceptance.",
    };
  }

  if (cluster.confidence === "high" && cluster.candidateIds.some(isReviewCommentCandidateId)) {
    return {
      value: "accepted",
      reason: "High-confidence cluster backed by review-comment candidates.",
    };
  }

  if (cluster.confidence === "low") {
    return {
      value: "needs_validation",
      reason: "Low-confidence cluster should be validated before acceptance.",
    };
  }

  return {
    value: "needs_review",
    reason: "Conservative policy could not confidently accept or reject this item.",
  };
}

function generateReviewSummaryMarkdown({
  manifest,
  policy,
  reviewedAt,
  decisions,
}: {
  manifest: AnalysisManifest;
  policy: ReviewPolicy;
  reviewedAt: string;
  decisions: ReviewDecision[];
}): string {
  return [
    "# Traceback Review Summary",
    "",
    `Reviewed: ${reviewedAt}`,
    "",
    "## Run",
    "",
    `- Run ID: ${manifest.runId}`,
    `- Mode: ${manifest.mode}`,
    `- Provider: ${manifest.provider ?? "none"}`,
    `- Policy: ${policy}`,
    "",
    "## Totals",
    "",
    `- Total decisions: ${decisions.length}`,
    "",
    "## Decisions by Type",
    "",
    ...renderCounts(countBy(decisions, (decision) => decision.itemType)),
    "",
    "## Decisions by Status",
    "",
    ...renderCounts(countBy(decisions, (decision) => decision.decision)),
    "",
    "## Accepted Clusters",
    "",
    ...renderDecisionList(decisions, (decision) => decision.itemType === "cluster" && decision.decision === "accepted"),
    "",
    "## Accepted Singleton Records",
    "",
    ...renderDecisionList(decisions, (decision) => decision.decision === "accepted_singleton"),
    "",
    "## Needs Validation Items",
    "",
    ...renderDecisionList(decisions, (decision) => decision.decision === "needs_validation"),
    "",
    "## Needs Cluster Items",
    "",
    ...renderDecisionList(decisions, (decision) => decision.decision === "needs_cluster"),
    "",
    "## Rejected or Needs Review Items",
    "",
    ...renderDecisionList(
      decisions,
      (decision) => decision.decision === "rejected" || decision.decision === "needs_review",
    ),
    "",
  ].join("\n");
}

function renderDecisionList(
  decisions: ReviewDecision[],
  predicate: (decision: ReviewDecision) => boolean,
): string[] {
  const matching = decisions.filter(predicate);
  if (matching.length === 0) {
    return ["None."];
  }

  return matching.flatMap((decision) => [
    `### ${decision.title}`,
    "",
    `- ID: ${decision.id}`,
    `- Decision: ${decision.decision}`,
    `- Reason: ${decision.reason}`,
    `- Confidence: ${decision.confidence}`,
    `- Source PRs: ${decision.sourcePrs.map((pr) => `#${pr}`).join(", ") || "none"}`,
    `- Source candidates: ${decision.sourceCandidateIds.join(", ") || "none"}`,
    "",
  ]);
}

function mapRecordsByCandidateId(
  enrichedRecords: EnrichedFailureRecord[],
): Map<string, EnrichedFailureRecord> {
  const recordsByCandidateId = new Map<string, EnrichedFailureRecord>();
  for (const record of enrichedRecords) {
    for (const candidateId of record.sourceCandidateIds) {
      recordsByCandidateId.set(candidateId, record);
    }
  }
  return recordsByCandidateId;
}

function groupWarningsByRecordId(
  warnings: AnalysisValidationWarning[],
): Map<string, AnalysisValidationWarning[]> {
  const warningsByRecordId = new Map<string, AnalysisValidationWarning[]>();
  for (const warning of warnings) {
    const current = warningsByRecordId.get(warning.enrichedRecordId) ?? [];
    current.push(warning);
    warningsByRecordId.set(warning.enrichedRecordId, current);
  }
  return warningsByRecordId;
}

function isReviewCommentCandidateId(candidateId: string): boolean {
  return candidateId.includes("-review_comment-");
}

function isPrBodyCandidateId(candidateId: string): boolean {
  return candidateId.includes("-pr_body-");
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function countBy<T>(items: T[], getKey: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = getKey(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function renderCounts(counts: Map<string, number>): string[] {
  if (counts.size === 0) {
    return ["None."];
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([value, count]) => `- ${value}: ${count}`);
}

function emptySummary(): AnalysisOutput["summary"] {
  return { overview: "", highestRiskPatterns: [], recommendedNextActions: [] };
}

async function readJson<T>(filePath: string): Promise<T> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Could not parse JSON file ${filePath}.`);
    }
    throw error;
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
