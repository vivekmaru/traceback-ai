import type { Stats } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { getTracebackPaths } from "./storage";
import { inferStatus } from "./extract";
import { assertSafeRunId } from "./run-id";
import type { AnalysisOutput } from "./analyze";
import type { ReviewDecision, ReviewDecisionsFile } from "./review";
import type { DraftRule, DraftRulesFile, LearningScope } from "./rules";
import type { RuleDecision, RuleDecisionsFile } from "./rules-review";
import type {
  FailureCandidate,
  FailureCandidateStatus,
  NormalizedPullRequestRecord,
  NormalizedReviewComment,
  NormalizedReviewThread,
} from "./types";

export type UiServerOptions = {
  host: string;
  port: number;
};

export type UiState = {
  schemaVersion: 1;
  generatedAt: string;
  repoRoot: string;
  summary: UiSummary;
  candidates: UiCandidate[];
  runs: UiRun[];
  defaultRunId: string | null;
  clusters: UiCluster[];
  reviewDecisions: UiReviewDecision[];
  draftRules: UiDraftRule[];
  ruleDecisions: UiRuleDecision[];
  exportItems: UiExport[];
  warnings: string[];
};

export type UiSummary = {
  importedPrs: number;
  failureCandidates: number;
  statusCounts: Partial<Record<FailureCandidateStatus, number>>;
  analysisRuns: number;
  reviewDecisions: number;
  draftRules: number;
  ruleDecisions: number;
  exports: number;
};

export type UiCandidate = {
  id: string;
  sourcePrNumber: number;
  sourcePrUrl: string;
  sourceCommentUrl: string | null;
  sourceAuthor: string | null;
  sourceType: FailureCandidate["sourceType"];
  sourcePath: string | null;
  sourceLine: number | null;
  title: string;
  category: FailureCandidate["candidateCategory"];
  severity: FailureCandidate["candidateSeverity"];
  confidence: FailureCandidate["confidence"];
  status: FailureCandidate["status"];
  evidenceExcerpt: string;
  detectedAgentMarkers: string[];
  notes: string[];
  createdAt: string | null;
  updatedAt: string | null;
  statusEvidence: UiCandidateStatusEvidence;
};

export type UiCandidateStatusEvidence = {
  label: string;
  detail: string;
  basis: ReturnType<typeof inferStatus>["basis"];
  inferredStatus: FailureCandidateStatus | null;
  matchesStoredStatus: boolean | null;
  replyCount: number;
  supportingReplyExcerpt: string | null;
  latestReplyExcerpt: string | null;
  threadResolved: boolean | null;
  threadOutdated: boolean | null;
};

export type UiRun = {
  runId: string;
  createdAt: string | null;
  mode: string;
  provider: string | null;
  failureCandidateCount: number;
  hasInput: boolean;
  hasPrompt: boolean;
  hasProviderOutput: boolean;
  hasAnalysisOutput: boolean;
  hasReviewOutput: boolean;
  hasDraftRules: boolean;
  hasRuleDecisions: boolean;
  enrichedRecords: number;
  clusters: number;
  reviewDecisions: number;
  draftRules: number;
  ruleDecisions: number;
  exportedRules: number;
  hasProposedAgents: boolean;
  warnings: string[];
  clusterItems: UiCluster[];
  reviewDecisionItems: UiReviewDecision[];
  draftRuleItems: UiDraftRule[];
  ruleDecisionItems: UiRuleDecision[];
  exportItem: UiExport | null;
};

export type UiCluster = {
  runId: string;
  id: string;
  title: string;
  summary: string;
  preventionRule: string;
  confidence: string;
  sourcePrs: number[];
  sourceCandidateIds: string[];
};

export type UiReviewDecision = {
  runId: string;
  id: string;
  title: string;
  decision: string;
  confidence: string;
  sourcePrs: number[];
  sourceCandidateIds: string[];
  reason: string;
};

export type UiDraftRule = {
  runId: string;
  id: string;
  title: string;
  rule: string;
  learningScope: LearningScope | "unknown";
  confidence: string;
  sourcePrs: number[];
};

export type UiRuleDecision = {
  runId: string;
  ruleId: string;
  title: string;
  decision: string;
  confidence: string;
  reason: string;
};

export type UiExport = {
  runId: string;
  target: string;
  createdAt: string | null;
  exportedRuleCount: number;
  repoSpecificRuleCount: number;
  broaderLearningCount: number;
  warnings: string[];
  hasProposedAgents: boolean;
  hasBroaderLearnings: boolean;
  proposedAgentsText: string | null;
  broaderLearningsText: string | null;
  summaryText: string | null;
};

type AnalysisManifest = {
  runId?: string;
  mode: string;
  provider: string | null;
  createdAt: string;
  source?: {
    failureCandidateCount?: number;
  };
  files?: {
    input?: string | null;
    prompt?: string | null;
    response?: string | null;
    enrichedRecords?: string | null;
    clusters?: string | null;
    summary?: string | null;
  };
};

type RulesExportManifest = {
  runId?: string;
  target?: string;
  createdAt?: string;
  exportedRuleCount?: number;
  repoSpecificRuleCount?: number;
  broaderLearningCount?: number;
  warnings?: string[];
};

export async function loadUiState(repoRoot: string, now = new Date()): Promise<UiState> {
  const paths = getTracebackPaths(repoRoot);
  const records = await readJsonFiles<NormalizedPullRequestRecord>(paths.dir, paths.records, (name) =>
    /^pr-\d+\.json$/.test(name),
  );
  const candidates = await readJsonFiles<FailureCandidate>(paths.dir, paths.failures, (name) => name.endsWith(".json"));
  const runs = await readRuns(repoRoot);
  const summary = buildSummary({ records, candidates, runs });
  const warnings = buildWarnings({ records, candidates, runs });

  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    repoRoot,
    summary,
    candidates: candidates.map((candidate) => toUiCandidate(candidate, records)),
    runs,
    defaultRunId: runs.find((run) => run.mode === "provider" && run.hasProviderOutput && run.hasAnalysisOutput)?.runId ?? runs[0]?.runId ?? null,
    clusters: runs.flatMap((run) => run.clusterItems),
    reviewDecisions: runs.flatMap((run) => run.reviewDecisionItems),
    draftRules: runs.flatMap((run) => run.draftRuleItems),
    ruleDecisions: runs.flatMap((run) => run.ruleDecisionItems),
    exportItems: runs.flatMap((run) => (run.exportItem ? [run.exportItem] : [])),
    warnings,
  };
}

export async function runUiServer(repoRoot: string, options: UiServerOptions): Promise<void> {
  if (!["127.0.0.1", "localhost", "::1"].includes(options.host)) {
    throw new Error("Traceback UI must bind to a loopback host: 127.0.0.1, localhost, or ::1.");
  }
  const server = Bun.serve({
    // Do not depend on DNS or hosts-file resolution to keep localhost local.
    hostname: options.host === "localhost" ? "127.0.0.1" : options.host,
    port: options.port,
    fetch(request, server) {
      return createUiRequestHandler(repoRoot, server.port!)(request);
    },
  });

  console.log(`Traceback UI running at ${server.url}`);
  await new Promise(() => {});
}

