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
  const recordsById = mapRecordsById(enrichedRecords);
  const duplicateClusterIds = findDuplicateValues(clusters.map((cluster) => cluster.id));
  const duplicateEnrichedRecordIds = findDuplicateValues(enrichedRecords.map((record) => record.id));
  const clusterIdCounts = countBy(clusters, (cluster) => cluster.id);
  const clusterIdIndexes = new Map<string, number>();
  const decisions: ReviewDecision[] = [];
  const emittedEnrichedRecordKeys = new Set<string>();
  const warningsByRecordId = groupWarningsByRecordId(warnings);

  for (const duplicateClusterId of duplicateClusterIds) {
    decisions.push(decisionFromDuplicateClusterIdWarning({ runId, reviewedAt, clusterId: duplicateClusterId }));
  }

  for (const duplicateRecordId of duplicateEnrichedRecordIds) {
    decisions.push(
      decisionFromDuplicateEnrichedRecordIdWarning({
        runId,
        reviewedAt,
        recordId: duplicateRecordId,
        records: recordsById.get(duplicateRecordId) ?? [],
      }),
    );
  }

  for (const cluster of clusters) {
    const nextIndex = (clusterIdIndexes.get(cluster.id) ?? 0) + 1;
    clusterIdIndexes.set(cluster.id, nextIndex);
    const clusterIdSuffix = (clusterIdCounts.get(cluster.id) ?? 0) > 1 ? String(nextIndex) : null;
    decisions.push(
      decisionFromCluster({
        runId,
        reviewedAt,
        cluster,
        recordsByCandidateId,
        idSuffix: clusterIdSuffix,
        hasDuplicateClusterId: duplicateClusterIds.has(cluster.id),
      }),
    );
  }

  for (const [enrichedRecordId, recordWarnings] of warningsByRecordId) {
    const records = recordsById.get(enrichedRecordId) ?? [];
    if (records.length === 0) {
      for (const warning of recordWarnings) {
        decisions.push(decisionFromWarning({ runId, reviewedAt, warning }));
      }
      continue;
    }

    const unclusteredCandidateIds = new Set(recordWarnings.map((warning) => warning.sourceCandidateId));
    records.forEach((record, index) => {
      const recordUnclusteredCandidateIds = record.sourceCandidateIds.filter((candidateId) =>
        unclusteredCandidateIds.has(candidateId),
      );
      if (recordUnclusteredCandidateIds.length === 0) {
        return;
      }

      const recordKey = enrichedRecordKey(record, index);
      decisions.push(
        decisionFromUnclusteredRecord({
          runId,
          reviewedAt,
          record,
          sourceCandidateIds: recordUnclusteredCandidateIds,
          idSuffix: records.length > 1 ? String(index + 1) : null,
        }),
      );
      emittedEnrichedRecordKeys.add(recordKey);
    });
  }

  enrichedRecords.forEach((record, index) => {
    if (record.sourceCandidateIds.length > 0 || emittedEnrichedRecordKeys.has(enrichedRecordKey(record, index))) {
      return;
    }

    decisions.push(
      decisionFromSourcelessRecord({
        runId,
        reviewedAt,
        record,
        idSuffix: (recordsById.get(record.id)?.length ?? 0) > 1 ? String(index + 1) : null,
      }),
    );
  });

  return withUniqueDecisionIds(decisions);
}

