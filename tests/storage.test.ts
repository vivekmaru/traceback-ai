import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getTracebackPaths, writeFailureCandidates } from "../src/storage";
import type { FailureCandidate } from "../src/types";

describe("getTracebackPaths", () => {
  test("uses .traceback as the local data directory", () => {
    expect(getTracebackPaths("/tmp/example-repo")).toEqual({
      root: "/tmp/example-repo",
      dir: "/tmp/example-repo/.traceback",
      imports: "/tmp/example-repo/.traceback/imports",
      records: "/tmp/example-repo/.traceback/records",
      failures: "/tmp/example-repo/.traceback/records/failures",
      reports: "/tmp/example-repo/.traceback/reports",
    });
  });

  test("refreshes failure candidates instead of preserving stale files", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "traceback-storage-"));
    const stalePath = path.join(repoRoot, ".traceback", "records", "failures", "stale.json");

    try {
      await writeFile(stalePath, "{}\n", "utf8").catch(async () => {
        await writeFailureCandidates(repoRoot, []);
        await writeFile(stalePath, "{}\n", "utf8");
      });

      await writeFailureCandidates(repoRoot, [candidate("failure-pr-12-review_comment-99")]);

      expect(await readdir(path.dirname(stalePath))).toEqual([
        "failure-pr-12-review_comment-99.json",
      ]);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});

function candidate(id: string): FailureCandidate {
  return {
    schemaVersion: 1,
    id,
    sourcePrNumber: 12,
    sourcePrUrl: "https://github.com/acme/widgets/pull/12",
    sourceCommentUrl: "https://github.com/acme/widgets/pull/12#discussion_r99",
    sourceAuthor: "codex",
    sourceType: "review_comment",
    extractedTitle: "Query params are dropped",
    evidenceExcerpt: "Query params are dropped during redirect.",
    candidateCategory: "query_state_preservation_failure",
    candidateSeverity: "medium",
    confidence: "high",
    status: "candidate",
    detectedAgentMarkers: ["codex"],
    createdAt: "2026-05-17T00:00:00Z",
    updatedAt: "2026-05-17T00:00:00Z",
    notes: ["test"],
  };
}
