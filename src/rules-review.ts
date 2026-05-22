import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertSafeRunId } from "./run-id";
import { getTracebackPaths } from "./storage";
import type { DraftRule, DraftRulesFile } from "./rules";

export type RuleReviewPolicy = "conservative";

export type RuleDecisionValue = "accepted" | "rejected" | "needs_edit" | "edited";

export type RuleDecision = {
  ruleId: string;
  runId: string;
  decision: RuleDecisionValue;
  title: string;
  editedTitle: string | null;
  instruction: string;
  editedInstruction: string | null;
  rationale: string;
  editedRationale: string | null;
  sourcePrs: number[];
  sourceCandidateIds: string[];
  confidence: DraftRule["confidence"];
  reason: string;
  notes: string[];
  reviewedAt: string;
};

export type RuleDecisionsFile = {
  schemaVersion: 1;
  runId: string;
  policy: RuleReviewPolicy;
  reviewedAt: string;
  source: {
    draftRules: string;
    draftRulesMarkdown: string;
    manualDecisions?: string;
  };
  decisions: RuleDecision[];
};

export type RunRulesReviewOptions = {
  runId: string;
  policy: RuleReviewPolicy;
  from?: string;
  now?: Date;
};

export type RulesReviewResult = {
  rulesDir: string;
  decisionsPath: string;
  markdownPath: string;
};

type ManualRuleDecision = Partial<RuleDecision> & { ruleId: string };
type ManualRuleDecisionsInput = RuleDecisionsFile | { decisions: ManualRuleDecision[] } | ManualRuleDecision[];

export async function runRulesReview(
  repoRoot: string,
  options: RunRulesReviewOptions,
): Promise<RulesReviewResult> {
  if (options.policy !== "conservative") {
    throw new Error("Only --policy conservative is supported.");
  }
  assertSafeRunId(options.runId);

  const paths = getTracebackPaths(repoRoot);
  const rulesDir = path.join(paths.rules, options.runId);
  const draftRulesPath = path.join(rulesDir, "draft-rules.json");
  const draftRulesMarkdownPath = path.join(rulesDir, "draft-rules.md");
  const draftRules = await readJson<DraftRulesFile>(draftRulesPath);
  await readFile(draftRulesMarkdownPath, "utf8");

  const reviewedAt = (options.now ?? new Date()).toISOString();
  const rulesById = new Map(draftRules.rules.map((rule) => [rule.id, rule]));
  const decisions = options.from
    ? normalizeManualDecisions({
        input: await readJson<ManualRuleDecisionsInput>(options.from),
        runId: options.runId,
        reviewedAt,
        rulesById,
      })
    : draftRules.rules.map((rule) => decisionFromDraftRule({ runId: options.runId, reviewedAt, rule }));

  assertUniqueRuleDecisionIds(decisions);
  await mkdir(rulesDir, { recursive: true });

  const decisionsFile: RuleDecisionsFile = {
    schemaVersion: 1,
    runId: options.runId,
    policy: options.policy,
    reviewedAt,
    source: {
      draftRules: path.relative(rulesDir, draftRulesPath),
      draftRulesMarkdown: path.relative(rulesDir, draftRulesMarkdownPath),
      ...(options.from ? { manualDecisions: path.relative(rulesDir, path.resolve(options.from)) } : {}),
    },
    decisions,
  };

  const decisionsPath = path.join(rulesDir, "rule-decisions.json");
  const markdownPath = path.join(rulesDir, "rule-review.md");
  await writeJson(decisionsPath, decisionsFile);
  await writeFile(markdownPath, generateRuleReviewMarkdown(decisionsFile), "utf8");

  return { rulesDir, decisionsPath, markdownPath };
}

function decisionFromDraftRule({
  runId,
  reviewedAt,
  rule,
}: {
  runId: string;
  reviewedAt: string;
  rule: DraftRule;
}): RuleDecision {
  const rationale = rule.notes.join(" ").trim();
  const classification = classifyDraftRule(rule);
  return {
    ruleId: rule.id,
    runId,
    decision: classification.decision,
    title: rule.title,
    editedTitle: null,
    instruction: rule.rule,
    editedInstruction: null,
    rationale,
    editedRationale: null,
    sourcePrs: rule.sourcePrs,
    sourceCandidateIds: rule.sourceCandidateIds,
    confidence: rule.confidence,
    reason: classification.reason,
    notes: rule.notes,
    reviewedAt,
  };
}

