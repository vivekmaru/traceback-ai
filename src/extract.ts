import type {
  FailureCandidate,
  FailureCandidateCategory,
  FailureCandidateConfidence,
  FailureCandidateSeverity,
  FailureCandidateSourceType,
  FailureCandidateStatus,
  NormalizedPullRequestRecord,
  NormalizedReviewThread,
} from "./types";

type SourceItem = {
  id: number;
  sourceType: FailureCandidateSourceType;
  author: string | null;
  body: string;
  url: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  inReplyToId: number | null;
};

type StatusThread = Pick<NormalizedReviewThread, "isResolved" | "isOutdated">;

const FAILURE_CUE_PATTERNS: RegExp[] = [
  /\bbug\b/i,
  /\bbreaks?\b/i,
  /\bbroken\b/i,
  /\brisk\b/i,
  /\bleak\b/i,
  /\bregression\b/i,
  /\broot cause\b/i,
  /\bmissing\b/i,
  /\bomits?\b/i,
  /\bomitted\b/i,
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
  /\bmalformed\b/i,
  /\btampered\b/i,
  /\bresets?\b/i,
  /\boverwrites?\b/i,
  /\boverwritten\b/i,
  /\bforeign-key violation\b/i,
  /\bgeneric\s+`?500`?\b/i,
  /\bremoves?\b.{0,80}\b(?:existence check|validation|guard|check)\b/i,
  /\bdeleted\b.{0,80}\b(?:insert|transaction|foreign-key|500)\b/i,
  /\bsensitive\b/i,
  /\bforward(?:s|ed|ing)?\b.*\bheaders?\b/i,
  /\bheaders?\b.*\bforwarded\b/i,
  /\bnever draws?\b/i,
  /\bdoes not (?:render|preserve|include|clear|match|work|return|show|appear)\b/i,
  /\bdoesn['’]?t (?:render|preserve|include|clear|match|work|return|show|appear)\b/i,
];

const PR_BODY_STRONG_SIGNAL_PATTERNS: RegExp[] = [
  /\broot cause\b/i,
  /\bvulnerability\b/i,
  /\bregression\b/i,
  /\bincident\b/i,
  /\bbug\b/i,
  /\bfailure\b/i,
  /\bcrash\b/i,
  /\bbroken\b/i,
  /\bleak\b/i,
  /\bunsafe\b/i,
  /\btampered\b/i,
  /\battack\b/i,
  /\bauth\b/i,
  /\bsecret\b/i,
  /\btoken\b/i,
  /\btiming attack\b/i,
];

const PR_BODY_FEATURE_SUMMARY_PATTERNS: RegExp[] = [
  /(?:^|\n)\s*#*\s*summary\b[\s\S]{0,600}\b(?:add|adds|added|implement|implemented|write|writes|document|documents|test|tests|export|exports|analyze|rules|provider|artifacts)\b/i,
];

const PR_BODY_EXPLICIT_FAILURE_PATTERNS: RegExp[] = [
  /\broot cause\b/i,
  /\bvulnerability\b/i,
  /\bregression\b/i,
  /\bincident\b/i,
  /\bbug\b/i,
  /\bfailure\b/i,
  /\bcrash\b/i,
  /\bbroken\b/i,
  /\bleak\b/i,
  /\bunsafe\b/i,
  /\btampered\b/i,
  /\battack\b/i,
  /\btiming attack\b/i,
];

const PR_BODY_FEATURE_SUMMARY_FAILURE_CUE_PATTERNS: RegExp[] = [
  /\b(?:breaks?|fails?|drops?|dropped|lost|omits?|omitted|incorrect|unsafe|hardcoded|stale|overwrites?|leaks?)\b.{0,120}\b(?:because|when|while|if|after|before|instead|caus(?:e|es|ing)|users?|data|state|request|upload|redirect|headers?|token|auth|intermittently|by)\b/i,
  /\b(?:because|when|while|if|after|before|instead|users?|data|state|request|upload|redirect|headers?|token|auth)\b.{0,120}\b(?:breaks?|fails?|drops?|dropped|lost|omits?|omitted|incorrect|unsafe|hardcoded|stale|overwrites?|leaks?)\b/i,
  /\bfails?\b.{0,80}\b(?:malformed|invalid|parser|parse|parsing|decode|input|error|exception|request|upload|render|redirect|headers?|token|auth|state|data)\b/i,
  /\b(?:malformed|invalid|parser|parse|parsing|decode|input|error|exception|request|upload|render|redirect|headers?|token|auth|state|data)\b.{0,80}\bfails?\b/i,
  /\b(?:malformed|invalid|parser|parse|parsing|decode|input)\b.{0,80}\bcannot parse\b/i,
  /\bcannot parse\b.{0,80}\b(?:malformed|invalid|parser|parse|parsing|decode|input)\b/i,
  /\bdoes not (?:render|preserve|include|clear|match|work|return|show|appear)\b/i,
  /\bdoesn['’]?t (?:render|preserve|include|clear|match|work|return|show|appear)\b/i,
  /\bthrows?\b.{0,80}\b(?:RangeError|TypeError|error|exception)\b/i,
  /\bRangeError\b/i,
];

const STANDALONE_FINDING_PATTERNS: RegExp[] = [
  /\btiming attack\b/i,
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
    category: "human_editable_artifact_validation",
    patterns: [
      /\b(?:reject|validate|validation|invalid|mismatch|escape|normaliz(?:e|es|ed|ing))\b.{0,80}\b(?:draft-rules?|rule-decisions?|rules?|export|manual decision|runId)\b.{0,80}\brunId\b/i,
      /\brunId\b.{0,80}\b(?:draft-rules?|rule-decisions?|rules?|export|manual decision)\b.{0,80}\b(?:reject|validate|validation|invalid|mismatch|escape|normaliz(?:e|es|ed|ing))\b/i,
      /\b(?:reject|validate|validation|invalid|mismatch|coerc(?:e|ing|ion)|normaliz(?:e|es|ed|ing))\b.{0,80}\b(?:rule-decisions?|draft-rules?|export|rules?|runId|human-edited|human-editable).{0,80}\bmanual decision\b/i,
      /\bmanual decision\b.{0,80}\b(?:rule-decisions?|draft-rules?|export|rules?|runId|human-edited|human-editable).{0,80}\b(?:reject|validate|validation|invalid|mismatch|coerc(?:e|ing|ion)|normaliz(?:e|es|ed|ing))\b/i,
      /\b(?:reject|validate|validation|invalid|mismatch|coerc(?:e|ing|ion)|normaliz(?:e|es|ed|ing))\b.{0,80}\bhuman-edited\b.{0,80}\b(?:rule-decisions?|draft-rules?|rules?|export|runId|manual decision|artifact|file)\b/i,
      /\b(?:rule-decisions?|draft-rules?|rules?|export|runId|manual decision|artifact|file)\b.{0,80}\bhuman-edited\b.{0,80}\b(?:reject|validate|validation|invalid|mismatch|coerc(?:e|ing|ion)|normaliz(?:e|es|ed|ing))\b/i,
      /\b(?:reject|validate|validation|invalid|mismatch|coerc(?:e|ing|ion)|normaliz(?:e|es|ed|ing))\b.{0,80}\bhuman-editable\b.{0,80}\b(?:rule-decisions?|draft-rules?|rules?|export|runId|manual decision|artifact|file)\b/i,
      /\b(?:rule-decisions?|draft-rules?|rules?|export|runId|manual decision|artifact|file)\b.{0,80}\bhuman-editable\b.{0,80}\b(?:reject|validate|validation|invalid|mismatch|coerc(?:e|ing|ion)|normaliz(?:e|es|ed|ing))\b/i,
      /\bedited(?:Title|Instruction|Rationale| fields?)\b.{0,80}\b(?:rule-decisions?|draft-rules?|rules?|export|manual decision|artifact)\b/i,
      /\b(?:rule-decisions?|draft-rules?|rules?|export|manual decision|artifact)\b.{0,80}\bedited(?:Title|Instruction|Rationale| fields?)\b/i,
      /\bunknown rule IDs?\b.{0,80}\b(?:reject|validate|validation|manual decision|rule-decisions?|artifact|export)\b/i,
      /\b(?:reject|validate|validation|manual decision|rule-decisions?|artifact|export)\b.{0,80}\bunknown rule IDs?\b/i,
      /\binvalid manual decision\b/i,
      /\bmanual decision\b.{0,80}\bcoerc(?:e|ing|ion)\b/i,
      /\bcoerc(?:e|ing|ion)\b.{0,80}\bmanual decision\b/i,
      /\baccepted\/edited\b.{0,80}\b(?:rule-decisions?|draft-rules?|rules?|export|manual decision|artifact).{0,80}\b(?:reject|validate|validation|invalid|mismatch|coerc(?:e|ing|ion)|normaliz(?:e|es|ed|ing))\b/i,
      /\b(?:reject|validate|validation|invalid|mismatch|coerc(?:e|ing|ion)|normaliz(?:e|es|ed|ing))\b.{0,80}\b(?:rule-decisions?|draft-rules?|rules?|export|manual decision|artifact).{0,80}\baccepted\/edited\b/i,
      /\b(?:reject|validate|validation|invalid|mismatch|coerc(?:e|ing|ion)|normaliz(?:e|es|ed|ing))\b.{0,80}\baccepted\/edited\b.{0,80}\b(?:rule-decisions?|draft-rules?|rules?|export|manual decision|artifact)\b/i,
    ],
  },
  {
    category: "identifier_collision_record_loss",
    patterns: [
      /\bduplicate (?:rule|decision|record|cluster|candidate|source) ?IDs?\b.{0,80}\b(?:collision|collide|overwrite|drop|loss|ambiguous|non-unique|reused)\b/i,
      /\b(?:collision|collide|overwrite|drop|loss|ambiguous|non-unique|reused)\b.{0,80}\bduplicate (?:rule|decision|record|cluster|candidate|source) ?IDs?\b/i,
      /\bcollisions?\b.{0,80}\bsourceCandidateIds?\b/i,
      /\bsourceCandidateIds?\b.{0,80}\bcollisions?\b/i,
      /\boverwrites?\b.{0,80}\b(?:candidate IDs?|sourceCandidateIds?)\b/i,
      /\b(?:candidate IDs?|sourceCandidateIds?)\b.{0,80}\boverwrites?\b/i,
      /\bdrops?\b.{0,80}\b(?:duplicate|candidate IDs?|sourceCandidateIds?|record loss)\b.{0,80}\brecords?\b/i,
      /\brecords?\b.{0,80}\b(?:duplicate|candidate IDs?|sourceCandidateIds?|record loss)\b.{0,80}\bdrops?\b/i,
      /\benriched records?\b.{0,80}\b(?:duplicate|reused|candidate IDs?|sourceCandidateIds?)\b/i,
      /\b(?:duplicate|reused|candidate IDs?|sourceCandidateIds?)\b.{0,80}\benriched records?\b/i,
      /\bsourceCandidateIds?\b.{0,80}\b(?:duplicate|collisions?|overwrites?|drops?|reused|record loss|mix(?:es|ing)? records?|avoid mixing|prevent mixing|disambiguat\w*.{0,40}(?:mix(?:es|ing)? records?|avoid mixing|prevent mixing|record loss))\b/i,
      /\b(?:duplicate|collisions?|overwrites?|drops?|reused|record loss|mix(?:es|ing)? records?|avoid mixing|prevent mixing|(?:mix(?:es|ing)? records?|avoid mixing|prevent mixing|record loss).{0,40}disambiguat\w*)\b.{0,80}\bsourceCandidateIds?\b/i,
      /\bcandidate IDs?\b.{0,80}\breused\b/i,
      /\breused\b.{0,80}\bcandidate IDs?\b/i,
      /\bmapRecordsByCandidateId\b.{0,80}\b(?:duplicate|collisions?|overwrites?|drops?|reused|record loss|candidate IDs?|sourceCandidateIds?)\b/i,
      /\b(?:duplicate|collisions?|overwrites?|drops?|reused|record loss|candidate IDs?|sourceCandidateIds?)\b.{0,80}\bmapRecordsByCandidateId\b/i,
      /\bsuffixing\b.{0,80}\bsourceCandidateIds?\b/i,
      /\bsourceCandidateIds?\b.{0,80}\bsuffixing\b/i,
    ],
  },
  {
    category: "status_inference_error",
    patterns: [
      /\bstatus inference\b/i,
      /\bdetectStatus\b/i,
      /\bacceptance heuristic\b/i,
      /\bnegated\b.{0,80}\b(?:status|acceptance|resolution|resolved|fixed|reply|replies|thread)\b/i,
      /\b(?:status|acceptance|resolution|resolved|fixed|reply|replies|thread)\b.{0,80}\bnegated\b/i,
      /\bnot fixed yet\b.{0,80}\b(?:status|acceptance|resolution|resolved|reply|replies|thread|inference)\b/i,
      /\b(?:status|acceptance|resolution|resolved|reply|replies|thread|inference)\b.{0,80}\bnot fixed yet\b/i,
      /\binReplyTo\b.{0,80}\b(?:status|inference|acceptance|resolution|resolved|rejected|contested|outcome)\b/i,
      /\b(?:status|inference|acceptance|resolution|resolved|rejected|contested|outcome)\b.{0,80}\binReplyTo\b/i,
      /\b(?:status|inference|acceptance|resolution|resolved|rejected|contested).{0,80}\bthread\b.{0,80}\b(?:reply|replies|status|resolved|outdated)\b/i,
      /\bthread\b.{0,80}\b(?:reply|replies|status|resolved|outdated).{0,80}\b(?:status|inference|acceptance|resolution|resolved|rejected|contested)\b/i,
      /\breplies\b.{0,80}\b(?:aggregate|whole PR|status).{0,80}\b(?:status|inference|acceptance|resolution|resolved|rejected|contested)\b/i,
      /\b(?:status|inference|acceptance|resolution|resolved|rejected|contested)\b.{0,80}\breplies\b.{0,80}\b(?:aggregate|whole PR|status)\b/i,
      /\bwhole PR\b.{0,80}\b(?:comments?|replies|context).{0,80}\b(?:status|inference|acceptance|resolution|resolved|rejected|contested)\b/i,
      /\b(?:status|inference|acceptance|resolution|resolved|rejected|contested)\b.{0,80}\bwhole PR\b.{0,80}\b(?:comments?|replies|context)\b/i,
    ],
  },
  {
    category: "pagination_boundary_error",
    patterns: [
      /\bper_page\b.{0,80}\b(?:import|imports|pulls?|PRs?|page size|above 100|more than 100|truncated|boundary)\b/i,
      /\b(?:import|imports|pulls?|PRs?|page size|above 100|more than 100|truncated|boundary)\b.{0,80}\bper_page\b/i,
      /\bpage size\b.{0,80}\b(?:import|imports|pulls?|PRs?|per_page|above 100|more than 100|truncated|boundary)\b/i,
      /\b(?:import|imports|pulls?|PRs?|per_page|above 100|more than 100|truncated|boundary)\b.{0,80}\bpage size\b/i,
      /\bpaginat(?:e|ed|ion)\b.{0,80}\b(?:import|imports|pulls?|above 100|more than 100)\b/i,
      /\b(?:import|imports|pulls?|above 100|more than 100)\b.{0,80}\bpaginat(?:e|ed|ion)\b/i,
      /\bpage=\d+\b.{0,80}\b(?:import|imports|pulls?|PRs?|per_page|truncated|above 100|more than 100)\b/i,
      /\b(?:import|imports|pulls?|PRs?|per_page|truncated|above 100|more than 100)\b.{0,80}\bpage=\d+\b/i,
      /\brequested PRs?\b.{0,80}\b(?:import|imports|pulls?|pagination|per_page|page size|above 100|more than 100|boundary)\b/i,
      /\b(?:import|imports|pulls?|pagination|per_page|page size|above 100|more than 100|boundary)\b.{0,80}\brequested PRs?\b/i,
      /\babove 100\b.{0,80}\b(?:import|imports|pulls?|PRs?|pagination|per_page|page size|truncated|boundary)\b/i,
      /\b(?:import|imports|pulls?|PRs?|pagination|per_page|page size|truncated|boundary)\b.{0,80}\babove 100\b/i,
      /\bmore than 100\b.{0,80}\b(?:import|imports|pulls?|PRs?|pagination|per_page|page size|truncated|boundary)\b/i,
      /\b(?:import|imports|pulls?|PRs?|pagination|per_page|page size|truncated|boundary)\b.{0,80}\bmore than 100\b/i,
      /\bsingle \/pulls page request\b/i,
      /\bsilently truncated\b.{0,80}\b(?:import|imports|pulls?|pagination|per_page|page size|above 100|more than 100|boundary)\b/i,
      /\b(?:import|imports|pulls?|pagination|per_page|page size|above 100|more than 100|boundary)\b.{0,80}\bsilently truncated\b/i,
    ],
  },
  {
    category: "insecure_randomness",
    patterns: [
      /\bMath\.random\(\)/i,
      /\bpseudo-random\b/i,
      /\bpredictable\b.{0,80}\b(?:random|identifier|identifiers|id|ids|entropy|uuid|nonce)\b/i,
      /\b(?:random|identifier|identifiers|id|ids|entropy|uuid|nonce)\b.{0,80}\bpredictable\b/i,
      /\bcryptographically secure\b/i,
      /\brandom identifier\b/i,
      /\bunique identifiers?\b.{0,80}\b(?:random|pseudo-random|predictable|entropy|cryptographic|secure)\b/i,
      /\b(?:random|pseudo-random|predictable|entropy|cryptographic|secure)\b.{0,80}\bunique identifiers?\b/i,
      /\b(?:random|pseudo-random|predictable|unique identifiers?|random identifiers?).{0,80}\buploaded files\b/i,
      /\buploaded files\b.{0,80}\b(?:random|pseudo-random|predictable|unique identifiers?|random identifiers?)\b/i,
      /\b(?:random|pseudo-random|predictable|unique identifiers?|random identifiers?).{0,80}\boffline queues\b/i,
      /\boffline queues\b.{0,80}\b(?:random|pseudo-random|predictable|unique identifiers?|random identifiers?)\b/i,
    ],
  },
  {
    category: "performance_regression",
    patterns: [
      /\bN\+1\b/i,
      /\bquery pattern\b/i,
      /\bbatched\b.{0,80}\b(?:database queries|queries|performance|load|execution time|N\+1)\b/i,
      /\b(?:database queries|queries|performance|load|execution time|N\+1)\b.{0,80}\bbatched\b/i,
      /\bdatabase queries\b/i,
      /\bcron\b.{0,80}\b(?:performance|load|execution time|slow|latency|timeout|throughput)\b/i,
      /\b(?:performance|load|execution time|slow|latency|timeout|throughput)\b.{0,80}\bcron\b/i,
      /\bperformance\b/i,
      /\bload\b.{0,80}\b(?:performance|execution time|slow|latency|timeout|throughput|database queries|N\+1)\b/i,
      /\b(?:performance|execution time|slow|latency|timeout|throughput|database queries|N\+1)\b.{0,80}\bload\b/i,
      /\bexecution time\b/i,
    ],
  },
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
      /\bredirects?\b/i,
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
      /\bparsing\b/i,
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
      /\bforeign-key violation\b/i,
      /\bgeneric\s+`?500`?\b/i,
      /\bcontrolled\s+`?404`?\b/i,
      /\bexistence check\b/i,
      /\bin-transaction\b/i,
      /\btransaction\b.{0,80}\b(?:existence|check|insert|foreign-key|stale|deleted)\b/i,
      /\b(?:existence|check|insert|foreign-key|stale|deleted)\b.{0,80}\btransaction\b/i,
      /\bexisting\b/i,
      /\bhelper\b/i,
      /\bcontract\b/i,
      /\bconvention\b/i,
      /\balready\b/i,
      /\bshould reuse\b/i,
    ],
  },
];

