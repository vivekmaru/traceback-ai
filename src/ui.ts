import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { getTracebackPaths } from "./storage";
import type { AnalysisOutput } from "./analyze";
import type { ReviewDecision, ReviewDecisionsFile } from "./review";
import type { DraftRule, DraftRulesFile } from "./rules";
import type { RuleDecision, RuleDecisionsFile } from "./rules-review";
import type { FailureCandidate, FailureCandidateStatus, NormalizedPullRequestRecord } from "./types";

export type UiServerOptions = {
  host: string;
  port: number;
};

export type UiState = {
  schemaVersion: 1;
  generatedAt: string;
  repoRoot: string;
  summary: UiSummary;
  candidates: UiCandidate[];
  runs: UiRun[];
  clusters: UiCluster[];
  reviewDecisions: UiReviewDecision[];
  draftRules: UiDraftRule[];
  ruleDecisions: UiRuleDecision[];
  exportItems: UiExport[];
  warnings: string[];
};

export type UiSummary = {
  importedPrs: number;
  failureCandidates: number;
  statusCounts: Partial<Record<FailureCandidateStatus, number>>;
  analysisRuns: number;
  reviewDecisions: number;
  draftRules: number;
  ruleDecisions: number;
  exports: number;
};

export type UiCandidate = {
  id: string;
  sourcePrNumber: number;
  sourcePrUrl: string;
  sourceCommentUrl: string | null;
  sourceType: FailureCandidate["sourceType"];
  title: string;
  category: FailureCandidate["candidateCategory"];
  severity: FailureCandidate["candidateSeverity"];
  confidence: FailureCandidate["confidence"];
  status: FailureCandidate["status"];
  evidenceExcerpt: string;
};

export type UiRun = {
  runId: string;
  createdAt: string | null;
  mode: string;
  provider: string | null;
  failureCandidateCount: number;
  hasInput: boolean;
  hasPrompt: boolean;
  hasProviderOutput: boolean;
  enrichedRecords: number;
  clusters: number;
  reviewDecisions: number;
  draftRules: number;
  ruleDecisions: number;
  exportedRules: number;
  hasProposedAgents: boolean;
  warnings: string[];
  clusterItems: UiCluster[];
  reviewDecisionItems: UiReviewDecision[];
  draftRuleItems: UiDraftRule[];
  ruleDecisionItems: UiRuleDecision[];
  exportItem: UiExport | null;
};

export type UiCluster = {
  runId: string;
  id: string;
  title: string;
  summary: string;
  preventionRule: string;
  confidence: string;
  sourcePrs: number[];
  sourceCandidateIds: string[];
};

export type UiReviewDecision = {
  runId: string;
  id: string;
  title: string;
  decision: string;
  confidence: string;
  sourcePrs: number[];
  sourceCandidateIds: string[];
  reason: string;
};

export type UiDraftRule = {
  runId: string;
  id: string;
  title: string;
  rule: string;
  confidence: string;
  sourcePrs: number[];
};

export type UiRuleDecision = {
  runId: string;
  ruleId: string;
  title: string;
  decision: string;
  confidence: string;
  reason: string;
};

export type UiExport = {
  runId: string;
  target: string;
  createdAt: string | null;
  exportedRuleCount: number;
  warnings: string[];
  hasProposedAgents: boolean;
  proposedAgentsText: string | null;
  summaryText: string | null;
};

type AnalysisManifest = {
  runId: string;
  mode: string;
  provider: string | null;
  createdAt: string;
  source?: {
    failureCandidateCount?: number;
  };
  files?: {
    input?: string | null;
    prompt?: string | null;
    response?: string | null;
    enrichedRecords?: string | null;
    clusters?: string | null;
    summary?: string | null;
  };
};

type RulesExportManifest = {
  runId?: string;
  target?: string;
  createdAt?: string;
  exportedRuleCount?: number;
  warnings?: string[];
};

export async function loadUiState(repoRoot: string, now = new Date()): Promise<UiState> {
  const paths = getTracebackPaths(repoRoot);
  const records = await readJsonFiles<NormalizedPullRequestRecord>(paths.records, (name) =>
    /^pr-\d+\.json$/.test(name),
  );
  const candidates = await readJsonFiles<FailureCandidate>(paths.failures, (name) => name.endsWith(".json"));
  const runs = await readRuns(repoRoot);
  const summary = buildSummary({ records, candidates, runs });
  const warnings = buildWarnings({ records, candidates, runs });

  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    repoRoot,
    summary,
    candidates: candidates.map(toUiCandidate),
    runs,
    clusters: runs.flatMap((run) => run.clusterItems),
    reviewDecisions: runs.flatMap((run) => run.reviewDecisionItems),
    draftRules: runs.flatMap((run) => run.draftRuleItems),
    ruleDecisions: runs.flatMap((run) => run.ruleDecisionItems),
    exportItems: runs.flatMap((run) => (run.exportItem ? [run.exportItem] : [])),
    warnings,
  };
}

