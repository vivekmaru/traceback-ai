import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertSafeRunId } from "./run-id";
import { getTracebackPaths } from "./storage";
import type { ReviewDecision, ReviewDecisionsFile } from "./review";
import type { DraftRule, DraftRulesFile } from "./rules";
import type { RuleDecision, RuleDecisionsFile } from "./rules-review";

export type RulesExportTarget = "agents-md";

export type RunRulesExportOptions = {
  runId: string;
  target: string;
  now?: Date;
};

export type RulesExportResult = {
  exportDir: string;
  proposedPath: string | null;
  summaryPath: string;
  manifestPath: string;
  outputs: string[];
  exportedRuleCount: number;
};

type RulesExportManifest = {
  schemaVersion: 1;
  runId: string;
  target: RulesExportTarget;
  createdAt: string;
  sourceDraftRulesPath: string;
  sourceDraftRulesMarkdownPath: string;
  sourceDecisionsPath?: string;
  sourceRuleDecisionsPath?: string;
  outputs: string[];
  exportedRuleCount: number;
  warnings: string[];
};

type ExportableRule = {
  id: string;
  title: string;
  instruction: string;
  rationale: string;
  sourcePrs: number[];
  sourceCandidateIds: string[];
  confidence: DraftRule["confidence"];
  reviewDecision: string;
  sourceDecisionIds: string[];
  notes: string[];
};

const SUPPORTED_TARGETS: RulesExportTarget[] = ["agents-md"];
const EXPORTABLE_REVIEW_DECISIONS = new Set<ReviewDecision["decision"]>([
  "accepted",
  "accepted_singleton",
  "edited",
]);
const EXPORTABLE_RULE_DECISIONS = new Set<RuleDecision["decision"]>(["accepted", "edited"]);

export async function runRulesExport(
  repoRoot: string,
  options: RunRulesExportOptions,
): Promise<RulesExportResult> {
  assertSupportedTarget(options.target);
  assertSafeRunId(options.runId);

  const target = options.target as RulesExportTarget;
  const paths = getTracebackPaths(repoRoot);
  const rulesDir = path.join(paths.rules, options.runId);
  const draftRulesPath = path.join(rulesDir, "draft-rules.json");
  const draftRulesMarkdownPath = path.join(rulesDir, "draft-rules.md");
  const decisionsPath = path.join(paths.reviews, options.runId, "decisions.json");
  const ruleDecisionsPath = path.join(rulesDir, "rule-decisions.json");

  await assertDraftRulesExist({
    runId: options.runId,
    draftRulesPath,
    draftRulesMarkdownPath,
    possibleRunPaths: [
      rulesDir,
      path.join(paths.reviews, options.runId),
      path.join(paths.analysisRuns, options.runId),
    ],
  });

  const draftRules = await readJson<DraftRulesFile>(draftRulesPath);
  await readFile(draftRulesMarkdownPath, "utf8");
  const { decisionsById, sourceDecisionsPath, warnings } = await readDecisionsById(decisionsPath);
  const ruleDecisionRead = await readRuleDecisionsByRuleId(ruleDecisionsPath);
  const exportableRules = buildExportableRules({
    draftRules: draftRules.rules,
    decisionsById,
    ruleDecisionsByRuleId: ruleDecisionRead.ruleDecisionsByRuleId,
    warnings,
  });

  const createdAt = (options.now ?? new Date()).toISOString();
  const exportDir = path.join(paths.exports, options.runId);
  await mkdir(exportDir, { recursive: true });

  const proposedPath = path.join(exportDir, "AGENTS.proposed.md");
  const summaryPath = path.join(exportDir, "export-summary.md");
  const manifestPath = path.join(exportDir, "manifest.json");
  const outputs =
    exportableRules.length > 0 ? [proposedPath, summaryPath, manifestPath] : [summaryPath, manifestPath];

  if (exportableRules.length > 0) {
    await writeFile(
      proposedPath,
      renderAgentsProposed({
        runId: options.runId,
        createdAt,
        rules: exportableRules,
      }),
      "utf8",
    );
  } else {
    await rm(proposedPath, { force: true });
    warnings.push("No exportable rules were found.");
  }

  const manifest: RulesExportManifest = {
    schemaVersion: 1,
    runId: options.runId,
    target,
    createdAt,
    sourceDraftRulesPath: draftRulesPath,
    sourceDraftRulesMarkdownPath: draftRulesMarkdownPath,
    ...(sourceDecisionsPath ? { sourceDecisionsPath } : {}),
    ...(ruleDecisionRead.sourceRuleDecisionsPath
      ? { sourceRuleDecisionsPath: ruleDecisionRead.sourceRuleDecisionsPath }
      : {}),
    outputs,
    exportedRuleCount: exportableRules.length,
    warnings,
  };

  await writeFile(
    summaryPath,
    renderExportSummary({
      runId: options.runId,
      target,
      exportedRuleCount: exportableRules.length,
      proposedPath: exportableRules.length > 0 ? proposedPath : null,
      warnings,
    }),
    "utf8",
  );
  await writeJson(manifestPath, manifest);

  return {
    exportDir,
    proposedPath: exportableRules.length > 0 ? proposedPath : null,
    summaryPath,
    manifestPath,
    outputs,
    exportedRuleCount: exportableRules.length,
  };
}

