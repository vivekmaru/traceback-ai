import type {
  GitHubIssueComment,
  GitHubPullRequest,
  GitHubRepository,
  GitHubReview,
  GitHubReviewComment,
  GitHubReviewThread,
  GitHubReviewThreadComment,
  RawPullRequestBundle,
} from "./types";

const API_ROOT = "https://api.github.com";
const GRAPHQL_ROOT = "https://api.github.com/graphql";

export type ImportOptions = {
  prs: number;
  repository: GitHubRepository;
  fetcher?: HttpFetcher;
};

export type HttpFetcher = (input: string, init?: RequestInit) => Promise<Response>;

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
  const prs = validatePrCount(options.prs);
  const context: RequestContext = {
    fetcher: options.fetcher ?? fetch,
  };
  const list = await fetchPullRequestList(options.repository, prs, context);

  const importedAt = new Date().toISOString();
  const bundles: RawPullRequestBundle[] = [];

  for (const item of list.slice(0, prs)) {
    const number = item.number;
    const [pullRequest, issueComments, reviewComments, reviewThreads, reviews] = await Promise.all([
      requestJson<GitHubPullRequest>(
        `/repos/${options.repository.owner}/${options.repository.repo}/pulls/${number}`,
        context,
      ),
      requestAllPages<GitHubIssueComment>(
        `/repos/${options.repository.owner}/${options.repository.repo}/issues/${number}/comments?per_page=100`,
        context,
      ),
      requestAllPages<GitHubReviewComment>(
        `/repos/${options.repository.owner}/${options.repository.repo}/pulls/${number}/comments?per_page=100`,
        context,
      ),
      fetchReviewThreads(options.repository, number, context),
      requestAllPages<GitHubReview>(
        `/repos/${options.repository.owner}/${options.repository.repo}/pulls/${number}/reviews?per_page=100`,
        context,
      ),
    ]);

    bundles.push({
      importedAt,
      repository: options.repository,
      pullRequest,
      issueComments,
      reviewComments,
      reviewThreads,
      reviews,
    });
  }

  return bundles;
}

type RequestContext = {
  fetcher: HttpFetcher;
};

type GraphQlPageInfo = {
  hasNextPage: boolean;
  endCursor: string | null;
};

type GraphQlReviewThreadNode = {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string | null;
  line: number | null;
  startLine: number | null;
  comments: {
    nodes: GitHubReviewThreadComment[];
    pageInfo: GraphQlPageInfo;
  };
};

type GraphQlReviewThreadPage = {
  nodes: GraphQlReviewThreadNode[];
  pageInfo: GraphQlPageInfo;
};

type ReviewThreadsResponse = {
  repository: {
    pullRequest: {
      reviewThreads: GraphQlReviewThreadPage;
    } | null;
  } | null;
};

type ReviewThreadCommentsResponse = {
  node: {
    comments?: {
      nodes: GitHubReviewThreadComment[];
      pageInfo: GraphQlPageInfo;
    };
  } | null;
};

async function fetchPullRequestList(
  repository: GitHubRepository,
  requestedCount: number,
  context: RequestContext,
): Promise<GitHubPullRequest[]> {
  const results: GitHubPullRequest[] = [];
  let page = 1;

  while (results.length < requestedCount) {
    const perPage = 100;
    const pullRequests = await requestJson<GitHubPullRequest[]>(
      `/repos/${repository.owner}/${repository.repo}/pulls?state=all&sort=updated&direction=desc&per_page=${perPage}&page=${page}`,
      context,
    );

    results.push(...pullRequests);
    if (pullRequests.length < perPage) {
      break;
    }
    page += 1;
  }

  return results.slice(0, requestedCount);
}

async function requestAllPages<T>(path: string, context: RequestContext): Promise<T[]> {
  const results: T[] = [];
  let nextUrl: string | null = toApiUrl(path);

  while (nextUrl) {
    const response = await request(nextUrl, context);
    const body = (await response.json()) as T[];
    results.push(...body);
    nextUrl = parseNextLink(response.headers.get("link"));
  }

  return results;
}

async function requestJson<T>(path: string, context: RequestContext): Promise<T> {
  const response = await request(toApiUrl(path), context);
  return (await response.json()) as T;
}

