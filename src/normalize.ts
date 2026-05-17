import type {
  CandidateAgentMarker,
  GitHubIssueComment,
  GitHubReview,
  GitHubReviewComment,
  NormalizedComment,
  NormalizedPullRequestRecord,
  NormalizedReview,
  NormalizedReviewComment,
  RawPullRequestBundle,
} from "./types";

const MARKER_PATTERNS: Array<[marker: string, pattern: RegExp]> = [
  ["codex", /\bcodex\b/i],
  ["claude", /\bclaude\b/i],
  ["cursor", /\bcursor\b/i],
  ["copilot", /\bcopilot\b/i],
  ["agent", /\bagent\b/i],
  ["ai", /\bai\b/i],
  ["bot", /\bbot\b|\[bot\]/i],
];

export function normalizePullRequestRecord(
  bundle: RawPullRequestBundle,
): NormalizedPullRequestRecord {
  const pr = bundle.pullRequest;
  const issueComments = bundle.issueComments.map(normalizeIssueComment);
  const reviewComments = bundle.reviewComments.map(normalizeReviewComment);
  const reviews = bundle.reviews.map(normalizeReview);

  return {
    schemaVersion: 1,
    importedAt: bundle.importedAt,
    repository: bundle.repository,
    prNumber: pr.number,
    title: pr.title,
    url: pr.html_url,
    state: pr.state,
    merged: Boolean(pr.merged ?? pr.merged_at),
    author: pr.user?.login ?? null,
    createdAt: pr.created_at ?? null,
    updatedAt: pr.updated_at ?? null,
    closedAt: pr.closed_at ?? null,
    mergedAt: pr.merged_at ?? null,
    baseBranch: pr.base?.ref ?? null,
    headBranch: pr.head?.ref ?? null,
    body: pr.body ?? "",
    labels: (pr.labels ?? []).map((label) => label.name).filter(isPresent),
    commitsCount: pr.commits ?? null,
    changedFilesCount: pr.changed_files ?? null,
    additions: pr.additions ?? null,
    deletions: pr.deletions ?? null,
    issueComments,
    reviewComments,
    reviews,
    candidateAgentMarkers: collectCandidateMarkers(bundle),
  };
}

function normalizeIssueComment(comment: GitHubIssueComment): NormalizedComment {
  return {
    id: comment.id,
    author: comment.user?.login ?? null,
    body: comment.body ?? "",
    createdAt: comment.created_at ?? null,
    updatedAt: comment.updated_at ?? null,
    url: comment.html_url ?? null,
  };
}

function normalizeReviewComment(comment: GitHubReviewComment): NormalizedReviewComment {
  return {
    ...normalizeIssueComment(comment),
    path: comment.path ?? null,
    line: comment.line ?? null,
    originalLine: comment.original_line ?? null,
    inReplyToId: comment.in_reply_to_id ?? null,
    commitId: comment.commit_id ?? null,
  };
}

function normalizeReview(review: GitHubReview): NormalizedReview {
  return {
    id: review.id,
    author: review.user?.login ?? null,
    body: review.body ?? "",
    state: review.state ?? null,
    submittedAt: review.submitted_at ?? null,
    url: review.html_url ?? null,
  };
}

function collectCandidateMarkers(bundle: RawPullRequestBundle): CandidateAgentMarker[] {
  const markers: CandidateAgentMarker[] = [];
  const pr = bundle.pullRequest;

  addMarkers(markers, "author", pr.user?.login ?? "");
  addMarkers(markers, "body", pr.body ?? "");

  for (const comment of bundle.issueComments) {
    addMarkers(markers, "issue_comment_author", comment.user?.login ?? "");
    addMarkers(markers, "issue_comment", comment.body ?? "");
  }

  for (const comment of bundle.reviewComments) {
    addMarkers(markers, "review_comment_author", comment.user?.login ?? "");
    addMarkers(markers, "review_comment", comment.body ?? "");
  }

  for (const review of bundle.reviews) {
    addMarkers(markers, "review_author", review.user?.login ?? "");
    addMarkers(markers, "review", review.body ?? "");
  }

  return dedupeMarkers(markers);
}

function addMarkers(
  markers: CandidateAgentMarker[],
  source: CandidateAgentMarker["source"],
  value: string,
): void {
  if (!value) {
    return;
  }

  for (const [marker, pattern] of MARKER_PATTERNS) {
    if (pattern.test(value)) {
      markers.push({ source, marker, value });
    }
  }
}

function dedupeMarkers(markers: CandidateAgentMarker[]): CandidateAgentMarker[] {
  const seen = new Set<string>();
  return markers.filter((marker) => {
    const key = `${marker.source}:${marker.marker}:${marker.value}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function isPresent(value: string | null | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}