export function createUiRequestHandler(repoRoot: string, port: number) {
  const localAuthorities = ["127.0.0.1", "localhost", "[::1]"]
    .flatMap((host) => port === 80 ? [host, `${host}:80`] : [`${host}:${port}`]);

  return async (request: Request): Promise<Response> => {
    const respond = (response: Response): Response => {
      response.headers.set("cache-control", "no-store");
      response.headers.set("x-content-type-options", "nosniff");
      response.headers.set("referrer-policy", "no-referrer");
      return request.method === "HEAD"
        ? new Response(null, { status: response.status, headers: response.headers })
        : response;
    };
    const url = new URL(request.url);
    const host = request.headers.get("host")?.toLowerCase();
    const origin = request.headers.get("origin");
    const fetchSite = request.headers.get("sec-fetch-site");
    if (
      url.protocol !== "http:" || url.username || url.password ||
      !localAuthorities.includes(url.host) || !host || !localAuthorities.includes(host) ||
      new URL(`http://${host}`).host !== url.host ||
      (origin !== null && origin !== url.origin) ||
      (fetchSite !== null && fetchSite !== "same-origin" && fetchSite !== "none")
    ) {
      return respond(new Response("Forbidden: Traceback UI only accepts same-origin loopback requests.", { status: 403 }));
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return respond(new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } }));
    }
    if (url.pathname === "/") {
      return respond(htmlResponse(renderHtml()));
    }
    if (url.pathname === "/api/state") {
      try {
        return respond(jsonResponse(await loadUiState(repoRoot)));
      } catch (error) {
        return respond(jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 500));
      }
    }
    return respond(new Response("Not found", { status: 404 }));
  };
}

async function readRuns(repoRoot: string): Promise<UiRun[]> {
  const paths = getTracebackPaths(repoRoot);
  const entries = (await readDirectoryIfExists(paths.dir, paths.analysisRuns))
    .filter((item) => item.isDirectory() || item.isSymbolicLink())
    .map((item) => item.name);
  const runs = await Promise.all(entries.sort().reverse().map((runId) => readRun(repoRoot, runId)));
  return runs.sort(compareRuns);
}

async function readRun(repoRoot: string, runId: string): Promise<UiRun> {
  assertSafeRunId(runId);
  const paths = getTracebackPaths(repoRoot);
  const runDir = path.join(paths.analysisRuns, runId);
  const manifestPath = path.join(runDir, "manifest.json");
  const manifest = await readJsonIfExists<AnalysisManifest>(paths.dir, manifestPath);
  assertManifestRunId(manifest, runId, manifestPath);
  const inputPath = manifestFilePath(manifest, "input", manifestPath, "input.json");
  const promptPath = manifestFilePath(manifest, "prompt", manifestPath, "prompt.md");
  const responsePath = manifestFilePath(manifest, "response", manifestPath, null);
  const analysis = await readAnalysisOutput(paths.dir, runDir);
  const reviews = await readJsonIfExists<ReviewDecisionsFile>(
    paths.dir, path.join(paths.reviews, runId, "decisions.json"),
  );
  const draftRules = await readJsonIfExists<DraftRulesFile>(
    paths.dir, path.join(paths.rules, runId, "draft-rules.json"),
  );
  const ruleDecisions = await readJsonIfExists<RuleDecisionsFile>(
    paths.dir, path.join(paths.rules, runId, "rule-decisions.json"),
  );
  const exportManifestPath = path.join(paths.exports, runId, "manifest.json");
  const exportManifest = await readJsonIfExists<RulesExportManifest>(paths.dir, exportManifestPath);
  assertManifestRunId(exportManifest, runId, exportManifestPath);
  const exportItem = await readExport(paths.dir, paths.exports, runId, exportManifest);
  const clusterItems = (analysis.clusters ?? []).map((cluster) => ({
    runId,
    id: cluster.id,
    title: cluster.title,
    summary: cluster.summary,
    preventionRule: cluster.preventionRule,
    confidence: cluster.confidence,
    sourcePrs: cluster.sourcePrs,
    sourceCandidateIds: cluster.candidateIds,
  }));
  const reviewDecisionItems = (reviews?.decisions ?? []).map((decision) =>
    toUiReviewDecision(runId, decision),
  );
  const draftRuleItems = (draftRules?.rules ?? []).map((rule) => toUiDraftRule(runId, rule));
  const ruleDecisionItems = (ruleDecisions?.decisions ?? []).map((decision) =>
    toUiRuleDecision(runId, decision),
  );

  return {
    runId,
    createdAt: manifest?.createdAt ?? null,
    mode: manifest?.mode ?? "unknown",
    provider: manifest?.provider ?? null,
    failureCandidateCount: manifest?.source?.failureCandidateCount ?? 0,
    hasInput: inputPath !== null && (await fileExists(paths.dir, inputPath)),
    hasPrompt: promptPath !== null && (await fileExists(paths.dir, promptPath)),
    hasProviderOutput: responsePath !== null && (await fileExists(paths.dir, responsePath)),
    hasAnalysisOutput: analysis.enrichedRecords !== undefined && analysis.clusters !== undefined,
    hasReviewOutput: reviews !== null,
    hasDraftRules: draftRules !== null,
    hasRuleDecisions: ruleDecisions !== null,
    enrichedRecords: analysis.enrichedRecords?.length ?? 0,
    clusters: analysis.clusters?.length ?? 0,
    reviewDecisions: reviews?.decisions.length ?? 0,
    draftRules: draftRules?.rules.length ?? 0,
    ruleDecisions: ruleDecisions?.decisions.length ?? 0,
    exportedRules: exportItem?.exportedRuleCount ?? 0,
    hasProposedAgents: exportItem?.hasProposedAgents ?? false,
    warnings: exportItem?.warnings ?? [],
    clusterItems,
    reviewDecisionItems,
    draftRuleItems,
    ruleDecisionItems,
    exportItem,
  };
}

async function readExport(
  dataRoot: string,
  exportsRoot: string,
  runId: string,
  manifest: RulesExportManifest | null,
): Promise<UiExport | null> {
  if (!manifest) {
    return null;
  }

  const exportDir = path.join(exportsRoot, runId);
  const proposedAgentsText = await readTextIfExists(dataRoot, path.join(exportDir, "AGENTS.proposed.md"));
  const broaderLearningsText = await readTextIfExists(dataRoot, path.join(exportDir, "broader-learnings.md"));
  const summaryText = await readTextIfExists(dataRoot, path.join(exportDir, "export-summary.md"));
  return {
    runId,
    target: manifest.target ?? "unknown",
    createdAt: manifest.createdAt ?? null,
    exportedRuleCount: manifest.exportedRuleCount ?? 0,
    repoSpecificRuleCount: manifest.repoSpecificRuleCount ?? manifest.exportedRuleCount ?? 0,
    broaderLearningCount: manifest.broaderLearningCount ?? 0,
    warnings: manifest.warnings ?? [],
    hasProposedAgents: proposedAgentsText !== null,
    hasBroaderLearnings: broaderLearningsText !== null,
    proposedAgentsText,
    broaderLearningsText,
    summaryText,
  };
}

function assertManifestRunId(
  manifest: { runId?: string } | null,
  runId: string,
  filePath: string,
): void {
  if (manifest?.runId !== undefined && manifest.runId !== runId) {
    throw new Error(`Manifest runId does not match directory ${runId}: ${filePath}`);
  }
}

function manifestFilePath(
  manifest: AnalysisManifest | null,
  key: "input" | "prompt" | "response",
  manifestPath: string,
  fallback: string | null,
): string | null {
  const name = manifest?.files?.[key] ?? fallback;
  if (name === null) return null;
  // A portable basename only: no traversal, drive prefixes, separators or controls.
  if (typeof name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) {
    throw new Error(`Invalid files.${key} in ${manifestPath}: expected a safe basename.`);
  }
  return path.join(path.dirname(manifestPath), name);
}

