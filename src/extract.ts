import type {
  FailureCandidate,
  FailureCandidateCategory,
  FailureCandidateConfidence,
  FailureCandidateSeverity,
  FailureCandidateSourceType,
  FailureCandidateStatus,
  NormalizedPullRequestRecord,
} from "./types";

type SourceItem = {
  id: number;
  sourceType: FailureCandidateSourceType;
  author: string | null;
  body: string;
  url: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

const FINDING_PATTERNS: RegExp[] = [
  /\bbug\b/i,
  /\bbreaks?\b/i,
  /\bbroken\b/i,
  /\brisk\b/i,
  /\bleak\b/i,
  /\bregression\b/i,
  /\bmissing\b/i,
  /\bdoes not\b/i,
  /\bdoesn't\b/i,
  /\bfails?\b/i,
  /\bincorrect\b/i,
  /\bunsafe\b/i,
  /\bhardcoded\b/i,
  /\bstale\b/i,
  /\bdrops?\b/i,
  /\bdropped\b/i,
  /\blost\b/i,
  /\bduplicated\b/i,
  /\binconsistent\b/i,
  /\bsilently\b/i,
  /\bthrows\b/i,
  /\bcrash\b/i,
  /\bRangeError\b/i,
  /\bauth\b/i,
  /\bcookie\b/i,
  /\bauthorization\b/i,
  /\bsecret\b/i,
  /\btoken\b/i,
  /\btiming attack\b/i,
  /\blocalStorage\b/i,
  /\bsessionStorage\b/i,
  /\bquery\b/i,
  /\bsearch\b/i,
  /\bredirect\b/i,
  /\bpreview\b/i,
  /\bgenerated output\b/i,
  /\bdownloaded\b/i,
  /\brenderer\b/i,
  /\brefetch\b/i,
  /\bDate\.now\(\)/i,
  /\bMath\.random\(\)/i,
];

const AGENT_MARKERS: Array<[marker: string, pattern: RegExp]> = [
  ["chatgpt-codex-connector", /chatgpt-codex-connector/i],
  ["Claude Code", /\bClaude Code\b/i],
  ["Generated with Claude Code", /Generated with Claude Code/i],
  ["Co-Authored-By: Claude", /Co-Authored-By:\s*Claude/i],
  ["Cursor", /\bCursor\b/i],
  ["Jules", /\bJules\b/i],
  ["Aider", /\bAider\b/i],
  ["codex", /\bcodex\b/i],
  ["agent", /\bagent\b/i],
  ["bot", /\bbot\b|\[bot\]/i],
];

const CATEGORY_PATTERNS: Array<{
  category: FailureCandidateCategory;
  patterns: RegExp[];
}> = [
  {
    category: "security_privacy_regression",
    patterns: [
      /\bcookie\b/i,
      /\bauthorization\b/i,
      /\bsecret\b/i,
      /\btoken\b/i,
      /\bleak\b/i,
      /\btiming attack\b/i,
      /\bunsafe\b/i,
      /\bauth\b/i,
    ],
  },
  {
    category: "environment_config_contract_violation",
    patterns: [
      /\bhardcoded\b/i,
      /\bAPP_URL\b/i,
      /\bWEB_URL\b/i,
      /\bVITE_APP_URL\b/i,
      /\benvironment\b/i,
      /\bstaging\b/i,
      /\bpreview\b/i,
      /\bself-hosted\b/i,
      /\bproduction domain\b/i,
    ],
  },
  {
    category: "preview_output_parity_failure",
    patterns: [
      /\bpreview\b/i,
      /\bgenerated image\b/i,
      /\bdownloaded\b/i,
      /\bPNG\b/i,
      /\brenderer\b/i,
      /\boutput\b/i,
      /\bcustomization UI\b/i,
      /\bdoes not render\b/i,
      /\bomits?\b/i,
    ],
  },
  {
    category: "query_state_preservation_failure",
    patterns: [
      /\bquery\b/i,
      /\bsearch\b/i,
      /\bredirect\b/i,
      /\bpathname\b/i,
      /\blocation\.state\b/i,
      /\bprotected route\b/i,
      /\blogin\b/i,
      /\bsignup\b/i,
    ],
  },
  {
    category: "stale_persisted_intent",
    patterns: [
      /\blocalStorage\b/i,
      /\bsessionStorage\b/i,
      /\bstale\b/i,
      /\bpersisted intent\b/i,
      /\bconsume\b/i,
      /\bstored intent\b/i,
    ],
  },
  {
    category: "user_input_loss",
    patterns: [
      /\breset\b/i,
      /\brefetch\b/i,
      /\bediting\b/i,
      /\boverwritten\b/i,
      /\bdata loss\b/i,
      /\bmodal\b/i,
    ],
  },
  {
    category: "lifecycle_ordering_bug",
    patterns: [
      /\binit\b/i,
      /\breset\b/i,
      /\bidentify\b/i,
      /\bpageview\b/i,
      /\bordering\b/i,
      /\blifecycle\b/i,
      /\bdistinct_id\b/i,
    ],
  },
  {
    category: "render_time_side_effect",
    patterns: [
      /\bDate\.now\(\)/i,
      /\bMath\.random\(\)/i,
      /\brender\b/i,
      /\bre-render\b/i,
      /\brefetch\b/i,
      /\bflicker\b/i,
      /\bspam\b/i,
    ],
  },
  {
    category: "parser_permissiveness",
    patterns: [
      /\bBuffer\.from\b/i,
      /\bhex\b/i,
      /\bbase64\b/i,
      /\btrailing\b/i,
      /\bmalformed\b/i,
      /\bcanonical\b/i,
      /\bparser\b/i,
      /\bdecode\b/i,
    ],
  },
  {
    category: "overbroad_change",
    patterns: [/\bunrelated\b/i, /\btoo broad\b/i, /\bscope\b/i, /\bchanged unrelated\b/i],
  },
  {
    category: "context_omission",
    patterns: [
      /\bexisting\b/i,
      /\bhelper\b/i,
      /\bcontract\b/i,
      /\bconvention\b/i,
      /\balready\b/i,
      /\bshould reuse\b/i,
    ],
  },
];

const RESOLVED_PATTERNS = [/\bfixed in\b/i, /\baddressed in\b/i, /\bresolved\b/i];
const ACCEPTED_PATTERNS = [
  /\bgood catch\b/i,
  /\bfixed\b/i,
  /\bvalid\b/i,
  /\baddressed\b/i,
  /\bdone\b/i,
  /\bagreed\b/i,
  /\byou are right\b/i,
  /\bthis is valid\b/i,
];
const REJECTED_PATTERNS = [
  /\bdisagree\b/i,
  /\bnot valid\b/i,
  /\bfalse positive\b/i,
  /\bleaving as-is\b/i,
  /\bleaving as is\b/i,
  /\bnot an issue\b/i,
  /\bintended\b/i,
  /\bby design\b/i,
];
const CONTESTED_PATTERNS = [
  /\bthoughts\?/i,
  /\bis this right\?/i,
  /\bI think\b/i,
  /\bcan you confirm\b/i,
  /\bnot sure\b/i,
];

export function extractFailureCandidates(records: NormalizedPullRequestRecord[]): FailureCandidate[] {
  const candidates = records.flatMap(extractFromRecord);
  return candidates.sort(compareCandidates);
}

export function detectAgentMarkers(body: string, author: string | null = null): string[] {
  const value = `${author ?? ""}\n${body}`;
  const markers: string[] = [];

  for (const [marker, pattern] of AGENT_MARKERS) {
    if (pattern.test(value)) {
      markers.push(marker);
    }
  }

  return markers;
}

export function detectSeverity(body: string): FailureCandidateSeverity | null {
  if (/\b(P0|CRITICAL)\b/i.test(body)) {
    return "high";
  }
  if (/\b(P1|HIGH)\b/i.test(body)) {
    return "high";
  }
  if (/\b(P2|MEDIUM)\b/i.test(body)) {
    return "medium";
  }
  if (/\b(P3|LOW)\b/i.test(body)) {
    return "low";
  }
  return null;
}

export function detectStatus(sourceBody: string, nearbyReplies: string[]): FailureCandidateStatus {
  const replyText = nearbyReplies.join("\n");
  if (matchesAny(replyText, RESOLVED_PATTERNS)) {
    return "resolved";
  }
  if (matchesAny(replyText, REJECTED_PATTERNS)) {
    return "rejected";
  }
  if (matchesAny(replyText, ACCEPTED_PATTERNS)) {
    return "accepted";
  }
  if (matchesAny(`${sourceBody}\n${replyText}`, CONTESTED_PATTERNS)) {
    return "contested";
  }
  return "candidate";
}

export function detectCategory(body: string): FailureCandidateCategory {
  let bestCategory: FailureCandidateCategory = "unknown";
  let bestScore = 0;

  for (const { category, patterns } of CATEGORY_PATTERNS) {
    const score = patterns.filter((pattern) => pattern.test(body)).length;
    if (score > bestScore) {
      bestCategory = category;
      bestScore = score;
    }
  }

  return bestCategory;
}

function extractFromRecord(record: NormalizedPullRequestRecord): FailureCandidate[] {
  const sources = collectSources(record);
  const replyBodies = sources.map((source) => source.body).filter(Boolean);
  const candidates: FailureCandidate[] = [];

  for (const source of sources) {
    if (!isCandidateFinding(source.body)) {
      continue;
    }

    const nearbyReplies = replyBodies.filter((body) => body !== source.body);
    candidates.push({
      schemaVersion: 1,
      id: `failure-pr-${record.prNumber}-${source.sourceType}-${source.id}`,
      sourcePrNumber: record.prNumber,
      sourcePrUrl: record.url,
      sourceCommentUrl: source.url,
      sourceAuthor: source.author,
      sourceType: source.sourceType,
      extractedTitle: extractTitle(source.body),
      evidenceExcerpt: extractEvidenceExcerpt(source.body),
      candidateCategory: detectCategory(source.body),
      candidateSeverity: detectSeverity(source.body),
      confidence: detectConfidence(source, record),
      status: detectStatus(source.body, nearbyReplies),
      detectedAgentMarkers: detectAgentMarkers(source.body, source.author),
      createdAt: source.createdAt,
      updatedAt: source.updatedAt,
      notes: [`Extracted deterministically from ${source.sourceType} keyword matches.`],
    });
  }

  return candidates;
}

function collectSources(record: NormalizedPullRequestRecord): SourceItem[] {
  return [
    ...record.reviewComments.map((comment) => ({
      id: comment.id,
      sourceType: "review_comment" as const,
      author: comment.author,
      body: comment.body,
      url: comment.url,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
    })),
    ...record.reviews.map((review) => ({
      id: review.id,
      sourceType: "review" as const,
      author: review.author,
      body: review.body,
      url: review.url,
      createdAt: review.submittedAt,
      updatedAt: review.submittedAt,
    })),
    ...record.issueComments.map((comment) => ({
      id: comment.id,
      sourceType: "issue_comment" as const,
      author: comment.author,
      body: comment.body,
      url: comment.url,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
    })),
    {
      id: record.prNumber,
      sourceType: "pr_body",
      author: record.author,
      body: record.body,
      url: null,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    },
  ];
}

function isCandidateFinding(body: string): boolean {
  return matchesAny(body, FINDING_PATTERNS);
}

function detectConfidence(
  source: SourceItem,
  record: NormalizedPullRequestRecord,
): FailureCandidateConfidence {
  const hasAgentMarker = detectAgentMarkers(source.body, source.author).length > 0;
  const recordHasAgentMarker = record.candidateAgentMarkers.length > 0;

  if (source.sourceType === "review_comment" && (hasAgentMarker || recordHasAgentMarker)) {
    return "high";
  }
  if (source.sourceType === "review_comment" || source.sourceType === "review") {
    return "medium";
  }
  if (source.sourceType === "issue_comment" && hasAgentMarker) {
    return "medium";
  }
  if (source.sourceType === "issue_comment") {
    return "medium";
  }
  return "low";
}

function extractTitle(body: string): string {
  const normalized =
    cleanMarkdown(body)
      .split("\n")
      .map((line) => line.replace(/^>\s?/, "").replace(/^[-*]\s+/, "").trim())
      .find(Boolean) ?? "";
  const firstSentence = normalized.match(/^[^.!?\n]+[.!?]?/)?.[0] ?? normalized;
  return truncate(firstSentence, 120);
}

function extractEvidenceExcerpt(body: string): string {
  return truncate(normalizeWhitespace(stripMarkdownNoise(body)), 320);
}

function stripMarkdownNoise(value: string): string {
  return cleanMarkdown(value)
    .split("\n")
    .map((line) => line.replace(/^>\s?/, "").replace(/^[-*]\s+/, "").trim())
    .filter(Boolean)
    .join(" ");
}

function cleanMarkdown(value: string): string {
  return value
    .replace(/!\[[^\]]*]\([^)]+\)/g, "")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/<\/?[^>]+>/g, "")
    .replace(/[*`#]/g, "");
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 1).trimEnd()}...`;
}

function matchesAny(value: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

function compareCandidates(a: FailureCandidate, b: FailureCandidate): number {
  return (
    b.sourcePrNumber - a.sourcePrNumber ||
    sourceTypeRank(a.sourceType) - sourceTypeRank(b.sourceType) ||
    a.id.localeCompare(b.id)
  );
}

function sourceTypeRank(sourceType: FailureCandidateSourceType): number {
  switch (sourceType) {
    case "review_comment":
      return 0;
    case "review":
      return 1;
    case "issue_comment":
      return 2;
    case "pr_body":
      return 3;
  }
}
