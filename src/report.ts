import type { CandidateAgentMarker, NormalizedPullRequestRecord } from "./types";

export function generateImportSummary(records: NormalizedPullRequestRecord[]): string {
  const generatedAt = new Date().toISOString();
  const repository = records[0]?.repository;
  const mergedCount = records.filter((record) => record.merged).length;
  const markerCounts = countMarkers(records.flatMap((record) => record.candidateAgentMarkers));

  const lines = [
    "# Traceback AI Import Summary",
    "",
    `Generated: ${generatedAt}`,
    "",
    "## Repository",
    "",
    repository
      ? `- GitHub: ${repository.owner}/${repository.repo}`
      : "- GitHub: no records imported yet",
    repository ? `- Origin: ${repository.remoteUrl}` : "",
    "",
    "## Totals",
    "",
    `- Pull requests: ${records.length}`,
    `- Merged pull requests: ${mergedCount}`,
    `- Issue comments: ${sum(records, (record) => record.issueComments.length)}`,
    `- Review comments: ${sum(records, (record) => record.reviewComments.length)}`,
    `- Reviews: ${sum(records, (record) => record.reviews.length)}`,
    `- Candidate AI/agent markers: ${sum(records, (record) => record.candidateAgentMarkers.length)}`,
    "",
    "## Candidate Markers",
    "",
    ...renderMarkerCounts(markerCounts),
    "",
    "## Imported Pull Requests",
    "",
    "| PR | Title | State | Merged | Author | Updated | Comments | Review Comments | Markers |",
    "| --- | --- | --- | --- | --- | --- | ---: | ---: | ---: |",
    ...records.map(renderRecordRow),
    "",
  ];

  return lines.filter((line) => line !== null).join("\n");
}

function renderMarkerCounts(markerCounts: Map<string, number>): string[] {
  if (markerCounts.size === 0) {
    return ["No candidate AI/agent markers found."];
  }

  return [...markerCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([marker, count]) => `- ${marker}: ${count}`);
}

function renderRecordRow(record: NormalizedPullRequestRecord): string {
  const cells = [
    `[#${record.prNumber}](${record.url})`,
    escapeTable(record.title),
    record.state,
    record.merged ? "yes" : "no",
    escapeTable(record.author ?? ""),
    record.updatedAt ?? "",
    record.issueComments.length.toString(),
    record.reviewComments.length.toString(),
    record.candidateAgentMarkers.length.toString(),
  ];

  return `| ${cells.join(" | ")} |`;
}

function countMarkers(markers: CandidateAgentMarker[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const marker of markers) {
    counts.set(marker.marker, (counts.get(marker.marker) ?? 0) + 1);
  }
  return counts;
}

function sum<T>(items: T[], fn: (item: T) => number): number {
  return items.reduce((total, item) => total + fn(item), 0);
}

function escapeTable(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
