import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { getTracebackPaths, initTraceback } from "./storage";
import type { FailureCandidate } from "./types";

export type AnalyzeMode = "dry-run" | "provider";
export type AnalyzeProvider = "openai";

export type AnalysisInput = {
  schemaVersion: 1;
  generatedAt: string;
  failureCandidateCount: number;
  failureCandidates: AnalysisCandidateInput[];
};

export type AnalysisCandidateInput = {
  id: string;
  sourcePrNumber: number;
  sourcePrUrl: string;
  sourceCommentUrl: string | null;
  sourceType: FailureCandidate["sourceType"];
  title: string;
  candidateCategory: FailureCandidate["candidateCategory"];
  candidateSeverity: FailureCandidate["candidateSeverity"];
  confidence: FailureCandidate["confidence"];
  status: FailureCandidate["status"];
  evidenceExcerpt: string;
  detectedAgentMarkers: string[];
  surroundingSummary: string;
};

export type EnrichedFailureRecord = {
  id: string;
  sourceCandidateIds: string[];
  title: string;
  failureType: string;
  summary: string;
  whatTheAgentMissed: string;
  evidenceSummary: string;
  likelyFixOrCorrection: string;
  preventionRule: string;
  confidence: "low" | "medium" | "high";
  sourcePrs: number[];
  sourceComments: string[];
  notes: string[];
};

export type FailureCluster = {
  id: string;
  title: string;
  summary: string;
  candidateIds: string[];
  failureTypes: string[];
  sourcePrs: number[];
  evidenceSummary: string;
  whatTheAgentMissed: string;
  preventionRule: string;
  confidence: "low" | "medium" | "high";
};

export type AnalysisSummary = {
  overview: string;
  highestRiskPatterns: string[];
  recommendedNextActions: string[];
};

export type AnalysisOutput = {
  enrichedRecords: EnrichedFailureRecord[];
  clusters: FailureCluster[];
  summary: AnalysisSummary;
};

export type AnalysisProviderRequest = {
  input: AnalysisInput;
  prompt: string;
};

export type AnalysisProviderResult = {
  rawResponse: unknown;
  analysis: AnalysisOutput;
};

export type AnalysisProviderClient = (
  request: AnalysisProviderRequest,
) => Promise<AnalysisProviderResult>;

export type RunAnalysisOptions = {
  mode: AnalyzeMode;
  provider?: AnalyzeProvider | null;
  now?: Date;
  providerClient?: AnalysisProviderClient;
};

export type AnalysisRunResult = {
  runId: string;
  runDir: string;
  manifestPath: string;
};

type AnalysisManifest = {
  runId: string;
  mode: AnalyzeMode;
  provider: AnalyzeProvider | null;
  createdAt: string;
  source: {
    failureCandidateCount: number;
    recordsHash: string;
  };
  files: {
    input: string;
    prompt: string;
    response: string | null;
    enrichedRecords: string | null;
    clusters: string | null;
    summary: string | null;
  };
};

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const DEFAULT_OPENAI_MODEL = "gpt-5-mini";

export async function runAnalysis(
  repoRoot: string,
  options: RunAnalysisOptions,
): Promise<AnalysisRunResult> {
  if (options.mode === "provider" && options.provider !== "openai") {
    throw new Error("Only --provider openai is supported for analysis.");
  }

  const createdAtDate = options.now ?? new Date();
  const createdAt = createdAtDate.toISOString();
  const baseRunId = formatRunId(createdAtDate);
  const candidates = await readFailureCandidates(repoRoot);
  const input = buildAnalysisInput(candidates, createdAt);
  const prompt = buildAnalysisPrompt(input);
  const recordsHash = hashCandidates(candidates);
  const paths = await initTraceback(repoRoot);
  const { runId, runDir } = await createRunDirectory(paths.analysisRuns, baseRunId);

  await writeJson(path.join(runDir, "input.json"), input);
  await writeFile(path.join(runDir, "prompt.md"), prompt, "utf8");

  const manifest: AnalysisManifest = {
    runId,
    mode: options.mode,
    provider: options.mode === "provider" ? options.provider ?? "openai" : null,
    createdAt,
    source: {
      failureCandidateCount: candidates.length,
      recordsHash,
    },
    files: {
      input: "input.json",
      prompt: "prompt.md",
      response: null,
      enrichedRecords: null,
      clusters: null,
      summary: null,
    },
  };

  const manifestPath = path.join(runDir, "manifest.json");
  await writeJson(manifestPath, manifest);

  if (options.mode === "provider") {
    const providerClient = options.providerClient ?? callOpenAIProvider;
    const providerResult = await providerClient({ input, prompt });
    validateAnalysisOutput(providerResult.analysis, candidates);

    await writeJson(path.join(runDir, "response.json"), providerResult.rawResponse);
    await writeJson(path.join(runDir, "enriched-records.json"), providerResult.analysis.enrichedRecords);
    await writeJson(path.join(runDir, "clusters.json"), providerResult.analysis.clusters);
    await writeFile(
      path.join(runDir, "analysis-summary.md"),
      generateAnalysisSummaryMarkdown(providerResult.analysis, {
        input,
        runId,
        mode: options.mode,
        provider: manifest.provider,
        warnings: [],
      }),
      "utf8",
    );

    manifest.files.response = "response.json";
    manifest.files.enrichedRecords = "enriched-records.json";
    manifest.files.clusters = "clusters.json";
    manifest.files.summary = "analysis-summary.md";
    await writeJson(manifestPath, manifest);
  }

  return { runId, runDir, manifestPath };
}

