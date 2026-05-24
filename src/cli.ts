#!/usr/bin/env bun
import { Command } from "commander";
import { runAnalysis } from "./analyze";
import { extractFailureCandidates } from "./extract";
import { findGitRoot, parseGitHubRemote, readOriginRemote } from "./git";
import { GitHubApiError, importRecentPullRequests } from "./github";
import { normalizePullRequestRecord } from "./normalize";
import { generateFailureCandidatesReport, generateImportSummary } from "./report";
import { runReview } from "./review";
import { runRulesDraft } from "./rules";
import { runRulesExport } from "./rules-export";
import { runRulesReview } from "./rules-review";
import { runUiServer } from "./ui";
import {
  initTraceback,
  readImportedRecords,
  readRecords,
  writeFailureCandidates,
  writeRawImport,
  writeRecord,
  writeReport,
} from "./storage";
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

program
  .command("extract")
  .description("Extract deterministic failure candidates from imported PR records.")
  .action(runExtract);

program
  .command("analyze")
  .description("Enrich deterministic failure candidates with AI-assisted analysis.")
  .option("--dry-run", "write analysis input and prompt without calling a provider")
  .option("--provider <provider>", "analysis provider to call; currently supports openai")
  .action(runAnalyze);

program
  .command("review")
  .description("Create local review decisions for an analysis run.")
  .requiredOption("--run <runId>", "analysis run ID to review")
  .requiredOption("--policy <policy>", "review policy to apply; currently supports conservative")
  .action(runReviewCommand);

program
  .command("rules")
  .description("Generate local draft rules from reviewed decisions.")
  .argument("[action]", "optional rules action; use review or export")
  .option("--run <runId>", "reviewed run ID to convert into draft rules")
  .option("--policy <policy>", "rule review policy to apply; currently supports conservative")
  .option("--from <path>", "read and normalize a manual rule-decisions-style file")
  .option("--target <target>", "export target; currently supports agents-md")
  .action(runRulesCommand);

program
  .command("ui")
  .description("Start a local read-only Traceback review UI.")
  .option("--host <host>", "host to bind", "127.0.0.1")
  .option("--port <number>", "port to bind", parsePort, 4317)
  .action(runUiCommand);

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

async function runExtract(): Promise<void> {
  const repoRoot = await findGitRoot();
  const records = await readImportedRecords(repoRoot);
  const candidates = extractFailureCandidates(records);
  await writeFailureCandidates(repoRoot, candidates);
  const reportPath = await writeReport(
    repoRoot,
    "failure-candidates.md",
    generateFailureCandidatesReport(candidates),
  );

  console.log(
    `Generated ${candidates.length} failure candidate(s) in .traceback/records/failures/.`,
  );
  console.log(`Wrote ${reportPath}`);
}

async function runAnalyze(options: { dryRun?: boolean; provider?: string }): Promise<void> {
  if (options.dryRun && options.provider) {
    throw new Error("Use either --dry-run or --provider openai, not both.");
  }

  if (options.dryRun) {
    const repoRoot = await findGitRoot();
    const result = await runAnalysis(repoRoot, { mode: "dry-run" });
    console.log(`Wrote dry-run analysis artifacts to ${result.runDir}`);
    return;
  }

  if (options.provider === "openai") {
    const repoRoot = await findGitRoot();
    const result = await runAnalysis(repoRoot, { mode: "provider", provider: "openai" });
    console.log(`Wrote OpenAI analysis artifacts to ${result.runDir}`);
    return;
  }

  if (options.provider) {
    throw new Error("Only --provider openai is supported.");
  }

  throw new Error("Specify --dry-run or --provider openai.");
}

async function runReviewCommand(options: { run: string; policy: string }): Promise<void> {
  if (options.policy !== "conservative") {
    throw new Error("Only --policy conservative is supported.");
  }

  const repoRoot = await findGitRoot();
  const result = await runReview(repoRoot, { runId: options.run, policy: "conservative" });
  console.log(`Wrote review decisions to ${result.decisionsPath}`);
  console.log(`Wrote review summary to ${result.summaryPath}`);
}

async function runRulesCommand(
  action: string | undefined,
  options: { run?: string; policy?: string; from?: string; target?: string },
): Promise<void> {
  if (action === "review") {
    await runRulesReviewCommand(options);
    return;
  }

  if (action === "export") {
    await runRulesExportCommand(options);
    return;
  }

  if (action) {
    throw new Error(`Unsupported rules action: ${action}. Supported actions: review, export.`);
  }

  if (!options.run) {
    throw new Error("Specify --run <runId>.");
  }

  const repoRoot = await findGitRoot();
  const result = await runRulesDraft(repoRoot, { runId: options.run });
  console.log(`Wrote draft rules to ${result.rulesPath}`);
  console.log(`Wrote draft rules summary to ${result.markdownPath}`);
}

async function runRulesReviewCommand(options: {
  run?: string;
  policy?: string;
  from?: string;
}): Promise<void> {
  if (!options.run) {
    throw new Error("Specify --run <runId>.");
  }
  if (options.policy !== "conservative") {
    throw new Error("Only --policy conservative is supported.");
  }

  const repoRoot = await findGitRoot();
  const result = await runRulesReview(repoRoot, {
    runId: options.run,
    policy: "conservative",
    from: options.from,
  });
  console.log(`Wrote rule decisions to ${result.decisionsPath}`);
  console.log(`Wrote rule review summary to ${result.markdownPath}`);
}

async function runRulesExportCommand(options: { run?: string; target?: string }): Promise<void> {
  if (!options.run) {
    throw new Error("Specify --run <runId>.");
  }
  if (!options.target) {
    throw new Error("Specify --target agents-md.");
  }

  const repoRoot = await findGitRoot();
  const result = await runRulesExport(repoRoot, { runId: options.run, target: options.target });
  if (result.proposedPath) {
    console.log(`Wrote proposed ${options.target} export to ${result.proposedPath}`);
  } else {
    console.log("No repo-specific rules were exported; AGENTS.proposed.md was not written.");
  }
  if (result.broaderLearningsPath) {
    console.log(`Wrote broader learnings to ${result.broaderLearningsPath}`);
  }
  console.log(`Wrote export summary to ${result.summaryPath}`);
  console.log(`Wrote export manifest to ${result.manifestPath}`);
}

async function runUiCommand(options: { host: string; port: number }): Promise<void> {
  const repoRoot = await findGitRoot();
  await runUiServer(repoRoot, { host: options.host, port: options.port });
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

function parsePort(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error("--port must be an integer between 1 and 65535.");
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
