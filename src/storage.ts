import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { NormalizedPullRequestRecord, RawPullRequestBundle } from "./types";

export const TRACEBACK_DATA_DIR = ".agentfail";

export type TracebackPaths = {
  root: string;
  dir: string;
  imports: string;
  records: string;
  reports: string;
};

export function getTracebackPaths(repoRoot: string): TracebackPaths {
  const dir = path.join(repoRoot, TRACEBACK_DATA_DIR);
  return {
    root: repoRoot,
    dir,
    imports: path.join(dir, "imports"),
    records: path.join(dir, "records"),
    reports: path.join(dir, "reports"),
  };
}

export async function initTraceback(repoRoot: string): Promise<TracebackPaths> {
  const paths = getTracebackPaths(repoRoot);
  await Promise.all([
    mkdir(paths.imports, { recursive: true }),
    mkdir(paths.records, { recursive: true }),
    mkdir(paths.reports, { recursive: true }),
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