async function readAnalysisOutput(dataRoot: string, runDir: string): Promise<Partial<AnalysisOutput>> {
  const enrichedRecords = await readJsonIfExists<AnalysisOutput["enrichedRecords"]>(
    dataRoot, path.join(runDir, "enriched-records.json"),
  );
  const clusters = await readJsonIfExists<AnalysisOutput["clusters"]>(dataRoot, path.join(runDir, "clusters.json"));
  const summary = await readJsonIfExists<AnalysisOutput["summary"]>(dataRoot, path.join(runDir, "summary.json"));

  // Keep parsed partial artifacts inspectable without marking analysis complete.
  return {
    enrichedRecords: enrichedRecords ?? undefined,
    clusters: clusters ?? undefined,
    summary: summary ?? undefined,
  };
}

async function readJsonFiles<T>(
  dataRoot: string,
  dirPath: string,
  predicate: (entry: string) => boolean,
): Promise<T[]> {
  const entries = await readDirectoryIfExists(dataRoot, dirPath);
  const values: Array<T | null> = await Promise.all(
    entries
      .map((entry) => entry.name)
      .filter(predicate)
      .sort()
      .map(async (entry) => readJsonIfExists<T>(dataRoot, path.join(dirPath, entry))),
  );

  return values.filter((value): value is T => value !== null);
}

