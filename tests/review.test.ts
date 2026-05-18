import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runReview } from "../src/review";
import type { EnrichedFailureRecord, FailureCluster } from "../src/analyze";

describe("runReview", () => {
  test("conservative policy accepts high-confidence review-comment-backed clusters", async () => {
    const repoRoot = await repoWithAnalysisRun({
      runId: "2026-05-18T11-35-13Z",
      enrichedRecords: [
        enrichedRecord({
          id: "failure-pr-91-review_comment-3241022371",
          sourceCandidateIds: ["failure-pr-91-review_comment-3241022371"],
          sourcePrs: [91],
          sourceComments: ["https://github.com/vivekmaru/EventSnaps/pull/91#discussion_r3241022371"],
          confidence: "high",
        }),
      ],
      clusters: [
        cluster({
          id: "cluster-template-intent-preservation-91",
          candidateIds: ["failure-pr-91-review_comment-3241022371"],
          sourcePrs: [91],
          confidence: "high",
        }),
      ],
    });

    try {
      const result = await runReview(repoRoot, {
        runId: "2026-05-18T11-35-13Z",
        policy: "conservative",
        now: new Date("2026-05-18T12:00:00Z"),
      });

      const decisions = await readJson(path.join(result.reviewDir, "decisions.json"));
      const summary = await readFile(path.join(result.reviewDir, "review-summary.md"), "utf8");

      expect(decisions.decisions).toHaveLength(1);
      expect(decisions.decisions[0]).toMatchObject({
        itemType: "cluster",
        sourceClusterId: "cluster-template-intent-preservation-91",
        sourceCandidateIds: ["failure-pr-91-review_comment-3241022371"],
        sourcePrs: [91],
        sourceComments: ["https://github.com/vivekmaru/EventSnaps/pull/91#discussion_r3241022371"],
        confidence: "high",
        decision: "accepted",
        editedTitle: null,
        editedPreventionRule: null,
        reviewedAt: "2026-05-18T12:00:00.000Z",
      });
      expect(summary).toContain("## Accepted Clusters");
      expect(summary).toContain("cluster-template-intent-preservation-91");
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("conservative policy marks low-confidence PR-body-only clusters as needs_validation", async () => {
    const repoRoot = await repoWithAnalysisRun({
      runId: "2026-05-18T11-35-13Z",
      enrichedRecords: [
        enrichedRecord({
          id: "failure-pr-83-pr_body-83",
          sourceCandidateIds: ["failure-pr-83-pr_body-83"],
          sourcePrs: [83],
          sourceComments: [],
          confidence: "low",
        }),
      ],
      clusters: [
        cluster({
          id: "cluster-insecure-randomness-83",
          candidateIds: ["failure-pr-83-pr_body-83"],
          sourcePrs: [83],
          confidence: "low",
        }),
      ],
    });

    try {
      const result = await runReview(repoRoot, {
        runId: "2026-05-18T11-35-13Z",
        policy: "conservative",
        now: new Date("2026-05-18T12:00:00Z"),
      });

      const decisions = await readJson(path.join(result.reviewDir, "decisions.json"));
      expect(decisions.decisions[0]).toMatchObject({
        itemType: "cluster",
        sourceClusterId: "cluster-insecure-randomness-83",
        decision: "needs_validation",
        reason: expect.stringContaining("Low-confidence PR-body-only"),
      });
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("conservative policy preserves unclustered enriched records as needs_cluster decisions", async () => {
    const repoRoot = await repoWithAnalysisRun({
      runId: "2026-05-18T11-35-13Z",
      enrichedRecords: [
        enrichedRecord({
          id: "failure-pr-93-review_comment-3248177660",
          sourceCandidateIds: ["failure-pr-93-review_comment-3248177660"],
          sourcePrs: [93],
          sourceComments: ["https://github.com/vivekmaru/EventSnaps/pull/93#discussion_r3248177660"],
          confidence: "high",
          title: "Restore environment-aware pricing source URL",
        }),
      ],
      clusters: [],
    });

    try {
      const result = await runReview(repoRoot, {
        runId: "2026-05-18T11-35-13Z",
        policy: "conservative",
        now: new Date("2026-05-18T12:00:00Z"),
      });

      const decisions = await readJson(path.join(result.reviewDir, "decisions.json"));
      const summary = await readFile(path.join(result.reviewDir, "review-summary.md"), "utf8");

      expect(decisions.decisions[0]).toMatchObject({
        itemType: "singleton",
        sourceEnrichedRecordId: "failure-pr-93-review_comment-3248177660",
        sourceCandidateIds: ["failure-pr-93-review_comment-3248177660"],
        decision: "needs_cluster",
        reason: expect.stringContaining("not represented in any cluster"),
      });
      expect(summary).toContain("## Needs Cluster Items");
      expect(summary).toContain("failure-pr-93-review_comment-3248177660");
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});

async function repoWithAnalysisRun({
  runId,
  enrichedRecords,
  clusters,
}: {
  runId: string;
  enrichedRecords: EnrichedFailureRecord[];
  clusters: FailureCluster[];
}): Promise<string> {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "traceback-review-"));
  const runDir = path.join(repoRoot, ".traceback", "analysis", "runs", runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(
    path.join(runDir, "manifest.json"),
    `${JSON.stringify(
      {
        runId,
        mode: "provider",
        provider: "openai",
        createdAt: "2026-05-18T11:35:13.499Z",
        source: { failureCandidateCount: enrichedRecords.length, recordsHash: "sha256-test" },
        files: {
          input: "input.json",
          prompt: "prompt.md",
          response: "response.json",
          enrichedRecords: "enriched-records.json",
          clusters: "clusters.json",
          summary: "analysis-summary.md",
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(path.join(runDir, "enriched-records.json"), `${JSON.stringify(enrichedRecords, null, 2)}\n`, "utf8");
  await writeFile(path.join(runDir, "clusters.json"), `${JSON.stringify(clusters, null, 2)}\n`, "utf8");
  return repoRoot;
}

function enrichedRecord(overrides: Partial<EnrichedFailureRecord>): EnrichedFailureRecord {
  return {
    id: "failure-pr-91-review_comment-3241022371",
    sourceCandidateIds: ["failure-pr-91-review_comment-3241022371"],
    title: "Preserve query string when resuming protected redirects",
    failureType: "query_state_preservation_failure",
    summary: "Protected redirects drop query state.",
    whatTheAgentMissed: "The agent missed full-location restoration.",
    evidenceSummary: "The saved location search was dropped.",
    likelyFixOrCorrection: "Restore pathname and search.",
    preventionRule: "Persist and restore pathname, search, and hash.",
    confidence: "high",
    sourcePrs: [91],
    sourceComments: ["https://github.com/vivekmaru/EventSnaps/pull/91#discussion_r3241022371"],
    notes: [],
    ...overrides,
  };
}

function cluster(overrides: Partial<FailureCluster>): FailureCluster {
  return {
    id: "cluster-template-intent-preservation-91",
    title: "Template intent and protected-URL state preservation",
    summary: "Template intent is lost across protected redirects.",
    candidateIds: ["failure-pr-91-review_comment-3241022371"],
    failureTypes: ["query_state_preservation_failure"],
    sourcePrs: [91],
    evidenceSummary: "Query params are dropped.",
    whatTheAgentMissed: "The agent missed redirect lifecycle contracts.",
    preventionRule: "Persist and restore full locations.",
    confidence: "high",
    ...overrides,
  };
}

async function readJson(filePath: string): Promise<any> {
  return JSON.parse(await readFile(filePath, "utf8"));
}
