import { describe, expect, test } from "bun:test";
import { importRecentPullRequests } from "../src/github";
import type { GitHubPullRequest } from "../src/types";

function pr(number: number): GitHubPullRequest {
  return {
    number,
    title: `PR ${number}`,
    html_url: `https://github.com/acme/widgets/pull/${number}`,
    state: "open",
  };
}

describe("importRecentPullRequests", () => {
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
    expect(requestedUrls.filter((url) => url.includes("/pulls?"))).toEqual([
      "https://api.github.com/repos/acme/widgets/pulls?state=all&sort=updated&direction=desc&per_page=100&page=1",
      "https://api.github.com/repos/acme/widgets/pulls?state=all&sort=updated&direction=desc&per_page=100&page=2",
    ]);
  });
});