function classifyDraftRule(rule: DraftRule): { decision: RuleDecisionValue; reason: string } {
  if (rule.rule.trim().length === 0) {
    return { decision: "rejected", reason: "Rule instruction is empty." };
  }

  if (
    rule.sourceDecisionIds.length === 0 ||
    rule.sourceCandidateIds.length === 0 ||
    rule.sourcePrs.length === 0
  ) {
    return { decision: "rejected", reason: "Rule is missing source references." };
  }

  if (rule.title.trim().length === 0) {
    return { decision: "needs_edit", reason: "Rule title is empty." };
  }

  if (isSingletonRule(rule)) {
    return {
      decision: "needs_edit",
      reason: "Rule appears to come from a singleton decision and needs human editing.",
    };
  }

  if (rule.confidence !== "high") {
    return {
      decision: "needs_edit",
      reason: "Rule is not high confidence, so conservative review requires a human edit.",
    };
  }

  if (rule.sourceDecisionIds.every((id) => id.startsWith("review-cluster-"))) {
    return {
      decision: "accepted",
      reason: "High-confidence cluster draft with preserved source references.",
    };
  }

  return {
    decision: "needs_edit",
    reason: "Conservative rule review could not confidently accept this draft.",
  };
}

function isSingletonRule(rule: DraftRule): boolean {
  return (
    rule.sourceDecisionIds.some((id) => id.includes("singleton")) ||
    rule.notes.some((note) => note.includes("accepted_singleton"))
  );
}

function normalizeManualDecisions({
  input,
  runId,
  reviewedAt,
  rulesById,
}: {
  input: ManualRuleDecisionsInput;
  runId: string;
  reviewedAt: string;
  rulesById: Map<string, DraftRule>;
}): RuleDecision[] {
  const manualDecisions = Array.isArray(input) ? input : input.decisions;
  return manualDecisions.map((manualDecision) => {
    const draftRule = rulesById.get(manualDecision.ruleId);
    return {
      ruleId: manualDecision.ruleId,
      runId,
      decision: normalizeDecisionValue(manualDecision.decision),
      title: manualDecision.title ?? draftRule?.title ?? "",
      editedTitle: manualDecision.editedTitle ?? null,
      instruction: manualDecision.instruction ?? draftRule?.rule ?? "",
      editedInstruction: manualDecision.editedInstruction ?? null,
      rationale: manualDecision.rationale ?? draftRule?.notes.join(" ").trim() ?? "",
      editedRationale: manualDecision.editedRationale ?? null,
      sourcePrs: uniqueNumbers([...(draftRule?.sourcePrs ?? []), ...(manualDecision.sourcePrs ?? [])]),
      sourceCandidateIds: uniqueStrings([
        ...(draftRule?.sourceCandidateIds ?? []),
        ...(manualDecision.sourceCandidateIds ?? []),
      ]),
      confidence: manualDecision.confidence ?? draftRule?.confidence ?? "unknown",
      reason: manualDecision.reason ?? "Imported from manual rule decision file.",
      notes: manualDecision.notes ?? draftRule?.notes ?? [],
      reviewedAt,
    };
  });
}

function normalizeDecisionValue(value: RuleDecisionValue | undefined): RuleDecisionValue {
  if (value === "accepted" || value === "rejected" || value === "needs_edit" || value === "edited") {
    return value;
  }

  return "needs_edit";
}

function assertUniqueRuleDecisionIds(decisions: RuleDecision[]): void {
  const seen = new Set<string>();
  for (const decision of decisions) {
    if (seen.has(decision.ruleId)) {
      throw new Error(`Duplicate rule decision for rule ID: ${decision.ruleId}`);
    }
    seen.add(decision.ruleId);
  }
}

function generateRuleReviewMarkdown(decisionsFile: RuleDecisionsFile): string {
  const counts = countBy(decisionsFile.decisions, (decision) => decision.decision);
  return [
    "# Traceback Rule Review",
    "",
    `Reviewed: ${decisionsFile.reviewedAt}`,
    "",
    "## Run",
    "",
    `- Run ID: ${decisionsFile.runId}`,
    `- Policy: ${decisionsFile.policy}`,
    "",
    "## Totals",
    "",
    `- Total decisions: ${decisionsFile.decisions.length}`,
    `- Accepted: ${counts.get("accepted") ?? 0}`,
    `- Edited: ${counts.get("edited") ?? 0}`,
    `- Needs edit: ${counts.get("needs_edit") ?? 0}`,
    `- Rejected: ${counts.get("rejected") ?? 0}`,
    "",
    "## Decisions",
    "",
    ...renderRuleDecisions(decisionsFile.decisions),
    "",
  ].join("\n");
}

function renderRuleDecisions(decisions: RuleDecision[]): string[] {
  if (decisions.length === 0) {
    return ["No draft rules were available for rule review."];
  }

  return decisions.flatMap((decision) => [
    `### ${decision.editedTitle ?? (decision.title || decision.ruleId)}`,
    "",
    `- Rule ID: ${decision.ruleId}`,
    `- Decision: ${decision.decision}`,
    `- Reason: ${decision.reason}`,
    `- Confidence: ${decision.confidence}`,
    `- Source PRs: ${decision.sourcePrs.map((pr) => `#${pr}`).join(", ") || "none"}`,
    `- Source candidates: ${decision.sourceCandidateIds.join(", ") || "none"}`,
    "",
  ]);
}

function countBy<T>(values: T[], getKey: (value: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    const key = getKey(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values)];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
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
