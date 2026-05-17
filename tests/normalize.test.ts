import { describe, expect, test } from "bun:test";
import { normalizePullRequestRecord } from "../src/normalize";
import type { RawPullRequestBundle } from "../src/types";

const rawBundle: RawPullRequestBundle = {
  importedAt: "2026-05-16T12:00:00.000Z",
  repository: {
    owner: "vivekmaru",
    repo: "EventSnaps",
    remoteUrl: "git@github.com:vivekmaru/EventSnaps.git",
  },
  pullRequest: {
    number: 91,
    title: "feat: add native QR template system",
    html_url: "https://github.com/vivekmaru/EventSnaps/pull/91",
    state: "closed",
    merged: true,
    user: { login: "codex-agent" },
    created_at: "2026-05-01T01:00:00Z",
    updated_at: "2026-05-02T01:00:00Z",
    closed_at: "2026-05-03T01:00:00Z",
    merged_at: "2026-05-03T01:00:00Z",
    base: { ref: "develop" },
    head: { ref: "template-system" },
    body: "Implemented with Codex assistance.",
    labels: [{ name: "feature" }, { name: "templates" }],
    commits: 7,
    changed_files: 12,
    additions: 240,
    deletions: 32,
  },
  issueComments: [
    {
      id: 1001,
      user: { login: "reviewer" },
      body: "Codex may have missed the auth redirect query string.",
      created_at: "2026-05-02T02:00:00Z",
      updated_at: "2026-05-02T02:10:00Z",
      html_url: "https://github.com/vivekmaru/EventSnaps/pull/91#issuecomment-1001",
    },
  ],
  reviewComments: [
    {
      id: 2001,
      user: { login: "github-actions[bot]" },
      body: "This path can drop the template query param.",
      path: "src/auth.ts",
      line: 42,
      original_line: 39,
      in_reply_to_id: 1999,
      commit_id: "abc123",
      created_at: "2026-05-02T03:00:00Z",
      updated_at: "2026-05-02T03:05:00Z",
      html_url: "https://github.com/vivekmaru/EventSnaps/pull/91#discussion_r2001",
    },
  ],
  reviews: [
    {
      id: 3001,
      user: { login: "copilot-pull-request-reviewer[bot]" },
      body: "Review completed.",
      state: "COMMENTED",
      submitted_at: "2026-05-02T04:00:00Z",
      html_url: "https://github.com/vivekmaru/EventSnaps/pull/91#pullrequestreview-3001",
    },
  ],
};

describe("normalizePullRequestRecord", () => {
  test("maps raw GitHub pull request data into a stable local record", () => {
    const record = normalizePullRequestRecord(rawBundle);

    expect(record).toMatchObject({
      prNumber: 91,
      title: "feat: add native QR template system",
      url: "https://github.com/vivekmaru/EventSnaps/pull/91",
      state: "closed",
      merged: true,
      author: "codex-agent",
      createdAt: "2026-05-01T01:00:00Z",
      updatedAt: "2026-05-02T01:00:00Z",
      closedAt: "2026-05-03T01:00:00Z",
      mergedAt: "2026-05-03T01:00:00Z",
      baseBranch: "develop",
      headBranch: "template-system",
      labels: ["feature", "templates"],
      commitsCount: 7,
      changedFilesCount: 12,
      additions: 240,
      deletions: 32,
    });
  });

  test("preserves comments, reviews, and review comments", () => {
    const record = normalizePullRequestRecord(rawBundle);

    expect(record.issueComments).toEqual([
      {
        id: 1001,
        author: "reviewer",
        body: "Codex may have missed the auth redirect query string.",
        createdAt: "2026-05-02T02:00:00Z",
        updatedAt: "2026-05-02T02:10:00Z",
        url: "https://github.com/vivekmaru/EventSnaps/pull/91#issuecomment-1001",
      },
    ]);
    expect(record.reviewComments[0]).toMatchObject({
      id: 2001,
      author: "github-actions[bot]",
      path: "src/auth.ts",
      line: 42,
      inReplyToId: 1999,
    });
    expect(record.reviews[0]).toMatchObject({
      id: 3001,
      author: "copilot-pull-request-reviewer[bot]",
      state: "COMMENTED",
    });
  });

  test("extracts candidate AI and agent markers without classifying failures", () => {
    const record = normalizePullRequestRecord(rawBundle);

    expect(record.candidateAgentMarkers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "author", marker: "codex" }),
        expect.objectContaining({ source: "body", marker: "codex" }),
        expect.objectContaining({ source: "issue_comment", marker: "codex" }),
        expect.objectContaining({ source: "review_author", marker: "copilot" }),
        expect.objectContaining({ source: "review_comment_author", marker: "bot" }),
      ]),
    );
  });
});
