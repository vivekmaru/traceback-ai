import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type GitHubRemote = {
  owner: string;
  repo: string;
};

export async function findGitRoot(cwd = process.cwd()): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd });
    return stdout.trim();
  } catch {
    throw new Error("Not inside a git repository. Run traceback from inside a git repo.");
  }
}

export async function readOriginRemote(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["config", "--get", "remote.origin.url"], { cwd });
    const remoteUrl = stdout.trim();
    if (!remoteUrl) {
      throw new Error("empty origin remote");
    }
    return remoteUrl;
  } catch {
    throw new Error("Could not read git remote 'origin'. Add an origin remote and try again.");
  }
}

export function parseGitHubRemote(remoteUrl: string): GitHubRemote {
  const trimmed = remoteUrl.trim();
  const sshMatch = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(trimmed);
  if (sshMatch) {
    return normalizeRemoteParts(sshMatch[1], sshMatch[2], trimmed);
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.hostname !== "github.com") {
      throw new Error("not github.com");
    }

    const pathParts = parsed.pathname.split("/").filter(Boolean);
    if (pathParts.length !== 2) {
      throw new Error("expected owner/repo path");
    }

    return normalizeRemoteParts(pathParts[0], pathParts[1], trimmed);
  } catch {
    throw new Error(
      `Unsupported GitHub remote URL: ${remoteUrl}. Expected https://github.com/owner/repo.git or git@github.com:owner/repo.git.`,
    );
  }
}

function normalizeRemoteParts(owner: string, repo: string, originalUrl: string): GitHubRemote {
  const normalizedRepo = repo.replace(/\.git$/, "");
  if (!owner || !normalizedRepo || normalizedRepo.includes("/")) {
    throw new Error(
      `Unsupported GitHub remote URL: ${originalUrl}. Expected a GitHub owner/repo remote.`,
    );
  }

  return {
    owner,
    repo: normalizedRepo,
  };
}
