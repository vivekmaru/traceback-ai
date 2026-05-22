import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runRulesReview } from "../src/rules-review";
import type { DraftRule, DraftRulesFile } from "../src/rules";

describe("runRulesReview", () => {
  test("writes conservative rule decisions and markdown summary", async () => {
    const repoRoot = await repoWithDraftRules({
      runId: "2026-05-18T11-35-13Z",
      rules: [
        draftRule({
          id: "draft-rule-review-cluster-template",
          title: "Template intent and protected-URL state preservation",
          rule: "Persist and restore full navigation intent including pathname, search, and hash.",
          sourceDecisionIds: ["review-cluster-template"],
          sourceCandidateIds: [
            "failure-pr-91-review_comment-3241022371",
            "failure-pr-92-review_comment-3248177660",
          ],
          sourcePrs: [91, 92],
          confidence: "high",
        }),
        draftRule({
          id: "draft-rule-review-cluster-randomness",
          title: "Validate random identifier threat model",
          rule: "Validate identifier threat model before changing randomness.",
          sourceDecisionIds: ["review-cluster-randomness"],
          sourceCandidateIds: ["failure-pr-83-pr_body-83"],
          sourcePrs: [83],
          confidence: "low",
        }),
        draftRule({
          id: "draft-rule-review-cluster-empty",
          title: "Empty rule",
          rule: "",
          sourceDecisionIds: ["review-cluster-empty"],
          sourceCandidateIds: ["failure-pr-99-review_comment-1"],
          sourcePrs: [99],
          confidence: "high",
        }),
      ],
    });

    try {
      const result = await runRulesReview(repoRoot, {
        runId: "2026-05-18T11-35-13Z",
        policy: "conservative",
        now: new Date("2026-05-18T15:00:00Z"),
      });

      const decisionsFile = await readJson(path.join(result.rulesDir, "rule-decisions.json"));
      const markdown = await readFile(path.join(result.rulesDir, "rule-review.md"), "utf8");

      expect(decisionsFile).toMatchObject({
        schemaVersion: 1,
        runId: "2026-05-18T11-35-13Z",
        policy: "conservative",
        reviewedAt: "2026-05-18T15:00:00.000Z",
      });
      expect(decisionsFile.decisions).toHaveLength(3);
      expect(decisionsFile.decisions[0]).toMatchObject({
        ruleId: "draft-rule-review-cluster-template",
        runId: "2026-05-18T11-35-13Z",
        decision: "accepted",
        title: "Template intent and protected-URL state preservation",
        editedTitle: null,
        instruction: "Persist and restore full navigation intent including pathname, search, and hash.",
        editedInstruction: null,
        rationale: "Generated from accepted review decision. Draft only; not written to AGENTS.md or repository instruction files.",
        editedRationale: null,
        sourcePrs: [91, 92],
        sourceCandidateIds: [
          "failure-pr-91-review_comment-3241022371",
          "failure-pr-92-review_comment-3248177660",
        ],
        confidence: "high",
        reason: "High-confidence cluster draft with preserved source references.",
        notes: [
          "Generated from accepted review decision.",
          "Draft only; not written to AGENTS.md or repository instruction files.",
        ],
        reviewedAt: "2026-05-18T15:00:00.000Z",
      });
      expect(decisionsFile.decisions[1]).toMatchObject({
        ruleId: "draft-rule-review-cluster-randomness",
        decision: "needs_edit",
        reason: "Rule is not high confidence, so conservative review requires a human edit.",
      });
      expect(decisionsFile.decisions[2]).toMatchObject({
        ruleId: "draft-rule-review-cluster-empty",
        decision: "rejected",
        reason: "Rule instruction is empty.",
      });
      expect(markdown).toContain("# Traceback Rule Review");
      expect(markdown).toContain("- Accepted: 1");
      expect(markdown).toContain("- Needs edit: 1");
      expect(markdown).toContain("- Rejected: 1");
      expect(markdown).toContain("Template intent and protected-URL state preservation");
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("normalizes manual rule decisions from a file", async () => {
    const repoRoot = await repoWithDraftRules({
      runId: "2026-05-18T11-35-13Z",
      rules: [draftRule({})],
    });
    const manualPath = path.join(repoRoot, "manual-rule-decisions.json");
    await writeFile(
      manualPath,
      `${JSON.stringify(
        {
          decisions: [
            {
              ruleId: "draft-rule-review-cluster-template",
              decision: "edited",
              title: "Template intent and protected-URL state preservation",
              editedTitle: "Edited navigation intent rule",
              instruction: "Persist and restore full navigation intent.",
              editedInstruction: "Always preserve pathname, search, and hash across auth redirects.",
              rationale: "Generated from accepted review decision.",
              editedRationale: "Tightened wording after human review.",
              sourcePrs: [91],
              sourceCandidateIds: ["failure-pr-91-review_comment-3241022371"],
              confidence: "high",
              reason: "Human-edited accepted rule.",
              notes: ["Manual review."],
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    try {
      const result = await runRulesReview(repoRoot, {
        runId: "2026-05-18T11-35-13Z",
        policy: "conservative",
        from: manualPath,
        now: new Date("2026-05-18T15:00:00Z"),
      });

      const decisionsFile = await readJson(path.join(result.rulesDir, "rule-decisions.json"));
      expect(decisionsFile.decisions[0]).toMatchObject({
        ruleId: "draft-rule-review-cluster-template",
        runId: "2026-05-18T11-35-13Z",
        decision: "edited",
        editedTitle: "Edited navigation intent rule",
        editedInstruction: "Always preserve pathname, search, and hash across auth redirects.",
        editedRationale: "Tightened wording after human review.",
        reviewedAt: "2026-05-18T15:00:00.000Z",
      });
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("rejects manual rule decisions from a different run", async () => {
    const repoRoot = await repoWithDraftRules({
      runId: "2026-05-18T11-35-13Z",
      rules: [draftRule({})],
    });
    const manualPath = path.join(repoRoot, "manual-rule-decisions.json");
    await writeFile(
      manualPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          runId: "2026-05-19T00-00-00Z",
          policy: "conservative",
          reviewedAt: "2026-05-18T15:00:00.000Z",
          source: {
            draftRules: "draft-rules.json",
            draftRulesMarkdown: "draft-rules.md",
          },
          decisions: [
            {
              ruleId: "draft-rule-review-cluster-template",
              decision: "accepted",
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    try {
      await expect(
        runRulesReview(repoRoot, {
          runId: "2026-05-18T11-35-13Z",
          policy: "conservative",
          from: manualPath,
          now: new Date("2026-05-18T15:00:00Z"),
        }),
      ).rejects.toThrow(
        "Manual rule decisions run ID 2026-05-19T00-00-00Z does not match requested run ID 2026-05-18T11-35-13Z.",
      );
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("rejects manual rule decisions for unknown rule IDs", async () => {
    const repoRoot = await repoWithDraftRules({
      runId: "2026-05-18T11-35-13Z",
      rules: [draftRule({})],
    });
    const manualPath = path.join(repoRoot, "manual-rule-decisions.json");
    await writeFile(
      manualPath,
      `${JSON.stringify(
        {
          decisions: [
            {
              ruleId: "draft-rule-stale",
              decision: "accepted",
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    try {
      await expect(
        runRulesReview(repoRoot, {
          runId: "2026-05-18T11-35-13Z",
          policy: "conservative",
          from: manualPath,
          now: new Date("2026-05-18T15:00:00Z"),
        }),
      ).rejects.toThrow("Manual rule decision references unknown rule ID: draft-rule-stale");
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});

async function repoWithDraftRules({
  runId,
  rules,
}: {
  runId: string;
  rules: DraftRule[];
}): Promise<string> {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "traceback-rules-review-"));
  const rulesDir = path.join(repoRoot, ".traceback", "rules", runId);
  await mkdir(rulesDir, { recursive: true });
  const draftFile: DraftRulesFile = {
    schemaVersion: 1,
    runId,
    generatedAt: "2026-05-18T13:00:00.000Z",
    source: {
      decisions: "../../reviews/2026-05-18T11-35-13Z/decisions.json",
    },
    rules,
    excludedDecisions: [],
  };
  await writeFile(
    path.join(rulesDir, "draft-rules.json"),
    `${JSON.stringify(draftFile, null, 2)}\n`,
    "utf8",
  );
  await writeFile(path.join(rulesDir, "draft-rules.md"), "# Traceback Draft Rules\n", "utf8");
  return repoRoot;
}

function draftRule(overrides: Partial<DraftRule>): DraftRule {
  return {
    id: "draft-rule-review-cluster-template",
    status: "draft",
    title: "Template intent and protected-URL state preservation",
    rule: "Persist and restore full navigation intent.",
    sourceDecisionIds: ["review-cluster-template"],
    sourceCandidateIds: ["failure-pr-91-review_comment-3241022371"],
    sourcePrs: [91],
    confidence: "high",
    notes: [
      "Generated from accepted review decision.",
      "Draft only; not written to AGENTS.md or repository instruction files.",
    ],
    ...overrides,
  };
}

async function readJson(filePath: string): Promise<any> {
  return JSON.parse(await readFile(filePath, "utf8"));
}