async function fetchReviewThreads(
  repository: GitHubRepository,
  pullRequestNumber: number,
  context: RequestContext,
): Promise<GitHubReviewThread[]> {
  if (!githubToken()) {
    return [];
  }

  const threads: GitHubReviewThread[] = [];
  let threadsCursor: string | null = null;

  do {
    let data: ReviewThreadsResponse;
    try {
      data = await requestGraphQl<ReviewThreadsResponse>(
        REVIEW_THREADS_QUERY,
        {
          owner: repository.owner,
          repo: repository.repo,
          number: pullRequestNumber,
          threadsCursor,
        },
        context,
      );
    } catch {
      return threads;
    }

    const page: GraphQlReviewThreadPage | undefined = data.repository?.pullRequest?.reviewThreads;
    if (!page) {
      return threads;
    }

    for (const node of page.nodes) {
      const comments = [...node.comments.nodes];
      if (node.comments.pageInfo.hasNextPage && node.comments.pageInfo.endCursor) {
        comments.push(
          ...(await fetchAdditionalReviewThreadComments(
            node.id,
            node.comments.pageInfo.endCursor,
            context,
          )),
        );
      }
      threads.push({
        id: node.id,
        isResolved: Boolean(node.isResolved),
        isOutdated: Boolean(node.isOutdated),
        path: node.path ?? null,
        line: node.line ?? null,
        startLine: node.startLine ?? null,
        comments,
      });
    }

    threadsCursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (threadsCursor);

  return threads;
}

async function fetchAdditionalReviewThreadComments(
  threadId: string,
  firstCursor: string | null,
  context: RequestContext,
): Promise<GitHubReviewThreadComment[]> {
  const comments: GitHubReviewThreadComment[] = [];
  let commentsCursor: string | null = firstCursor;

  try {
    do {
      const data = await requestGraphQl<ReviewThreadCommentsResponse>(
        REVIEW_THREAD_COMMENTS_QUERY,
        { threadId, commentsCursor },
        context,
      );
      const page = data.node?.comments;
      if (!page) {
        return comments;
      }
      comments.push(...page.nodes);
      commentsCursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } while (commentsCursor);
  } catch {
    return comments;
  }

  return comments;
}

async function requestGraphQl<T>(
  query: string,
  variables: Record<string, unknown>,
  context: RequestContext,
): Promise<T> {
  const token = githubToken();
  if (!token) {
    throw new Error("GitHub GraphQL requests require GITHUB_TOKEN or GH_TOKEN.");
  }
  const response = await context.fetcher(GRAPHQL_ROOT, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "traceback-cli",
      "x-github-api-version": "2022-11-28",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) {
    throw new GitHubApiError(await formatGitHubError(response), response.status, GRAPHQL_ROOT);
  }

  const body = (await response.json()) as { data?: T; errors?: Array<{ message?: string }> };
  if (body.errors?.length) {
    const message = body.errors.map((error) => error.message ?? "Unknown GraphQL error").join("; ");
    throw new GitHubApiError(`GitHub GraphQL request failed. ${message}`, response.status, GRAPHQL_ROOT);
  }
  return body.data as T;
}

async function request(url: string, context: RequestContext): Promise<Response> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "traceback-cli",
    "x-github-api-version": "2022-11-28",
  };
  const token = githubToken();
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }

  const response = await context.fetcher(url, { headers });
  if (!response.ok) {
    throw new GitHubApiError(await formatGitHubError(response), response.status, url);
  }

  return response;
}

function githubToken(): string | undefined {
  return process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
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

function validatePrCount(prs: number): number {
  if (!Number.isInteger(prs) || prs < 1) {
    throw new Error("--prs must be a positive integer.");
  }
  return prs;
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
    return `GitHub API returned 404.${detail} If this is a private repo, configure GITHUB_TOKEN or GH_TOKEN with a token that can access the repository. Also check that origin points to the intended GitHub repository.`;
  }

  return `GitHub API request failed with ${response.status}.${detail}`;
}

const REVIEW_THREADS_QUERY = /* GraphQL */ `
  query TracebackReviewThreads(
    $owner: String!
    $repo: String!
    $number: Int!
    $threadsCursor: String
  ) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $threadsCursor) {
          nodes {
            id
            isResolved
            isOutdated
            path
            line
            startLine
            comments(first: 100) {
              nodes {
                id
                fullDatabaseId
                url
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
  }
`;

const REVIEW_THREAD_COMMENTS_QUERY = /* GraphQL */ `
  query TracebackReviewThreadComments($threadId: ID!, $commentsCursor: String) {
    node(id: $threadId) {
      ... on PullRequestReviewThread {
        comments(first: 100, after: $commentsCursor) {
          nodes {
            id
            fullDatabaseId
            url
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
  }
`;