export async function readFailureCandidates(repoRoot: string): Promise<FailureCandidate[]> {
  const paths = getTracebackPaths(repoRoot);
  let entries: string[];
  try {
    entries = await readdir(paths.failures);
  } catch {
    throw new Error(
      "No failure candidates found in .traceback/records/failures/. Run `traceback extract` first.",
    );
  }

  const jsonEntries = entries.filter((entry) => entry.endsWith(".json")).sort();
  if (jsonEntries.length === 0) {
    throw new Error(
      "No failure candidates found in .traceback/records/failures/. Run `traceback extract` first.",
    );
  }

  const candidates = await Promise.all(
    jsonEntries.map(async (entry) => {
      const raw = await readFile(path.join(paths.failures, entry), "utf8");
      return JSON.parse(raw) as FailureCandidate;
    }),
  );

  return candidates.sort(compareFailureCandidates);
}

export function buildAnalysisInput(
  failureCandidates: FailureCandidate[],
  generatedAt: string,
): AnalysisInput {
  return {
    schemaVersion: 1,
    generatedAt,
    failureCandidateCount: failureCandidates.length,
    failureCandidates: failureCandidates.map(toAnalysisCandidateInput),
  };
}

export function buildAnalysisPrompt(input: AnalysisInput): string {
  return [
    "# Traceback AI Candidate Enrichment",
    "",
    "You are Traceback's AI analysis layer. Your job is to enrich only the deterministic failure candidates supplied below.",
    "",
    "Privacy boundary: only use the provided candidate data. Do not analyze raw PR data from scratch.",
    "",
    "Requirements:",
    "",
    "- preserve source references",
    "- do not invent PRs, comments, files, code, or evidence",
    "- only use provided candidate data",
    "- group related candidates where appropriate",
    "- keep prevention rules concrete and actionable",
    "- distinguish deterministic candidate category from enriched failure type",
    "- flag uncertainty instead of guessing",
    "- avoid exposing unnecessary raw code in final summaries",
    "",
    "For each enriched record, infer a concise failure type, what the agent missed, an evidence summary, likely fix or correction, and one practical prevention rule that an agent could apply in future work.",
    "",
    "Cluster candidates by recurring failure pattern. Prefer specific clusters over broad categories, but keep the cluster list compact.",
    "",
    "Return JSON matching the requested schema.",
    "",
    "## Input",
    "",
    "```json",
    JSON.stringify(input, null, 2),
    "```",
    "",
  ].join("\n");
}

export async function callOpenAIProvider({
  input,
  prompt,
}: AnalysisProviderRequest): Promise<AnalysisProviderResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is required for `traceback analyze --provider openai`. Set it with `export OPENAI_API_KEY=...` and retry.",
    );
  }

  console.warn(
    "Traceback analyze: selected local PR/comment evidence will be sent to the configured OpenAI model provider.",
  );

  const response = await fetch(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.TRACEBACK_OPENAI_MODEL ?? process.env.OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL,
      instructions:
        "You enrich deterministic Traceback failure candidates. Return only valid structured JSON and never add candidates that were not provided.",
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: prompt,
            },
          ],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "traceback_analysis",
          strict: true,
          schema: analysisJsonSchema(input.failureCandidates.map((candidate) => candidate.id)),
        },
      },
    }),
  });

  const rawResponseText = await response.text();
  const rawResponse = parseJsonResponse(rawResponseText);

  if (!response.ok) {
    throw new Error(`OpenAI analysis request failed (${response.status}): ${JSON.stringify(rawResponse)}`);
  }

  const outputText = extractResponseText(rawResponse);
  const analysis = parseAnalysisOutput(outputText);
  return { rawResponse, analysis };
}

