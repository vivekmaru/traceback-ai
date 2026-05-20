import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runRulesExport } from "../src/rules-export";
import type { ReviewDecision, ReviewDecisionsFile } from "../src/review";
import type { DraftRule, DraftRulesFile } from "../src/rules";

describe("runRulesExport", () => {
  test("writes a human-reviewable AGENTS proposed file from draft rules", async () => {
    const repoRoot = await repoWithDraftRules({
      runId: "2026-05-18T11-35-13Z",
      rules: [
        draftRule({
          id: "draft-rule-review-cluster-template",
          title: "Template intent and protected-URL state preservation",
          rule: "Persist and restore full navigation intent including pathname, search, and hash.",
          sourceDecisionIds: ["review-cluster-template"],
          sourceCandidateIds: ["failure-pr-91-review_comment-3241022371"],
          sourcePrs: [91],
          confidence: "high",
        }),
      ],
      decisions: [
        decision({
          id: "review-cluster-template",
          decision: "accepted",
          sourceComments: ["https://github.com/vivekmaru/EventSnaps/pull/91#discussion_r3241022371"],
          reason: "High-confidence cluster backed by review-comment candidates.",
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
      ],
    });

    try {
      const result = await runRulesExport(repoRoot, {
        runId: "2026-05-18T11-35-13Z",
        target: "agents-md",
        now: new Date("2026-05-18T14:00:00Z"),
      });

      const proposed = await readFile(
        path.join(result.exportDir, "AGENTS.proposed.md"),
        "utf8",
      );
      const summary = await readFile(path.join(result.exportDir, "export-summary.md"), "utf8");
      const manifest = await readJson(path.join(result.exportDir, "manifest.json"));

      expect(result.exportedRuleCount).toBe(1);
      expect(proposed).toContain("# Traceback Proposed AGENTS.md Instructions");
      expect(proposed).toContain("Run ID: 2026-05-18T11-35-13Z");
      expect(proposed).toContain("Generated: 2026-05-18T14:00:00.000Z");
      expect(proposed).toContain("proposed output and has not been applied");
      expect(proposed).toContain("Local-only privacy note");
      expect(proposed).toContain("Template intent and protected-URL state preservation");
      expect(proposed).toContain(
        "Persist and restore full navigation intent including pathname, search, and hash.",
      );
      expect(proposed).toContain("High-confidence cluster backed by review-comment candidates.");
      expect(proposed).toContain("https://github.com/vivekmaru/EventSnaps/pull/91#discussion_r3241022371");
      expect(proposed).toContain("Confidence: high");
      expect(proposed).toContain("Review decision: accepted");
      expect(proposed).not.toContain("needs_validation");
      expect(proposed).not.toContain("Insecure randomness used for identifiers");

      expect(summary).toContain("- Run ID: 2026-05-18T11-35-13Z");
      expect(summary).toContain("- Target: agents-md");
      expect(summary).toContain("- Rules exported: 1");
      expect(summary).toContain("AGENTS.proposed.md");
      expect(summary).toContain("No root repo instruction files were modified.");

      expect(manifest).toMatchObject({
        runId: "2026-05-18T11-35-13Z",
        target: "agents-md",
        createdAt: "2026-05-18T14:00:00.000Z",
        exportedRuleCount: 1,
      });
      expect(manifest.sourceDraftRulesPath).toEndWith(
        ".traceback/rules/2026-05-18T11-35-13Z/draft-rules.json",
      );
      expect(manifest.sourceDecisionsPath).toEndWith(
        ".traceback/reviews/2026-05-18T11-35-13Z/decisions.json",
      );
      expect(manifest.outputs).toEqual([
        path.join(result.exportDir, "AGENTS.proposed.md"),
        path.join(result.exportDir, "export-summary.md"),
        path.join(result.exportDir, "manifest.json"),
      ]);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("fails clearly when draft rules are missing", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "traceback-rules-export-"));
    await mkdir(path.join(repoRoot, ".traceback", "reviews", "2026-05-18T11-35-13Z"), {
      recursive: true,
    });

    try {
      await expect(
        runRulesExport(repoRoot, {
          runId: "2026-05-18T11-35-13Z",
          target: "agents-md",
          now: new Date("2026-05-18T14:00:00Z"),
        }),
      ).rejects.toThrow("Run `traceback rules --run 2026-05-18T11-35-13Z` first.");
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("fails clearly for unsupported targets", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "traceback-rules-export-"));

    try {
      await expect(
        runRulesExport(repoRoot, {
          runId: "2026-05-18T11-35-13Z",
          target: "claude-md",
          now: new Date("2026-05-18T14:00:00Z"),
        }),
      ).rejects.toThrow("Unsupported export target: claude-md. Supported targets: agents-md.");
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("does not modify root AGENTS.md", async () => {
    const repoRoot = await repoWithDraftRules({
      runId: "2026-05-18T11-35-13Z",
      rules: [draftRule({})],
      decisions: [decision({})],
    });
    const rootAgentsPath = path.join(repoRoot, "AGENTS.md");
    await writeFile(rootAgentsPath, "# Existing Repo Instructions\n\nDo not overwrite me.\n", "utf8");

    try {
      await runRulesExport(repoRoot, {
        runId: "2026-05-18T11-35-13Z",
        target: "agents-md",
        now: new Date("2026-05-18T14:00:00Z"),
      });

      await expect(readFile(rootAgentsPath, "utf8")).resolves.toBe(
        "# Existing Repo Instructions\n\nDo not overwrite me.\n",
      );
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("does not write AGENTS proposed output when no exportable rules exist", async () => {
    const repoRoot = await repoWithDraftRules({
      runId: "2026-05-18T11-35-13Z",
      rules: [],
      decisions: [
        decision({
          id: "review-cluster-randomness",
          decision: "needs_validation",
        }),
      ],
    });

    try {
      const result = await runRulesExport(repoRoot, {
        runId: "2026-05-18T11-35-13Z",
        target: "agents-md",
        now: new Date("2026-05-18T14:00:00Z"),
      });

      const summary = await readFile(path.join(result.exportDir, "export-summary.md"), "utf8");
      const manifest = await readJson(path.join(result.exportDir, "manifest.json"));

      expect(result.exportedRuleCount).toBe(0);
      await expect(readFile(path.join(result.exportDir, "AGENTS.proposed.md"), "utf8")).rejects.toThrow();
      expect(summary).toContain("No exportable rules were found.");
      expect(manifest.exportedRuleCount).toBe(0);
      expect(manifest.outputs).toEqual([
        path.join(result.exportDir, "export-summary.md"),
        path.join(result.exportDir, "manifest.json"),
      ]);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});

async function repoWithDraftRules({
  runId,
  rules,
  decisions,
}: {
  runId: string;
  rules: DraftRule[];
  decisions: ReviewDecision[];
}): Promise<string> {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "traceback-rules-export-"));
  const rulesDir = path.join(repoRoot, ".traceback", "rules", runId);
  const reviewDir = path.join(repoRoot, ".traceback", "reviews", runId);
  await mkdir(rulesDir, { recursive: true });
  await mkdir(reviewDir, { recursive: true });

  const draftFile: DraftRulesFile = {
    schemaVersion: 1,
    runId,
    generatedAt: "2026-05-18T13:00:00.000Z",
    source: {
      decisions: path.relative(rulesDir, path.join(reviewDir, "decisions.json")),
    },
    rules,
    excludedDecisions: [
      {
        id: "review-cluster-randomness",
        decision: "needs_validation",
        reason: "Decision is not accepted for draft rule generation.",
      },
    ],
  };
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
    path.join(rulesDir, "draft-rules.json"),
    `${JSON.stringify(draftFile, null, 2)}\n`,
    "utf8",
  );
  await writeFile(path.join(rulesDir, "draft-rules.md"), "# Traceback Draft Rules\n", "utf8");
  await writeFile(
    path.join(reviewDir, "decisions.json"),
    `${JSON.stringify(decisionsFile, null, 2)}\n`,
    "utf8",
  );

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