function decisionFromCluster({
  runId,
  reviewedAt,
  cluster,
  recordsByCandidateId,
  idSuffix,
  hasDuplicateClusterId,
}: {
  runId: string;
  reviewedAt: string;
  cluster: FailureCluster;
  recordsByCandidateId: Map<string, EnrichedFailureRecord[]>;
  idSuffix: string | null;
  hasDuplicateClusterId: boolean;
}): ReviewDecision {
  const recordMatches = cluster.candidateIds.map((candidateId) => ({
    candidateId,
    records: recordsByCandidateId.get(candidateId) ?? [],
  }));
  const relatedRecords = uniqueRecords(recordMatches.flatMap((match) => match.records));
  const sourceComments = uniqueStrings(relatedRecords.flatMap((record) => record.sourceComments));
  const hasMissingCandidate = recordMatches.some((match) => match.records.length === 0);
  const hasDuplicateCandidateOwnership = recordMatches.some((match) => match.records.length > 1);
  const decision = decideCluster(cluster, {
    hasMissingCandidate,
    hasDuplicateCandidateOwnership,
    hasDuplicateClusterId,
  });

  return {
    id: `review-cluster-${cluster.id}${idSuffix ? `-${idSuffix}` : ""}`,
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
  sourceCandidateIds,
  idSuffix,
}: {
  runId: string;
  reviewedAt: string;
  record: EnrichedFailureRecord;
  sourceCandidateIds: string[];
  idSuffix: string | null;
}): ReviewDecision {
  return {
    id: `review-singleton-${record.id}${idSuffix ? `-${idSuffix}` : ""}`,
    runId,
    itemType: "singleton",
    sourceClusterId: null,
    sourceEnrichedRecordId: record.id,
    sourceCandidateIds,
    sourcePrs: record.sourcePrs,
    sourceComments: record.sourceComments,
    title: record.title,
    preventionRule: record.preventionRule,
    confidence: record.confidence,
    decision: "needs_cluster",
    reason:
      sourceCandidateIds.length === record.sourceCandidateIds.length
        ? `Enriched record ${record.id} is not represented in any cluster.`
        : `Enriched record ${record.id} has source candidates that are not represented in any cluster.`,
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
  idSuffix,
}: {
  runId: string;
  reviewedAt: string;
  record: EnrichedFailureRecord;
  idSuffix: string | null;
}): ReviewDecision {
  return {
    id: `review-enriched-record-${record.id}${idSuffix ? `-${idSuffix}` : ""}`,
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

function decisionFromDuplicateClusterIdWarning({
  runId,
  reviewedAt,
  clusterId,
}: {
  runId: string;
  reviewedAt: string;
  clusterId: string;
}): ReviewDecision {
  return {
    id: `review-warning-duplicate-cluster-id-${clusterId}`,
    runId,
    itemType: "warning",
    sourceClusterId: clusterId,
    sourceEnrichedRecordId: null,
    sourceCandidateIds: [],
    sourcePrs: [],
    sourceComments: [],
    title: "Duplicate cluster ID",
    preventionRule: "",
    confidence: "unknown",
    decision: "needs_review",
    reason: `Duplicate cluster ID ${clusterId} appears more than once in analysis output.`,
    editedTitle: null,
    editedPreventionRule: null,
    notes: ["duplicate_cluster_id"],
    reviewedAt,
  };
}

function decisionFromDuplicateEnrichedRecordIdWarning({
  runId,
  reviewedAt,
  recordId,
  records,
}: {
  runId: string;
  reviewedAt: string;
  recordId: string;
  records: EnrichedFailureRecord[];
}): ReviewDecision {
  return {
    id: `review-warning-duplicate-enriched-record-id-${recordId}`,
    runId,
    itemType: "warning",
    sourceClusterId: null,
    sourceEnrichedRecordId: recordId,
    sourceCandidateIds: uniqueStrings(records.flatMap((record) => record.sourceCandidateIds)),
    sourcePrs: uniqueNumbers(records.flatMap((record) => record.sourcePrs)),
    sourceComments: uniqueStrings(records.flatMap((record) => record.sourceComments)),
    title: "Duplicate enriched record ID",
    preventionRule: "",
    confidence: "unknown",
    decision: "needs_review",
    reason: `Duplicate enriched record ID ${recordId} appears more than once in analysis output.`,
    editedTitle: null,
    editedPreventionRule: null,
    notes: ["duplicate_enriched_record_id"],
    reviewedAt,
  };
}

function decideCluster(
  cluster: FailureCluster,
  issues: {
    hasMissingCandidate: boolean;
    hasDuplicateCandidateOwnership: boolean;
    hasDuplicateClusterId: boolean;
  },
): { value: ReviewDecisionValue; reason: string } {
  if (issues.hasDuplicateClusterId) {
    return {
      value: "needs_review",
      reason: "Cluster ID appears more than once in analysis output.",
    };
  }

  if (issues.hasDuplicateCandidateOwnership) {
    return {
      value: "needs_review",
      reason: "Cluster references candidate IDs that are owned by multiple enriched records.",
    };
  }

  if (issues.hasMissingCandidate) {
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
): Map<string, EnrichedFailureRecord[]> {
  const recordsByCandidateId = new Map<string, EnrichedFailureRecord[]>();
  for (const record of enrichedRecords) {
    for (const candidateId of record.sourceCandidateIds) {
      const current = recordsByCandidateId.get(candidateId) ?? [];
      current.push(record);
      recordsByCandidateId.set(candidateId, current);
    }
  }
  return recordsByCandidateId;
}

function mapRecordsById(enrichedRecords: EnrichedFailureRecord[]): Map<string, EnrichedFailureRecord[]> {
  const recordsById = new Map<string, EnrichedFailureRecord[]>();
  for (const record of enrichedRecords) {
    const current = recordsById.get(record.id) ?? [];
    current.push(record);
    recordsById.set(record.id, current);
  }
  return recordsById;
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

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

function uniqueRecords(records: EnrichedFailureRecord[]): EnrichedFailureRecord[] {
  const seen = new Set<EnrichedFailureRecord>();
  const unique: EnrichedFailureRecord[] = [];
  for (const record of records) {
    if (seen.has(record)) {
      continue;
    }
    seen.add(record);
    unique.push(record);
  }
  return unique;
}

function findDuplicateValues(values: string[]): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    }
    seen.add(value);
  }
  return duplicates;
}

function enrichedRecordKey(record: EnrichedFailureRecord, index: number): string {
  return `${record.id}:${index}`;
}

function withUniqueDecisionIds(decisions: ReviewDecision[]): ReviewDecision[] {
  const usedIds = new Set<string>();
  return decisions.map((decision) => ({
    ...decision,
    id: allocateUniqueId(decision.id, usedIds),
  }));
}

function allocateUniqueId(baseId: string, usedIds: Set<string>): string {
  if (!usedIds.has(baseId)) {
    usedIds.add(baseId);
    return baseId;
  }

  let index = 2;
  let candidate = `${baseId}__dedupe_${index}`;
  while (usedIds.has(candidate)) {
    index += 1;
    candidate = `${baseId}__dedupe_${index}`;
  }
  usedIds.add(candidate);
  return candidate;
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
