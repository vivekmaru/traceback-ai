import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GitHubApiError, importRecentPullRequests } from "../src/github";
import type { GitHubPullRequest } from "../src/types";

const ORIGINAL_GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const ORIGINAL_GH_TOKEN = process.env.GH_TOKEN;

function pr(number: number): GitHubPullRequest {
  return {
    number,
    title: `PR ${number}`,
    html_url: `https://github.com/acme/widgets/pull/${number}`,
    state: "open",
  };
}

describe("importRecentPullRequests", () => {
  beforeEach(() => {
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
  });

  afterEach(() => {
    restoreEnv("GITHUB_TOKEN", ORIGINAL_GITHUB_TOKEN);
    restoreEnv("GH_TOKEN", ORIGINAL_GH_TOKEN);
  });

  test("paginates pull request list until the requested count is reached", async () => {
    const requestedUrls: string[] = [];
    const fetcher = async (input: string) => {
      const url = input.toString();
      requestedUrls.push(url);

      if (url.includes("/pulls?")) {
        const parsed = new URL(url);
        const page = parsed.searchParams.get("page");
        const pullRequests =
          page === "2" ? [pr(101), pr(102)] : Array.from({ length: 100 }, (_, i) => pr(i + 1));
        return Response.json(pullRequests);
      }

      const pullNumber = Number(url.match(/\/pulls\/(\d+)/)?.[1]);
      const issueNumber = Number(url.match(/\/issues\/(\d+)/)?.[1]);
      if (
        url.includes(`/pulls/${pullNumber}/comments`) ||
        url.includes(`/pulls/${pullNumber}/reviews`)
      ) {
        return Response.json([]);
      }
      if (url.includes(`/issues/${issueNumber}/comments`)) {
        return Response.json([]);
      }
      if (url.includes(`/pulls/${pullNumber}`)) {
        return Response.json(pr(pullNumber));
      }

      throw new Error(`Unexpected URL: ${url}`);
    };

    const bundles = await importRecentPullRequests({
      prs: 102,
      repository: {
        owner: "acme",
        repo: "widgets",
        remoteUrl: "https://github.com/acme/widgets.git",
      },
      fetcher,
    });

    expect(bundles).toHaveLength(102);
    expect(bundles.every((bundle) => bundle.reviewThreads.length === 0)).toBe(true);
    expect(requestedUrls.filter((url) => url.includes("/pulls?"))).toEqual([
      "https://api.github.com/repos/acme/widgets/pulls?state=all&sort=updated&direction=desc&per_page=100&page=1",
      "https://api.github.com/repos/acme/widgets/pulls?state=all&sort=updated&direction=desc&per_page=100&page=2",
    ]);
  });

  test("continues without GraphQL review threads when no token is available", async () => {
    const requestedUrls: string[] = [];
    const fetcher = async (input: string) => {
      const url = input.toString();
      requestedUrls.push(url);

      if (url.includes("/pulls?")) {
        return Response.json([pr(12)]);
      }
      if (url.includes("/pulls/12/comments") || url.includes("/pulls/12/reviews")) {
        return Response.json([]);
      }
      if (url.includes("/issues/12/comments")) {
        return Response.json([]);
      }
      if (url.includes("/pulls/12")) {
        return Response.json(pr(12));
      }

      throw new Error(`Unexpected URL: ${url}`);
    };

    const [bundle] = await importRecentPullRequests({
      prs: 1,
      repository: {
        owner: "acme",
        repo: "widgets",
        remoteUrl: "https://github.com/acme/widgets.git",
      },
      fetcher,
    });

    expect(requestedUrls.some((url) => url === "https://api.github.com/graphql")).toBe(false);
    expect(bundle.reviewThreads).toEqual([]);
  });

  test("fetches paginated GraphQL review thread metadata when a token is available", async () => {
    process.env.GITHUB_TOKEN = "test-token";
    const graphqlBodies: unknown[] = [];
    const fetcher = async (input: string, init?: RequestInit) => {
      const url = input.toString();

      if (url === "https://api.github.com/graphql") {
        const body = JSON.parse(String(init?.body));
        graphqlBodies.push(body);
        expect((init?.headers as Record<string, string>).authorization).toBe("Bearer test-token");
        const cursor = body.variables.threadsCursor;
        return Response.json({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes:
                    cursor === null
                      ? [
                          {
                            id: "PRRT_kwDOABC123",
                            isResolved: true,
                            isOutdated: false,
                            path: "src/auth.ts",
                            line: 42,
                            startLine: 40,
                            comments: {
                              nodes: [
                                {
                                  id: "PRRC_kwDOABC2001",
                                  fullDatabaseId: 2001,
                                  url: "https://github.com/acme/widgets/pull/12#discussion_r2001",
                                },
                              ],
                              pageInfo: { hasNextPage: false, endCursor: null },
                            },
                          },
                        ]
                      : [
                          {
                            id: "PRRT_kwDOABC456",
                            isResolved: false,
                            isOutdated: true,
                            path: "src/ui.ts",
                            line: 18,
                            startLine: null,
                            comments: {
                              nodes: [
                                {
                                  id: "PRRC_kwDOABC2002",
                                  fullDatabaseId: "2002",
                                  url: "https://github.com/acme/widgets/pull/12#discussion_r2002",
                                },
                              ],
                              pageInfo: { hasNextPage: false, endCursor: null },
                            },
                          },
                        ],
                  pageInfo:
                    cursor === null
                      ? { hasNextPage: true, endCursor: "thread-page-2" }
                      : { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        });
      }

      if (url.includes("/pulls?")) {
        return Response.json([pr(12)]);
      }
      if (url.includes("/pulls/12/comments") || url.includes("/pulls/12/reviews")) {
        return Response.json([]);
      }
      if (url.includes("/issues/12/comments")) {
        return Response.json([]);
      }
      if (url.includes("/pulls/12")) {
        return Response.json(pr(12));
      }

      throw new Error(`Unexpected URL: ${url}`);
    };

    const [bundle] = await importRecentPullRequests({
      prs: 1,
      repository: {
        owner: "acme",
        repo: "widgets",
        remoteUrl: "https://github.com/acme/widgets.git",
      },
      fetcher,
    });

    expect(graphqlBodies).toHaveLength(2);
    expect(graphqlBodies.map((body) => (body as { variables: { threadsCursor: string | null } }).variables.threadsCursor)).toEqual([
      null,
      "thread-page-2",
    ]);
    expect(bundle.reviewThreads).toEqual([
      {
        id: "PRRT_kwDOABC123",
        isResolved: true,
        isOutdated: false,
        path: "src/auth.ts",
        line: 42,
        startLine: 40,
        comments: [
          {
            id: "PRRC_kwDOABC2001",
            fullDatabaseId: 2001,
            url: "https://github.com/acme/widgets/pull/12#discussion_r2001",
          },
        ],
      },
      {
        id: "PRRT_kwDOABC456",
        isResolved: false,
        isOutdated: true,
        path: "src/ui.ts",
        line: 18,
        startLine: null,
        comments: [
          {
            id: "PRRC_kwDOABC2002",
            fullDatabaseId: "2002",
            url: "https://github.com/acme/widgets/pull/12#discussion_r2002",
          },
        ],
      },
    ]);
  });

  test("fetches paginated GraphQL review thread comments", async () => {
    process.env.GITHUB_TOKEN = "test-token";
    const graphqlVariables: unknown[] = [];
    const fetcher = async (input: string, init?: RequestInit) => {
      const url = input.toString();

      if (url === "https://api.github.com/graphql") {
        const body = JSON.parse(String(init?.body));
        graphqlVariables.push(body.variables);
        if (body.variables.threadId) {
          return Response.json({
            data: {
              node: {
                comments: {
                  nodes: [
                    {
                      id: "PRRC_kwDOABC2002",
                      fullDatabaseId: 2002,
                      url: "https://github.com/acme/widgets/pull/14#discussion_r2002",
                    },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          });
        }
        return Response.json({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [
                    {
                      id: "PRRT_kwDOABC123",
                      isResolved: false,
                      isOutdated: false,
                      path: "src/auth.ts",
                      line: 42,
                      startLine: 40,
                      comments: {
                        nodes: [
                          {
                            id: "PRRC_kwDOABC2001",
                            fullDatabaseId: 2001,
                            url: "https://github.com/acme/widgets/pull/14#discussion_r2001",
                          },
                        ],
                        pageInfo: { hasNextPage: true, endCursor: "comment-page-2" },
                      },
                    },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        });
      }

      if (url.includes("/pulls?")) {
        return Response.json([pr(14)]);
      }
      if (url.includes("/pulls/14/comments") || url.includes("/pulls/14/reviews")) {
        return Response.json([]);
      }
      if (url.includes("/issues/14/comments")) {
        return Response.json([]);
      }
      if (url.includes("/pulls/14")) {
        return Response.json(pr(14));
      }

      throw new Error(`Unexpected URL: ${url}`);
    };

    const [bundle] = await importRecentPullRequests({
      prs: 1,
      repository: {
        owner: "acme",
        repo: "widgets",
        remoteUrl: "https://github.com/acme/widgets.git",
      },
      fetcher,
    });

    expect(graphqlVariables).toEqual([
      { owner: "acme", repo: "widgets", number: 14, threadsCursor: null },
      { threadId: "PRRT_kwDOABC123", commentsCursor: "comment-page-2" },
    ]);
    expect(bundle.reviewThreads[0].comments.map((comment) => comment.fullDatabaseId)).toEqual([
      2001,
      2002,
    ]);
  });

  test("404 errors mention private repository token access", async () => {
    const fetcher = async () =>
      Response.json({ message: "Not Found" }, { status: 404, statusText: "Not Found" });

    await expect(
      importRecentPullRequests({
        prs: 1,
        repository: {
          owner: "acme",
          repo: "private-widgets",
          remoteUrl: "https://github.com/acme/private-widgets.git",
        },
        fetcher,
      }),
    ).rejects.toThrow(GitHubApiError);

    await expect(
      importRecentPullRequests({
        prs: 1,
        repository: {
          owner: "acme",
          repo: "private-widgets",
          remoteUrl: "https://github.com/acme/private-widgets.git",
        },
        fetcher,
      }),
    ).rejects.toThrow(
      "If this is a private repo, configure GITHUB_TOKEN or GH_TOKEN with a token that can access the repository.",
    );
  });
});

function restoreEnv(name: "GITHUB_TOKEN" | "GH_TOKEN", value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