export function parseAnalysisOutput(value: string): AnalysisOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("OpenAI response did not contain valid JSON analysis output.");
  }

  if (!isAnalysisOutput(parsed)) {
    throw new Error("OpenAI response JSON did not match Traceback analysis output shape.");
  }

  return parsed;
}

export function generateAnalysisSummaryMarkdown(
  analysis: AnalysisOutput,
  context: {
    input: AnalysisInput;
    runId: string;
    mode: AnalyzeMode;
    provider: AnalyzeProvider | null;
    warnings: string[];
  },
): string {
  const { input } = context;
  return [
    "# Traceback AI Analysis Summary",
    "",
    `Generated: ${input.generatedAt}`,
    "",
    "## Run",
    "",
    `- Run ID: ${context.runId}`,
    `- Mode: ${context.mode}`,
    `- Provider: ${context.provider ?? "none"}`,
    "",
    "## Totals",
    "",
    `- Deterministic candidates analyzed: ${input.failureCandidateCount}`,
    `- Enriched records: ${analysis.enrichedRecords.length}`,
    `- Clusters: ${analysis.clusters.length}`,
    "",
    "## Overview",
    "",
    analysis.summary.overview,
    "",
    "## Highest Risk Patterns",
    "",
    ...renderMarkdownList(analysis.summary.highestRiskPatterns),
    "",
    "## Recommended Next Actions",
    "",
    ...renderMarkdownList(analysis.summary.recommendedNextActions),
    "",
    "## Warnings",
    "",
    ...renderMarkdownList(context.warnings),
    "",
    "## Clusters",
    "",
    ...renderClusters(analysis.clusters),
    "",
    "## Enriched Records",
    "",
    ...renderEnrichedRecords(analysis.enrichedRecords),
    "",
  ].join("\n");
}

function validateAnalysisOutput(analysis: AnalysisOutput, candidates: FailureCandidate[]): void {
  const knownCandidateIds = new Set(candidates.map((candidate) => candidate.id));
  for (const record of analysis.enrichedRecords) {
    for (const candidateId of record.sourceCandidateIds) {
      if (!knownCandidateIds.has(candidateId)) {
        throw new Error(`Analysis output referenced unknown candidate ID: ${candidateId}`);
      }
    }
  }

  for (const cluster of analysis.clusters) {
    for (const candidateId of cluster.candidateIds) {
      if (!knownCandidateIds.has(candidateId)) {
        throw new Error(`Analysis output cluster ${cluster.id} referenced unknown candidate ID: ${candidateId}`);
      }
    }
  }
}

function analysisJsonSchema(candidateIds: string[]): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["enrichedRecords", "clusters", "summary"],
    properties: {
      enrichedRecords: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "id",
            "sourceCandidateIds",
            "title",
            "failureType",
            "summary",
            "whatTheAgentMissed",
            "evidenceSummary",
            "likelyFixOrCorrection",
            "preventionRule",
            "confidence",
            "sourcePrs",
            "sourceComments",
            "notes",
          ],
          properties: {
            id: { type: "string" },
            sourceCandidateIds: { type: "array", items: { type: "string", enum: candidateIds } },
            title: { type: "string" },
            failureType: { type: "string" },
            summary: { type: "string" },
            whatTheAgentMissed: { type: "string" },
            evidenceSummary: { type: "string" },
            likelyFixOrCorrection: { type: "string" },
            preventionRule: { type: "string" },
            confidence: { type: "string", enum: ["low", "medium", "high"] },
            sourcePrs: { type: "array", items: { type: "integer" } },
            sourceComments: { type: "array", items: { type: "string" } },
            notes: { type: "array", items: { type: "string" } },
          },
        },
      },
      clusters: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "id",
            "title",
            "summary",
            "candidateIds",
            "failureTypes",
            "sourcePrs",
            "evidenceSummary",
            "whatTheAgentMissed",
            "preventionRule",
            "confidence",
          ],
          properties: {
            id: { type: "string" },
            title: { type: "string" },
            summary: { type: "string" },
            candidateIds: { type: "array", items: { type: "string", enum: candidateIds } },
            failureTypes: { type: "array", items: { type: "string" } },
            sourcePrs: { type: "array", items: { type: "integer" } },
            evidenceSummary: { type: "string" },
            whatTheAgentMissed: { type: "string" },
            preventionRule: { type: "string" },
            confidence: { type: "string", enum: ["low", "medium", "high"] },
          },
        },
      },
      summary: {
        type: "object",
        additionalProperties: false,
        required: ["overview", "highestRiskPatterns", "recommendedNextActions"],
        properties: {
          overview: { type: "string" },
          highestRiskPatterns: { type: "array", items: { type: "string" } },
          recommendedNextActions: { type: "array", items: { type: "string" } },
        },
      },
    },
  };
}

