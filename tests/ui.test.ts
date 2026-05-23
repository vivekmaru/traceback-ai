import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadUiState } from "../src/ui";
import type { FailureCandidate, NormalizedPullRequestRecord } from "../src/types";

describe("loadUiState", () => {
  test("summarizes Traceback artifacts without requiring provider output", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "traceback-ui-"));
    const runId = "2026-05-22T12-59-06Z";

    try {
      await writeJson(path.join(repoRoot, ".traceback", "records", "pr-8.json"), record(8));
      await writeJson(
        path.join(repoRoot, ".traceback", "records", "failures", "failure-pr-8-review_comment-1.json"),
        candidate("failure-pr-8-review_comment-1"),
      );
      await writeJson(path.join(repoRoot, ".traceback", "analysis", "runs", runId, "manifest.json"), {
        runId,
        mode: "dry-run",
        provider: null,
        createdAt: "2026-05-22T12:59:06.000Z",
        source: {
          failureCandidateCount: 1,
          recordsHash: "sha256-test",
        },
        files: {
          input: "input.json",
          prompt: "prompt.md",
          response: null,
          enrichedRecords: null,
          clusters: null,
          summary: null,
        },
      });
      await writeFile(path.join(repoRoot, ".traceback", "analysis", "runs", runId, "input.json"), "{}\n");
      await writeFile(path.join(repoRoot, ".traceback", "analysis", "runs", runId, "prompt.md"), "# Prompt\n");

      const state = await loadUiState(repoRoot, new Date("2026-05-22T13:00:00.000Z"));

      expect(state.summary).toEqual({
        importedPrs: 1,
        failureCandidates: 1,
        analysisRuns: 1,
        reviewDecisions: 0,
        draftRules: 0,
        ruleDecisions: 0,
        exports: 0,
      });
      expect(state.candidates).toHaveLength(1);
      expect(state.runs[0]).toMatchObject({
        runId,
        mode: "dry-run",
        hasInput: true,
        hasPrompt: true,
        hasProviderOutput: false,
        failureCandidateCount: 1,
      });
      expect(state.warnings).toContain(
        "All extracted candidates are still marked `candidate`; thread-aware outcome detection is a known quality gap.",
      );
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("counts reviews, rules, rule decisions, and exports when present", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "traceback-ui-"));
    const runId = "2026-05-22T13-10-00Z";

    try {
      await writeJson(path.join(repoRoot, ".traceback", "records", "pr-9.json"), record(9));
      await writeJson(
        path.join(repoRoot, ".traceback", "records", "failures", "failure-pr-9-review_comment-1.json"),
        { ...candidate("failure-pr-9-review_comment-1"), status: "resolved" },
      );
      await writeJson(path.join(repoRoot, ".traceback", "analysis", "runs", runId, "manifest.json"), {
        runId,
        mode: "provider",
        provider: "openai",
        createdAt: "2026-05-22T13:10:00.000Z",
        source: {
          failureCandidateCount: 1,
        },
        files: {
          input: "input.json",
          prompt: "prompt.md",
          response: "response.json",
          enrichedRecords: "enriched-records.json",
          clusters: "clusters.json",
          summary: "analysis-summary.md",
        },
      });
      await writeJson(path.join(repoRoot, ".traceback", "analysis", "runs", runId, "enriched-records.json"), [
        {
          id: "enriched-1",
          sourceCandidateIds: ["failure-pr-9-review_comment-1"],
          title: "Resolved issue",
          failureType: "context omission",
          summary: "summary",
          whatTheAgentMissed: "miss",
          evidenceSummary: "evidence",
          likelyFixOrCorrection: "fix",
          preventionRule: "rule",
          confidence: "high",
          sourcePrs: [9],
          sourceComments: [],
          notes: [],
        },
      ]);
      await writeJson(path.join(repoRoot, ".traceback", "analysis", "runs", runId, "clusters.json"), [
        {
          id: "cluster-1",
          title: "Cluster",
          summary: "summary",
          candidateIds: ["failure-pr-9-review_comment-1"],
          failureTypes: ["context omission"],
          sourcePrs: [9],
          evidenceSummary: "evidence",
          whatTheAgentMissed: "miss",
          preventionRule: "rule",
          confidence: "high",
        },
      ]);
      await writeJson(path.join(repoRoot, ".traceback", "reviews", runId, "decisions.json"), {
        schemaVersion: 1,
        runId,
        policy: "conservative",
        reviewedAt: "2026-05-22T13:11:00.000Z",
        source: {
          manifest: "../../analysis/runs/manifest.json",
          enrichedRecords: "../../analysis/runs/enriched-records.json",
          clusters: "../../analysis/runs/clusters.json",
        },
        decisions: [{ id: "review-cluster-1" }, { id: "review-cluster-2" }],
      });
      await writeJson(path.join(repoRoot, ".traceback", "rules", runId, "draft-rules.json"), {
        schemaVersion: 1,
        runId,
        generatedAt: "2026-05-22T13:12:00.000Z",
        source: {
          decisions: "../../reviews/decisions.json",
        },
        rules: [{ id: "draft-rule-1" }],
        excludedDecisions: [],
      });
      await writeJson(path.join(repoRoot, ".traceback", "rules", runId, "rule-decisions.json"), {
        schemaVersion: 1,
        runId,
        policy: "conservative",
        reviewedAt: "2026-05-22T13:13:00.000Z",
        source: {
          draftRules: "draft-rules.json",
          draftRulesMarkdown: "draft-rules.md",
        },
        decisions: [{ ruleId: "draft-rule-1" }],
      });
      await writeJson(path.join(repoRoot, ".traceback", "exports", runId, "manifest.json"), {
        schemaVersion: 1,
        runId,
        target: "agents-md",
        createdAt: "2026-05-22T13:14:00.000Z",
        sourceDraftRulesPath: "draft-rules.json",
        sourceDraftRulesMarkdownPath: "draft-rules.md",
        outputs: ["AGENTS.proposed.md"],
        exportedRuleCount: 1,
        warnings: [],
      });
      await writeFile(
        path.join(repoRoot, ".traceback", "exports", runId, "AGENTS.proposed.md"),
        "## Traceback Learnings\n\nWhen editing Traceback:\n\n- Preserve provenance.\n",
      );
      await writeFile(
        path.join(repoRoot, ".traceback", "exports", runId, "export-summary.md"),
        "# Traceback Rule Export Summary\n\n- Rules exported: 1\n",
      );

      const state = await loadUiState(repoRoot, new Date("2026-05-22T13:15:00.000Z"));

      expect(state.summary).toMatchObject({
        reviewDecisions: 2,
        draftRules: 1,
        ruleDecisions: 1,
        exports: 1,
      });
      expect(state.runs[0]).toMatchObject({
        runId,
        hasProviderOutput: true,
        enrichedRecords: 1,
        clusters: 1,
        reviewDecisions: 2,
        draftRules: 1,
        ruleDecisions: 1,
        exportedRules: 1,
        hasProposedAgents: true,
      });
      expect(state.runs[0].clusterItems).toHaveLength(1);
      expect(state.runs[0].reviewDecisionItems).toHaveLength(2);
      expect(state.runs[0].draftRuleItems).toHaveLength(1);
      expect(state.runs[0].ruleDecisionItems).toHaveLength(1);
      const exportItem = state.runs[0].exportItem;
      if (exportItem === null) {
        throw new Error("Expected export item to be present.");
      }
      expect(exportItem).toMatchObject({
        runId,
        target: "agents-md",
        createdAt: "2026-05-22T13:14:00.000Z",
        exportedRuleCount: 1,
        hasProposedAgents: true,
        proposedAgentsText: "## Traceback Learnings\n\nWhen editing Traceback:\n\n- Preserve provenance.\n",
        summaryText: "# Traceback Rule Export Summary\n\n- Rules exported: 1\n",
      });
      expect(state.exportItems).toHaveLength(1);
      expect(state.exportItems[0]).toBe(exportItem);
      expect(state.warnings).not.toContain(
        "All extracted candidates are still marked `candidate`; thread-aware outcome detection is a known quality gap.",
      );
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("represents export warnings when proposed AGENTS output is missing", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "traceback-ui-"));
    const runId = "2026-05-22T14-00-00Z";

    try {
      await writeJson(path.join(repoRoot, ".traceback", "records", "pr-10.json"), record(10));
      await writeJson(path.join(repoRoot, ".traceback", "analysis", "runs", runId, "manifest.json"), {
        runId,
        mode: "provider",
        provider: "openai",
        createdAt: "2026-05-22T14:00:00.000Z",
        source: {
          failureCandidateCount: 0,
        },
        files: {
          input: "input.json",
          prompt: "prompt.md",
          response: "response.json",
          enrichedRecords: "enriched-records.json",
          clusters: "clusters.json",
          summary: "analysis-summary.md",
        },
      });
      await writeJson(path.join(repoRoot, ".traceback", "exports", runId, "manifest.json"), {
        schemaVersion: 1,
        runId,
        target: "agents-md",
        createdAt: "2026-05-22T14:05:00.000Z",
        sourceDraftRulesPath: "draft-rules.json",
        sourceDraftRulesMarkdownPath: "draft-rules.md",
        outputs: ["export-summary.md", "manifest.json"],
        exportedRuleCount: 0,
        warnings: ["No exportable rules were found."],
      });
      await writeFile(
        path.join(repoRoot, ".traceback", "exports", runId, "export-summary.md"),
        "# Traceback Rule Export Summary\n\nNo AGENTS.proposed.md written.\n",
      );

      const state = await loadUiState(repoRoot, new Date("2026-05-22T14:10:00.000Z"));

      expect(state.summary.exports).toBe(0);
      expect(state.runs[0].exportItem).toMatchObject({
        runId,
        target: "agents-md",
        exportedRuleCount: 0,
        warnings: ["No exportable rules were found."],
        hasProposedAgents: false,
        proposedAgentsText: null,
        summaryText: "# Traceback Rule Export Summary\n\nNo AGENTS.proposed.md written.\n",
      });
      expect(state.runs[0].warnings).toEqual(["No exportable rules were found."]);
      expect(state.exportItems).toHaveLength(1);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function record(prNumber: number): NormalizedPullRequestRecord {
  return {
    schemaVersion: 2,
    importedAt: "2026-05-22T12:58:00.000Z",
    repository: {
      owner: "vivekmaru",
      repo: "traceback-ai",
      remoteUrl: "https://github.com/vivekmaru/traceback-ai.git",
    },
    prNumber,
    title: `PR ${prNumber}`,
    url: `https://github.com/vivekmaru/traceback-ai/pull/${prNumber}`,
    state: "closed",
    merged: true,
    author: "vivekmaru",
    createdAt: "2026-05-22T12:00:00.000Z",
    updatedAt: "2026-05-22T12:30:00.000Z",
    closedAt: "2026-05-22T12:30:00.000Z",
    mergedAt: "2026-05-22T12:30:00.000Z",
    baseBranch: "main",
    headBranch: "feat/test",
    body: "",
    labels: [],
    commitsCount: 1,
    changedFilesCount: 1,
    additions: 1,
    deletions: 0,
    issueComments: [],
    reviewComments: [],
    reviews: [],
    candidateAgentMarkers: [],
  };
}

function candidate(id: string): FailureCandidate {
  return {
    schemaVersion: 1,
    id,
    sourcePrNumber: 8,
    sourcePrUrl: "https://github.com/vivekmaru/traceback-ai/pull/8",
    sourceCommentUrl: "https://github.com/vivekmaru/traceback-ai/pull/8#discussion_r1",
    sourceAuthor: "chatgpt-codex-connector",
    sourceType: "review_comment",
    extractedTitle: "Validate rule decision provenance",
    evidenceExcerpt: "Rule decisions from another run should not be accepted.",
    candidateCategory: "context_omission",
    candidateSeverity: "medium",
    confidence: "high",
    status: "candidate",
    detectedAgentMarkers: ["codex"],
    createdAt: "2026-05-22T12:00:00.000Z",
    updatedAt: "2026-05-22T12:30:00.000Z",
    notes: [],
  };
}
