import { describe, expect, test } from "bun:test";
import {
  detectAgentMarkers,
  detectCategory,
  detectSeverity,
  detectStatus,
  extractFailureCandidates,
} from "../src/extract";
import type { NormalizedPullRequestRecord } from "../src/types";

const baseRecord: NormalizedPullRequestRecord = {
  schemaVersion: 1,
  importedAt: "2026-05-17T00:00:00.000Z",
  repository: {
    owner: "vivekmaru",
    repo: "EventSnaps",
    remoteUrl: "git@github.com:vivekmaru/EventSnaps.git",
  },
  prNumber: 91,
  title: "feat: add native QR template system",
  url: "https://github.com/vivekmaru/EventSnaps/pull/91",
  state: "closed",
  merged: true,
  author: "chatgpt-codex-connector[bot]",
  createdAt: "2026-05-01T01:00:00Z",
  updatedAt: "2026-05-02T01:00:00Z",
  closedAt: "2026-05-03T01:00:00Z",
  mergedAt: "2026-05-03T01:00:00Z",
  baseBranch: "develop",
  headBranch: "template-system",
  body: "",
  labels: [],
  commitsCount: 4,
  changedFilesCount: 8,
  additions: 120,
  deletions: 12,
  issueComments: [
    {
      id: 1001,
      author: "vivek",
      body: "Good catch, fixed in the follow-up commit.",
      createdAt: "2026-05-02T03:10:00Z",
      updatedAt: "2026-05-02T03:10:00Z",
      url: "https://github.com/vivekmaru/EventSnaps/pull/91#issuecomment-1001",
    },
  ],
  reviewComments: [
    {
      id: 2001,
      author: "chatgpt-codex-connector[bot]",
      body: "[P1] This breaks protected redirects because pathname is preserved but the query/search params are dropped.",
      createdAt: "2026-05-02T03:00:00Z",
      updatedAt: "2026-05-02T03:05:00Z",
      url: "https://github.com/vivekmaru/EventSnaps/pull/91#discussion_r2001",
      path: "src/auth.ts",
      line: 42,
      originalLine: 39,
      inReplyToId: null,
      commitId: "abc123",
    },
  ],
  reviews: [],
  candidateAgentMarkers: [],
};

