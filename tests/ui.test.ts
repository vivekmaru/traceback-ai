import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createContext, runInContext } from "node:vm";
import { createUiRequestHandler, loadUiState, renderHtml, runUiServer } from "../src/ui";
import type { FailureCandidate, NormalizedPullRequestRecord } from "../src/types";

describe("loadUiState", () => {
  test("prefers usable provider output, preserves manual selection, and falls back for dry runs", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "traceback-ui-"));
    const providerId = "2026-05-22T12-00-00Z";
    const incompleteId = "2026-05-23T12-00-00Z";
    const dryId = "2026-05-24T12-00-00Z";
    try {
      expect((await loadUiState(repoRoot)).defaultRunId).toBeNull();
      for (const [runId, mode] of [[dryId, "dry-run"], [incompleteId, "provider"], [providerId, "provider"]]) {
        await writeJson(path.join(repoRoot, ".traceback/analysis/runs", runId, "manifest.json"), {
          runId, mode, provider: mode === "provider" ? "openai" : null,
          files: { response: mode === "provider" ? "response.json" : null },
        });
        if (mode === "provider") {
          await writeJson(path.join(repoRoot, ".traceback/analysis/runs", runId, "response.json"), {});
          await writeJson(path.join(repoRoot, ".traceback/analysis/runs", runId, "enriched-records.json"), []);
        }
      }
      expect((await loadUiState(repoRoot)).defaultRunId).toBe(dryId);
      await writeJson(path.join(repoRoot, ".traceback/analysis/runs", providerId, "clusters.json"), []);
      const data = await loadUiState(repoRoot);
      expect(data.runs.map((run) => run.runId)).toEqual([dryId, incompleteId, providerId]);
      expect(data.defaultRunId).toBe(providerId);
      expect(data.runs[1].hasAnalysisOutput).toBe(false);
      const context = uiContext({ data, dryId });
      runInContext("state.data = data; render()", context);
      expect(runInContext("state.selectedRunId", context)).toBe(providerId);
      runInContext("state.selectedRunId = dryId; render()", context);
      expect(runInContext("state.selectedRunId", context)).toBe(dryId);
      runInContext("state.selectedRunId = 'missing'; render()", context);
      expect(runInContext("state.selectedRunId", context)).toBe(providerId);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("blocks downstream commands for dry runs and recognizes empty completed stages", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "traceback-ui-"));
    const runId = "2026-05-22T12-00-00Z";
    try {
      await writeJson(path.join(repoRoot, ".traceback/analysis/runs", runId, "manifest.json"), { runId, mode: "dry-run" });
      const data = await loadUiState(repoRoot);
      const context = uiContext({ run: data.runs[0], summary: { importedPrs: 1, failureCandidates: 1 } });
      const html = runInContext("stageCards(summary, run)", context);
      expect(html).toContain("traceback analyze --provider openai");
      expect(html).toContain("sends current candidates to OpenAI");
      expect(html).toContain("NEW run");
      expect(html).toContain("blocked");
      expect(html).not.toContain("traceback review --run");
      expect(html).not.toContain("traceback rules --run");
      expect(html).not.toContain("traceback rules export");
      await writeJson(path.join(repoRoot, ".traceback/reviews", runId, "decisions.json"), { decisions: [] });
      await writeJson(path.join(repoRoot, ".traceback/rules", runId, "draft-rules.json"), { rules: [] });
      await writeJson(path.join(repoRoot, ".traceback/rules", runId, "rule-decisions.json"), { decisions: [] });
      const [run] = (await loadUiState(repoRoot)).runs;
      expect(run).toMatchObject({ hasReviewOutput: true, hasDraftRules: true, hasRuleDecisions: true, draftRules: 0 });
      const completed = runInContext("stageCards(summary, run)", uiContext({ run, summary: data.summary }));
      expect(completed).toContain("traceback rules export --run");
      expect(completed).not.toContain("traceback rules review --run");
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test.each(["repo_specific", "general_engineering", "process_or_workflow", undefined, "invented"])(
    "projects learning scope %s without guessing missing or invalid values", async (learningScope) => {
      const repoRoot = await mkdtemp(path.join(os.tmpdir(), "traceback-ui-"));
      const runId = "2026-05-22T12-00-00Z";
      try {
        await writeJson(path.join(repoRoot, ".traceback/analysis/runs", runId, "manifest.json"), { runId });
        await writeJson(path.join(repoRoot, ".traceback/rules", runId, "draft-rules.json"), { rules: [{ id: "rule-1", learningScope }] });
        const state = await loadUiState(repoRoot);
        expect(state.draftRules[0].learningScope).toBe(!learningScope || learningScope === "invented" ? "unknown" : learningScope);
      } finally {
        await rm(repoRoot, { recursive: true, force: true });
      }
    },
  );

  test.each([
    { replies: ["Thanks for the context."], resolved: false, outdated: false, status: "candidate", basis: "none", inferred: "candidate", matching: null },
    { replies: ["Thanks for the context."], resolved: true, outdated: false, status: "resolved", basis: "thread_resolved", inferred: "resolved", matching: null },
    { replies: [], resolved: false, outdated: true, status: "superseded", basis: "thread_outdated", inferred: "superseded", matching: null },
    { replies: ["Fixed in abc123.", "Thanks for the context."], resolved: false, outdated: false, status: "resolved", basis: "reply", inferred: "resolved", matching: "Fixed in abc123." },
    { replies: ["Fixed in abc123.", "Not fixed yet."], resolved: true, outdated: false, status: "resolved", basis: "reply", inferred: "candidate", matching: "Not fixed yet." },
  ] as const)("attributes status to the matching signal: %j", async (fixture) => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "traceback-ui-"));
    const original = {
      id: 1001, author: "reviewer", body: "This drops source evidence.",
      createdAt: "2026-05-22T12:00:00Z", updatedAt: null,
      url: "https://github.com/vivekmaru/traceback-ai/pull/8#discussion_r1001",
      path: "src/ui.ts", line: 1, originalLine: 1, inReplyToId: null, commitId: null,
    };
    try {
      await writeJson(path.join(repoRoot, ".traceback/records/pr-8.json"), {
        ...record(8),
        reviewComments: [original, ...fixture.replies.map((body, index) => ({
          ...original, id: 1002 + index, body, inReplyToId: 1001,
          createdAt: `2026-05-22T12:0${index + 1}:00Z`,
        })).reverse()],
        reviewThreads: [{ id: "thread-1", isResolved: fixture.resolved, isOutdated: fixture.outdated, commentIds: ["1001"] }],
      });
      await writeJson(path.join(repoRoot, ".traceback/records/failures/failure-pr-8-review_comment-1001.json"), {
        ...candidate("failure-pr-8-review_comment-1001"), sourceCommentUrl: original.url, status: fixture.status,
      });
      const state = await loadUiState(repoRoot);
      const evidence = state.candidates[0].statusEvidence;
      expect(evidence).toMatchObject({
        basis: fixture.basis, inferredStatus: fixture.inferred,
        matchesStoredStatus: fixture.inferred === fixture.status,
        supportingReplyExcerpt: fixture.matching, replyCount: fixture.replies.length,
      });
      expect(state.candidates[0].status).toBe(fixture.status);
      if (fixture.replies.at(-1) === "Thanks for the context.") {
        expect(evidence.latestReplyExcerpt).toBe("Thanks for the context.");
      }
      if (fixture.inferred !== fixture.status) expect(evidence.detail).toContain("Re-run traceback extract");
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

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
        statusCounts: {
          candidate: 1,
        },
        analysisRuns: 1,
        reviewDecisions: 0,
        draftRules: 0,
        ruleDecisions: 0,
        exports: 0,
      });
      expect(state.candidates).toHaveLength(1);
      expect(state.candidates[0].status).toBe("candidate");
      expect(state.runs[0]).toMatchObject({
        runId,
        mode: "dry-run",
        hasInput: true,
        hasPrompt: true,
        hasProviderOutput: false,
        failureCandidateCount: 1,
      });
      expect(state.warnings).toContain(
        "No candidate has an inferred outcome. Same-thread replies or GitHub thread metadata may be unavailable; this alone does not indicate an extraction error.",
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
      await writeFile(
        path.join(repoRoot, ".traceback", "analysis", "runs", runId, "response.json"),
        "{}\n",
      );
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
        rules: [{ id: "draft-rule-1", learningScope: "general_engineering" }],
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
        repoSpecificRuleCount: 1,
        broaderLearningCount: 1,
        warnings: [],
      });
      await writeFile(
        path.join(repoRoot, ".traceback", "exports", runId, "AGENTS.proposed.md"),
        "## Traceback Learnings\n\nWhen editing Traceback:\n\n- Preserve provenance.\n",
      );
      await writeFile(
        path.join(repoRoot, ".traceback", "exports", runId, "broader-learnings.md"),
        "# Traceback Broader Learnings\n\n## General Engineering\n\n- Add negative fixtures.\n",
      );
      await writeFile(
        path.join(repoRoot, ".traceback", "exports", runId, "export-summary.md"),
        "# Traceback Rule Export Summary\n\n- Repo-specific rules exported: 1\n- Broader learnings preserved: 1\n",
      );

      const state = await loadUiState(repoRoot, new Date("2026-05-22T13:15:00.000Z"));

      expect(state.summary).toMatchObject({
        statusCounts: {
          resolved: 1,
        },
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
      expect(state.runs[0].draftRuleItems[0].learningScope).toBe("general_engineering");
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
        repoSpecificRuleCount: 1,
        broaderLearningCount: 1,
        hasProposedAgents: true,
        hasBroaderLearnings: true,
        proposedAgentsText: "## Traceback Learnings\n\nWhen editing Traceback:\n\n- Preserve provenance.\n",
        broaderLearningsText:
          "# Traceback Broader Learnings\n\n## General Engineering\n\n- Add negative fixtures.\n",
        summaryText:
          "# Traceback Rule Export Summary\n\n- Repo-specific rules exported: 1\n- Broader learnings preserved: 1\n",
      });
      expect(state.exportItems).toHaveLength(1);
      expect(state.exportItems[0]).toBe(exportItem);
      expect(state.warnings).not.toContain(
        "No candidate has an inferred outcome. Same-thread replies or GitHub thread metadata may be unavailable; this alone does not indicate an extraction error.",
      );
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("surfaces status distribution including superseded candidates", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "traceback-ui-"));

    try {
      await writeJson(path.join(repoRoot, ".traceback", "records", "pr-11.json"), record(11));
      await writeJson(
        path.join(repoRoot, ".traceback", "records", "failures", "failure-pr-11-review_comment-1.json"),
        { ...candidate("failure-pr-11-review_comment-1"), status: "candidate" },
      );
      await writeJson(
        path.join(repoRoot, ".traceback", "records", "failures", "failure-pr-11-review_comment-2.json"),
        { ...candidate("failure-pr-11-review_comment-2"), status: "superseded" },
      );

      const state = await loadUiState(repoRoot, new Date("2026-05-22T15:00:00.000Z"));

      expect(state.summary.statusCounts).toEqual({
        candidate: 1,
        superseded: 1,
      });
      expect(state.warnings).not.toContain(
        "No candidate has an inferred outcome. Same-thread replies or GitHub thread metadata may be unavailable; this alone does not indicate an extraction error.",
      );
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("adds candidate source and status evidence from imported review threads", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "traceback-ui-"));

    try {
      await writeJson(path.join(repoRoot, ".traceback", "records", "pr-8.json"), {
        ...record(8),
        reviewComments: [
          {
            id: 1001,
            author: "chatgpt-codex-connector[bot]",
            body: "This drops the source evidence.",
            createdAt: "2026-05-22T12:00:00.000Z",
            updatedAt: "2026-05-22T12:00:00.000Z",
            url: "https://github.com/vivekmaru/traceback-ai/pull/8#discussion_r1001",
            path: "src/ui.ts",
            line: 120,
            originalLine: 110,
            inReplyToId: null,
            commitId: "abc123",
          },
          {
            id: 1002,
            author: "vivekmaru",
            body: "Good catch, fixed in the follow-up.",
            createdAt: "2026-05-22T12:05:00.000Z",
            updatedAt: "2026-05-22T12:05:00.000Z",
            url: "https://github.com/vivekmaru/traceback-ai/pull/8#discussion_r1002",
            path: "src/ui.ts",
            line: 120,
            originalLine: 110,
            inReplyToId: 1001,
            commitId: "abc123",
          },
        ],
        reviewThreads: [
          {
            id: "thread-1",
            isResolved: true,
            isOutdated: false,
            path: "src/ui.ts",
            line: 120,
            startLine: null,
            commentIds: ["1001", "1002"],
          },
        ],
      });
      await writeJson(
        path.join(repoRoot, ".traceback", "records", "failures", "failure-pr-8-review_comment-1001.json"),
        {
          ...candidate("failure-pr-8-review_comment-1001"),
          sourceCommentUrl: "https://github.com/vivekmaru/traceback-ai/pull/8#discussion_r1001",
          status: "resolved",
        },
      );

      const state = await loadUiState(repoRoot, new Date("2026-05-22T15:00:00.000Z"));

      expect(state.candidates[0]).toMatchObject({
        sourceAuthor: "chatgpt-codex-connector",
        sourcePath: "src/ui.ts",
        sourceLine: 120,
        statusEvidence: {
          label: "Same-thread reply signal",
          basis: "reply",
          inferredStatus: "resolved",
          matchesStoredStatus: true,
          replyCount: 1,
          supportingReplyExcerpt: "Good catch, fixed in the follow-up.",
          latestReplyExcerpt: null,
          threadResolved: true,
          threadOutdated: false,
        },
      });
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("does not mark provider output present when the response artifact is missing", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "traceback-ui-"));
    const runId = "2026-05-22T13-20-00Z";

    try {
      await writeJson(path.join(repoRoot, ".traceback", "records", "pr-12.json"), record(12));
      await writeJson(path.join(repoRoot, ".traceback", "analysis", "runs", runId, "manifest.json"), {
        runId,
        mode: "provider",
        provider: "openai",
        createdAt: "2026-05-22T13:20:00.000Z",
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
      await writeJson(path.join(repoRoot, ".traceback", "analysis", "runs", runId, "enriched-records.json"), []);
      await writeJson(path.join(repoRoot, ".traceback", "analysis", "runs", runId, "clusters.json"), []);

      const state = await loadUiState(repoRoot, new Date("2026-05-22T13:25:00.000Z"));

      expect(state.runs[0]).toMatchObject({
        runId,
        hasProviderOutput: false,
        enrichedRecords: 0,
        clusters: 0,
      });
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

  test("counts broader-only export artifacts as exports", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "traceback-ui-"));
    const runId = "2026-05-22T14-30-00Z";

    try {
      await writeJson(path.join(repoRoot, ".traceback", "records", "pr-12.json"), record(12));
      await writeJson(path.join(repoRoot, ".traceback", "analysis", "runs", runId, "manifest.json"), {
        runId,
        mode: "provider",
        provider: "openai",
        createdAt: "2026-05-22T14:30:00.000Z",
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
        createdAt: "2026-05-22T14:35:00.000Z",
        sourceDraftRulesPath: "draft-rules.json",
        sourceDraftRulesMarkdownPath: "draft-rules.md",
        outputs: ["broader-learnings.md", "export-summary.md", "manifest.json"],
        exportedRuleCount: 2,
        repoSpecificRuleCount: 0,
        broaderLearningCount: 2,
        warnings: [],
      });
      await writeFile(
        path.join(repoRoot, ".traceback", "exports", runId, "broader-learnings.md"),
        "# Traceback Broader Learnings\n\n## General Engineering\n\n- Keep useful engineering lessons.\n",
      );
      await writeFile(
        path.join(repoRoot, ".traceback", "exports", runId, "export-summary.md"),
        "# Traceback Rule Export Summary\n\n- Rules exported: 2\n",
      );

      const state = await loadUiState(repoRoot, new Date("2026-05-22T14:40:00.000Z"));

      expect(state.summary.exports).toBe(1);
      expect(state.runs[0]).toMatchObject({
        exportedRules: 2,
        hasProposedAgents: false,
      });
      expect(state.runs[0].exportItem).toMatchObject({
        exportedRuleCount: 2,
        repoSpecificRuleCount: 0,
        broaderLearningCount: 2,
        hasBroaderLearnings: true,
      });
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});

describe("UI link safety", () => {
  test.each([
    "javascript:alert(1)", "JaVaScRiPt:alert(1)", "java\nscript:alert(1)",
    "data:text/html,<script>alert(1)</script>", "file:///etc/passwd", "mailto:a@example.com",
    "/api/state", "//example.com", "example.com", "https:example.com", "https://", "",
    'javascript:alert(1)\" onclick=\"alert(2)', null,
  ])("renders an inert escaped label for %j", (href) => {
    const context = uiContext({ href, label: '<img src=x onerror="alert(1)"> & \'label\'' });
    expect(runInContext("link(href, label)", context))
      .toBe("&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &#39;label&#39;");
  });

  test.each(["http://example.com/pr/1", "HTTPS://example.com/pr/1", 'https://example.com/?q="<tag>"&other=\'value\''])(
    "keeps absolute HTTP links and escapes hostile attributes: %s", (href) => {
      const context = uiContext({ href, label: '<b>Source</b> " & \' ' });
      const html = runInContext("link(href, label)", context);
      expect(html).toBe(runInContext(
        '`<a href="${escapeHtml(new URL(href).href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`', context,
      ));
      expect(html).not.toContain("<b>");
      expect(html).toContain("&lt;b&gt;Source&lt;/b&gt; &quot; &amp; &#39;");
    },
  );
});

describe("UI request boundary", () => {
  test.each(["0.0.0.0", "::", "192.168.1.5", "example.com", "127.0.0.2", "localhost.example.com"])(
    "rejects a nonlocal bind before starting a server: %s", async (host) => {
      await expect(runUiServer(os.tmpdir(), { host, port: 0 })).rejects.toThrow("must bind to a loopback host");
    },
  );

  test("allows loopback GET/HEAD requests with same-origin or absent browser headers", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "traceback-ui-"));
    const handler = createUiRequestHandler(repoRoot, 4321);
    try {
      for (const host of ["127.0.0.1:4321", "localhost:4321", "[::1]:4321"]) {
        for (const route of ["/", "/api/state"]) {
          for (const method of ["GET", "HEAD"]) {
            for (const browserHeaders of [{}, { origin: `http://${host}`, "sec-fetch-site": "same-origin" }, { "sec-fetch-site": "none" }]) {
              const response = await handler(new Request(`http://${host}${route}`, {
                method, headers: { host, ...browserHeaders } as Record<string, string>,
              }));
              expect(response.status).toBe(200);
              expectSecurityHeaders(response);
              const body = await response.text();
              if (method === "HEAD") expect(body).toBe("");
              else if (route === "/") expect(body).toContain("Traceback Review UI");
              else expect(JSON.parse(body).schemaVersion).toBe(1);
            }
          }
        }
      }
      const response = await createUiRequestHandler(repoRoot, 80)(new Request("http://localhost/", {
        headers: { host: "localhost:80", origin: "http://localhost" },
      }));
      expect(response.status).toBe(200);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("enforces the handler boundary through Bun's HTTP server", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "traceback-ui-"));
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch: (request, server) => createUiRequestHandler(repoRoot, server.port!)(request),
    });
    try {
      const url = new URL("/api/state", server.url);
      const response = await fetch(url);
      expect(response.status).toBe(200);
      expect((await response.json()).schemaVersion).toBe(1);
      expectSecurityHeaders(response);
      const rejectedHeaders: Record<string, string>[] = [
        { host: "evil.example" }, { origin: "https://evil.example" }, { "sec-fetch-site": "cross-site" },
      ];
      for (const headers of rejectedHeaders) {
        const rejected = await fetch(url, { headers });
        expect(rejected.status).toBe(403);
        expectSecurityHeaders(rejected);
      }
    } finally {
      await server.stop(true);
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test.each([
    {}, { host: "evil.example:4321" }, { host: "localhost.evil.example:4321" },
    { host: "localhost:9999" }, { host: "127.0.0.1:4321" },
    { host: "localhost:4321@evil.example" }, { host: "localhost:4321, evil.example" },
    { host: "localhost:4321", origin: "https://evil.example" },
    { host: "localhost:4321", origin: "http://localhost:9999" },
    { host: "localhost:4321", origin: "http://127.0.0.1:4321" },
    { host: "localhost:4321", origin: "https://localhost:4321" },
    { host: "localhost:4321", origin: "null" },
    { host: "localhost:4321", "sec-fetch-site": "cross-site" },
    { host: "localhost:4321", "sec-fetch-site": "same-site" },
  ])("rejects foreign/malformed request headers before reading artifacts: %j", async (headers) => {
    const handler = createUiRequestHandler(path.join(os.tmpdir(), "unused-traceback-ui"), 4321);
    for (const route of ["/", "/api/state"]) {
      const response = await handler(new Request(`http://localhost:4321${route}`, { headers: headers as HeadersInit }));
      expect(response.status).toBe(403);
      expectSecurityHeaders(response);
      expect(response.headers.has("access-control-allow-origin")).toBe(false);
    }
  });

  test.each(["http://evil.example:4321/", "http://localhost:9999/", "https://localhost:4321/"])(
    "does not trust a local Host when the request URL is foreign: %s", async (url) => {
      const handler = createUiRequestHandler(os.tmpdir(), 4321);
      const response = await handler(new Request(url, { headers: { host: "localhost:4321" } }));
      expect(response.status).toBe(403);
      expectSecurityHeaders(response);
    },
  );

  test.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])("rejects %s on read-only routes", async (method) => {
    const handler = createUiRequestHandler(os.tmpdir(), 4321);
    for (const route of ["/", "/api/state"]) {
      const response = await handler(new Request(`http://localhost:4321${route}`, { method, headers: { host: "localhost:4321" } }));
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("GET, HEAD");
      expectSecurityHeaders(response);
    }
  });

  test("uses security headers and empty HEAD bodies for errors too", async () => {
    const handler = createUiRequestHandler(os.tmpdir(), 4321);
    for (const [route, host, status] of [["/missing", "localhost:4321", 404], ["/api/state", "evil.example", 403]] as const) {
      const response = await handler(new Request(`http://localhost:4321${route}`, { method: "HEAD", headers: { host } }));
      expect(response.status).toBe(status);
      expect(await response.text()).toBe("");
      expectSecurityHeaders(response);
    }
  });
});