function extractResponseText(rawResponse: unknown): string {
  if (typeof rawResponse === "object" && rawResponse !== null && "output_text" in rawResponse) {
    const outputText = (rawResponse as { output_text?: unknown }).output_text;
    if (typeof outputText === "string") {
      return outputText;
    }
  }

  const output = (rawResponse as { output?: unknown })?.output;
  if (Array.isArray(output)) {
    const parts: string[] = [];
    for (const item of output) {
      const content = (item as { content?: unknown })?.content;
      if (!Array.isArray(content)) {
        continue;
      }
      for (const contentItem of content) {
        const text = (contentItem as { text?: unknown })?.text;
        if (typeof text === "string") {
          parts.push(text);
        }
      }
    }
    if (parts.length > 0) {
      return parts.join("\n");
    }
  }

  throw new Error("OpenAI response did not include text output.");
}

function parseJsonResponse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return { raw: value };
  }
}

function isAnalysisOutput(value: unknown): value is AnalysisOutput {
  const maybe = value as AnalysisOutput;
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray(maybe.enrichedRecords) &&
    maybe.enrichedRecords.every(isEnrichedFailureRecord) &&
    Array.isArray(maybe.clusters) &&
    maybe.clusters.every(isFailureCluster) &&
    typeof maybe.summary === "object" &&
    maybe.summary !== null &&
    typeof maybe.summary.overview === "string" &&
    Array.isArray(maybe.summary.highestRiskPatterns) &&
    maybe.summary.highestRiskPatterns.every((item) => typeof item === "string") &&
    Array.isArray(maybe.summary.recommendedNextActions) &&
    maybe.summary.recommendedNextActions.every((item) => typeof item === "string")
  );
}

function isEnrichedFailureRecord(value: unknown): value is EnrichedFailureRecord {
  const maybe = value as EnrichedFailureRecord;
  return (
    typeof value === "object" &&
    value !== null &&
    typeof maybe.id === "string" &&
    Array.isArray(maybe.sourceCandidateIds) &&
    maybe.sourceCandidateIds.every((item) => typeof item === "string") &&
    typeof maybe.title === "string" &&
    typeof maybe.failureType === "string" &&
    typeof maybe.summary === "string" &&
    typeof maybe.whatTheAgentMissed === "string" &&
    typeof maybe.evidenceSummary === "string" &&
    typeof maybe.likelyFixOrCorrection === "string" &&
    typeof maybe.preventionRule === "string" &&
    ["low", "medium", "high"].includes(maybe.confidence) &&
    Array.isArray(maybe.sourcePrs) &&
    maybe.sourcePrs.every((item) => typeof item === "number") &&
    Array.isArray(maybe.sourceComments) &&
    maybe.sourceComments.every((item) => typeof item === "string") &&
    Array.isArray(maybe.notes) &&
    maybe.notes.every((item) => typeof item === "string")
  );
}

function isFailureCluster(value: unknown): value is FailureCluster {
  const maybe = value as FailureCluster;
  return (
    typeof value === "object" &&
    value !== null &&
    typeof maybe.id === "string" &&
    typeof maybe.title === "string" &&
    typeof maybe.summary === "string" &&
    Array.isArray(maybe.candidateIds) &&
    maybe.candidateIds.every((item) => typeof item === "string") &&
    Array.isArray(maybe.failureTypes) &&
    maybe.failureTypes.every((item) => typeof item === "string") &&
    Array.isArray(maybe.sourcePrs) &&
    maybe.sourcePrs.every((item) => typeof item === "number") &&
    typeof maybe.evidenceSummary === "string" &&
    typeof maybe.whatTheAgentMissed === "string" &&
    typeof maybe.preventionRule === "string" &&
    ["low", "medium", "high"].includes(maybe.confidence)
  );
}