export async function runUiServer(repoRoot: string, options: UiServerOptions): Promise<void> {
  const server = Bun.serve({
    hostname: options.host,
    port: options.port,
    async fetch(request) {
      const url = new URL(request.url);

      if (url.pathname === "/") {
        return htmlResponse(renderHtml());
      }

      if (url.pathname === "/api/state") {
        try {
          return jsonResponse(await loadUiState(repoRoot));
        } catch (error) {
          return jsonResponse(
            {
              error: error instanceof Error ? error.message : String(error),
            },
            500,
          );
        }
      }

      return new Response("Not found", { status: 404 });
    },
  });

  console.log(`Traceback UI running at ${server.url}`);
  await new Promise(() => {});
}

async function readRuns(repoRoot: string): Promise<UiRun[]> {
  const paths = getTracebackPaths(repoRoot);
  let entries: string[];
  try {
    entries = await readdir(paths.analysisRuns, { withFileTypes: true }).then((items) =>
      items.filter((item) => item.isDirectory()).map((item) => item.name),
    );
  } catch {
    return [];
  }

  const runs = await Promise.all(entries.sort().reverse().map((runId) => readRun(repoRoot, runId)));
  return runs.sort(compareRuns);
}

async function readRun(repoRoot: string, runId: string): Promise<UiRun> {
  const paths = getTracebackPaths(repoRoot);
  const runDir = path.join(paths.analysisRuns, runId);
  const manifest = await readJsonIfExists<AnalysisManifest>(path.join(runDir, "manifest.json"));
  const analysis = await readAnalysisOutput(runDir);
  const reviews = await readJsonIfExists<ReviewDecisionsFile>(
    path.join(paths.reviews, runId, "decisions.json"),
  );
  const draftRules = await readJsonIfExists<DraftRulesFile>(
    path.join(paths.rules, runId, "draft-rules.json"),
  );
  const ruleDecisions = await readJsonIfExists<RuleDecisionsFile>(
    path.join(paths.rules, runId, "rule-decisions.json"),
  );
  const exportManifest = await readJsonIfExists<RulesExportManifest>(
    path.join(paths.exports, runId, "manifest.json"),
  );
  const exportItem = await readExport(paths.exports, runId, exportManifest);
  const clusterItems = (analysis?.clusters ?? []).map((cluster) => ({
    runId,
    id: cluster.id,
    title: cluster.title,
    summary: cluster.summary,
    preventionRule: cluster.preventionRule,
    confidence: cluster.confidence,
    sourcePrs: cluster.sourcePrs,
    sourceCandidateIds: cluster.candidateIds,
  }));
  const reviewDecisionItems = (reviews?.decisions ?? []).map((decision) =>
    toUiReviewDecision(runId, decision),
  );
  const draftRuleItems = (draftRules?.rules ?? []).map((rule) => toUiDraftRule(runId, rule));
  const ruleDecisionItems = (ruleDecisions?.decisions ?? []).map((decision) =>
    toUiRuleDecision(runId, decision),
  );

  return {
    runId,
    createdAt: manifest?.createdAt ?? null,
    mode: manifest?.mode ?? "unknown",
    provider: manifest?.provider ?? null,
    failureCandidateCount: manifest?.source?.failureCandidateCount ?? 0,
    hasInput: await fileExists(path.join(runDir, manifest?.files?.input ?? "input.json")),
    hasPrompt: await fileExists(path.join(runDir, manifest?.files?.prompt ?? "prompt.md")),
    hasProviderOutput: Boolean(manifest?.files?.response || analysis),
    enrichedRecords: analysis?.enrichedRecords.length ?? 0,
    clusters: analysis?.clusters.length ?? 0,
    reviewDecisions: reviews?.decisions.length ?? 0,
    draftRules: draftRules?.rules.length ?? 0,
    ruleDecisions: ruleDecisions?.decisions.length ?? 0,
    exportedRules: exportItem?.exportedRuleCount ?? 0,
    hasProposedAgents: exportItem?.hasProposedAgents ?? false,
    warnings: exportItem?.warnings ?? [],
    clusterItems,
    reviewDecisionItems,
    draftRuleItems,
    ruleDecisionItems,
    exportItem,
  };
}