function buildExportableRules({
  draftRules,
  decisionsById,
  ruleDecisionsByRuleId,
  warnings,
}: {
  draftRules: DraftRule[];
  decisionsById: Map<string, ReviewDecision>;
  ruleDecisionsByRuleId: Map<string, RuleDecision> | null;
  warnings: string[];
}): ExportableRule[] {
  if (ruleDecisionsByRuleId) {
    return draftRules.flatMap((rule) => {
      const decision = ruleDecisionsByRuleId.get(rule.id);
      if (!decision) {
        warnings.push(`Rule decision missing for ${rule.id}; excluded from export.`);
        return [];
      }

      if (!EXPORTABLE_RULE_DECISIONS.has(decision.decision)) {
        return [];
      }

      return [
        {
          id: rule.id,
          title: decision.editedTitle ?? decision.title,
          instruction: decision.editedInstruction ?? decision.instruction,
          rationale: decision.editedRationale ?? decision.rationale,
          sourcePrs: decision.sourcePrs,
          sourceCandidateIds: decision.sourceCandidateIds,
          confidence: decision.confidence,
          reviewDecision: decision.decision,
          sourceDecisionIds: rule.sourceDecisionIds,
          notes: decision.notes,
        },
      ];
    });
  }

  if (decisionsById.size === 0) {
    warnings.push("Review decisions were not found; export used draft rule metadata only.");
  }

  return draftRules.map((rule) => {
    const sourceDecisions = sourceReviewDecisions(rule, decisionsById);
    const reviewDecisions = unique(sourceDecisions.map((decision) => decision.decision));
    const rationales = unique(sourceDecisions.map((decision) => decision.reason).filter(Boolean));
    const sourceComments = unique(sourceDecisions.flatMap((decision) => decision.sourceComments));

    return {
      id: rule.id,
      title: rule.title,
      instruction: rule.rule,
      rationale:
        rationales.join(" ") ||
        rule.notes.join(" ") ||
        "Derived from accepted Traceback draft rule evidence.",
      sourcePrs: rule.sourcePrs,
      sourceCandidateIds: [...sourceComments, ...rule.sourceCandidateIds],
      confidence: rule.confidence,
      reviewDecision: reviewDecisions.join(", ") || "accepted draft rule",
      sourceDecisionIds: rule.sourceDecisionIds,
      notes: rule.notes,
    };
  });
}

function sourceReviewDecisions(
  rule: DraftRule,
  decisionsById: Map<string, ReviewDecision>,
): ReviewDecision[] {
  return rule.sourceDecisionIds
    .map((decisionId) => decisionsById.get(decisionId))
    .filter((decision): decision is ReviewDecision =>
      Boolean(decision && EXPORTABLE_REVIEW_DECISIONS.has(decision.decision)),
    );
}

function assertSupportedTarget(target: string): void {
  if (!SUPPORTED_TARGETS.includes(target as RulesExportTarget)) {
    throw new Error(
      `Unsupported export target: ${target}. Supported targets: ${SUPPORTED_TARGETS.join(", ")}.`,
    );
  }
}

async function assertDraftRulesExist({
  runId,
  draftRulesPath,
  draftRulesMarkdownPath,
  possibleRunPaths,
}: {
  runId: string;
  draftRulesPath: string;
  draftRulesMarkdownPath: string;
  possibleRunPaths: string[];
}): Promise<void> {
  const [hasJson, hasMarkdown] = await Promise.all([
    pathExists(draftRulesPath),
    pathExists(draftRulesMarkdownPath),
  ]);
  if (hasJson && hasMarkdown) {
    return;
  }

  if (!(await anyPathExists(possibleRunPaths))) {
    throw new Error(`Run ID does not exist: ${runId}.`);
  }

  throw new Error(
    `Draft rules are missing for run ID ${runId}. Run \`traceback rules --run ${runId}\` first.`,
  );
}

