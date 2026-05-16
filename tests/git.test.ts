import { describe, expect, test } from "bun:test";
import { parseGitHubRemote } from "../src/git";

describe("parseGitHubRemote", () => {
  test("parses HTTPS remote with .git suffix", () => {
    expect(parseGitHubRemote("https://github.com/octocat/hello-world.git")).toEqual({
      owner: "octocat",
      repo: "hello-world",
    });
  });

  test("parses HTTPS remote without .git suffix", () => {
    expect(parseGitHubRemote("https://github.com/octocat/hello-world")).toEqual({
      owner: "octocat",
      repo: "hello-world",
    });
  });

  test("parses SSH shorthand remote", () => {
    expect(parseGitHubRemote("git@github.com:octocat/hello-world.git")).toEqual({
      owner: "octocat",
      repo: "hello-world",
    });
  });

  test("parses ssh:// remote", () => {
    expect(parseGitHubRemote("ssh://git@github.com/octocat/hello-world.git")).toEqual({
      owner: "octocat",
      repo: "hello-world",
    });
  });

  test("rejects non-GitHub remotes", () => {
    expect(() => parseGitHubRemote("git@gitlab.com:octocat/hello-world.git")).toThrow(
      "Unsupported GitHub remote URL",
    );
  });
});
