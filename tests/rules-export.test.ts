import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runRulesExport } from "../src/rules-export";
import type { RuleDecision, RuleDecisionsFile } from "../src/rules-review";
import type { DraftRule, DraftRulesFile } from "../src/rules";

describe("runRulesExport", () => {
  test("uses rule decisions when present", async () => {
    const repoRoot = await repoWithDraftRules({
      runId: "2026-05-18T11-35-13Z",
      rules: [
        draftRule({
          id: "draft-rule-accepted",
          title: "Accepted title",
          rule: "Accepted instruction.",
          sourceDecisionIds: ["review-cluster-accepted"],
          sourceCandidateIds: ["failure-pr-91-review_comment-3241022371"],
          sourcePrs: [91],
          confidence: "high",
        }),
        draftRule({
          id: "draft-rule-needs-edit",
          title: "Needs edit title",
          rule: "Needs edit instruction.",
          sourceDecisionIds: ["review-cluster-needs-edit"],
          sourceCandidateIds: ["failure-pr-83-pr_body-83"],
          sourcePrs: [83],
          confidence: "low",
        }),
      ],
      ruleDecisions: [
        ruleDecision({
          ruleId: "draft-rule-accepted",
          decision: "accepted",
          title: "Accepted title",
          instruction: "Accepted instruction.",
          sourcePrs: [91],
          sourceCandidateIds: ["failure-pr-91-review_comment-3241022371"],
          confidence: "high",
        }),
        ruleDecision({
          ruleId: "draft-rule-needs-edit",
          decision: "needs_edit",
          title: "Needs edit title",
          instruction: "Needs edit instruction.",
          sourcePrs: [83],
          sourceCandidateIds: ["failure-pr-83-pr_body-83"],
          confidence: "low",
        }),
      ],
    });

    try {
      const result = await runRulesExport(repoRoot, {
        runId: "2026-05-18T11-35-13Z",
        target: "agents-md",
        now: new Date("2026-05-18T16:00:00Z"),
      });

      const proposed = await readFile(path.join(result.exportDir, "AGENTS.proposed.md"), "utf8");
      const manifest = await readJson(path.join(result.exportDir, "manifest.json"));

      expect(result.exportedRuleCount).toBe(1);
      expect(proposed).toContain("Accepted title");
      expect(proposed).toContain("Accepted instruction.");
      expect(proposed).toContain("Review decision: accepted");
      expect(proposed).not.toContain("Needs edit title");
      expect(proposed).not.toContain("Needs edit instruction.");
      expect(manifest.sourceRuleDecisionsPath).toEndWith(
        ".traceback/rules/2026-05-18T11-35-13Z/rule-decisions.json",
      );
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("exports edited rule fields from rule decisions", async () => {
    const repoRoot = await repoWithDraftRules({
      runId: "2026-05-18T11-35-13Z",
      rules: [
        draftRule({
          id: "draft-rule-edited",
          title: "Original title",
          rule: "Original instruction.",
        }),
      ],
      ruleDecisions: [
        ruleDecision({
          ruleId: "draft-rule-edited",
          decision: "edited",
          title: "Original title",
          editedTitle: "Edited navigation intent rule",
          instruction: "Original instruction.",
          editedInstruction: "Always preserve pathname, search, and hash across auth redirects.",
          rationale: "Original rationale.",
          editedRationale: "Tightened after rule review.",
        }),
      ],
    });

    try {
      const result = await runRulesExport(repoRoot, {
        runId: "2026-05-18T11-35-13Z",
        target: "agents-md",
        now: new Date("2026-05-18T16:00:00Z"),
      });

      const proposed = await readFile(path.join(result.exportDir, "AGENTS.proposed.md"), "utf8");
      expect(proposed).toContain("Edited navigation intent rule");
      expect(proposed).toContain("Always preserve pathname, search, and hash across auth redirects.");
      expect(proposed).toContain("Tightened after rule review.");
      expect(proposed).toContain("Review decision: edited");
      expect(proposed).not.toContain("### Original title");
      expect(proposed).not.toContain("Original instruction.");
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("excludes rejected and needs_edit rule decisions from export", async () => {
    const repoRoot = await repoWithDraftRules({
      runId: "2026-05-18T11-35-13Z",
      rules: [
        draftRule({ id: "draft-rule-rejected", title: "Rejected title", rule: "Rejected instruction." }),
        draftRule({ id: "draft-rule-needs-edit", title: "Needs edit title", rule: "Needs edit instruction." }),
      ],
      ruleDecisions: [
        ruleDecision({
          ruleId: "draft-rule-rejected",
          decision: "rejected",
          title: "Rejected title",
          instruction: "Rejected instruction.",
        }),
        ruleDecision({
          ruleId: "draft-rule-needs-edit",
          decision: "needs_edit",
          title: "Needs edit title",
          instruction: "Needs edit instruction.",
        }),
      ],
    });

    try {
      const result = await runRulesExport(repoRoot, {
        runId: "2026-05-18T11-35-13Z",
        target: "agents-md",
        now: new Date("2026-05-18T16:00:00Z"),
      });

      const summary = await readFile(path.join(result.exportDir, "export-summary.md"), "utf8");
      await expect(readFile(path.join(result.exportDir, "AGENTS.proposed.md"), "utf8")).rejects.toThrow();
      expect(result.exportedRuleCount).toBe(0);
      expect(summary).toContain("No exportable rules were found.");
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("falls back to draft-rule export when no rule decisions exist", async () => {
    const repoRoot = await repoWithDraftRules({
      runId: "2026-05-18T11-35-13Z",
      rules: [draftRule({ id: "draft-rule-fallback", title: "Fallback title", rule: "Fallback instruction." })],
      ruleDecisions: null,
    });

    try {
      const result = await runRulesExport(repoRoot, {
        runId: "2026-05-18T11-35-13Z",
        target: "agents-md",
        now: new Date("2026-05-18T16:00:00Z"),
      });

      const proposed = await readFile(path.join(result.exportDir, "AGENTS.proposed.md"), "utf8");
      const manifest = await readJson(path.join(result.exportDir, "manifest.json"));
      expect(result.exportedRuleCount).toBe(1);
      expect(proposed).toContain("Fallback title");
      expect(proposed).toContain("Fallback instruction.");
      expect(proposed).toContain("Review decision: accepted draft rule");
      expect(manifest.sourceRuleDecisionsPath).toBeUndefined();
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
          now: new Date("2026-05-18T16:00:00Z"),
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
          now: new Date("2026-05-18T16:00:00Z"),
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
      ruleDecisions: [ruleDecision({})],
    });
    const rootAgentsPath = path.join(repoRoot, "AGENTS.md");
    await writeFile(rootAgentsPath, "# Existing Repo Instructions\n\nDo not overwrite me.\n", "utf8");

    try {
      await runRulesExport(repoRoot, {
        runId: "2026-05-18T11-35-13Z",
        target: "agents-md",
        now: new Date("2026-05-18T16:00:00Z"),
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
      ruleDecisions: [],
    });

    try {
      const result = await runRulesExport(repoRoot, {
        runId: "2026-05-18T11-35-13Z",
        target: "agents-md",
        now: new Date("2026-05-18T16:00:00Z"),
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
  ruleDecisions,
}: {
  runId: string;
  rules: DraftRule[];
  ruleDecisions: RuleDecision[] | null;
}): Promise<string> {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "traceback-rules-export-"));
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

  if (ruleDecisions) {
    const ruleDecisionsFile: RuleDecisionsFile = {
      schemaVersion: 1,
      runId,
      policy: "conservative",
      reviewedAt: "2026-05-18T15:00:00.000Z",
      source: {
        draftRules: "draft-rules.json",
        draftRulesMarkdown: "draft-rules.md",
      },
      decisions: ruleDecisions,
    };
    await writeFile(
      path.join(rulesDir, "rule-decisions.json"),
      `${JSON.stringify(ruleDecisionsFile, null, 2)}\n`,
      "utf8",
    );
  }

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

function ruleDecision(overrides: Partial<RuleDecision>): RuleDecision {
  return {
    ruleId: "draft-rule-review-cluster-template",
    runId: "2026-05-18T11-35-13Z",
    decision: "accepted",
    title: "Template intent and protected-URL state preservation",
    editedTitle: null,
    instruction: "Persist and restore full navigation intent.",
    editedInstruction: null,
    rationale: "Generated from accepted review decision.",
    editedRationale: null,
    sourcePrs: [91],
    sourceCandidateIds: ["failure-pr-91-review_comment-3241022371"],
    confidence: "high",
    reason: "High-confidence cluster draft with preserved source references.",
    notes: [],
    reviewedAt: "2026-05-18T15:00:00.000Z",
    ...overrides,
  };
}

async function readJson(filePath: string): Promise<any> {
  return JSON.parse(await readFile(filePath, "utf8"));
}