const RESOLVED_PATTERNS = [/\bfixed\b/i, /\baddressed in\b/i, /\bresolved\b/i];
const REQUESTED_FIX_PATTERNS = [
  /\badded\b.{0,80}\b(?:as requested|requested|null check|guard|validation|handling|test|coverage)\b/i,
];
const NEGATED_RESOLUTION_PATTERNS = [
  /\bnot\s+(?:fixed|addressed|resolved)\b/i,
  /\bwasn['’]?t\s+(?:fixed|addressed|resolved)\b/i,
  /\bisn['’]?t\s+(?:fixed|addressed|resolved)\b/i,
  /\bnever\s+(?:fixed|addressed|resolved)\b/i,
  /\b(?:fixed|addressed|resolved)\s+yet\b/i,
];
const NEGATED_ACCEPTANCE_PATTERNS = [
  /\bnot\s+(?:done|agreed)\b/i,
  /\bwasn['’]?t\s+(?:done|valid|agreed)\b/i,
  /\bisn['’]?t\s+(?:done|valid|agreed)\b/i,
  /\bnever\s+(?:done|valid|agreed)\b/i,
  /\b(?:done|valid|agreed)\s+yet\b/i,
];
const ACCEPTED_PATTERNS = [
  /\bgood catch\b/i,
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
  /\bisn['’]?t valid\b/i,
  /\bwasn['’]?t valid\b/i,
  /\bfalse positive\b/i,
  /\bleaving as-is\b/i,
  /\bleaving as is\b/i,
  /\bnot an issue\b/i,
  /\bworks? as intended\b/i,
  /\bintended behavior\b/i,
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

export function detectStatus(
  sourceBody: string,
  nearbyReplies: string[],
  reviewThread: StatusThread | null = null,
): FailureCandidateStatus {
  const repliesNewestFirst = [...nearbyReplies].reverse();

  for (const replyText of repliesNewestFirst) {
    if (matchesAny(replyText, REJECTED_PATTERNS)) {
      return "rejected";
    }
    if (
      matchesAny(replyText, NEGATED_RESOLUTION_PATTERNS) ||
      matchesAny(replyText, NEGATED_ACCEPTANCE_PATTERNS)
    ) {
      return "candidate";
    }
    if (matchesAny(replyText, RESOLVED_PATTERNS) || matchesAny(replyText, REQUESTED_FIX_PATTERNS)) {
      return "resolved";
    }
    if (matchesAny(replyText, ACCEPTED_PATTERNS)) {
      return "accepted";
    }
    if (matchesAny(replyText, CONTESTED_PATTERNS)) {
      return "contested";
    }
  }
  if (reviewThread?.isResolved) {
    return "resolved";
  }
  if (matchesAny(`${sourceBody}\n${nearbyReplies.join("\n")}`, CONTESTED_PATTERNS)) {
    return "contested";
  }
  if (reviewThread?.isOutdated) {
    return "superseded";
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
  const reviewThreadByCommentId = buildReviewThreadCommentMap(record.reviewThreads);
  const candidates: FailureCandidate[] = [];

  for (const source of sources) {
    if (source.inReplyToId !== null) {
      continue;
    }

    if (!isCandidateFinding(source)) {
      continue;
    }

    const replyBodies = sources
      .filter(
        (reply) =>
          source.sourceType === "review_comment" &&
          reply.sourceType === "review_comment" &&
          reply.inReplyToId === source.id,
      )
      .map((reply) => reply.body)
      .filter(Boolean);
    const reviewThread =
      source.sourceType === "review_comment"
        ? reviewThreadByCommentId.get(String(source.id)) ?? null
        : null;

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
      status: detectStatus(source.body, replyBodies, reviewThread),
      detectedAgentMarkers: detectAgentMarkers(source.body, source.author),
      createdAt: source.createdAt,
      updatedAt: source.updatedAt,
      notes: [`Extracted deterministically from ${source.sourceType} keyword matches.`],
    });
  }

  return candidates;
}

function buildReviewThreadCommentMap(
  reviewThreads: NormalizedReviewThread[],
): Map<string, NormalizedReviewThread> {
  const threadByCommentId = new Map<string, NormalizedReviewThread>();
  for (const thread of reviewThreads) {
    for (const commentId of thread.commentIds) {
      threadByCommentId.set(commentId, thread);
    }
  }
  return threadByCommentId;
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
      inReplyToId: comment.inReplyToId ?? null,
    })),
    ...record.reviews.map((review) => ({
      id: review.id,
      sourceType: "review" as const,
      author: review.author,
      body: review.body,
      url: review.url,
      createdAt: review.submittedAt,
      updatedAt: review.submittedAt,
      inReplyToId: null,
    })),
    ...record.issueComments.map((comment) => ({
      id: comment.id,
      sourceType: "issue_comment" as const,
      author: comment.author,
      body: comment.body,
      url: comment.url,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
      inReplyToId: null,
    })),
    {
      id: record.prNumber,
      sourceType: "pr_body",
      author: record.author,
      body: record.body,
      url: null,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      inReplyToId: null,
    },
  ];
}

function isCandidateFinding(source: SourceItem): boolean {
  const matchesStandaloneFinding = matchesAny(source.body, STANDALONE_FINDING_PATTERNS);
  const matchesFailureCue = matchesAny(source.body, FAILURE_CUE_PATTERNS);

  if (source.sourceType === "pr_body") {
    if (matchesStandaloneFinding) {
      return true;
    }

    const matchesStrongSignal = matchesAny(source.body, PR_BODY_STRONG_SIGNAL_PATTERNS);
    const matchesFeatureSummaryFailureCue = matchesAny(
      source.body,
      PR_BODY_FEATURE_SUMMARY_FAILURE_CUE_PATTERNS,
    );

    if (
      isFeatureSummaryPrBody(source.body) &&
      !matchesStrongSignal &&
      !matchesFeatureSummaryFailureCue
    ) {
      return false;
    }

    if (
      isFeatureSummaryPrBody(source.body) &&
      (matchesStrongSignal || matchesFeatureSummaryFailureCue)
    ) {
      return matchesFailureCue || matchesFeatureSummaryFailureCue;
    }
  }

  if (
    source.sourceType === "pr_body" &&
    !matchesStandaloneFinding &&
    !matchesAny(source.body, PR_BODY_STRONG_SIGNAL_PATTERNS) &&
    !(matchesFailureCue && detectCategory(source.body) !== "unknown")
  ) {
    return false;
  }

  return matchesStandaloneFinding || matchesFailureCue;
}

function isFeatureSummaryPrBody(body: string): boolean {
  return (
    matchesAny(body, PR_BODY_FEATURE_SUMMARY_PATTERNS) &&
    !matchesAny(body, PR_BODY_EXPLICIT_FAILURE_PATTERNS)
  );
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
