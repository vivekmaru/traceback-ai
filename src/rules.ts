import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getTracebackPaths } from "./storage";
import type { ReviewDecision, ReviewDecisionValue, ReviewDecisionsFile } from "./review";

export type DraftRule = {
  id: string;
  status: "draft";
  title: string;
  rule: string;
  sourceDecisionIds: string[];
  sourceCandidateIds: string[];
  sourcePrs: number[];
  confidence: ReviewDecision["confidence"];
  notes: string[];
};

export type ExcludedDecision = {
  id: string;
  decision: ReviewDecisionValue;
  reason: string;
};

export type DraftRulesFile = {
  schemaVersion: 1;
  runId: string;
  generatedAt: string;
  source: {
    decisions: string;
  };
  rules: DraftRule[];
  excludedDecisions: ExcludedDecision[];
};

export type RunRulesDraftOptions = {
  runId: string;
  now?: Date;
};

export type RulesDraftResult = {
  rulesDir: string;
  rulesPath: string;
  markdownPath: string;
};

const ACCEPTED_DECISIONS = new Set<ReviewDecisionValue>([
  "accepted",
  "accepted_singleton",
  "edited",
]);

export async function runRulesDraft(
  repoRoot: string,
  options: RunRulesDraftOptions,
): Promise<RulesDraftResult> {
  const paths = getTracebackPaths(repoRoot);
  const reviewDir = path.join(paths.reviews, options.runId);
  const decisionsPath = path.join(reviewDir, "decisions.json");
  const decisionsFile = await readJson<ReviewDecisionsFile>(decisionsPath);
  const generatedAt = (options.now ?? new Date()).toISOString();
  const rules = decisionsFile.decisions
    .filter((decision) => ACCEPTED_DECISIONS.has(decision.decision))
    .map(toDraftRule);
  const excludedDecisions = decisionsFile.decisions
    .filter((decision) => !ACCEPTED_DECISIONS.has(decision.decision))
    .map((decision) => ({
      id: decision.id,
      decision: decision.decision,
      reason: "Decision is not accepted for draft rule generation.",
    }));

  const rulesDir = path.join(paths.rules, options.runId);
  await mkdir(rulesDir, { recursive: true });

  const draftFile: DraftRulesFile = {
    schemaVersion: 1,
    runId: options.runId,
    generatedAt,
    source: {
      decisions: path.relative(rulesDir, decisionsPath),
    },
    rules,
    excludedDecisions,
  };

  const rulesPath = path.join(rulesDir, "draft-rules.json");
  const markdownPath = path.join(rulesDir, "draft-rules.md");
  await writeJson(rulesPath, draftFile);
  await writeFile(markdownPath, generateDraftRulesMarkdown(draftFile), "utf8");

  return { rulesDir, rulesPath, markdownPath };
}

function toDraftRule(decision: ReviewDecision): DraftRule {
  return {
    id: `draft-rule-${decision.id}`,
    status: "draft",
    title: decision.editedTitle ?? decision.title,
    rule: decision.editedPreventionRule ?? decision.preventionRule,
    sourceDecisionIds: [decision.id],
    sourceCandidateIds: decision.sourceCandidateIds,
    sourcePrs: decision.sourcePrs,
    confidence: decision.confidence,
    notes: [
      `Generated from ${decision.decision} review decision.`,
      "Draft only; not written to AGENTS.md or repository instruction files.",
      ...decision.notes,
    ],
  };
}

function generateDraftRulesMarkdown(draftFile: DraftRulesFile): string {
  return [
    "# Traceback Draft Rules",
    "",
    `Generated: ${draftFile.generatedAt}`,
    "",
    "## Run",
    "",
    `- Run ID: ${draftFile.runId}`,
    `- Draft rules: ${draftFile.rules.length}`,
    `- Excluded decisions: ${draftFile.excludedDecisions.length}`,
    "",
    "## Draft Rules",
    "",
    ...renderRules(draftFile.rules),
    "",
    "## Excluded Decisions",
    "",
    ...renderExcludedDecisions(draftFile.excludedDecisions),
    "",
  ].join("\n");
}

function renderRules(rules: DraftRule[]): string[] {
  if (rules.length === 0) {
    return ["No accepted review decisions were available for draft rule generation."];
  }

  return rules.flatMap((rule) => [
    `### ${rule.title}`,
    "",
    `- ID: ${rule.id}`,
    `- Status: ${rule.status}`,
    `- Confidence: ${rule.confidence}`,
    `- Source decisions: ${rule.sourceDecisionIds.join(", ")}`,
    `- Source PRs: ${rule.sourcePrs.map((pr) => `#${pr}`).join(", ") || "none"}`,
    `- Source candidates: ${rule.sourceCandidateIds.join(", ") || "none"}`,
    `- Rule: ${rule.rule}`,
    "",
  ]);
}

function renderExcludedDecisions(excludedDecisions: ExcludedDecision[]): string[] {
  if (excludedDecisions.length === 0) {
    return ["None."];
  }

  return excludedDecisions.map(
    (decision) => `- ${decision.id}: ${decision.decision} - ${decision.reason}`,
  );
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