describe("UI artifact boundaries", () => {
  const runId = "2026-05-22T12-00-00Z";
  const runPath = `.traceback/analysis/runs/${runId}`;

  test.each(["input", "prompt", "response"])("rejects unsafe files.%s references", async (key) => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "traceback-ui-"));
    const manifestPath = path.join(repoRoot, runPath, "manifest.json");
    try {
      for (const reference of ["../outside.json", "nested/file.json", "/tmp/outside.json", "..\\outside.json", "C:\\outside.json", ".", "..", "", "file\u0000.json", 123]) {
        await writeJson(manifestPath, { runId, files: { [key]: reference } });
        await expect(loadUiState(repoRoot)).rejects.toThrow(`Invalid files.${key} in ${manifestPath}`);
      }
      await writeJson(manifestPath, { files: { [key]: "custom-artifact.v1.json" } });
      await writeJson(path.join(repoRoot, runPath, "custom-artifact.v1.json"), {});
      const run = (await loadUiState(repoRoot)).runs[0];
      expect(key === "input" ? run.hasInput : key === "prompt" ? run.hasPrompt : run.hasProviderOutput).toBe(true);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test.each([`${runPath}/manifest.json`, `.traceback/exports/${runId}/manifest.json`])(
    "checks optional manifest run identity in %s", async (relativePath) => {
      const repoRoot = await mkdtemp(path.join(os.tmpdir(), "traceback-ui-"));
      const filePath = path.join(repoRoot, relativePath);
      try {
        await writeJson(path.join(repoRoot, runPath, "manifest.json"), {});
        for (const manifestRunId of ["2026-05-22T12-00-01Z", "../escape", null, 123]) {
          await writeJson(filePath, { runId: manifestRunId });
          await expect(loadUiState(repoRoot)).rejects.toThrow(`Manifest runId does not match directory ${runId}: ${filePath}`);
        }
        await writeJson(filePath, {});
        expect((await loadUiState(repoRoot)).runs[0].runId).toBe(runId);
      } finally {
        await rm(repoRoot, { recursive: true, force: true });
      }
    },
  );

  test.each(["not-a-run", "2026-05-22T12-00-00Z;command", "2026-05-22T12-00-00Z\n"])(
    "rejects unsafe run directories: %j", async (directory) => {
      const repoRoot = await mkdtemp(path.join(os.tmpdir(), "traceback-ui-"));
      try {
        await mkdir(path.join(repoRoot, ".traceback/analysis/runs", directory), { recursive: true });
        await expect(loadUiState(repoRoot)).rejects.toThrow("Invalid run ID");
      } finally {
        await rm(repoRoot, { recursive: true, force: true });
      }
    },
  );

  test.each([
    ".traceback/records/pr-8.json", ".traceback/records/failures/failure.json",
    `${runPath}/manifest.json`, `${runPath}/enriched-records.json`, `${runPath}/clusters.json`, `${runPath}/summary.json`,
    `.traceback/reviews/${runId}/decisions.json`, `.traceback/rules/${runId}/draft-rules.json`,
    `.traceback/rules/${runId}/rule-decisions.json`, `.traceback/exports/${runId}/manifest.json`,
  ])("reports malformed JSON by filename without contents: %s", async (relativePath) => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "traceback-ui-"));
    const filePath = path.join(repoRoot, relativePath);
    try {
      await writeJson(path.join(repoRoot, runPath, "manifest.json"), { runId });
      await writeJson(filePath, {});
      await writeFile(filePath, '{"secret": "PRIVATE_ARTIFACT_CONTENT", broken');
      await expect(loadUiState(repoRoot)).rejects.toThrow(`Invalid JSON in ${filePath}.`);
      const handler = createUiRequestHandler(repoRoot, 4321);
      for (const method of ["GET", "HEAD"]) {
        const response = await handler(new Request("http://localhost:4321/api/state", { method, headers: { host: "localhost:4321" } }));
        expect(response.status).toBe(500);
        expectSecurityHeaders(response);
        if (method === "HEAD") expect(await response.text()).toBe("");
        else expect(await response.json()).toEqual({ error: `Invalid JSON in ${filePath}.` });
      }
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test.each(["enriched-records.json", "clusters.json"])("keeps partial %s visible without completing analysis", async (artifact) => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "traceback-ui-"));
    try {
      await writeJson(path.join(repoRoot, runPath, "manifest.json"), { runId, mode: "provider", files: { response: "response.json" } });
      await writeJson(path.join(repoRoot, runPath, "response.json"), {});
      await writeJson(path.join(repoRoot, runPath, artifact), [{
        id: "partial-1", title: "Partial output remains inspectable", summary: "summary",
        preventionRule: "rule", confidence: "high", sourcePrs: [8], candidateIds: ["candidate-1"],
      }]);
      const data = await loadUiState(repoRoot);
      const run = data.runs[0];
      expect(run.hasProviderOutput).toBe(true);
      expect(run.hasAnalysisOutput).toBe(false);
      expect(run.enrichedRecords).toBe(artifact === "enriched-records.json" ? 1 : 0);
      expect(run.clusters).toBe(artifact === "clusters.json" ? 1 : 0);
      const context = uiContext({ run, summary: data.summary });
      expect(runInContext("stageCards(summary, run)", context)).not.toContain("traceback review --run");
      if (artifact === "clusters.json") {
        expect(data.clusters[0].title).toBe("Partial output remains inspectable");
        runInContext("renderClusters(run)", context);
        expect(runInContext('document.getElementById("clusters").innerHTML', context)).toContain("Partial output remains inspectable");
      }
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test.each([".traceback/records", ".traceback/records/failures", ".traceback/analysis", ".traceback/analysis/runs"])(
    "does not swallow unexpected directory errors: %s", async (relativePath) => {
      const repoRoot = await mkdtemp(path.join(os.tmpdir(), "traceback-ui-"));
      try {
        await writeJson(path.join(repoRoot, relativePath), {});
        await expect(loadUiState(repoRoot)).rejects.toThrow("ENOTDIR");
      } finally {
        await rm(repoRoot, { recursive: true, force: true });
      }
    },
  );

  test.each(["input.json", "prompt.md", "response.json", "enriched-records.json"])(
    "does not treat directories as artifact files: %s", async (file) => {
      const repoRoot = await mkdtemp(path.join(os.tmpdir(), "traceback-ui-"));
      try {
        await writeJson(path.join(repoRoot, runPath, "manifest.json"), { files: { response: "response.json" } });
        await mkdir(path.join(repoRoot, runPath, file));
        await expect(loadUiState(repoRoot)).rejects.toThrow("Expected a regular file");
      } finally {
        await rm(repoRoot, { recursive: true, force: true });
      }
    },
  );

  test.each([
    ".traceback", ".traceback/records", ".traceback/records/pr-8.json", ".traceback/records/failures",
    ".traceback/records/failures/failure.json", ".traceback/analysis", ".traceback/analysis/runs", runPath,
    `${runPath}/manifest.json`, `${runPath}/enriched-records.json`, `${runPath}/clusters.json`,
    `${runPath}/input.json`, `${runPath}/prompt.md`, `${runPath}/response.json`,
    ".traceback/reviews", `.traceback/reviews/${runId}`, `.traceback/reviews/${runId}/decisions.json`,
    ".traceback/rules", `.traceback/rules/${runId}/draft-rules.json`, `.traceback/rules/${runId}/rule-decisions.json`,
    ".traceback/exports", `.traceback/exports/${runId}`, `.traceback/exports/${runId}/manifest.json`,
    `.traceback/exports/${runId}/AGENTS.proposed.md`, `.traceback/exports/${runId}/broader-learnings.md`,
  ])("rejects direct and parent symlink escapes: %s", async (relativePath) => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "traceback-ui-"));
    const linkPath = path.join(repoRoot, relativePath);
    const outside = path.join(repoRoot, "outside-traceback");
    try {
      await writeJson(path.join(repoRoot, runPath, "manifest.json"), { runId, files: { response: "response.json" } });
      await writeJson(path.join(repoRoot, ".traceback/exports", runId, "manifest.json"), { runId });
      await writeJson(path.join(outside, "secret.json"), { secret: "must not be read" });
      await rm(linkPath, { recursive: true, force: true });
      await mkdir(path.dirname(linkPath), { recursive: true });
      const isFile = /\.(json|md)$/.test(relativePath);
      await symlink(isFile ? path.join(outside, "secret.json") : outside, linkPath, isFile ? "file" : "dir");
      await expect(loadUiState(repoRoot)).rejects.toThrow("UI refuses symbolic links in .traceback");
      await rm(linkPath, { recursive: true, force: true });
      await symlink(path.join(outside, "missing"), linkPath, isFile ? "file" : "dir");
      await expect(loadUiState(repoRoot)).rejects.toThrow("UI refuses symbolic links in .traceback");
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});

function expectSecurityHeaders(response: Response) {
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
}

function uiContext(globals: Record<string, unknown>) {
  const elements = new Map<string, object>();
  const context = createContext({
    URL,
    ...globals,
    fetch: () => new Promise(() => {}),
    document: {
      querySelectorAll: () => [],
      getElementById: (id: string) => {
        if (!elements.has(id)) elements.set(id, {
          innerHTML: "", textContent: "",
          querySelectorAll: () => [],
          querySelector: () => ({ addEventListener() {} }),
        });
        return elements.get(id);
      },
    },
  });
  const script = renderHtml().match(/<script>([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw new Error("Missing UI script");
  runInContext(script, context);
  return context;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function record(prNumber: number): NormalizedPullRequestRecord {
  return {
    schemaVersion: 3,
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
    reviewThreads: [],
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
