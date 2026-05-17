#!/usr/bin/env bun
import { Command } from "commander";
import { findGitRoot, parseGitHubRemote, readOriginRemote } from "./git";
import { GitHubApiError, importRecentPullRequests } from "./github";
import { normalizePullRequestRecord } from "./normalize";
import { generateImportSummary } from "./report";
import { initTraceback, readRecords, writeRawImport, writeRecord, writeReport } from "./storage";
import type { GitHubRepository } from "./types";

const program = new Command();

program
  .name("traceback")
  .description("Convert PR noise into local Traceback AI import records.")
  .version("0.1.0");

program.command("init").description("Create the local .traceback directory.").action(runInit);

program
  .command("import")
  .description("Import recent GitHub pull request data into .traceback.")
  .requiredOption("--prs <number>", "number of recent pull requests to import", parsePrCount)
  .action(runImport);

program
  .command("report")
  .description("Generate .traceback/reports/import-summary.md from normalized records.")
  .action(runReport);

program.parseAsync().catch((error: unknown) => {
  printError(error);
  process.exitCode = 1;
});

async function runInit(): Promise<void> {
  const repoRoot = await findGitRoot();
  await initTraceback(repoRoot);
  console.log(`Created .traceback/ in ${repoRoot}`);
}

async function runImport(options: { prs: number }): Promise<void> {
  const repoRoot = await findGitRoot();
  const repository = await detectRepository(repoRoot);
  const bundles = await importRecentPullRequests({ prs: options.prs, repository });

  for (const bundle of bundles) {
    await writeRawImport(repoRoot, bundle);
    await writeRecord(repoRoot, normalizePullRequestRecord(bundle));
  }

  console.log(`Imported ${bundles.length} pull request(s) from ${repository.owner}/${repository.repo}.`);
}

async function runReport(): Promise<void> {
  const repoRoot = await findGitRoot();
  const records = await readRecords(repoRoot);
  const reportPath = await writeReport(repoRoot, "import-summary.md", generateImportSummary(records));
  console.log(`Wrote ${reportPath}`);
}

async function detectRepository(repoRoot: string): Promise<GitHubRepository> {
  const remoteUrl = await readOriginRemote(repoRoot);
  const { owner, repo } = parseGitHubRemote(remoteUrl);
  return { owner, repo, remoteUrl };
}

function parsePrCount(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error("--prs must be a positive integer.");
  }
  return parsed;
}

function printError(error: unknown): void {
  if (error instanceof GitHubApiError) {
    console.error(error.message);
    return;
  }

  if (error instanceof Error) {
    console.error(error.message);
    return;
  }

  console.error(String(error));
}