async function readExport(
  exportsRoot: string,
  runId: string,
  manifest: RulesExportManifest | null,
): Promise<UiExport | null> {
  if (!manifest) {
    return null;
  }

  const exportDir = path.join(exportsRoot, runId);
  const proposedAgentsText = await readTextIfExists(path.join(exportDir, "AGENTS.proposed.md"));
  const summaryText = await readTextIfExists(path.join(exportDir, "export-summary.md"));
  return {
    runId,
    target: manifest.target ?? "unknown",
    createdAt: manifest.createdAt ?? null,
    exportedRuleCount: manifest.exportedRuleCount ?? 0,
    warnings: manifest.warnings ?? [],
    hasProposedAgents: proposedAgentsText !== null,
    proposedAgentsText,
    summaryText,
  };
}

async function readAnalysisOutput(runDir: string): Promise<AnalysisOutput | null> {
  const enrichedRecords = await readJsonIfExists<AnalysisOutput["enrichedRecords"]>(
    path.join(runDir, "enriched-records.json"),
  );
  const clusters = await readJsonIfExists<AnalysisOutput["clusters"]>(path.join(runDir, "clusters.json"));
  const summary = await readJsonIfExists<AnalysisOutput["summary"]>(path.join(runDir, "summary.json"));

  if (!enrichedRecords && !clusters) {
    return null;
  }

  return {
    enrichedRecords: enrichedRecords ?? [],
    clusters: clusters ?? [],
    summary: summary ?? {
      overview: "",
      highestRiskPatterns: [],
      recommendedNextActions: [],
    },
  };
}

async function readJsonFiles<T>(
  dirPath: string,
  predicate: (entry: string) => boolean,
): Promise<T[]> {
  let entries: string[];
  try {
    entries = await readdir(dirPath);
  } catch {
    return [];
  }

  const values: Array<T | null> = await Promise.all(
    entries
      .filter(predicate)
      .sort()
      .map(async (entry) => readJsonIfExists<T>(path.join(dirPath, entry))),
  );

  return values.filter((value): value is T => value !== null);
}

async function readJsonIfExists<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function readTextIfExists(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function buildSummary({
  records,
  candidates,
  runs,
}: {
  records: NormalizedPullRequestRecord[];
  candidates: FailureCandidate[];
  runs: UiRun[];
}): UiSummary {
  return {
    importedPrs: records.length,
    failureCandidates: candidates.length,
    statusCounts: countCandidateStatuses(candidates),
    analysisRuns: runs.length,
    reviewDecisions: sum(runs, (run) => run.reviewDecisions),
    draftRules: sum(runs, (run) => run.draftRules),
    ruleDecisions: sum(runs, (run) => run.ruleDecisions),
    exports: runs.filter((run) => run.exportedRules > 0 || run.hasProposedAgents).length,
  };
}

function countCandidateStatuses(
  candidates: FailureCandidate[],
): Partial<Record<FailureCandidateStatus, number>> {
  const counts: Partial<Record<FailureCandidateStatus, number>> = {};
  for (const candidate of candidates) {
    counts[candidate.status] = (counts[candidate.status] ?? 0) + 1;
  }
  return counts;
}

function buildWarnings({
  records,
  candidates,
  runs,
}: {
  records: NormalizedPullRequestRecord[];
  candidates: FailureCandidate[];
  runs: UiRun[];
}): string[] {
  const warnings: string[] = [];

  if (records.length === 0) {
    warnings.push("No imported PR records found. Run `traceback import --prs <number>`.");
  }
  if (candidates.length === 0) {
    warnings.push("No failure candidates found. Run `traceback extract`.");
  }
  if (runs.length === 0) {
    warnings.push("No analysis runs found. Run `traceback analyze --dry-run`.");
  }
  if (candidates.length > 0 && candidates.every((candidate) => candidate.status === "candidate")) {
    warnings.push(
      "All extracted candidates are still marked `candidate`; thread-aware outcome detection is a known quality gap.",
    );
  }

  return warnings;
}

function toUiCandidate(candidate: FailureCandidate): UiCandidate {
  return {
    id: candidate.id,
    sourcePrNumber: candidate.sourcePrNumber,
    sourcePrUrl: candidate.sourcePrUrl,
    sourceCommentUrl: candidate.sourceCommentUrl,
    sourceType: candidate.sourceType,
    title: candidate.extractedTitle,
    category: candidate.candidateCategory,
    severity: candidate.candidateSeverity,
    confidence: candidate.confidence,
    status: candidate.status,
    evidenceExcerpt: candidate.evidenceExcerpt,
  };
}

function toUiReviewDecision(runId: string, decision: ReviewDecision): UiReviewDecision {
  return {
    runId,
    id: decision.id,
    title: decision.title ?? decision.id,
    decision: decision.decision ?? "unknown",
    confidence: decision.confidence ?? "unknown",
    sourcePrs: decision.sourcePrs ?? [],
    sourceCandidateIds: decision.sourceCandidateIds ?? [],
    reason: decision.reason ?? "",
  };
}

function toUiDraftRule(runId: string, rule: DraftRule): UiDraftRule {
  return {
    runId,
    id: rule.id,
    title: rule.title ?? rule.id,
    rule: rule.rule ?? "",
    confidence: rule.confidence ?? "unknown",
    sourcePrs: rule.sourcePrs ?? [],
  };
}

function toUiRuleDecision(runId: string, decision: RuleDecision): UiRuleDecision {
  return {
    runId,
    ruleId: decision.ruleId,
    title: decision.title ?? decision.ruleId,
    decision: decision.decision ?? "unknown",
    confidence: decision.confidence ?? "unknown",
    reason: decision.reason ?? "",
  };
}

function compareRuns(a: UiRun, b: UiRun): number {
  const aTime = a.createdAt ?? a.runId;
  const bTime = b.createdAt ?? b.runId;
  return bTime.localeCompare(aTime);
}

function sum<T>(values: T[], selector: (value: T) => number): number {
  return values.reduce((total, value) => total + selector(value), 0);
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function htmlResponse(html: string): Response {
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
    },
  });
}

function renderHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Traceback Review UI</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f7f4;
      --panel: #ffffff;
      --ink: #1e2420;
      --muted: #657068;
      --line: #d9ded8;
      --accent: #1f7a63;
      --accent-soft: #e5f3ee;
      --warn: #9a5b12;
      --warn-soft: #fff2d8;
      --bad: #9f2d2d;
      --good: #1f6f43;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      background: var(--bg);
      color: var(--ink);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.45;
    }

    header {
      padding: 24px clamp(16px, 3vw, 40px) 18px;
      border-bottom: 1px solid var(--line);
      background: var(--panel);
    }

    h1, h2, h3 { margin: 0; letter-spacing: 0; }
    h1 { font-size: 28px; }
    h2 { font-size: 18px; }
    h3 { font-size: 15px; }
    p { margin: 0; color: var(--muted); }

    main {
      display: grid;
      gap: 18px;
      padding: 20px clamp(16px, 3vw, 40px) 40px;
    }

    .topline {
      display: flex;
      flex-wrap: wrap;
      gap: 8px 14px;
      margin-top: 8px;
      color: var(--muted);
      font-size: 13px;
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 12px;
    }

    .card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 14px;
    }

    .metric {
      display: grid;
      gap: 4px;
      min-height: 76px;
    }

    .metric strong {
      font-size: 26px;
      line-height: 1;
    }

    .tabs {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }

    button {
      border: 1px solid var(--line);
      background: var(--panel);
      color: var(--ink);
      border-radius: 8px;
      padding: 8px 11px;
      font: inherit;
      cursor: pointer;
    }

    .run-select {
      width: 100%;
      text-align: left;
      padding: 14px;
    }

    button[aria-selected="true"] {
      border-color: var(--accent);
      background: var(--accent-soft);
      color: var(--accent);
    }

    .run-select[aria-current="true"] {
      border-color: var(--accent);
      background: var(--accent-soft);
    }

    .intro {
      max-width: 980px;
      color: var(--muted);
    }

    .overview {
      display: grid;
      gap: 14px;
    }

    .overview-head {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
    }

    .stage-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
      gap: 10px;
    }

    .stage {
      display: grid;
      gap: 6px;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px;
      background: #fbfbf9;
      min-width: 0;
    }

    .stage code, .proposal, .value {
      overflow-wrap: anywhere;
      word-break: break-word;
    }

    .legend {
      display: grid;
      gap: 8px;
      grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
    }

    .legend-item {
      display: grid;
      gap: 2px;
      color: var(--muted);
      font-size: 13px;
    }

    .section {
      display: none;
    }

    .section.active {
      display: grid;
      gap: 12px;
    }

    .list {
      display: grid;
      gap: 10px;
    }

    .row {
      display: grid;
      gap: 8px;
    }

    .run {
      grid-template-columns: minmax(190px, 1.2fr) repeat(6, minmax(96px, .7fr));
      align-items: center;
    }

    .candidate {
      grid-template-columns: minmax(260px, 1.4fr) repeat(4, minmax(120px, .7fr));
    }

    .run, .candidate {
      display: grid;
      gap: 10px;
    }

    .label {
      color: var(--muted);
      font-size: 12px;
    }

    .value {
      display: inline-block;
      max-width: 100%;
    }

    .pill {
      display: inline-flex;
      align-items: center;
      width: fit-content;
      border-radius: 999px;
      padding: 3px 8px;
      background: #f1f2ef;
      color: var(--muted);
      font-size: 12px;
      white-space: nowrap;
    }

    .pill.good { background: #e5f4ea; color: var(--good); }
    .pill.warn { background: var(--warn-soft); color: var(--warn); }
    .pill.bad { background: #f8e3e3; color: var(--bad); }

    .warnings {
      display: grid;
      gap: 8px;
    }

    .warning {
      border-color: #edcf9b;
      background: var(--warn-soft);
      color: #5d3b0d;
    }

    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }

    .proposal {
      margin: 0;
      white-space: pre-wrap;
      font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      color: var(--ink);
    }

    .empty {
      color: var(--muted);
      padding: 18px;
      text-align: center;
    }

    @media (max-width: 760px) {
      .run, .candidate {
        grid-template-columns: 1fr;
      }
      h1 { font-size: 24px; }
    }
  </style>
</head>
<body>
  <header>
    <h1>Traceback Review UI</h1>
    <div class="topline">
      <span id="repo-root"></span>
      <span id="generated-at"></span>
    </div>
  </header>
  <main>
    <section class="grid" id="summary"></section>
    <section class="warnings" id="warnings"></section>
    <section id="selected-run"></section>
    <nav class="tabs" aria-label="Traceback views">
      <button type="button" data-tab="runs" aria-selected="true">Runs</button>
      <button type="button" data-tab="candidates" aria-selected="false">Candidates</button>
      <button type="button" data-tab="clusters" aria-selected="false">AI clusters</button>
      <button type="button" data-tab="reviews" aria-selected="false">Review decisions</button>
      <button type="button" data-tab="rules" aria-selected="false">Rules & exports</button>
    </nav>
    <section class="section active" id="runs"></section>
    <section class="section" id="candidates"></section>
    <section class="section" id="clusters"></section>
    <section class="section" id="reviews"></section>
    <section class="section" id="rules"></section>
  </main>
  <script>
    const state = { data: null, selectedRunId: null };

    async function load() {
      const response = await fetch("/api/state");
      state.data = await response.json();
      if (!response.ok) throw new Error(state.data.error || "Could not load Traceback state");
      render();
    }

    function render() {
      const data = state.data;
      if (!state.selectedRunId || !data.runs.some((run) => run.runId === state.selectedRunId)) {
        state.selectedRunId = data.runs[0]?.runId ?? null;
      }
      document.getElementById("repo-root").textContent = data.repoRoot;
      document.getElementById("generated-at").textContent = "Generated " + formatDate(data.generatedAt);
      renderSummary(data.summary);
      renderWarnings(data.warnings);
      renderSelectedRun(data);
      renderRuns(data.runs);
      renderCandidates(data.candidates, data.summary.statusCounts);
      const selectedRun = getSelectedRun();
      renderClusters(selectedRun);
      renderReviewDecisions(selectedRun);
      renderRules(selectedRun);
    }

    function renderSummary(summary) {
      const items = [
        ["Imported PRs", summary.importedPrs],
        ["Candidates", summary.failureCandidates],
        ["Analysis runs", summary.analysisRuns],
        ["Review decisions", summary.reviewDecisions],
        ["Draft rules", summary.draftRules],
        ["Rule decisions", summary.ruleDecisions],
        ["Exports", summary.exports],
      ];
      document.getElementById("summary").innerHTML = items.map(([label, value]) => \`
        <article class="card metric">
          <span class="label">\${escapeHtml(label)}</span>
          <strong>\${value}</strong>
        </article>
      \`).join("");
    }

    function renderWarnings(warnings) {
      document.getElementById("warnings").innerHTML = warnings.map((warning) => \`
        <article class="card warning">\${escapeHtml(warning)}</article>
      \`).join("");
    }

    function renderSelectedRun(data) {
      const container = document.getElementById("selected-run");
      const run = getSelectedRun();
      if (!run) {
        container.innerHTML = \`<article class="card overview">\${emptyContent("No analysis run selected.")}</article>\`;
        return;
      }

      const provider = run.provider ? run.provider : "none";
      container.innerHTML = \`
        <article class="card overview">
          <div class="overview-head">
            <div>
              <span class="label">Selected run</span>
              <h2>\${escapeHtml(run.runId)}</h2>
              <p>Mode \${escapeHtml(run.mode)} · Provider \${escapeHtml(provider)} · \${escapeHtml(formatDate(run.createdAt))}</p>
            </div>
            <div>
              <span class="label">Provider output</span><br>
              \${statusPill(run.hasProviderOutput ? "present" : "missing", run.hasProviderOutput ? "good" : "warn")}
            </div>
          </div>
          <div class="grid">
            \${metric("Candidates", run.failureCandidateCount)}
            \${metric("Enriched records", run.enrichedRecords)}
            \${metric("Clusters", run.clusters)}
            \${metric("Review decisions", run.reviewDecisions)}
            \${metric("Draft rules", run.draftRules)}
            \${metric("Rule decisions", run.ruleDecisions)}
            \${metric("Exported rules", run.exportedRules)}
          </div>
          <div>
            <h3>Pipeline stages</h3>
            <div class="stage-grid">\${stageCards(data.summary, run)}</div>
          </div>
        </article>
      \`;
    }

    function renderRuns(runs) {
      const container = document.getElementById("runs");
      container.innerHTML = "<h2>Runs overview</h2><p class='intro'>Each row is an analysis run. Select a run to inspect its clusters, decisions, rules, and export output.</p>" + (runs.length ? \`
        <div class="list">
          \${runs.map((run) => \`
            <button type="button" class="run-select" data-run-id="\${escapeHtml(run.runId)}" aria-current="\${String(run.runId === state.selectedRunId)}">
              <span class="run">
                <span>
                  <strong>\${escapeHtml(run.runId)}</strong><br>
                  <span class="value">\${escapeHtml(formatDate(run.createdAt))}</span>
                </span>
                \${field("Mode", run.mode)}
                \${field("Candidates", run.failureCandidateCount)}
                \${field("Clusters", run.clusters)}
                \${field("Reviews", run.reviewDecisions)}
                \${field("Rules", run.draftRules)}
                <span>
                  <span class="label">Provider output</span><br>
                  \${statusPill(run.hasProviderOutput ? "present" : "missing", run.hasProviderOutput ? "good" : "warn")}
                </span>
              </span>
            </button>
          \`).join("")}
        </div>
      \` : empty("No analysis runs found."));
      container.querySelectorAll("[data-run-id]").forEach((button) => {
        button.addEventListener("click", () => {
          state.selectedRunId = button.dataset.runId;
          render();
        });
      });
    }

    function renderCandidates(candidates, statusCounts) {
      const container = document.getElementById("candidates");
      container.innerHTML = "<h2>Failure candidates</h2><p class='intro'>These are deterministic inputs extracted from imported PR evidence. They are candidates, not final confirmed failures.</p>" + renderStatusDistribution(statusCounts) + (candidates.length ? \`
        <div class="list">
          \${candidates.map((candidate) => \`
            <article class="card candidate">
              <div>
                <h3>\${escapeHtml(candidate.title)}</h3>
                <p>\${escapeHtml(candidate.evidenceExcerpt)}</p>
                <p>\${candidate.sourceCommentUrl ? link(candidate.sourceCommentUrl, "Source comment") : link(candidate.sourcePrUrl, "Source PR")}</p>
              </div>
              \${field("PR", "#" + candidate.sourcePrNumber)}
              \${field("Category", candidate.category)}
              \${field("Confidence", candidate.confidence)}
              \${field("Source", candidate.sourceType)}
              <div>
                <span class="label">Status</span><br>
                \${statusPill(candidate.status, statusTone(candidate.status))}
              </div>
            </article>
          \`).join("")}
        </div>
      \` : empty("No failure candidates found."));
    }

    function renderClusters(run) {
      const container = document.getElementById("clusters");
      const clusters = run?.clusterItems ?? [];
      container.innerHTML = "<h2>AI clusters</h2><p class='intro'>Clusters are provider-enriched groupings of related deterministic candidates for the selected run.</p>" + (clusters.length ? \`
        <div class="list">
          \${clusters.map((cluster) => \`
            <article class="card row">
              <div>
                <h3>\${escapeHtml(cluster.title)}</h3>
                <p>\${escapeHtml(cluster.summary)}</p>
              </div>
              <div>
                <span class="label">Run</span><br>
                <code>\${escapeHtml(cluster.runId)}</code>
              </div>
              \${field("Confidence", cluster.confidence)}
              \${field("Source PRs", cluster.sourcePrs.map((pr) => "#" + pr).join(", ") || "none")}
              <div>
                <span class="label">Prevention rule</span><br>
                <span>\${escapeHtml(cluster.preventionRule || "No prevention rule recorded.")}</span>
              </div>
            </article>
          \`).join("")}
        </div>
      \` : empty(run ? "No AI clusters found for the selected run. Provider output may be missing." : "No run selected."));
    }

    function renderReviewDecisions(run) {
      const container = document.getElementById("reviews");
      const decisions = run?.reviewDecisionItems ?? [];
      container.innerHTML = "<h2>Review decisions</h2><p class='intro'>Conservative review turns AI clusters into local decisions before any rule draft is generated.</p>" + renderReviewLegend() + (decisions.length ? \`
        <div class="list">
          \${decisions.map((decision) => \`
            <article class="card candidate">
              <div>
                <h3>\${escapeHtml(decision.title)}</h3>
                <p>\${escapeHtml(decision.reason || "No reason recorded.")}</p>
              </div>
              \${field("Run", decision.runId)}
              \${field("Decision", decision.decision)}
              \${field("Confidence", decision.confidence)}
              \${field("Source PRs", decision.sourcePrs.map((pr) => "#" + pr).join(", ") || "none")}
            </article>
          \`).join("")}
        </div>
      \` : empty(run ? "No review decisions found for the selected run." : "No run selected."));
    }

    function renderRules(run) {
      const container = document.getElementById("rules");
      if (!run) {
        container.innerHTML = "<h2>Rules and exports</h2>" + empty("No run selected.");
        return;
      }
      const draftRules = run.draftRuleItems ?? [];
      const ruleDecisions = run.ruleDecisionItems ?? [];
      const exportItem = run.exportItem;
      const runHtml = \`
        <div class="list">
          <article class="card run">
            <div>
              <h3>\${escapeHtml(run.runId)}</h3>
              <p>\${run.warnings.length ? escapeHtml(run.warnings.join(" ")) : "No export warnings."}</p>
            </div>
            \${field("Draft rules", run.draftRules)}
            \${field("Rule decisions", run.ruleDecisions)}
            \${field("Exported rules", run.exportedRules)}
            <div>
              <span class="label">AGENTS proposal</span><br>
              \${statusPill(run.hasProposedAgents ? "present" : "missing", run.hasProposedAgents ? "good" : "warn")}
            </div>
          </article>
        </div>
      \`;
      const rulesHtml = draftRules.length ? \`
        <h3>Draft rules</h3>
        <div class="list">
          \${draftRules.map((rule) => \`
            <article class="card row">
              <h3>\${escapeHtml(rule.title)}</h3>
              <p>\${escapeHtml(rule.rule)}</p>
              \${field("Run", rule.runId)}
              \${field("Confidence", rule.confidence)}
            </article>
          \`).join("")}
        </div>
      \` : "";
      const decisionsHtml = ruleDecisions.length ? \`
        <h3>Rule decisions</h3>
        \${renderRuleLegend()}
        <div class="list">
          \${ruleDecisions.map((decision) => \`
            <article class="card row">
              <h3>\${escapeHtml(decision.title)}</h3>
              <p>\${escapeHtml(decision.reason || "No reason recorded.")}</p>
              \${field("Run", decision.runId)}
              \${field("Decision", decision.decision)}
              \${field("Confidence", decision.confidence)}
            </article>
          \`).join("")}
        </div>
      \` : "";
      const exportHtml = exportItem ? \`
        <h3>Proposed export</h3>
        <article class="card row">
          \${field("Target", exportItem.target)}
          \${field("Created", formatDate(exportItem.createdAt))}
          \${field("Exported rules", exportItem.exportedRuleCount)}
          \${field("Warnings", exportItem.warnings.length ? exportItem.warnings.join(" ") : "none")}
          \${exportItem.proposedAgentsText ? \`<pre class="proposal">\${escapeHtml(exportItem.proposedAgentsText)}</pre>\` : "<p>No AGENTS.proposed.md was written for this run.</p>"}
        </article>
      \` : "";
      container.innerHTML = "<h2>Rules and exports</h2><p class='intro'>Draft rules are working artifacts. Rule decisions decide what can be exported. The proposed export is reviewable guidance and is not applied automatically.</p>" + runHtml + rulesHtml + decisionsHtml + exportHtml;
    }

    function field(label, value) {
      return \`<span><span class="label">\${escapeHtml(label)}</span><br><span class="value">\${escapeHtml(String(value))}</span></span>\`;
    }

    function metric(label, value) {
      return \`
        <article class="metric">
          <span class="label">\${escapeHtml(label)}</span>
          <strong>\${escapeHtml(String(value))}</strong>
        </article>
      \`;
    }

    function stageCards(summary, run) {
      return [
        stage("Import", summary.importedPrs > 0, summary.importedPrs + " PR records", "traceback import --prs <number>"),
        stage("Extract", summary.failureCandidates > 0, summary.failureCandidates + " candidates", "traceback extract"),
        stage("Analyze", run.hasInput && run.hasPrompt, run.hasProviderOutput ? "provider output present" : "input and prompt only", "traceback analyze --provider openai"),
        stage("Review", run.reviewDecisions > 0, run.reviewDecisions + " decisions", "traceback review --run " + run.runId + " --policy conservative"),
        stage("Draft rules", run.draftRules > 0, run.draftRules + " draft rules", "traceback rules --run " + run.runId),
        stage("Rule review", run.ruleDecisions > 0, run.ruleDecisions + " rule decisions", "traceback rules review --run " + run.runId + " --policy conservative"),
        stage("Export", run.exportItem !== null, run.exportedRules + " exported rules", "traceback rules export --run " + run.runId + " --target agents-md"),
      ].join("");
    }

    function stage(label, isPresent, detail, command) {
      return \`
        <div class="stage">
          <strong>\${escapeHtml(label)}</strong>
          \${statusPill(isPresent ? "present" : "missing", isPresent ? "good" : "warn")}
          <span class="value">\${escapeHtml(detail)}</span>
          \${isPresent ? "" : \`<code>\${escapeHtml(command)}</code>\`}
        </div>
      \`;
    }

    function renderReviewLegend() {
      return \`
        <div class="card legend">
          \${legendItem("accepted", "High-confidence cluster backed by review-comment evidence.")}
          \${legendItem("needs_validation", "Low-confidence or PR-body-only evidence needs human validation.")}
          \${legendItem("needs_cluster", "An enriched record was not represented in any cluster.")}
          \${legendItem("needs_review", "Source references or evidence shape need manual review.")}
        </div>
      \`;
    }

    function renderRuleLegend() {
      return \`
        <div class="card legend">
          \${legendItem("accepted", "Exportable as-is.")}
          \${legendItem("edited", "Exportable using edited instruction fields.")}
          \${legendItem("needs_edit", "Not exportable until edited.")}
          \${legendItem("rejected", "Not exportable.")}
        </div>
      \`;
    }

    function renderStatusDistribution(statusCounts) {
      const entries = Object.entries(statusCounts || {});
      if (!entries.length) {
        return "";
      }
      return \`
        <article class="card row">
          <h3>Status distribution</h3>
          <p>Thread-aware status detection uses same-thread replies and GitHub review-thread state. Superseded means the source thread is outdated without stronger outcome evidence.</p>
          <div class="tabs">
            \${entries.map(([status, count]) => statusPill(status + ": " + count, statusTone(status))).join("")}
          </div>
        </article>
      \`;
    }

    function legendItem(label, description) {
      return \`<span class="legend-item"><strong>\${escapeHtml(label)}</strong><span>\${escapeHtml(description)}</span></span>\`;
    }

    function statusPill(label, tone) {
      return \`<span class="pill \${tone}">\${escapeHtml(label)}</span>\`;
    }

    function statusTone(status) {
      if (status === "resolved" || status === "accepted") return "good";
      if (status === "rejected") return "bad";
      if (status === "candidate" || status === "contested") return "warn";
      return "";
    }

    function link(href, label) {
      return \`<a href="\${escapeHtml(href)}" target="_blank" rel="noreferrer">\${escapeHtml(label)}</a>\`;
    }

    function empty(message) {
      return \`<article class="card empty">\${escapeHtml(message)}</article>\`;
    }

    function emptyContent(message) {
      return \`<div class="empty">\${escapeHtml(message)}</div>\`;
    }

    function getSelectedRun() {
      return state.data?.runs.find((run) => run.runId === state.selectedRunId) ?? null;
    }

    function formatDate(value) {
      if (!value) return "unknown time";
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
    }

    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[char]));
    }

    document.querySelectorAll("[data-tab]").forEach((button) => {
      button.addEventListener("click", () => {
        document.querySelectorAll("[data-tab]").forEach((tab) => {
          tab.setAttribute("aria-selected", String(tab === button));
        });
        document.querySelectorAll(".section").forEach((section) => {
          section.classList.toggle("active", section.id === button.dataset.tab);
        });
      });
    });

    load().catch((error) => {
      document.querySelector("main").innerHTML = \`<article class="card warning">\${escapeHtml(error.message)}</article>\`;
    });
  </script>
</body>
</html>`;
}