async function readDirectoryIfExists(dataRoot: string, dirPath: string) {
  try {
    if (await safeUiStat(dataRoot, dirPath) === null) return [];
    return await readdir(dirPath, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function readJsonIfExists<T>(dataRoot: string, filePath: string): Promise<T | null> {
  const text = await readTextIfExists(dataRoot, filePath);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    // Parser messages can echo sensitive artifact contents; report the filename only.
    throw new Error(`Invalid JSON in ${filePath}.`);
  }
}

async function readTextIfExists(dataRoot: string, filePath: string): Promise<string | null> {
  try {
    if (!await fileExists(dataRoot, filePath)) return null;
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function fileExists(dataRoot: string, filePath: string): Promise<boolean> {
  const info = await safeUiStat(dataRoot, filePath);
  if (info === null) return false;
  if (!info.isFile()) throw new Error(`Expected a regular file: ${filePath}`);
  return true;
}

async function safeUiStat(dataRoot: string, targetPath: string): Promise<Stats | null> {
  const root = path.resolve(dataRoot);
  const relative = path.relative(root, path.resolve(targetPath));
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`UI artifact path is outside .traceback: ${targetPath}`);
  }
  // Reject direct and parent links, including .traceback itself, even dangling links.
  // These checks are not atomic with reads; concurrent filesystem mutation is not sandboxed.
  let current = root;
  let info: Stats | null = null;
  for (const segment of ["", ...relative.split(path.sep).filter(Boolean)]) {
    current = path.join(current, segment);
    try {
      info = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (info.isSymbolicLink()) throw new Error(`UI refuses symbolic links in .traceback: ${current}`);
  }
  return info;
}

function buildSummary({
  records,
  candidates,
  runs,
}: {
  records: NormalizedPullRequestRecord[];
  candidates: FailureCandidate[];
  runs: UiRun[];
}): UiSummary {
  return {
    importedPrs: records.length,
    failureCandidates: candidates.length,
    statusCounts: countCandidateStatuses(candidates),
    analysisRuns: runs.length,
    reviewDecisions: sum(runs, (run) => run.reviewDecisions),
    draftRules: sum(runs, (run) => run.draftRules),
    ruleDecisions: sum(runs, (run) => run.ruleDecisions),
    exports: runs.filter((run) => run.exportedRules > 0 || run.hasProposedAgents).length,
  };
}

function countCandidateStatuses(
  candidates: FailureCandidate[],
): Partial<Record<FailureCandidateStatus, number>> {
  const counts: Partial<Record<FailureCandidateStatus, number>> = {};
  for (const candidate of candidates) {
    counts[candidate.status] = (counts[candidate.status] ?? 0) + 1;
  }
  return counts;
}

function buildWarnings({
  records,
  candidates,
  runs,
}: {
  records: NormalizedPullRequestRecord[];
  candidates: FailureCandidate[];
  runs: UiRun[];
}): string[] {
  const warnings: string[] = [];

  if (records.length === 0) {
    warnings.push("No imported PR records found. Run `traceback import --prs <number>`.");
  }
  if (candidates.length === 0) {
    warnings.push("No failure candidates found. Run `traceback extract`.");
  }
  if (runs.length === 0) {
    warnings.push("No analysis runs found. Run `traceback analyze --dry-run`.");
  }
  if (candidates.length > 0 && candidates.every((candidate) => candidate.status === "candidate")) {
    warnings.push(
      "No candidate has an inferred outcome. Same-thread replies or GitHub thread metadata may be unavailable; this alone does not indicate an extraction error.",
    );
  }

  return warnings;
}

function toUiCandidate(candidate: FailureCandidate, records: NormalizedPullRequestRecord[]): UiCandidate {
  const source = findCandidateSource(candidate, records);
  return {
    id: candidate.id,
    sourcePrNumber: candidate.sourcePrNumber,
    sourcePrUrl: candidate.sourcePrUrl,
    sourceCommentUrl: candidate.sourceCommentUrl,
    sourceAuthor: candidate.sourceAuthor,
    sourceType: candidate.sourceType,
    sourcePath: source.comment?.path ?? source.thread?.path ?? null,
    sourceLine: source.comment?.line ?? source.comment?.originalLine ?? source.thread?.line ?? null,
    title: candidate.extractedTitle,
    category: candidate.candidateCategory,
    severity: candidate.candidateSeverity,
    confidence: candidate.confidence,
    status: candidate.status,
    evidenceExcerpt: candidate.evidenceExcerpt,
    detectedAgentMarkers: candidate.detectedAgentMarkers,
    notes: candidate.notes,
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
    statusEvidence: buildCandidateStatusEvidence(candidate, source),
  };
}

function findCandidateSource(
  candidate: FailureCandidate,
  records: NormalizedPullRequestRecord[],
): {
  comment: NormalizedReviewComment | null;
  replies: NormalizedReviewComment[];
  thread: NormalizedReviewThread | null;
} {
  if (candidate.sourceType !== "review_comment") {
    return { comment: null, replies: [], thread: null };
  }

  const record = records.find((item) => item.prNumber === candidate.sourcePrNumber);
  const sourceId = parseReviewCommentId(candidate);
  if (!record || sourceId === null) {
    return { comment: null, replies: [], thread: null };
  }

  const comment = record.reviewComments.find((item) => item.id === sourceId) ?? null;
  const replies = record.reviewComments
    .filter((item) => item.inReplyToId === sourceId)
    .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
  const thread =
    record.reviewThreads.find((item) => item.commentIds.includes(String(sourceId))) ?? null;

  return { comment, replies, thread };
}

function parseReviewCommentId(candidate: FailureCandidate): number | null {
  const fromUrl = candidate.sourceCommentUrl?.match(/discussion_r(\d+)/)?.[1];
  const fromId = candidate.id.match(/review_comment-(\d+)$/)?.[1];
  const value = fromUrl ?? fromId;
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildCandidateStatusEvidence(
  candidate: FailureCandidate,
  source: {
    comment: NormalizedReviewComment | null;
    replies: NormalizedReviewComment[];
    thread: NormalizedReviewThread | null;
  },
): UiCandidateStatusEvidence {
  const inference = source.comment
    ? inferStatus(source.comment.body, source.replies.map((reply) => reply.body), source.thread)
    : null;
  const supportingReply = inference?.replyIndex != null ? source.replies[inference.replyIndex] : null;
  const latestReply = source.replies.at(-1);
  const basis = inference?.basis ?? "none";
  const labels = {
    reply: "Same-thread reply signal",
    thread_resolved: "GitHub thread resolved (metadata only)",
    thread_outdated: "GitHub thread outdated (metadata only)",
    source: "Uncertainty in source finding",
    none: "No outcome signal",
  };
  const details = {
    reply: `Matching reply from ${supportingReply?.author ?? "unknown author"} infers ${inference?.status}. This is a text signal, not independent verification of a fix.`,
    thread_resolved: "GitHub marks this thread resolved. No stronger reply signal was found; thread closure does not verify code correctness.",
    thread_outdated: "GitHub marks this thread outdated. Changed code context does not verify a fix.",
    source: "The source finding expresses uncertainty; no stronger outcome evidence was found.",
    none: source.comment
      ? "No outcome-bearing reply or thread state was found. Neutral replies do not confirm a fix."
      : "The original review comment is unavailable; the stored status cannot be checked against thread evidence.",
  };
  const matchesStoredStatus = inference ? inference.status === candidate.status : null;
  return {
    label: labels[basis],
    detail: details[basis] + (matchesStoredStatus === false
      ? ` Stored status is ${candidate.status}; current evidence infers ${inference?.status}. Re-run traceback extract to refresh candidates; historical runs remain unchanged.`
      : ""),
    basis,
    inferredStatus: inference?.status ?? null,
    matchesStoredStatus,
    replyCount: source.replies.length,
    supportingReplyExcerpt: supportingReply ? truncateText(normalizeWhitespace(supportingReply.body), 220) : null,
    latestReplyExcerpt: latestReply && latestReply !== supportingReply
      ? truncateText(normalizeWhitespace(latestReply.body), 220)
      : null,
    threadResolved: source.thread?.isResolved ?? null,
    threadOutdated: source.thread?.isOutdated ?? null,
  };
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 1).trimEnd()}...`;
}

function toUiReviewDecision(runId: string, decision: ReviewDecision): UiReviewDecision {
  return {
    runId,
    id: decision.id,
    title: decision.title ?? decision.id,
    decision: decision.decision ?? "unknown",
    confidence: decision.confidence ?? "unknown",
    sourcePrs: decision.sourcePrs ?? [],
    sourceCandidateIds: decision.sourceCandidateIds ?? [],
    reason: decision.reason ?? "",
  };
}

function toUiDraftRule(runId: string, rule: DraftRule): UiDraftRule {
  return {
    runId,
    id: rule.id,
    title: rule.title ?? rule.id,
    rule: rule.rule ?? "",
    learningScope: ["repo_specific", "general_engineering", "process_or_workflow"].includes(rule.learningScope)
      ? rule.learningScope
      : "unknown",
    confidence: rule.confidence ?? "unknown",
    sourcePrs: rule.sourcePrs ?? [],
  };
}

function toUiRuleDecision(runId: string, decision: RuleDecision): UiRuleDecision {
  return {
    runId,
    ruleId: decision.ruleId,
    title: decision.title ?? decision.ruleId,
    decision: decision.decision ?? "unknown",
    confidence: decision.confidence ?? "unknown",
    reason: decision.reason ?? "",
  };
}

function compareRuns(a: UiRun, b: UiRun): number {
  const aTime = a.createdAt ?? a.runId;
  const bTime = b.createdAt ?? b.runId;
  return bTime.localeCompare(aTime);
}

function sum<T>(values: T[], selector: (value: T) => number): number {
  return values.reduce((total, value) => total + selector(value), 0);
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function htmlResponse(html: string): Response {
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
    },
  });
}

export function renderHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Traceback Review UI</title>
  <link rel="icon" href="data:,">
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f7f4;
      --panel: #ffffff;
      --ink: #1e2420;
      --muted: #657068;
      --line: #d9ded8;
      --accent: #1f7a63;
      --accent-soft: #e5f3ee;
      --warn: #9a5b12;
      --warn-soft: #fff2d8;
      --bad: #9f2d2d;
      --good: #1f6f43;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      background: var(--bg);
      color: var(--ink);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.45;
    }

    header {
      padding: 24px clamp(16px, 3vw, 40px) 18px;
      border-bottom: 1px solid var(--line);
      background: var(--panel);
    }

    h1, h2, h3 { margin: 0; letter-spacing: 0; }
    h1 { font-size: 28px; }
    h2 { font-size: 18px; }
    h3 { font-size: 15px; }
    p { margin: 0; color: var(--muted); }

    main {
      display: grid;
      gap: 18px;
      padding: 20px clamp(16px, 3vw, 40px) 40px;
    }

    .topline {
      display: flex;
      flex-wrap: wrap;
      gap: 8px 14px;
      margin-top: 8px;
      color: var(--muted);
      font-size: 13px;
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 12px;
    }

    .card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 14px;
    }

    .metric {
      display: grid;
      gap: 4px;
      min-height: 76px;
    }

    .metric strong {
      font-size: 26px;
      line-height: 1;
    }

    .tabs {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }

    button {
      border: 1px solid var(--line);
      background: var(--panel);
      color: var(--ink);
      border-radius: 8px;
      padding: 8px 11px;
      font: inherit;
      cursor: pointer;
    }

    .run-select {
      width: 100%;
      text-align: left;
      padding: 14px;
    }

    button[aria-selected="true"] {
      border-color: var(--accent);
      background: var(--accent-soft);
      color: var(--accent);
    }

    .run-select[aria-current="true"] {
      border-color: var(--accent);
      background: var(--accent-soft);
    }

    .intro {
      max-width: 980px;
      color: var(--muted);
    }

    .overview {
      display: grid;
      min-width: 0;
      gap: 14px;
    }

    .overview-head {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
    }

    .stage-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
      gap: 10px;
    }

    .stage {
      display: grid;
      align-content: start;
      justify-items: start;
      gap: 6px;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px;
      background: #fbfbf9;
      min-width: 0;
    }

    .stage code, .proposal, .value {
      overflow-wrap: anywhere;
      word-break: break-word;
    }

    .legend {
      display: grid;
      gap: 8px;
      grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
    }

    .legend-item {
      display: grid;
      gap: 2px;
      color: var(--muted);
      font-size: 13px;
    }

    .section {
      display: none;
    }

    .section.active {
      display: grid;
      gap: 12px;
    }

    .list {
      display: grid;
      gap: 10px;
    }

    .row {
      display: grid;
      gap: 8px;
    }

    .controls {
      display: grid;
      gap: 10px;
      grid-template-columns: minmax(220px, 1.4fr) repeat(5, minmax(130px, .8fr)) auto;
      align-items: end;
    }

    .control {
      display: grid;
      gap: 4px;
      min-width: 0;
    }

    input, select {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      color: var(--ink);
      padding: 8px 10px;
      font: inherit;
    }

    .candidate-results {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      flex-wrap: wrap;
      color: var(--muted);
      font-size: 13px;
    }

    .candidate-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 8px;
    }

    .evidence {
      display: grid;
      gap: 6px;
      padding-top: 4px;
    }

    .evidence blockquote {
      margin: 0;
      padding-left: 10px;
      border-left: 3px solid var(--line);
      color: var(--muted);
    }

    .run {
      grid-template-columns: minmax(190px, 1.2fr) repeat(6, minmax(96px, .7fr));
      align-items: center;
    }

    .candidate {
      grid-template-columns: minmax(280px, 1.35fr) repeat(5, minmax(110px, .7fr));
    }

    .run, .candidate {
      display: grid;
      gap: 10px;
    }

    .run > *, .candidate > * {
      min-width: 0;
      overflow-wrap: anywhere;
    }

    .candidate-meta .pill {
      max-width: 100%;
      white-space: normal;
      overflow-wrap: anywhere;
    }

    .label {
      color: var(--muted);
      font-size: 12px;
    }

    .value {
      display: inline-block;
      max-width: 100%;
    }

    .pill {
      display: inline-flex;
      align-items: center;
      width: fit-content;
      border-radius: 999px;
      padding: 3px 8px;
      background: #f1f2ef;
      color: var(--muted);
      font-size: 12px;
      white-space: nowrap;
    }

    .pill.good { background: #e5f4ea; color: var(--good); }
    .pill.warn { background: var(--warn-soft); color: var(--warn); }
    .pill.bad { background: #f8e3e3; color: var(--bad); }

    .warnings {
      display: grid;
      gap: 8px;
    }

    .warning {
      border-color: #edcf9b;
      background: var(--warn-soft);
      color: #5d3b0d;
    }

    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }

    .proposal {
      margin: 0;
      white-space: pre-wrap;
      font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      color: var(--ink);
    }

    .empty {
      color: var(--muted);
      padding: 18px;
      text-align: center;
    }

    @media (max-width: 1100px) {
      .run, .candidate, .controls {
        grid-template-columns: minmax(0, 1fr);
      }
    }

    @media (max-width: 760px) {
      h1 { font-size: 24px; }
    }
  </style>
</head>
<body>
  <header>
    <h1>Traceback Review UI</h1>
    <div class="topline">
      <span id="repo-root"></span>
      <span id="generated-at"></span>
    </div>
  </header>
  <main>
    <p>Repository totals across all runs. Candidates below are the current extracted corpus, not a historical run snapshot.</p>
    <section class="grid" id="summary"></section>
    <section class="warnings" id="warnings"></section>
    <section id="selected-run"></section>
    <nav class="tabs" aria-label="Traceback views">
      <button type="button" data-tab="runs" aria-selected="true">Runs</button>
      <button type="button" data-tab="candidates" aria-selected="false">Candidates</button>
      <button type="button" data-tab="clusters" aria-selected="false">AI clusters</button>
      <button type="button" data-tab="reviews" aria-selected="false">Review decisions</button>
      <button type="button" data-tab="rules" aria-selected="false">Rules & exports</button>
    </nav>
    <section class="section active" id="runs"></section>
    <section class="section" id="candidates"></section>
    <section class="section" id="clusters"></section>
    <section class="section" id="reviews"></section>
    <section class="section" id="rules"></section>
  </main>
  <script>
    const state = {
      data: null,
      selectedRunId: null,
      candidateFilters: {
        query: "",
        status: "all",
        category: "all",
        sourceType: "all",
        confidence: "all",
        sort: "pr-desc",
      },
    };

    async function load() {
      const response = await fetch("/api/state");
      state.data = await response.json();
      if (!response.ok) throw new Error(state.data.error || "Could not load Traceback state");
      render();
    }

    function render() {
      const data = state.data;
      if (!state.selectedRunId || !data.runs.some((run) => run.runId === state.selectedRunId)) {
        state.selectedRunId = data.defaultRunId;
      }
      document.getElementById("repo-root").textContent = data.repoRoot;
      document.getElementById("generated-at").textContent = "Generated " + formatDate(data.generatedAt);
      renderSummary(data.summary);
      renderWarnings(data.warnings);
      renderSelectedRun(data);
      renderRuns(data.runs);
      renderCandidates(data.candidates, data.summary.statusCounts);
      const selectedRun = getSelectedRun();
      renderClusters(selectedRun);
      renderReviewDecisions(selectedRun);
      renderRules(selectedRun);
    }

    function renderSummary(summary) {
      const items = [
        ["Imported PRs", summary.importedPrs],
        ["Candidates", summary.failureCandidates],
        ["Analysis runs", summary.analysisRuns],
        ["Review decisions", summary.reviewDecisions],
        ["Draft rules", summary.draftRules],
        ["Rule decisions", summary.ruleDecisions],
        ["Exports", summary.exports],
      ];
      document.getElementById("summary").innerHTML = items.map(([label, value]) => \`
        <article class="card metric">
          <span class="label">\${escapeHtml(label)}</span>
          <strong>\${value}</strong>
        </article>
      \`).join("");
    }

    function renderWarnings(warnings) {
      document.getElementById("warnings").innerHTML = warnings.map((warning) => \`
        <article class="card warning">\${escapeHtml(warning)}</article>
      \`).join("");
    }

    function renderSelectedRun(data) {
      const container = document.getElementById("selected-run");
      const run = getSelectedRun();
      if (!run) {
        container.innerHTML = \`<article class="card overview">\${emptyContent("No analysis run selected.")}</article>\`;
        return;
      }

      const latestRun = data.runs[0];
      container.innerHTML = \`
        <article class="card overview">
          <label class="control">Inspect run
            <select id="run-picker">\${data.runs.map((item) => \`
              <option value="\${escapeHtml(item.runId)}" \${item.runId === run.runId ? "selected" : ""}>\${escapeHtml(runLabel(item) + " · " + item.runId)}</option>
            \`).join("")}</select>
          </label>
          \${latestRun.runId !== run.runId ? \`<p>Viewing an older run. The latest run is \${escapeHtml(runLabel(latestRun))} (\${escapeHtml(latestRun.runId)}). Newer candidates are not included in this analysis.</p>\` : ""}
          <div class="overview-head">
            <div>
              <span class="label">Selected analysis run</span>
              <h2>\${escapeHtml(runLabel(run))}</h2>
              <p class="value">\${escapeHtml(formatDate(run.createdAt))} · <code>\${escapeHtml(run.runId)}</code></p>
            </div>
            <div>
              <span class="label">Provider output</span><br>
              \${statusPill(run.hasProviderOutput ? "present" : "missing", run.hasProviderOutput ? "good" : "warn")}
            </div>
          </div>
          <div class="grid">
            \${metric("Candidates", run.failureCandidateCount)}
            \${metric("Enriched records", run.enrichedRecords)}
            \${metric("Clusters", run.clusters)}
            \${metric("Review decisions", run.reviewDecisions)}
            \${metric("Draft rules", run.draftRules)}
            \${metric("Rule decisions", run.ruleDecisions)}
            \${metric("Exported rules", run.exportedRules)}
          </div>
          <details \${run.hasAnalysisOutput ? "" : "open"}>
            <summary>Pipeline stages and next steps</summary>
            <div class="stage-grid">\${stageCards(data.summary, run)}</div>
          </details>
        </article>
      \`;
      container.querySelector("#run-picker").addEventListener("change", (event) => {
        state.selectedRunId = event.target.value;
        render();
      });
    }

    function runLabel(run) {
      return (run.mode === "dry-run" ? "Dry run" : run.provider || run.mode) + " · " + run.failureCandidateCount + " candidates";
    }

    function renderRuns(runs) {
      const container = document.getElementById("runs");
      container.innerHTML = "<h2>Runs overview</h2><p class='intro'>Newest first. Initially selects the latest provider run with usable analysis output, or the latest run if none exists. Select any run to inspect its artifacts.</p>" + (runs.length ? \`
        <div class="list">
          \${runs.map((run) => \`
            <button type="button" class="run-select" data-run-id="\${escapeHtml(run.runId)}" aria-current="\${String(run.runId === state.selectedRunId)}">
              <span class="run">
                <span>
                  <strong>\${escapeHtml(runLabel(run))}</strong><br>
                  <span class="value">\${escapeHtml(formatDate(run.createdAt))}</span><br>
                  <code class="value">\${escapeHtml(run.runId)}</code>
                </span>
                \${field("Mode", run.mode)}
                \${field("Candidates", run.failureCandidateCount)}
                \${field("Clusters", run.clusters)}
                \${field("Reviews", run.reviewDecisions)}
                \${field("Rules", run.draftRules)}
                <span>
                  <span class="label">Provider output</span><br>
                  \${statusPill(run.hasProviderOutput ? "present" : "missing", run.hasProviderOutput ? "good" : "warn")}
                </span>
              </span>
            </button>
          \`).join("")}
        </div>
      \` : empty("No analysis runs found."));
      container.querySelectorAll("[data-run-id]").forEach((button) => {
        button.addEventListener("click", () => {
          state.selectedRunId = button.dataset.runId;
          render();
        });
      });
    }

    function renderCandidates(candidates, statusCounts) {
      const container = document.getElementById("candidates");
      const filteredCandidates = sortCandidates(filterCandidates(candidates));
      container.innerHTML = "<h2>Failure candidates — current corpus</h2><p class='intro'>These candidates reflect the latest extraction, independent of the selected analysis run. Extraction confidence is not confidence that a fix worked.</p>" + renderStatusDistribution(statusCounts) + renderCandidateControls(candidates, filteredCandidates.length) + (filteredCandidates.length ? \`
        <div class="list">
          \${filteredCandidates.map((candidate) => \`
            <article class="card candidate">
              <div>
                <h3>\${escapeHtml(candidate.title)}</h3>
                <p>\${escapeHtml(candidate.evidenceExcerpt)}</p>
                <div class="candidate-meta">
                  \${candidate.sourceCommentUrl ? link(candidate.sourceCommentUrl, "Source comment") : link(candidate.sourcePrUrl, "Source PR")}
                  \${link(candidate.sourcePrUrl, "PR #" + candidate.sourcePrNumber)}
                  \${candidate.sourcePath ? statusPill(candidate.sourcePath + (candidate.sourceLine ? ":" + candidate.sourceLine : ""), "") : ""}
                  \${candidate.detectedAgentMarkers.map((marker) => statusPill(marker, "")).join("")}
                </div>
              </div>
              \${field("PR", "#" + candidate.sourcePrNumber)}
              \${field("Category", candidate.category)}
              \${field("Confidence", candidate.confidence)}
              \${field("Source", candidate.sourceType)}
              <div>
                <span class="label">Status</span><br>
                \${statusPill(candidate.status, statusTone(candidate.status))}
              </div>
              <div class="evidence">
                <span class="label">Status evidence</span>
                <strong>\${escapeHtml(candidate.statusEvidence.label)}</strong>
                <span class="value">\${escapeHtml(candidate.statusEvidence.detail)}</span>
                \${candidate.statusEvidence.matchesStoredStatus === false ? statusPill("Stored status differs", "warn") : ""}
                \${candidate.statusEvidence.supportingReplyExcerpt ? \`<span class="label">Matching reply</span><blockquote>\${escapeHtml(candidate.statusEvidence.supportingReplyExcerpt)}</blockquote>\` : ""}
                \${candidate.statusEvidence.latestReplyExcerpt ? \`<span class="label">Latest reply (context only)</span><blockquote>\${escapeHtml(candidate.statusEvidence.latestReplyExcerpt)}</blockquote>\` : ""}
                <span class="label">\${escapeHtml(threadState(candidate))}</span>
              </div>
            </article>
          \`).join("")}
        </div>
      \` : empty(candidates.length ? "No candidates match the current filters." : "No failure candidates found."));
      bindCandidateControls(container);
    }

    function renderCandidateControls(candidates, visibleCount) {
      const filters = state.candidateFilters;
      return \`
        <article class="card row">
          <div class="controls">
            \${control("Search", \`<input type="search" data-candidate-filter="query" placeholder="Title, evidence, PR, category, status" value="\${escapeHtml(filters.query)}">\`)}
            \${control("Status", select("status", statusOptions(candidates), filters.status))}
            \${control("Category", select("category", optionsFor(candidates, "category"), filters.category))}
            \${control("Source", select("sourceType", optionsFor(candidates, "sourceType"), filters.sourceType))}
            \${control("Confidence", select("confidence", optionsFor(candidates, "confidence"), filters.confidence))}
            \${control("Sort", select("sort", [
              ["pr-desc", "PR newest"],
              ["pr-asc", "PR oldest"],
              ["confidence-desc", "Confidence"],
              ["status", "Status"],
              ["category", "Category"],
            ], filters.sort))}
            <button type="button" data-candidate-reset>Reset</button>
          </div>
          <div class="candidate-results">
            <span>Showing \${visibleCount} of \${candidates.length} candidates</span>
            <span>Filters are local to this browser session.</span>
          </div>
        </article>
      \`;
    }

    function control(label, inputHtml) {
      return \`<label class="control"><span class="label">\${escapeHtml(label)}</span>\${inputHtml}</label>\`;
    }

    function select(name, options, selectedValue) {
      return \`<select data-candidate-filter="\${escapeHtml(name)}">\${options.map(([value, label]) => \`
        <option value="\${escapeHtml(value)}" \${value === selectedValue ? "selected" : ""}>\${escapeHtml(label)}</option>
      \`).join("")}</select>\`;
    }

    function optionsFor(candidates, key) {
      return [["all", "All"], ...Array.from(new Set(candidates.map((candidate) => candidate[key]).filter(Boolean)))
        .sort((a, b) => String(a).localeCompare(String(b)))
        .map((value) => [String(value), String(value)])];
    }

    function statusOptions(candidates) {
      const counts = candidates.reduce((accumulator, candidate) => {
        accumulator[candidate.status] = (accumulator[candidate.status] ?? 0) + 1;
        return accumulator;
      }, {});
      return [["all", "All"], ...Object.keys(counts)
        .sort((a, b) => statusRank(a) - statusRank(b) || a.localeCompare(b))
        .map((status) => [status, status + " (" + counts[status] + ")"])];
    }

    function bindCandidateControls(container) {
      container.querySelectorAll("[data-candidate-filter]").forEach((control) => {
        if (control.dataset.candidateFilter === "query") {
          control.addEventListener("input", () => updateCandidateFilter(control));
        } else {
          control.addEventListener("change", () => updateCandidateFilter(control));
        }
      });
      container.querySelector("[data-candidate-reset]")?.addEventListener("click", () => {
        state.candidateFilters = {
          query: "",
          status: "all",
          category: "all",
          sourceType: "all",
          confidence: "all",
          sort: "pr-desc",
        };
        renderCandidates(state.data.candidates, state.data.summary.statusCounts);
      });
    }

    function updateCandidateFilter(control) {
      const filterName = control.dataset.candidateFilter;
      const value = control.value;
      state.candidateFilters[filterName] = value;
      renderCandidates(state.data.candidates, state.data.summary.statusCounts);
      if (filterName === "query") {
        requestAnimationFrame(() => {
          const input = document.querySelector('[data-candidate-filter="query"]');
          input?.focus();
          input?.setSelectionRange(value.length, value.length);
        });
      }
    }

    function filterCandidates(candidates) {
      const filters = state.candidateFilters;
      const query = filters.query.trim().toLowerCase();
      return candidates.filter((candidate) => {
        if (filters.status !== "all" && candidate.status !== filters.status) return false;
        if (filters.category !== "all" && candidate.category !== filters.category) return false;
        if (filters.sourceType !== "all" && candidate.sourceType !== filters.sourceType) return false;
        if (filters.confidence !== "all" && candidate.confidence !== filters.confidence) return false;
        if (!query) return true;
        return candidateSearchText(candidate).includes(query);
      });
    }

    function candidateSearchText(candidate) {
      return [
        candidate.id,
        candidate.title,
        candidate.evidenceExcerpt,
        candidate.sourcePrNumber,
        candidate.sourceAuthor,
        candidate.sourceType,
        candidate.sourcePath,
        candidate.category,
        candidate.severity,
        candidate.confidence,
        candidate.status,
        candidate.statusEvidence.label,
        candidate.statusEvidence.detail,
        candidate.statusEvidence.supportingReplyExcerpt,
        candidate.statusEvidence.latestReplyExcerpt,
        ...(candidate.detectedAgentMarkers ?? []),
        ...(candidate.notes ?? []),
      ].filter(Boolean).join(" ").toLowerCase();
    }

    function sortCandidates(candidates) {
      const rankedConfidence = { high: 0, medium: 1, low: 2 };
      return [...candidates].sort((a, b) => {
        switch (state.candidateFilters.sort) {
          case "pr-asc":
            return a.sourcePrNumber - b.sourcePrNumber || a.id.localeCompare(b.id);
          case "confidence-desc":
            return (rankedConfidence[a.confidence] ?? 9) - (rankedConfidence[b.confidence] ?? 9) || b.sourcePrNumber - a.sourcePrNumber;
          case "status":
            return statusRank(a.status) - statusRank(b.status) || b.sourcePrNumber - a.sourcePrNumber;
          case "category":
            return a.category.localeCompare(b.category) || b.sourcePrNumber - a.sourcePrNumber;
          default:
            return b.sourcePrNumber - a.sourcePrNumber || a.id.localeCompare(b.id);
        }
      });
    }

    function threadState(candidate) {
      const evidence = candidate.statusEvidence;
      const thread = evidence.threadResolved === null
        ? "thread unknown"
        : "thread " + (evidence.threadResolved ? "resolved" : "open");
      const outdated = evidence.threadOutdated === null
        ? "outdated unknown"
        : evidence.threadOutdated ? "outdated" : "current";
      return evidence.replyCount + " same-thread replies · " + thread + " · " + outdated;
    }

    function renderClusters(run) {
      const container = document.getElementById("clusters");
      const clusters = run?.clusterItems ?? [];
      container.innerHTML = "<h2>AI clusters</h2><p class='intro'>Clusters are provider-enriched groupings of related deterministic candidates for the selected run.</p>" + (clusters.length ? \`
        <div class="list">
          \${clusters.map((cluster) => \`
            <article class="card row">
              <div>
                <h3>\${escapeHtml(cluster.title)}</h3>
                <p>\${escapeHtml(cluster.summary)}</p>
              </div>
              <div>
                <span class="label">Run</span><br>
                <code>\${escapeHtml(cluster.runId)}</code>
              </div>
              \${field("Confidence", cluster.confidence)}
              \${field("Source PRs", cluster.sourcePrs.map((pr) => "#" + pr).join(", ") || "none")}
              <div>
                <span class="label">Prevention rule</span><br>
                <span>\${escapeHtml(cluster.preventionRule || "No prevention rule recorded.")}</span>
              </div>
            </article>
          \`).join("")}
        </div>
      \` : empty(run ? "No AI clusters found for the selected run. Provider output may be missing." : "No run selected."));
    }

    function renderReviewDecisions(run) {
      const container = document.getElementById("reviews");
      const decisions = run?.reviewDecisionItems ?? [];
      container.innerHTML = "<h2>Review decisions</h2><p class='intro'>Conservative review turns AI clusters into local decisions before any rule draft is generated.</p>" + renderReviewLegend() + (decisions.length ? \`
        <div class="list">
          \${decisions.map((decision) => \`
            <article class="card candidate">
              <div>
                <h3>\${escapeHtml(decision.title)}</h3>
                <p>\${escapeHtml(decision.reason || "No reason recorded.")}</p>
              </div>
              \${field("Run", decision.runId)}
              \${field("Decision", decision.decision)}
              \${field("Confidence", decision.confidence)}
              \${field("Source PRs", decision.sourcePrs.map((pr) => "#" + pr).join(", ") || "none")}
            </article>
          \`).join("")}
        </div>
      \` : empty(run ? "No review decisions found for the selected run." : "No run selected."));
    }

    function renderRules(run) {
      const container = document.getElementById("rules");
      if (!run) {
        container.innerHTML = "<h2>Rules and exports</h2>" + empty("No run selected.");
        return;
      }
      const draftRules = run.draftRuleItems ?? [];
      const ruleDecisions = run.ruleDecisionItems ?? [];
      const exportItem = run.exportItem;
      const runHtml = \`
        <div class="list">
          <article class="card run">
            <div>
              <h3>\${escapeHtml(run.runId)}</h3>
              <p>\${run.warnings.length ? escapeHtml(run.warnings.join(" ")) : exportItem ? "No export warnings." : "No export has been generated for this run."}</p>
            </div>
            \${field("Draft rules", run.draftRules)}
            \${field("Rule decisions", run.ruleDecisions)}
            \${field("Exported rules", run.exportedRules)}
            <div>
              <span class="label">AGENTS proposal</span><br>
              \${statusPill(run.hasProposedAgents ? "present" : "missing", run.hasProposedAgents ? "good" : "warn")}
            </div>
          </article>
        </div>
      \`;
      const rulesHtml = draftRules.length ? \`
        <h3>Draft rules</h3>
        <div class="list">
          \${draftRules.map((rule) => \`
            <article class="card row">
              <h3>\${escapeHtml(rule.title)}</h3>
              <p>\${escapeHtml(rule.rule)}</p>
              \${field("Run", rule.runId)}
              \${field("Learning scope", rule.learningScope.replaceAll("_", " "))}
              \${field("Confidence", rule.confidence)}
            </article>
          \`).join("")}
        </div>
      \` : "";
      const decisionsHtml = ruleDecisions.length ? \`
        <h3>Rule decisions</h3>
        \${renderRuleLegend()}
        <div class="list">
          \${ruleDecisions.map((decision) => \`
            <article class="card row">
              <h3>\${escapeHtml(decision.title)}</h3>
              <p>\${escapeHtml(decision.reason || "No reason recorded.")}</p>
              \${field("Run", decision.runId)}
              \${field("Decision", decision.decision)}
              \${field("Confidence", decision.confidence)}
            </article>
          \`).join("")}
        </div>
      \` : "";
      const exportHtml = exportItem ? \`
        <h3>Proposed export</h3>
        <article class="card row">
          \${field("Target", exportItem.target)}
          \${field("Created", formatDate(exportItem.createdAt))}
          \${field("Exported rules", exportItem.exportedRuleCount)}
          \${field("Repo-specific rules", exportItem.repoSpecificRuleCount)}
          \${field("Broader learnings", exportItem.broaderLearningCount)}
          \${field("Warnings", exportItem.warnings.length ? exportItem.warnings.join(" ") : "none")}
          \${exportItem.proposedAgentsText ? \`<pre class="proposal">\${escapeHtml(exportItem.proposedAgentsText)}</pre>\` : "<p>No AGENTS.proposed.md was written for this run.</p>"}
          \${exportItem.broaderLearningsText ? \`<pre class="proposal">\${escapeHtml(exportItem.broaderLearningsText)}</pre>\` : ""}
        </article>
      \` : "";
      container.innerHTML = "<h2>Rules and exports</h2><p class='intro'>Draft rules are working artifacts. Rule decisions decide what can be exported. The proposed export is reviewable guidance and is not applied automatically.</p>" + runHtml + rulesHtml + decisionsHtml + exportHtml;
    }

    function field(label, value) {
      return \`<span><span class="label">\${escapeHtml(label)}</span><br><span class="value">\${escapeHtml(String(value))}</span></span>\`;
    }

    function metric(label, value) {
      return \`
        <article class="metric">
          <span class="label">\${escapeHtml(label)}</span>
          <strong>\${escapeHtml(String(value))}</strong>
        </article>
      \`;
    }

    function stageCards(summary, run) {
      const analysisReady = run.hasProviderOutput && run.hasAnalysisOutput;
      return [
        stage("Import (current corpus)", summary.importedPrs > 0, summary.importedPrs + " PR records", "traceback import --prs <number>"),
        stage("Extract (current corpus)", summary.failureCandidates > 0, summary.failureCandidates + " candidates", "traceback extract", summary.importedPrs > 0 ? "" : "Import PR records first."),
        stage("Analyze", analysisReady,
          analysisReady ? "provider analysis available" : "Prepared or incomplete; provider analysis has not completed. Running the command sends current candidates to OpenAI and creates a NEW run. Select that new run before review.",
          "traceback analyze --provider openai", summary.failureCandidates > 0 ? "" : "Extract candidates first."),
        stage("Review", run.hasReviewOutput, run.reviewDecisions + " decisions", "traceback review --run " + run.runId + " --policy conservative", analysisReady ? "" : "Requires provider analysis for this run."),
        stage("Draft rules", run.hasDraftRules, run.draftRules + " draft rules", "traceback rules --run " + run.runId, run.hasReviewOutput ? "" : "Requires review decisions for this run."),
        stage("Rule review", run.hasRuleDecisions, run.ruleDecisions + " rule decisions", "traceback rules review --run " + run.runId + " --policy conservative", run.hasDraftRules ? "" : "Requires draft rules for this run."),
        stage("Export", run.exportItem !== null, run.exportedRules + " exported rules", "traceback rules export --run " + run.runId + " --target agents-md", run.hasRuleDecisions ? "" : "Review rules before exporting."),
      ].join("");
    }

    function stage(label, isPresent, detail, command, blockedReason = "") {
      return \`
        <div class="stage">
          <strong>\${escapeHtml(label)}</strong>
          \${statusPill(isPresent ? "present" : blockedReason ? "blocked" : "missing", isPresent ? "good" : "warn")}
          <span class="value">\${escapeHtml(detail)}</span>
          \${isPresent ? "" : blockedReason ? \`<p>\${escapeHtml(blockedReason)}</p>\` : \`<code>\${escapeHtml(command)}</code>\`}
        </div>
      \`;
    }

    function renderReviewLegend() {
      return \`
        <div class="card legend">
          \${legendItem("accepted", "High-confidence cluster backed by review-comment evidence.")}
          \${legendItem("needs_validation", "Low-confidence or PR-body-only evidence needs human validation.")}
          \${legendItem("needs_cluster", "An enriched record was not represented in any cluster.")}
          \${legendItem("needs_review", "Source references or evidence shape need manual review.")}
        </div>
      \`;
    }

    function renderRuleLegend() {
      return \`
        <div class="card legend">
          \${legendItem("accepted", "Exportable as-is.")}
          \${legendItem("edited", "Exportable using edited instruction fields.")}
          \${legendItem("needs_edit", "Not exportable until edited.")}
          \${legendItem("rejected", "Not exportable.")}
        </div>
      \`;
    }

    function renderStatusDistribution(statusCounts) {
      const entries = Object.entries(statusCounts || {});
      if (!entries.length) {
        return "";
      }
      const candidates = state.data.candidates;
      const replySignals = candidates.filter((candidate) => candidate.statusEvidence.basis === "reply").length;
      const metadataOnly = candidates.filter((candidate) => candidate.statusEvidence.basis.startsWith("thread_")).length;
      const mismatches = candidates.filter((candidate) => candidate.statusEvidence.matchesStoredStatus === false).length;
      return \`
        <article class="card row">
          <h3>Status distribution</h3>
          <p>Stored outcomes inferred from replies or thread metadata; resolved does not mean independently verified. Superseded means outdated without a stronger signal. See each candidate’s evidence source below.</p>
          <div class="tabs">
            \${entries.map(([status, count]) => statusPill(status + ": " + count, statusTone(status))).join("")}
          </div>
          <p>Current evidence: \${replySignals} reply signals · \${metadataOnly} metadata only · \${candidates.length - replySignals - metadataOnly} source-only or unavailable · \${mismatches} stored-status mismatches.</p>
        </article>
      \`;
    }

    function legendItem(label, description) {
      return \`<span class="legend-item"><strong>\${escapeHtml(label)}</strong><span>\${escapeHtml(description)}</span></span>\`;
    }

    function statusPill(label, tone) {
      return \`<span class="pill \${tone}">\${escapeHtml(label)}</span>\`;
    }

    function statusTone(status) {
      if (status === "resolved" || status === "accepted") return "good";
      if (status === "rejected") return "bad";
      if (status === "candidate" || status === "contested") return "warn";
      return "";
    }

    function statusRank(status) {
      const ranks = {
        candidate: 0,
        contested: 1,
        unknown: 2,
        resolved: 3,
        accepted: 4,
        superseded: 5,
        rejected: 6,
      };
      return ranks[status] ?? 99;
    }

    function link(href, label) {
      try {
        if (typeof href !== "string" || !/^https?:[/][/]/i.test(href)) return escapeHtml(label);
        const url = new URL(href);
        if (url.protocol !== "http:" && url.protocol !== "https:") return escapeHtml(label);
        return \`<a href="\${escapeHtml(url.href)}" target="_blank" rel="noopener noreferrer">\${escapeHtml(label)}</a>\`;
      } catch {
        return escapeHtml(label);
      }
    }

    function empty(message) {
      return \`<article class="card empty">\${escapeHtml(message)}</article>\`;
    }

    function emptyContent(message) {
      return \`<div class="empty">\${escapeHtml(message)}</div>\`;
    }

    function getSelectedRun() {
      return state.data?.runs.find((run) => run.runId === state.selectedRunId) ?? null;
    }

    function formatDate(value) {
      if (!value) return "unknown time";
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
    }

    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[char]));
    }

    document.querySelectorAll("[data-tab]").forEach((button) => {
      button.addEventListener("click", () => {
        document.querySelectorAll("[data-tab]").forEach((tab) => {
          tab.setAttribute("aria-selected", String(tab === button));
        });
        document.querySelectorAll(".section").forEach((section) => {
          section.classList.toggle("active", section.id === button.dataset.tab);
        });
      });
    });

    load().catch((error) => {
      document.querySelector("main").innerHTML = \`<article class="card warning">\${escapeHtml(error.message)}</article>\`;
    });
  </script>
</body>
</html>`;
}
