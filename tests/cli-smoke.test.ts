import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runAnalysis } from "../src/analyze";
import type { FailureCandidate, NormalizedPullRequestRecord } from "../src/types";

test("bundled CLI completes an offline review/export flow from a clean repository", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "traceback-cli-smoke-"));
  const app = path.join(root, "app");
  const repo = path.join(root, "repo");
  const env = { ...process.env, OPENAI_API_KEY: "", GITHUB_TOKEN: "", GH_TOKEN: "" };
  try {
    await mkdir(app);
    await mkdir(repo);
    const build = await Bun.build({ entrypoints: [path.resolve(import.meta.dir, "../src/cli.ts")], outdir: app, target: "bun" });
    expect(build.success).toBe(true);
    const init = Bun.spawnSync(["git", "init", "--quiet", repo], { env });
    expect(init.exitCode).toBe(0);
    async function cli(...args: string[]) {
      const child = Bun.spawn([process.execPath, path.join(app, "cli.js"), ...args], { cwd: repo, env, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      return stdout;
    }
    expect(await cli("--version")).toContain("0.1.0");
    await cli("init");
    const instructions = "# Existing guidance\nDo not replace this file.\n";
    await writeFile(path.join(repo, "AGENTS.md"), instructions);
    const record: NormalizedPullRequestRecord = {
      schemaVersion: 3, importedAt: "2026-09-23T00:00:00Z",
      repository: { owner: "acme", repo: "widgets", remoteUrl: "https://github.com/acme/widgets.git" },
      prNumber: 1, title: "Synthetic fix", url: "https://github.com/acme/widgets/pull/1", state: "closed", merged: true,
      author: "author", createdAt: "2026-09-01T00:00:00Z", updatedAt: null, closedAt: null, mergedAt: null,
      baseBranch: "main", headBranch: "fix", body: "", labels: [], commitsCount: 1, changedFilesCount: 1, additions: 1, deletions: 1,
      issueComments: [], reviews: [], candidateAgentMarkers: [],
      reviewComments: [{ id: 7, author: "reviewer", body: "The redirect drops query params and loses template state.",
        createdAt: "2026-09-01T00:00:00Z", updatedAt: null, url: "https://github.com/acme/widgets/pull/1#discussion_r7",
        path: "src/redirect.ts", line: 1, originalLine: 1, inReplyToId: null, commitId: null }],
      reviewThreads: [{ id: "thread-7", isResolved: true, isOutdated: false, path: "src/redirect.ts", line: 1, startLine: null, commentIds: ["7"] }],
    };
    await writeFile(path.join(repo, ".traceback/records/pr-1.json"), JSON.stringify(record));
    await cli("report");
    expect(await cli("extract")).toContain("Generated 1 failure candidate");
    const failures = path.join(repo, ".traceback/records/failures");
    const [file] = await readdir(failures);
    const candidate = JSON.parse(await readFile(path.join(failures, file), "utf8")) as FailureCandidate;
    expect(candidate.status).toBe("resolved");
    await cli("analyze", "--dry-run");
    let providerCalls = 0;
    const run = await runAnalysis(repo, { mode: "provider", provider: "openai", providerClient: async ({ input }) => {
      providerCalls++;
      const source = input.failureCandidates[0];
      return { rawResponse: { fixture: true }, analysis: {
        enrichedRecords: [{ id: "enriched-1", sourceCandidateIds: [source.id], title: "Preserve redirect context", failureType: "contract",
          summary: "A required query value is lost.", whatTheAgentMissed: "Existing redirect contract", evidenceSummary: source.evidenceExcerpt,
          likelyFixOrCorrection: "Preserve the query", preventionRule: "Preserve query values in the repository redirect helper.",
          confidence: "high", sourcePrs: [1], sourceComments: [record.reviewComments[0].url!], notes: [] }],
        clusters: [{ id: "cluster-1", title: "Redirect context", summary: "Missing context", candidateIds: [source.id], failureTypes: ["contract"],
          sourcePrs: [1], evidenceSummary: source.evidenceExcerpt, whatTheAgentMissed: "Redirect contract",
          preventionRule: "Preserve query values in the repository redirect helper.", confidence: "high" }],
        summary: { overview: "Synthetic offline output", highestRiskPatterns: [], recommendedNextActions: [] },
      } };
    } });
    expect(providerCalls).toBe(1);
    await cli("review", "--run", run.runId, "--policy", "conservative");
    await cli("rules", "--run", run.runId);
    await cli("rules", "review", "--run", run.runId, "--policy", "conservative");
    await cli("rules", "export", "--run", run.runId, "--target", "agents-md");
    const manifest = JSON.parse(await readFile(path.join(repo, ".traceback/exports", run.runId, "manifest.json"), "utf8"));
    expect(manifest.exportedRuleCount).toBe(1);
    expect(await readFile(path.join(repo, "AGENTS.md"), "utf8")).toBe(instructions);
    const rejected = Bun.spawnSync([process.execPath, path.join(app, "cli.js"), "review", "--run", "../outside", "--policy", "conservative"], { cwd: repo, env });
    expect(rejected.exitCode).not.toBe(0);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30000);