describe("extractFailureCandidates", () => {
  test("creates a stable failure candidate schema from a review comment", () => {
    const [candidate] = extractFailureCandidates([baseRecord]);

    expect(candidate).toMatchObject({
      id: "failure-pr-91-review_comment-2001",
      sourcePrNumber: 91,
      sourcePrUrl: "https://github.com/vivekmaru/EventSnaps/pull/91",
      sourceCommentUrl: "https://github.com/vivekmaru/EventSnaps/pull/91#discussion_r2001",
      sourceAuthor: "chatgpt-codex-connector[bot]",
      sourceType: "review_comment",
      candidateCategory: "query_state_preservation_failure",
      candidateSeverity: "high",
      confidence: "high",
      status: "candidate",
      detectedAgentMarkers: ["chatgpt-codex-connector", "codex", "bot"],
      createdAt: "2026-05-02T03:00:00Z",
      updatedAt: "2026-05-02T03:05:00Z",
    });
    expect(candidate.extractedTitle).toContain("breaks protected redirects");
    expect(candidate.evidenceExcerpt).toContain("query/search params are dropped");
    expect(candidate.notes).toContain("Extracted deterministically from review_comment keyword matches.");
  });

  test("extracts from PR body conservatively with lower confidence", () => {
    const record = {
      ...baseRecord,
      body: "Root cause: Buffer.from(mac, \"hex\") accepted trailing malformed token data.",
      issueComments: [],
      reviewComments: [],
      reviews: [],
    };

    const [candidate] = extractFailureCandidates([record]);

    expect(candidate).toMatchObject({
      id: "failure-pr-91-pr_body-91",
      sourceType: "pr_body",
      candidateCategory: "parser_permissiveness",
      confidence: "low",
      status: "candidate",
    });
  });

  test("cleans GitHub badge markdown from extracted titles", () => {
    const record = {
      ...baseRecord,
      issueComments: [],
      reviewComments: [
        {
          ...baseRecord.reviewComments[0],
          body: "**<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub> Missing query state in redirect**\n\nThis silently drops search params.",
        },
      ],
      reviews: [],
    };

    const [candidate] = extractFailureCandidates([record]);

    expect(candidate.extractedTitle).toBe("Missing query state in redirect");
  });

  test("does not infer status from unrelated PR comments", () => {
    const [candidate] = extractFailureCandidates([baseRecord]);

    expect(candidate.status).toBe("candidate");
  });

  test("infers status from review comment replies in the same thread", () => {
    const record = {
      ...baseRecord,
      issueComments: [],
      reviewComments: [
        baseRecord.reviewComments[0],
        {
          ...baseRecord.reviewComments[0],
          id: 2002,
          body: "Good catch, fixed in the follow-up commit.",
          inReplyToId: 2001,
        },
      ],
      reviews: [],
    };

    const [candidate] = extractFailureCandidates([record]);

    expect(candidate.id).toBe("failure-pr-91-review_comment-2001");
    expect(candidate.status).toBe("resolved");
  });

  test("does not extract review comment replies as standalone candidates", () => {
    const record = {
      ...baseRecord,
      issueComments: [],
      reviewComments: [
        {
          ...baseRecord.reviewComments[0],
          id: 2002,
          body: "Good catch, fixed in the follow-up commit.",
          inReplyToId: 2001,
        },
      ],
      reviews: [],
    };

    expect(extractFailureCandidates([record])).toEqual([]);
  });

  test("does not use review comment replies to classify non-review-comment sources", () => {
    const record = {
      ...baseRecord,
      body: "Root cause: Buffer.from(mac, \"hex\") accepted trailing malformed token data.",
      issueComments: [],
      reviewComments: [
        {
          ...baseRecord.reviewComments[0],
          id: 2002,
          body: "Good catch, fixed in the follow-up commit.",
          inReplyToId: 91,
        },
      ],
      reviews: [],
    };

    const [candidate] = extractFailureCandidates([record]);

    expect(candidate.sourceType).toBe("pr_body");
    expect(candidate.status).toBe("candidate");
  });

  test("does not extract neutral domain comments without a failure cue", () => {
    const record = {
      ...baseRecord,
      issueComments: [],
      reviewComments: [
        {
          ...baseRecord.reviewComments[0],
          body: "The search params are passed through the redirect helper.",
        },
      ],
      reviews: [],
    };

    expect(extractFailureCandidates([record])).toEqual([]);
  });
});

describe("deterministic extraction helpers", () => {
  test("detects AI and agent markers from authors and text", () => {
    expect(
      detectAgentMarkers("Generated with Claude Code\nCo-Authored-By: Claude", "Jules[bot]"),
    ).toEqual(["Claude Code", "Generated with Claude Code", "Co-Authored-By: Claude", "Jules", "bot"]);
  });

  test("maps priority badges and text to rough severity", () => {
    expect(detectSeverity("[P0] critical token leak")).toBe("high");
    expect(detectSeverity("MEDIUM risk regression")).toBe("medium");
    expect(detectSeverity("[P3] low polish issue")).toBe("low");
    expect(detectSeverity("Missing query state")).toBeNull();
  });

  test("detects status heuristics from source and nearby replies", () => {
    expect(detectStatus("I think this is unsafe. Thoughts?", [])).toBe("contested");
    expect(detectStatus("This is unsafe", ["I disagree, this is not an issue."])).toBe("rejected");
    expect(detectStatus("This is unsafe", ["Good catch, addressed in abc123."])).toBe("resolved");
    expect(detectStatus("This is unsafe", ["Not fixed yet."])).toBe("candidate");
    expect(detectStatus("This is unsafe", ["This is not resolved."])).toBe("candidate");
  });

  test("maps representative keyword categories", () => {
    expect(detectCategory("Authorization cookie headers leak to third-party proxy")).toBe(
      "security_privacy_regression",
    );
    expect(detectCategory("APP_URL was replaced with a hardcoded production domain")).toBe(
      "environment_config_contract_violation",
    );
    expect(detectCategory("Downloaded PNG output omits fields shown in the preview renderer")).toBe(
      "preview_output_parity_failure",
    );
    expect(detectCategory("Template text is overwritten after React Query refetch while editing")).toBe(
      "user_input_loss",
    );
  });
});
