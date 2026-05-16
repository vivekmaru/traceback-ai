import type {
  GitHubIssueComment,
  GitHubPullRequest,
  GitHubRepository,
  GitHubReview,
  GitHubReviewComment,
  RawPullRequestBundle,
} from "./types";

const API_ROOT = "https://api.github.com";

export type ImportOptions = {
  prs: number;
  repository: GitHubRepository;
};

export class GitHubApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

export async function importRecentPullRequests(
  options: ImportOptions,
): Promise<RawPullRequestBundle[]> {
  const prs = clampPerPage(options.prs);
  const list = await requestJson<GitHubPullRequest[]>(
    `/repos/${options.repository.owner}/${options.repository.repo}/pulls?state=all&sort=updated&direction=desc&per_page=${prs}`,
  );

  const importedAt = new Date().toISOString();
  const bundles: RawPullRequestBundle[] = [];

  for (const item of list.slice(0, prs)) {
    const number = item.number;
    const [pullRequest, issueComments, reviewComments, reviews] = await Promise.all([
      requestJson<GitHubPullRequest>(
        `/repos/${options.repository.owner}/${options.repository.repo}/pulls/${number}`,
      ),
      requestAllPages<GitHubIssueComment>(
        `/repos/${options.repository.owner}/${options.repository.repo}/issues/${number}/comments?per_page=100`,
      ),
      requestAllPages<GitHubReviewComment>(
        `/repos/${options.repository.owner}/${options.repository.repo}/pulls/${number}/comments?per_page=100`,
      ),
      requestAllPages<GitHubReview>(
        `/repos/${options.repository.owner}/${options.repository.repo}/pulls/${number}/reviews?per_page=100`,
      ),
    ]);

    bundles.push({
      importedAt,
      repository: options.repository,
      pullRequest,
      issueComments,
      reviewComments,
      reviews,
    });
  }

  return bundles;
}

async function requestAllPages<T>(path: string): Promise<T[]> {
  const results: T[] = [];
  let nextUrl: string | null = toApiUrl(path);

  while (nextUrl) {
    const response = await request(nextUrl);
    const body = (await response.json()) as T[];
    results.push(...body);
    nextUrl = parseNextLink(response.headers.get("link"));
  }

  return results;
}

async function requestJson<T>(path: string): Promise<T> {
  const response = await request(toApiUrl(path));
  return (await response.json()) as T;
}

async function request(url: string): Promise<Response> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "traceback-cli",
    "x-github-api-version": "2022-11-28",
  };
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }

  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new GitHubApiError(await formatGitHubError(response), response.status, url);
  }

  return response;
}

function toApiUrl(path: string): string {
  if (path.startsWith("https://")) {
    return path;
  }
  return `${API_ROOT}${path}`;
}

function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) {
    return null;
  }

  for (const part of linkHeader.split(",")) {
    const match = /<([^>]+)>;\s*rel="next"/.exec(part.trim());
    if (match) {
      return match[1];
    }
  }

  return null;
}

function clampPerPage(prs: number): number {
  if (!Number.isInteger(prs) || prs < 1) {
    throw new Error("--prs must be a positive integer.");
  }
  return Math.min(prs, 100);
}

async function formatGitHubError(response: Response): Promise<string> {
  let detail = "";
  try {
    const body = (await response.json()) as { message?: string };
    detail = body.message ? ` ${body.message}` : "";
  } catch {
    detail = "";
  }

  if (response.status === 401 || response.status === 403) {
    return `GitHub API request failed with ${response.status}.${detail} Set GITHUB_TOKEN or GH_TOKEN if this repository is private or rate-limited.`;
  }

  if (response.status === 404) {
    return `GitHub API request failed with 404.${detail} Check that origin points to a GitHub repository you can access.`;
  }

  return `GitHub API request failed with ${response.status}.${detail}`;
}