function hashCandidates(candidates: FailureCandidate[]): string {
  return `sha256-${createHash("sha256").update(JSON.stringify(candidates)).digest("hex")}`;
}

function formatRunId(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-");
}

async function createRunDirectory(
  analysisRunsDir: string,
  baseRunId: string,
): Promise<{ runId: string; runDir: string }> {
  for (let suffix = 0; suffix < 1000; suffix += 1) {
    const runId = suffix === 0 ? baseRunId : `${baseRunId}-${suffix}`;
    const runDir = path.join(analysisRunsDir, runId);
    try {
      await mkdir(runDir);
      return { runId, runDir };
    } catch (error) {
      if (isAlreadyExistsError(error)) {
        continue;
      }
      throw error;
    }
  }

  throw new Error(`Could not allocate a unique analysis run directory for ${baseRunId}.`);
}

function isAlreadyExistsError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "EEXIST"
  );
}

function compareFailureCandidates(a: FailureCandidate, b: FailureCandidate): number {
  return b.sourcePrNumber - a.sourcePrNumber || a.id.localeCompare(b.id);
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function renderMarkdownList(items: string[]): string[] {
  if (items.length === 0) {
    return ["None provided."];
  }
  return items.map((item) => `- ${item}`);
}

function renderClusters(clusters: FailureCluster[]): string[] {
  if (clusters.length === 0) {
    return ["No clusters found."];
  }

  return clusters.flatMap((cluster) => [
    `### ${cluster.title}`,
    "",
    `- ID: ${cluster.id}`,
    `- Candidates: ${cluster.candidateIds.join(", ")}`,
    `- Failure types: ${cluster.failureTypes.join(", ")}`,
    `- Source PRs: ${cluster.sourcePrs.map((pr) => `#${pr}`).join(", ")}`,
    `- Confidence: ${cluster.confidence}`,
    `- Prevention rule: ${cluster.preventionRule}`,
    `- What the agent missed: ${cluster.whatTheAgentMissed}`,
    `- Evidence: ${cluster.evidenceSummary}`,
    `- Summary: ${cluster.summary}`,
    "",
  ]);
}

function renderEnrichedRecords(records: EnrichedFailureRecord[]): string[] {
  if (records.length === 0) {
    return ["No enriched records found."];
  }

  return records.flatMap((record) => [
    `### ${record.title}`,
    "",
    `- ID: ${record.id}`,
    `- Source candidates: ${record.sourceCandidateIds.join(", ")}`,
    `- Failure type: ${record.failureType}`,
    `- Confidence: ${record.confidence}`,
    `- Source PRs: ${record.sourcePrs.map((pr) => `#${pr}`).join(", ")}`,
    `- Source comments: ${record.sourceComments.length > 0 ? record.sourceComments.join(", ") : "none"}`,
    `- Prevention rule: ${record.preventionRule}`,
    `- What the agent missed: ${record.whatTheAgentMissed}`,
    `- Likely fix or correction: ${record.likelyFixOrCorrection}`,
    `- Evidence: ${record.evidenceSummary}`,
    `- Summary: ${record.summary}`,
    "",
  ]);
}

function toAnalysisCandidateInput(candidate: FailureCandidate): AnalysisCandidateInput {
  return {
    id: candidate.id,
    sourcePrNumber: candidate.sourcePrNumber,
    sourcePrUrl: candidate.sourcePrUrl,
    sourceCommentUrl: candidate.sourceCommentUrl,
    sourceType: candidate.sourceType,
    title: candidate.extractedTitle,
    candidateCategory: candidate.candidateCategory,
    candidateSeverity: candidate.candidateSeverity,
    confidence: candidate.confidence,
    status: candidate.status,
    evidenceExcerpt: candidate.evidenceExcerpt,
    detectedAgentMarkers: candidate.detectedAgentMarkers,
    surroundingSummary: buildSurroundingSummary(candidate),
  };
}

function buildSurroundingSummary(candidate: FailureCandidate): string {
  return truncate(
    `PR #${candidate.sourcePrNumber} ${candidate.sourceType}: ${candidate.extractedTitle}. ${candidate.evidenceExcerpt}`,
    500,
  );
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 1).trimEnd()}...`;
}