async function readDecisionsById(
  decisionsPath: string,
): Promise<{ decisionsById: Map<string, ReviewDecision>; sourceDecisionsPath?: string; warnings: string[] }> {
  if (!(await pathExists(decisionsPath))) {
    return {
      decisionsById: new Map(),
      warnings: [],
    };
  }

  const decisionsFile = await readJson<ReviewDecisionsFile>(decisionsPath);
  return {
    decisionsById: new Map(decisionsFile.decisions.map((decision) => [decision.id, decision])),
    sourceDecisionsPath: decisionsPath,
    warnings: [],
  };
}

async function readRuleDecisionsByRuleId(
  ruleDecisionsPath: string,
): Promise<{ ruleDecisionsByRuleId: Map<string, RuleDecision> | null; sourceRuleDecisionsPath?: string }> {
  if (!(await pathExists(ruleDecisionsPath))) {
    return { ruleDecisionsByRuleId: null };
  }

  const decisionsFile = await readJson<RuleDecisionsFile>(ruleDecisionsPath);
  return {
    ruleDecisionsByRuleId: new Map(decisionsFile.decisions.map((decision) => [decision.ruleId, decision])),
    sourceRuleDecisionsPath: ruleDecisionsPath,
  };
}

function renderAgentsProposed({
  runId,
  createdAt,
  rules,
}: {
  runId: string;
  createdAt: string;
  rules: ExportableRule[];
}): string {
  return [
    "# Traceback Proposed AGENTS.md Instructions",
    "",
    "Generated by Traceback from accepted rule decisions.",
    "",
    `- Run ID: ${runId}`,
    `- Generated: ${createdAt}`,
    "- Status: This is proposed output and has not been applied.",
    "- Local-only privacy note: this file was generated from local Traceback artifacts and should be reviewed before copying into repository instructions.",
    "",
    "## High Confidence Rules",
    "",
    ...renderRuleSection(rules.filter((rule) => rule.confidence === "high")),
    "",
    "## Other Rules",
    "",
    ...renderRuleSection(rules.filter((rule) => rule.confidence !== "high")),
    "",
  ].join("\n");
}

function renderRuleSection(rules: ExportableRule[]): string[] {
  if (rules.length === 0) {
    return ["None."];
  }

  return rules.flatMap(renderRule);
}

function renderRule(rule: ExportableRule): string[] {
  return [
    `### ${rule.title}`,
    "",
    `- Instruction: ${rule.instruction}`,
    `- Rationale: ${rule.rationale || rule.notes.join(" ") || "Derived from accepted Traceback draft rule evidence."}`,
    `- Source PRs: ${rule.sourcePrs.map((pr) => `#${pr}`).join(", ") || "none"}`,
    `- Source evidence: ${formatList(rule.sourceCandidateIds)}`,
    `- Confidence: ${rule.confidence}`,
    `- Review decision: ${rule.reviewDecision}`,
    "",
  ];
}

function renderExportSummary({
  runId,
  target,
  exportedRuleCount,
  proposedPath,
  warnings,
}: {
  runId: string;
  target: RulesExportTarget;
  exportedRuleCount: number;
  proposedPath: string | null;
  warnings: string[];
}): string {
  return [
    "# Traceback Rule Export Summary",
    "",
    `- Run ID: ${runId}`,
    `- Target: ${target}`,
    `- Rules exported: ${exportedRuleCount}`,
    `- Output path: ${proposedPath ?? "No AGENTS.proposed.md written."}`,
    "- Root repo files modified: none",
    "",
    "## Warnings",
    "",
    ...renderWarnings(warnings),
    "",
    "No root repo instruction files were modified.",
    "",
  ].join("\n");
}

function renderWarnings(warnings: string[]): string[] {
  if (warnings.length === 0) {
    return ["None."];
  }

  return warnings.map((warning) => `- ${warning}`);
}

function formatList(values: string[]): string {
  const uniqueValues = unique(values).filter(Boolean);
  return uniqueValues.length > 0 ? uniqueValues.join(", ") : "none";
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

async function anyPathExists(paths: string[]): Promise<boolean> {
  const results = await Promise.all(paths.map(pathExists));
  return results.some(Boolean);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
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
