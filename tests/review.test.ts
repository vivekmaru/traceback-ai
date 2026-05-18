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

  test("conservative policy emits one singleton decision for a multi-candidate unclustered record", async () => {
    const repoRoot = await repoWithAnalysisRun({
      runId: "2026-05-18T11-35-13Z",
      enrichedRecords: [
        enrichedRecord({
          id: "enriched-multi-candidate",
          sourceCandidateIds: [
            "failure-pr-93-review_comment-3248177660",
            "failure-pr-93-review_comment-3248177661",
          ],
          sourcePrs: [93],
          sourceComments: [
            "https://github.com/vivekmaru/EventSnaps/pull/93#discussion_r3248177660",
            "https://github.com/vivekmaru/EventSnaps/pull/93#discussion_r3248177661",
          ],
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
      expect(decisions.decisions).toHaveLength(1);
      expect(decisions.decisions[0]).toMatchObject({
        id: "review-singleton-enriched-multi-candidate",
        sourceEnrichedRecordId: "enriched-multi-candidate",
        sourceCandidateIds: [
          "failure-pr-93-review_comment-3248177660",
          "failure-pr-93-review_comment-3248177661",
        ],
        decision: "needs_cluster",
      });
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("conservative policy emits singleton decisions only for partially unclustered candidate IDs", async () => {
    const repoRoot = await repoWithAnalysisRun({
      runId: "2026-05-18T11-35-13Z",
      enrichedRecords: [
        enrichedRecord({
          id: "enriched-partial-candidate-coverage",
          sourceCandidateIds: [
            "failure-pr-91-review_comment-3241022371",
            "failure-pr-91-review_comment-3241022372",
          ],
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
      const singleton = decisions.decisions.find((decision: any) => decision.itemType === "singleton");

      expect(decisions.decisions).toHaveLength(2);
      expect(singleton).toMatchObject({
        id: "review-singleton-enriched-partial-candidate-coverage",
        sourceCandidateIds: ["failure-pr-91-review_comment-3241022372"],
        decision: "needs_cluster",
      });
      expect(singleton.sourceCandidateIds).not.toContain("failure-pr-91-review_comment-3241022371");
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("conservative policy flags duplicate cluster IDs without duplicating review decision IDs", async () => {
    const repoRoot = await repoWithAnalysisRun({
      runId: "2026-05-18T11-35-13Z",
      enrichedRecords: [
        enrichedRecord({
          id: "failure-pr-91-review_comment-3241022371",
          sourceCandidateIds: ["failure-pr-91-review_comment-3241022371"],
        }),
        enrichedRecord({
          id: "failure-pr-92-review_comment-3241022372",
          sourceCandidateIds: ["failure-pr-92-review_comment-3241022372"],
          sourcePrs: [92],
        }),
      ],
      clusters: [
        cluster({
          id: "duplicate-cluster",
          candidateIds: ["failure-pr-91-review_comment-3241022371"],
        }),
        cluster({
          id: "duplicate-cluster",
          candidateIds: ["failure-pr-92-review_comment-3241022372"],
          sourcePrs: [92],
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
      const decisionIds = decisions.decisions.map((decision: any) => decision.id);
      const duplicateWarning = decisions.decisions.find((decision: any) =>
        decision.id === "review-warning-duplicate-cluster-id-duplicate-cluster"
      );

      expect(new Set(decisionIds).size).toBe(decisionIds.length);
      expect(decisionIds).toContain("review-cluster-duplicate-cluster-1");
      expect(decisionIds).toContain("review-cluster-duplicate-cluster-2");
      expect(duplicateWarning).toMatchObject({
        itemType: "warning",
        sourceClusterId: "duplicate-cluster",
        decision: "needs_review",
        reason: expect.stringContaining("Duplicate cluster ID"),
      });
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("conservative policy preserves colliding enriched record IDs with disambiguated decisions", async () => {
    const repoRoot = await repoWithAnalysisRun({
      runId: "2026-05-18T11-35-13Z",
      enrichedRecords: [
        enrichedRecord({
          id: "duplicate-enriched-record",
          sourceCandidateIds: ["failure-pr-91-review_comment-3241022371"],
          title: "First duplicate record",
        }),
        enrichedRecord({
          id: "duplicate-enriched-record",
          sourceCandidateIds: ["failure-pr-92-review_comment-3241022372"],
          sourcePrs: [92],
          title: "Second duplicate record",
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
      const singletonIds = decisions.decisions
        .filter((decision: any) => decision.itemType === "singleton")
        .map((decision: any) => decision.id);
      const duplicateWarning = decisions.decisions.find((decision: any) =>
        decision.id === "review-warning-duplicate-enriched-record-id-duplicate-enriched-record"
      );

      expect(singletonIds).toEqual([
        "review-singleton-duplicate-enriched-record-1",
        "review-singleton-duplicate-enriched-record-2",
      ]);
      expect(duplicateWarning).toMatchObject({
        itemType: "warning",
        sourceEnrichedRecordId: "duplicate-enriched-record",
        sourceCandidateIds: [
          "failure-pr-91-review_comment-3241022371",
          "failure-pr-92-review_comment-3241022372",
        ],
        decision: "needs_review",
        reason: expect.stringContaining("Duplicate enriched record ID"),
      });
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("conservative policy flags candidate IDs reused across enriched records", async () => {
    const repoRoot = await repoWithAnalysisRun({
      runId: "2026-05-18T11-35-13Z",
      enrichedRecords: [
        enrichedRecord({
          id: "first-owner",
          sourceCandidateIds: ["failure-pr-91-review_comment-3241022371"],
          sourceComments: ["https://github.com/vivekmaru/EventSnaps/pull/91#discussion_r3241022371"],
        }),
        enrichedRecord({
          id: "second-owner",
          sourceCandidateIds: ["failure-pr-91-review_comment-3241022371"],
          sourceComments: ["https://github.com/vivekmaru/EventSnaps/pull/91#discussion_r3241022372"],
        }),
      ],
      clusters: [
        cluster({
          id: "cluster-template-intent-preservation-91",
          candidateIds: ["failure-pr-91-review_comment-3241022371"],
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
      const clusterDecision = decisions.decisions.find((decision: any) => decision.itemType === "cluster");

      expect(clusterDecision).toMatchObject({
        decision: "needs_review",
        reason: expect.stringContaining("multiple enriched records"),
        sourceComments: [
          "https://github.com/vivekmaru/EventSnaps/pull/91#discussion_r3241022371",
          "https://github.com/vivekmaru/EventSnaps/pull/91#discussion_r3241022372",
        ],
      });
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("conservative policy preserves enriched records with no source candidate IDs", async () => {
    const repoRoot = await repoWithAnalysisRun({
      runId: "2026-05-18T11-35-13Z",
      enrichedRecords: [
        enrichedRecord({
          id: "enriched-without-candidates",
          sourceCandidateIds: [],
          sourcePrs: [93],
          sourceComments: [],
          confidence: "high",
          title: "Record without source candidates",
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
      expect(decisions.decisions).toHaveLength(1);
      expect(decisions.decisions[0]).toMatchObject({
        itemType: "enriched_record",
        sourceEnrichedRecordId: "enriched-without-candidates",
        sourceCandidateIds: [],
        decision: "needs_review",
        reason: expect.stringContaining("does not reference any source candidates"),
      });
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("rejects run IDs that would escape the reviews directory", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "traceback-review-"));

    try {
      await expect(
        runReview(repoRoot, {
          runId: "../../pwn",
          policy: "conservative",
          now: new Date("2026-05-18T12:00:00Z"),
        }),
      ).rejects.toThrow("Invalid run ID");
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
