import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { getTracebackPaths } from "./storage";
import type { AnalysisOutput } from "./analyze";
import type { ReviewDecision, ReviewDecisionsFile } from "./review";
import type { DraftRule, DraftRulesFile } from "./rules";
import type { RuleDecision, RuleDecisionsFile } from "./rules-review";
import type { FailureCandidate, NormalizedPullRequestRecord } from "./types";

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
  warnings: string[];
};

export type UiSummary = {
  importedPrs: number;
  failureCandidates: number;
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
    exportedRules: exportManifest?.exportedRuleCount ?? 0,
    hasProposedAgents: await fileExists(path.join(paths.exports, runId, "AGENTS.proposed.md")),
    warnings: exportManifest?.warnings ?? [],
    clusterItems,
    reviewDecisionItems,
    draftRuleItems,
    ruleDecisionItems,
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
    analysisRuns: runs.length,
    reviewDecisions: sum(runs, (run) => run.reviewDecisions),
    draftRules: sum(runs, (run) => run.draftRules),
    ruleDecisions: sum(runs, (run) => run.ruleDecisions),
    exports: runs.filter((run) => run.exportedRules > 0 || run.hasProposedAgents).length,
  };
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

    button[aria-selected="true"] {
      border-color: var(--accent);
      background: var(--accent-soft);
      color: var(--accent);
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
      grid-template-columns: minmax(170px, 1.2fr) repeat(6, minmax(82px, .7fr));
      align-items: center;
    }

    .candidate {
      grid-template-columns: minmax(220px, 1.4fr) repeat(4, minmax(100px, .7fr));
    }

    .run, .candidate {
      display: grid;
      gap: 10px;
    }

    .label {
      color: var(--muted);
      font-size: 12px;
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
    const state = { data: null };

    async function load() {
      const response = await fetch("/api/state");
      state.data = await response.json();
      if (!response.ok) throw new Error(state.data.error || "Could not load Traceback state");
      render();
    }

    function render() {
      const data = state.data;
      document.getElementById("repo-root").textContent = data.repoRoot;
      document.getElementById("generated-at").textContent = "Generated " + formatDate(data.generatedAt);
      renderSummary(data.summary);
      renderWarnings(data.warnings);
      renderRuns(data.runs);
      renderCandidates(data.candidates);
      renderClusters(data.clusters);
      renderReviewDecisions(data.reviewDecisions);
      renderRules(data.runs, data.draftRules, data.ruleDecisions);
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

    function renderRuns(runs) {
      const container = document.getElementById("runs");
      container.innerHTML = "<h2>Runs overview</h2>" + (runs.length ? \`
        <div class="list">
          \${runs.map((run) => \`
            <article class="card run">
              <div>
                <h3>\${escapeHtml(run.runId)}</h3>
                <p>\${escapeHtml(formatDate(run.createdAt))}</p>
              </div>
              \${field("Mode", run.mode)}
              \${field("Candidates", run.failureCandidateCount)}
              \${field("Clusters", run.clusters)}
              \${field("Reviews", run.reviewDecisions)}
              \${field("Rules", run.draftRules)}
              <div>
                <span class="label">Provider output</span><br>
                \${statusPill(run.hasProviderOutput ? "present" : "missing", run.hasProviderOutput ? "good" : "warn")}
              </div>
            </article>
          \`).join("")}
        </div>
      \` : empty("No analysis runs found."));
    }

    function renderCandidates(candidates) {
      const container = document.getElementById("candidates");
      container.innerHTML = "<h2>Failure candidates</h2>" + (candidates.length ? \`
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
                \${statusPill(candidate.status, candidate.status === "candidate" ? "warn" : "good")}
              </div>
            </article>
          \`).join("")}
        </div>
      \` : empty("No failure candidates found."));
    }

    function renderClusters(clusters) {
      const container = document.getElementById("clusters");
      container.innerHTML = "<h2>AI clusters</h2>" + (clusters.length ? \`
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
      \` : empty("No AI clusters found. Provider output may be missing for these runs."));
    }

    function renderReviewDecisions(decisions) {
      const container = document.getElementById("reviews");
      container.innerHTML = "<h2>Review decisions</h2>" + (decisions.length ? \`
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
      \` : empty("No review decisions found for the available runs."));
    }

    function renderRules(runs, draftRules, ruleDecisions) {
      const rows = runs.filter((run) => run.draftRules || run.ruleDecisions || run.exportedRules || run.hasProposedAgents);
      const container = document.getElementById("rules");
      const runHtml = rows.length ? \`
        <div class="list">
          \${rows.map((run) => \`
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
          \`).join("")}
        </div>
      \` : empty("No draft rules or exports found.");
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
      container.innerHTML = "<h2>Rules and exports</h2>" + runHtml + rulesHtml + decisionsHtml;
    }

    function field(label, value) {
      return \`<div><span class="label">\${escapeHtml(label)}</span><br><span>\${escapeHtml(String(value))}</span></div>\`;
    }

    function statusPill(label, tone) {
      return \`<span class="pill \${tone}">\${escapeHtml(label)}</span>\`;
    }

    function link(href, label) {
      return \`<a href="\${escapeHtml(href)}" target="_blank" rel="noreferrer">\${escapeHtml(label)}</a>\`;
    }

    function empty(message) {
      return \`<article class="card empty">\${escapeHtml(message)}</article>\`;
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
