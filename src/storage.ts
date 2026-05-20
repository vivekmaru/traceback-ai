import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { NORMALIZED_RECORD_SCHEMA_VERSION } from "./types";
import type { FailureCandidate, NormalizedPullRequestRecord, RawPullRequestBundle } from "./types";

export const TRACEBACK_DATA_DIR = ".traceback";

export type TracebackPaths = {
  root: string;
  dir: string;
  imports: string;
  records: string;
  failures: string;
  reports: string;
  analysisRuns: string;
  reviews: string;
  rules: string;
  exports: string;
};

export function getTracebackPaths(repoRoot: string): TracebackPaths {
  const dir = path.join(repoRoot, TRACEBACK_DATA_DIR);
  return {
    root: repoRoot,
    dir,
    imports: path.join(dir, "imports"),
    records: path.join(dir, "records"),
    failures: path.join(dir, "records", "failures"),
    reports: path.join(dir, "reports"),
    analysisRuns: path.join(dir, "analysis", "runs"),
    reviews: path.join(dir, "reviews"),
    rules: path.join(dir, "rules"),
    exports: path.join(dir, "exports"),
  };
}

export async function initTraceback(repoRoot: string): Promise<TracebackPaths> {
  const paths = getTracebackPaths(repoRoot);
  await Promise.all([
    mkdir(paths.imports, { recursive: true }),
    mkdir(paths.records, { recursive: true }),
    mkdir(paths.failures, { recursive: true }),
    mkdir(paths.reports, { recursive: true }),
    mkdir(paths.analysisRuns, { recursive: true }),
    mkdir(paths.reviews, { recursive: true }),
    mkdir(paths.rules, { recursive: true }),
    mkdir(paths.exports, { recursive: true }),
  ]);
  return paths;
}

export async function writeRawImport(
  repoRoot: string,
  bundle: RawPullRequestBundle,
): Promise<string> {
  const paths = await initTraceback(repoRoot);
  const filePath = path.join(paths.imports, prFileName(bundle.pullRequest.number));
  await writeJson(filePath, bundle);
  return filePath;
}

export async function writeRecord(
  repoRoot: string,
  record: NormalizedPullRequestRecord,
): Promise<string> {
  const paths = await initTraceback(repoRoot);
  const filePath = path.join(paths.records, prFileName(record.prNumber));
  await writeJson(filePath, record);
  return filePath;
}

export async function readRecords(repoRoot: string): Promise<NormalizedPullRequestRecord[]> {
  const paths = getTracebackPaths(repoRoot);
  let entries: string[];
  try {
    entries = await readdir(paths.records);
  } catch {
    return [];
  }

  const records = await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".json"))
      .map(async (entry) => {
        const raw = await readFile(path.join(paths.records, entry), "utf8");
        return JSON.parse(raw) as NormalizedPullRequestRecord;
      }),
  );

  return records.sort((a, b) => b.prNumber - a.prNumber);
}

export async function readImportedRecords(repoRoot: string): Promise<NormalizedPullRequestRecord[]> {
  const paths = getTracebackPaths(repoRoot);
  let entries: string[];
  try {
    entries = await readdir(paths.records);
  } catch {
    throw new Error(
      "No imported PR records found in .traceback/records/. Run `traceback import --prs <number>` first.",
    );
  }

  if (!entries.some((entry) => entry.endsWith(".json"))) {
    throw new Error(
      "No imported PR records found in .traceback/records/. Run `traceback import --prs <number>` first.",
    );
  }

  const records = await readRecords(repoRoot);
  validateImportedRecords(records);
  return records;
}

export async function writeFailureCandidates(
  repoRoot: string,
  candidates: FailureCandidate[],
): Promise<string[]> {
  const paths = await initTraceback(repoRoot);
  await rm(paths.failures, { recursive: true, force: true });
  await mkdir(paths.failures, { recursive: true });

  const filePaths: string[] = [];
  for (const candidate of candidates) {
    const filePath = path.join(paths.failures, `${candidate.id}.json`);
    await writeJson(filePath, candidate);
    filePaths.push(filePath);
  }

  return filePaths;
}

export async function writeReport(
  repoRoot: string,
  fileName: string,
  content: string,
): Promise<string> {
  const paths = await initTraceback(repoRoot);
  const filePath = path.join(paths.reports, fileName);
  await writeFile(filePath, content, "utf8");
  return filePath;
}

function prFileName(prNumber: number): string {
  return `pr-${prNumber}.json`;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function validateImportedRecords(records: NormalizedPullRequestRecord[]): void {
  for (const record of records) {
    if (record.schemaVersion !== NORMALIZED_RECORD_SCHEMA_VERSION) {
      throw new Error(
        `Unsupported normalized PR record schema in .traceback/records/pr-${record.prNumber}.json. Run \`traceback import --prs <number>\` again before extracting failures.`,
      );
    }

    for (const comment of record.reviewComments) {
      if (!Object.hasOwn(comment, "inReplyToId")) {
        throw new Error(
          `Unsupported normalized PR record schema in .traceback/records/pr-${record.prNumber}.json. Run \`traceback import --prs <number>\` again before extracting failures.`,
        );
      }
    }
  }
}
