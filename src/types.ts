export const NORMALIZED_RECORD_SCHEMA_VERSION = 2;

export type GitHubRepository = {
  owner: string;
  repo: string;
  remoteUrl: string;
};

export type GitHubUser = {
  login?: string | null;
};

export type GitHubLabel = {
  name?: string | null;
};

export type GitHubPullRequest = {
  number: number;
  title: string;
  html_url: string;
  state: string;
  merged?: boolean | null;
  user?: GitHubUser | null;
  created_at?: string | null;
  updated_at?: string | null;
  closed_at?: string | null;
  merged_at?: string | null;
  base?: { ref?: string | null } | null;
  head?: { ref?: string | null } | null;
  body?: string | null;
  labels?: GitHubLabel[] | null;
  commits?: number | null;
  changed_files?: number | null;
  additions?: number | null;
  deletions?: number | null;
};

export type GitHubIssueComment = {
  id: number;
  user?: GitHubUser | null;
  body?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  html_url?: string | null;
};

export type GitHubReviewComment = GitHubIssueComment & {
  path?: string | null;
  line?: number | null;
  original_line?: number | null;
  in_reply_to_id?: number | null;
  commit_id?: string | null;
};

export type GitHubReview = {
  id: number;
  user?: GitHubUser | null;
  body?: string | null;
  state?: string | null;
  submitted_at?: string | null;
  html_url?: string | null;
};

export type RawPullRequestBundle = {
  importedAt: string;
  repository: GitHubRepository;
  pullRequest: GitHubPullRequest;
  issueComments: GitHubIssueComment[];
  reviewComments: GitHubReviewComment[];
  reviews: GitHubReview[];
};

export type NormalizedComment = {
  id: number;
  author: string | null;
  body: string;
  createdAt: string | null;
  updatedAt: string | null;
  url: string | null;
};

export type NormalizedReviewComment = NormalizedComment & {
  path: string | null;
  line: number | null;
  originalLine: number | null;
  inReplyToId: number | null;
  commitId: string | null;
};

export type NormalizedReview = {
  id: number;
  author: string | null;
  body: string;
  state: string | null;
  submittedAt: string | null;
  url: string | null;
};

export type CandidateAgentMarker = {
  source:
    | "author"
    | "body"
    | "issue_comment"
    | "issue_comment_author"
    | "review_comment"
    | "review_comment_author"
    | "review"
    | "review_author";
  marker: string;
  value: string;
};

export type FailureCandidateSourceType = "review_comment" | "issue_comment" | "review" | "pr_body";

export type FailureCandidateCategory =
  | "security_privacy_regression"
  | "environment_config_contract_violation"
  | "preview_output_parity_failure"
  | "query_state_preservation_failure"
  | "stale_persisted_intent"
  | "user_input_loss"
  | "lifecycle_ordering_bug"
  | "render_time_side_effect"
  | "parser_permissiveness"
  | "overbroad_change"
  | "context_omission"
  | "unknown";

export type FailureCandidateSeverity = "low" | "medium" | "high";

export type FailureCandidateConfidence = "low" | "medium" | "high";

export type FailureCandidateStatus =
  | "candidate"
  | "accepted"
  | "rejected"
  | "contested"
  | "resolved"
  | "unknown";

export type FailureCandidate = {
  schemaVersion: 1;
  id: string;
  sourcePrNumber: number;
  sourcePrUrl: string;
  sourceCommentUrl: string | null;
  sourceAuthor: string | null;
  sourceType: FailureCandidateSourceType;
  extractedTitle: string;
  evidenceExcerpt: string;
  candidateCategory: FailureCandidateCategory;
  candidateSeverity: FailureCandidateSeverity | null;
  confidence: FailureCandidateConfidence;
  status: FailureCandidateStatus;
  detectedAgentMarkers: string[];
  createdAt: string | null;
  updatedAt: string | null;
  notes: string[];
};

export type NormalizedPullRequestRecord = {
  schemaVersion: 2;
  importedAt: string;
  repository: GitHubRepository;
  prNumber: number;
  title: string;
  url: string;
  state: string;
  merged: boolean;
  author: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  closedAt: string | null;
  mergedAt: string | null;
  baseBranch: string | null;
  headBranch: string | null;
  body: string;
  labels: string[];
  commitsCount: number | null;
  changedFilesCount: number | null;
  additions: number | null;
  deletions: number | null;
  issueComments: NormalizedComment[];
  reviewComments: NormalizedReviewComment[];
  reviews: NormalizedReview[];
  candidateAgentMarkers: CandidateAgentMarker[];
};
