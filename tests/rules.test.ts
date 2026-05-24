import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runRulesDraft } from "../src/rules";
import type { ReviewDecision, ReviewDecisionsFile } from "../src/review";

describe("runRulesDraft", () => {
  test("writes draft rules from accepted review decisions only", async () => {
    const repoRoot = await repoWithReviewDecisions({
      runId: "2026-05-18T11-35-13Z",
      decisions: [
        decision({
          id: "review-cluster-template",
          decision: "accepted",
          title: "Template intent and protected-URL state preservation",
          preventionRule: "Persist and restore full navigation intent including pathname, search, and hash.",
          sourceCandidateIds: ["failure-pr-91-review_comment-3241022371"],
          sourcePrs: [91],
          confidence: "high",
        }),
        decision({
          id: "review-cluster-randomness",
          decision: "needs_validation",
          title: "Insecure randomness used for identifiers",
          preventionRule: "Validate identifier threat model before changing randomness.",
          sourceCandidateIds: ["failure-pr-83-pr_body-83"],
          sourcePrs: [83],
          confidence: "low",
        }),
        decision({
          id: "review-singleton-env-config",
          decision: "needs_cluster",
          title: "Restore environment-aware pricing source URL",
          preventionRule: "Derive app URLs from environment configuration.",
          sourceCandidateIds: ["failure-pr-93-review_comment-3248177660"],
          sourcePrs: [93],
          confidence: "high",
        }),
      ],
    });

    try {
      const result = await runRulesDraft(repoRoot, {
        runId: "2026-05-18T11-35-13Z",
        now: new Date("2026-05-18T13:00:00Z"),
      });

      const rules = await readJson(path.join(result.rulesDir, "draft-rules.json"));
      const markdown = await readFile(path.join(result.rulesDir, "draft-rules.md"), "utf8");

      expect(rules).toMatchObject({
        schemaVersion: 1,
        runId: "2026-05-18T11-35-13Z",
        generatedAt: "2026-05-18T13:00:00.000Z",
      });
      expect(rules.rules).toHaveLength(1);
      expect(rules.rules[0]).toMatchObject({
        id: "draft-rule-review-cluster-template",
        status: "draft",
        title: "Template intent and protected-URL state preservation",
        rule: "Persist and restore full navigation intent including pathname, search, and hash.",
        sourceDecisionIds: ["review-cluster-template"],
        sourceCandidateIds: ["failure-pr-91-review_comment-3241022371"],
        sourcePrs: [91],
        confidence: "high",
      });
      expect(rules.excludedDecisions).toEqual([
        {
          id: "review-cluster-randomness",
          decision: "needs_validation",
          reason: "Decision is not accepted for draft rule generation.",
        },
        {
          id: "review-singleton-env-config",
          decision: "needs_cluster",
          reason: "Decision is not accepted for draft rule generation.",
        },
      ]);
      expect(markdown).toContain("# Traceback Draft Rules");
      expect(markdown).toContain("Template intent and protected-URL state preservation");
      expect(markdown).not.toContain("Insecure randomness used for identifiers");
      expect(markdown).not.toContain("Restore environment-aware pricing source URL");
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("includes edited decisions using edited title and prevention rule", async () => {
    const repoRoot = await repoWithReviewDecisions({
      runId: "2026-05-18T11-35-13Z",
      decisions: [
        decision({
          id: "review-cluster-edited",
          decision: "edited",
          title: "Original title",
          preventionRule: "Original rule.",
          editedTitle: "Edited navigation intent rule",
          editedPreventionRule: "Always preserve full navigation intent across auth redirects.",
        }),
      ],
    });

    try {
      const result = await runRulesDraft(repoRoot, {
        runId: "2026-05-18T11-35-13Z",
        now: new Date("2026-05-18T13:00:00Z"),
      });

      const rules = await readJson(path.join(result.rulesDir, "draft-rules.json"));
      expect(rules.rules[0]).toMatchObject({
        title: "Edited navigation intent rule",
        rule: "Always preserve full navigation intent across auth redirects.",
      });
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("classifies draft rules by learning scope", async () => {
    const repoRoot = await repoWithReviewDecisions({
      runId: "2026-05-18T11-35-13Z",
      decisions: [
        decision({
          id: "review-cluster-traceback-taxonomy",
          decision: "accepted",
          title: "Traceback taxonomy fixture guard",
          preventionRule:
            "When editing Traceback taxonomy heuristics, require contextual tokens and positive/negative fixtures.",
        }),
        decision({
          id: "review-cluster-general-heuristics",
          decision: "accepted",
          title: "Fixture-backed classifier tuning",
          preventionRule:
            "When tuning extraction heuristics, test standalone and contextual examples before broadening matches.",
        }),
        decision({
          id: "review-cluster-status-inference",
          decision: "accepted",
          title: "Status inference and thread-context mishandling",
          preventionRule:
            "Derive status from scoped thread replies and keep candidate outcomes thread-local.",
        }),
        decision({
          id: "review-cluster-import-pagination",
          decision: "accepted",
          title: "Import pagination and page boundary handling",
          preventionRule: "Implement fixed per_page pagination loops for imported PR records.",
        }),
        decision({
          id: "review-cluster-pr-loop",
          decision: "accepted",
          title: "Review-loop audit after repeated comments",
          preventionRule:
            "After repeated PR review comments in one area, audit the whole matcher family before pushing another patch.",
        }),
      ],
    });

    try {
      const result = await runRulesDraft(repoRoot, {
        runId: "2026-05-18T11-35-13Z",
        now: new Date("2026-05-18T13:00:00Z"),
      });

      const rules = await readJson(path.join(result.rulesDir, "draft-rules.json"));
      const markdown = await readFile(path.join(result.rulesDir, "draft-rules.md"), "utf8");

      expect(rules.rules.map((rule: any) => [rule.id, rule.learningScope])).toEqual([
        ["draft-rule-review-cluster-traceback-taxonomy", "repo_specific"],
        ["draft-rule-review-cluster-general-heuristics", "general_engineering"],
        ["draft-rule-review-cluster-status-inference", "repo_specific"],
        ["draft-rule-review-cluster-import-pagination", "repo_specific"],
        ["draft-rule-review-cluster-pr-loop", "process_or_workflow"],
      ]);
      expect(markdown).toContain("- Learning scope: repo_specific");
      expect(markdown).toContain("- Learning scope: general_engineering");
      expect(markdown).toContain("- Learning scope: process_or_workflow");
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("writes an empty draft when there are no accepted decisions", async () => {
    const repoRoot = await repoWithReviewDecisions({
      runId: "2026-05-18T11-35-13Z",
      decisions: [
        decision({
          id: "review-cluster-randomness",
          decision: "needs_validation",
        }),
      ],
    });

    try {
      const result = await runRulesDraft(repoRoot, {
        runId: "2026-05-18T11-35-13Z",
        now: new Date("2026-05-18T13:00:00Z"),
      });

      const rules = await readJson(path.join(result.rulesDir, "draft-rules.json"));
      const markdown = await readFile(path.join(result.rulesDir, "draft-rules.md"), "utf8");

      expect(rules.rules).toEqual([]);
      expect(markdown).toContain("No accepted review decisions were available for draft rule generation.");
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("rejects duplicate decision IDs before generating draft rules", async () => {
    const repoRoot = await repoWithReviewDecisions({
      runId: "2026-05-18T11-35-13Z",
      decisions: [
        decision({
          id: "dup",
          decision: "accepted",
        }),
        decision({
          id: "dup",
          decision: "accepted",
          title: "Duplicate accepted decision",
        }),
      ],
    });

    try {
      await expect(
        runRulesDraft(repoRoot, {
          runId: "2026-05-18T11-35-13Z",
          now: new Date("2026-05-18T13:00:00Z"),
        }),
      ).rejects.toThrow("Duplicate review decision ID");
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("rejects run IDs that would escape the rules directory", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "traceback-rules-"));

    try {
      await expect(
        runRulesDraft(repoRoot, {
          runId: "../../pwn",
          now: new Date("2026-05-18T13:00:00Z"),
        }),
      ).rejects.toThrow("Invalid run ID");
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});

async function repoWithReviewDecisions({
  runId,
  decisions,
}: {
  runId: string;
  decisions: ReviewDecision[];
}): Promise<string> {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "traceback-rules-"));
  const reviewDir = path.join(repoRoot, ".traceback", "reviews", runId);
  await mkdir(reviewDir, { recursive: true });
  const decisionsFile: ReviewDecisionsFile = {
    schemaVersion: 1,
    runId,
    policy: "conservative",
    reviewedAt: "2026-05-18T12:00:00.000Z",
    source: {
      manifest: "../../analysis/runs/2026-05-18T11-35-13Z/manifest.json",
      enrichedRecords: "../../analysis/runs/2026-05-18T11-35-13Z/enriched-records.json",
      clusters: "../../analysis/runs/2026-05-18T11-35-13Z/clusters.json",
    },
    decisions,
  };
  await writeFile(
    path.join(reviewDir, "decisions.json"),
    `${JSON.stringify(decisionsFile, null, 2)}\n`,
    "utf8",
  );
  return repoRoot;
}

function decision(overrides: Partial<ReviewDecision>): ReviewDecision {
  return {
    id: "review-cluster-template",
    runId: "2026-05-18T11-35-13Z",
    itemType: "cluster",
    sourceClusterId: "cluster-template",
    sourceEnrichedRecordId: null,
    sourceCandidateIds: ["failure-pr-91-review_comment-3241022371"],
    sourcePrs: [91],
    sourceComments: ["https://github.com/vivekmaru/EventSnaps/pull/91#discussion_r3241022371"],
    title: "Template intent and protected-URL state preservation",
    preventionRule: "Persist and restore full navigation intent.",
    confidence: "high",
    decision: "accepted",
    reason: "High-confidence cluster backed by review-comment candidates.",
    editedTitle: null,
    editedPreventionRule: null,
    notes: [],
    reviewedAt: "2026-05-18T12:00:00.000Z",
    ...overrides,
  };
}

async function readJson(filePath: string): Promise<any> {
  return JSON.parse(await readFile(filePath, "utf8"));
}
