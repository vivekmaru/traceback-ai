import { describe, expect, test } from "bun:test";
import { generateFailureCandidatesReport } from "../src/report";
import type { FailureCandidate } from "../src/types";

describe("generateFailureCandidatesReport", () => {
  test("groups low-confidence PR body candidates as potential noise", () => {
    const report = generateFailureCandidatesReport([
      candidate({
        id: "failure-pr-10-pr_body-10",
        sourceType: "pr_body",
        confidence: "low",
        extractedTitle: "Root cause N+1 query pattern",
      }),
      candidate({
        id: "failure-pr-10-review_comment-99",
        sourceType: "review_comment",
        confidence: "high",
        extractedTitle: "Renderer omits event name",
      }),
    ]);

    expect(report).toContain("## Potential Noise");
    expect(report).toContain("Root cause N+1 query pattern");
    expect(report).not.toContain("- Renderer omits event name ([#10]");
  });
});

function candidate(overrides: Partial<FailureCandidate>): FailureCandidate {
  return {
    schemaVersion: 1,
    id: "failure-pr-10-review_comment-99",
    sourcePrNumber: 10,
    sourcePrUrl: "https://github.com/acme/widgets/pull/10",
    sourceCommentUrl: "https://github.com/acme/widgets/pull/10#discussion_r99",
    sourceAuthor: "codex",
    sourceType: "review_comment",
    extractedTitle: "Renderer omits event name",
    evidenceExcerpt: "Renderer omits event name.",
    candidateCategory: "preview_output_parity_failure",
    candidateSeverity: null,
    confidence: "high",
    status: "candidate",
    detectedAgentMarkers: ["codex"],
    createdAt: "2026-05-17T00:00:00Z",
    updatedAt: "2026-05-17T00:00:00Z",
    notes: ["test"],
    ...overrides,
  };
}
