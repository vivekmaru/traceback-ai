import { describe, expect, test } from "bun:test";
import {
  detectAgentMarkers,
  detectCategory,
  detectSeverity,
  detectStatus,
  extractFailureCandidates,
  inferStatus,
  type StatusInference,
  type StatusThread,
} from "../src/extract";
import type { NormalizedPullRequestRecord } from "../src/types";

const baseRecord: NormalizedPullRequestRecord = {
  schemaVersion: 3,
  importedAt: "2026-05-17T00:00:00.000Z",
  repository: {
    owner: "vivekmaru",
    repo: "EventSnaps",
    remoteUrl: "git@github.com:vivekmaru/EventSnaps.git",
  },
  prNumber: 91,
  title: "feat: add native QR template system",
  url: "https://github.com/vivekmaru/EventSnaps/pull/91",
  state: "closed",
  merged: true,
  author: "chatgpt-codex-connector[bot]",
  createdAt: "2026-05-01T01:00:00Z",
  updatedAt: "2026-05-02T01:00:00Z",
  closedAt: "2026-05-03T01:00:00Z",
  mergedAt: "2026-05-03T01:00:00Z",
  baseBranch: "develop",
  headBranch: "template-system",
  body: "",
  labels: [],
  commitsCount: 4,
  changedFilesCount: 8,
  additions: 120,
  deletions: 12,
  issueComments: [
    {
      id: 1001,
      author: "vivek",
      body: "Good catch, fixed in the follow-up commit.",
      createdAt: "2026-05-02T03:10:00Z",
      updatedAt: "2026-05-02T03:10:00Z",
      url: "https://github.com/vivekmaru/EventSnaps/pull/91#issuecomment-1001",
    },
  ],
  reviewComments: [
    {
      id: 2001,
      author: "chatgpt-codex-connector[bot]",
      body: "[P1] This breaks protected redirects because pathname is preserved but the query/search params are dropped.",
      createdAt: "2026-05-02T03:00:00Z",
      updatedAt: "2026-05-02T03:05:00Z",
      url: "https://github.com/vivekmaru/EventSnaps/pull/91#discussion_r2001",
      path: "src/auth.ts",
      line: 42,
      originalLine: 39,
      inReplyToId: null,
      commitId: "abc123",
    },
  ],
  reviewThreads: [
    {
      id: "PRRT_kwDOABC2001",
      isResolved: false,
      isOutdated: false,
      path: "src/auth.ts",
      line: 42,
      startLine: 39,
      commentIds: ["2001"],
    },
  ],
  reviews: [],
  candidateAgentMarkers: [],
};

describe("extractFailureCandidates", () => {
  test("creates a stable failure candidate schema from a review comment", () => {
    const [candidate] = extractFailureCandidates([baseRecord]);

    expect(candidate).toMatchObject({
      id: "failure-pr-91-review_comment-2001",
      sourcePrNumber: 91,
      sourcePrUrl: "https://github.com/vivekmaru/EventSnaps/pull/91",
      sourceCommentUrl: "https://github.com/vivekmaru/EventSnaps/pull/91#discussion_r2001",
      sourceAuthor: "chatgpt-codex-connector[bot]",
      sourceType: "review_comment",
      candidateCategory: "query_state_preservation_failure",
      candidateSeverity: "high",
      confidence: "high",
      status: "candidate",
      detectedAgentMarkers: ["chatgpt-codex-connector", "codex", "bot"],
      createdAt: "2026-05-02T03:00:00Z",
      updatedAt: "2026-05-02T03:05:00Z",
    });
    expect(candidate.extractedTitle).toContain("breaks protected redirects");
    expect(candidate.evidenceExcerpt).toContain("query/search params are dropped");
    expect(candidate.notes).toContain("Extracted deterministically from review_comment keyword matches.");
  });

  test("extracts from PR body conservatively with lower confidence", () => {
    const record = {
      ...baseRecord,
      body: "Root cause: Buffer.from(mac, \"hex\") accepted trailing malformed token data.",
      issueComments: [],
      reviewComments: [],
      reviews: [],
    };

    const [candidate] = extractFailureCandidates([record]);

    expect(candidate).toMatchObject({
      id: "failure-pr-91-pr_body-91",
      sourceType: "pr_body",
      candidateCategory: "parser_permissiveness",
      confidence: "low",
      status: "candidate",
    });
  });

  test("does not extract accessibility-only PR body improvements", () => {
    const record = {
      ...baseRecord,
      body: "Improve accessibility for the share panel with clearer labels and keyboard navigation.",
      issueComments: [],
      reviewComments: [],
      reviews: [],
    };

    expect(extractFailureCandidates([record])).toEqual([]);
  });

  test("extracts PR body performance root-cause writeups as performance regressions", () => {
    const record = {
      ...baseRecord,
      body: "Root cause: the event dashboard had an N+1 query pattern in a loop. Fixed with batched database queries to reduce load and execution time.",
      issueComments: [],
      reviewComments: [],
      reviews: [],
    };

    const [candidate] = extractFailureCandidates([record]);

    expect(candidate).toMatchObject({
      sourceType: "pr_body",
      candidateCategory: "performance_regression",
      confidence: "low",
    });
  });

  test("extracts hardcoded environment failures from PR bodies", () => {
    const record = {
      ...baseRecord,
      body: "The pricing link hardcoded a production domain instead of using APP_URL for preview environments.",
      issueComments: [],
      reviewComments: [],
      reviews: [],
    };

    const [candidate] = extractFailureCandidates([record]);

    expect(candidate).toMatchObject({
      sourceType: "pr_body",
      candidateCategory: "environment_config_contract_violation",
      confidence: "low",
    });
  });

  test("does not extract uncategorized weak PR body failure cues", () => {
    const record = {
      ...baseRecord,
      body: "Missing polish for the button spacing in the toolbar.",
      issueComments: [],
      reviewComments: [],
      reviews: [],
    };

    expect(extractFailureCandidates([record])).toEqual([]);
  });

  test("does not extract Traceback feature-summary PR bodies as failures", () => {
    const featureSummaries = [
      "Summary add traceback analyze --dry-run and traceback analyze --provider openai write compact analysis run artifacts under .traceback/analysis/runs/<runId>/ add OpenAI provider isolation, explicit privacy warning, missing-key preservation, strict output validation, and collision-safe run IDs document analysis behavior",
      "Context\n\n## Summary\n\n- Add traceback analyze --provider openai artifacts.\n- Preserve missing-key diagnostics and collision-safe run IDs.",
      "## Summary\n\n- Add missing data export report for local review UI.",
      "## Summary\n\n- Add security headers and missing-key diagnostics for exported rules.",
      "## Summary\n\n- Add traceback rules export --run --target agents-md for controlled export of accepted draft rules.\n- Write proposed artifacts under .traceback/exports/<runId>/ without modifying root instruction files.\n- Document safety boundaries and add tests for success, missing drafts, unsupported targets, root AGENTS.md preservation.",
      "## Summary\n\n- Add traceback rules review --run --policy conservative for deterministic local rule decisions.\n- Add optional --from normalization for human-edited rule-decision files.\n- Add controlled rules export --target agents-md behavior that prefers rule decisions when present, uses edited fields, excludes rejected and needs_edit.",
    ];

    for (const body of featureSummaries) {
      const record = {
        ...baseRecord,
        body,
        issueComments: [],
        reviewComments: [],
        reviews: [],
      };

      expect(extractFailureCandidates([record])).toEqual([]);
    }
  });

  test("still extracts high-signal PR body summaries", () => {
    const summaries = [
      {
        body: "## Summary\n\n- Add retry handling because upload fails intermittently.",
        category: "unknown",
      },
      {
        body: "## Summary\n\n- Fix renderer because downloaded PNG does not render fields shown in preview.",
        category: "preview_output_parity_failure",
      },
      {
        body: "## Summary\n\n- Fix renderer because downloaded PNG doesn't render fields shown in preview.",
        category: "preview_output_parity_failure",
      },
      {
        body: "## Summary\n\n- Fix redirect handling because this breaks protected redirects by dropping search params.",
        category: "query_state_preservation_failure",
      },
      {
        body: "## Summary\n\n- Guard parser because malformed input throws RangeError.",
        category: "parser_permissiveness",
      },
      {
        body: "## Summary\n\n- Add parser guard; parsing fails on malformed input.",
        category: "parser_permissiveness",
      },
      {
        body: "## Summary\n\n- Parsing fails.",
        category: "parser_permissiveness",
      },
      {
        body: "## Summary\n\n- Add parser guard because malformed input cannot parse.",
        category: "parser_permissiveness",
      },
      {
        body: "## Summary\n\n- Add guard to avoid forwarding auth headers to the analytics proxy.",
        category: "security_privacy_regression",
      },
      {
        body: "## Summary\n\n- Date.now() is called during render, causing URL regeneration and refetch spam.",
        category: "render_time_side_effect",
      },
    ];

    for (const { body, category } of summaries) {
      const record = {
        ...baseRecord,
        body,
        issueComments: [],
        reviewComments: [],
        reviews: [],
      };

      const [candidate] = extractFailureCandidates([record]);

      expect(candidate).toMatchObject({
        sourceType: "pr_body",
        candidateCategory: category,
      });
    }
  });

  test("maps predictable Math.random identifiers to insecure randomness", () => {
    const record = recordWithReviewComment(
      "Math.random() creates predictable random identifiers for uploaded files in offline queues; use cryptographically secure randomness.",
    );

    const [candidate] = extractFailureCandidates([record]);

    expect(candidate.candidateCategory).toBe("insecure_randomness");
  });

  test("extracts standalone PR body signals without other strong PR body prose", () => {
    const record = {
      ...baseRecord,
      body: "Date.now() is called during render, causing URL regeneration and refetch spam on every re-render.",
      issueComments: [],
      reviewComments: [],
      reviews: [],
    };

    const [candidate] = extractFailureCandidates([record]);

    expect(candidate).toMatchObject({
      sourceType: "pr_body",
      candidateCategory: "render_time_side_effect",
      confidence: "low",
    });
  });

  test("keeps Date.now render churn mapped to render-time side effect", () => {
    const record = recordWithReviewComment(
      "Date.now() is called during render, causing URL regeneration and refetch spam on every re-render.",
    );

    const [candidate] = extractFailureCandidates([record]);

    expect(candidate.candidateCategory).toBe("render_time_side_effect");
  });

  test("does not classify generic uploaded files or offline queues as insecure randomness", () => {
    const record = recordWithReviewComment(
      "The uploader drops metadata for uploaded files when offline queues are replayed.",
    );

    const [candidate] = extractFailureCandidates([record]);

    expect(candidate.candidateCategory).not.toBe("insecure_randomness");
  });

  test("does not classify generic predictable wording as insecure randomness", () => {
    const record = recordWithReviewComment(
      "The retry worker drops requests because predictable offline retry ordering replays stale work.",
    );

    const [candidate] = extractFailureCandidates([record]);

    expect(candidate.candidateCategory).not.toBe("insecure_randomness");
  });

  test("does not classify generic loop wording as performance regression", () => {
    const record = recordWithReviewComment(
      "The form drops edits inside a loop while the user is editing template text.",
    );

    const [candidate] = extractFailureCandidates([record]);

    expect(candidate.candidateCategory).not.toBe("performance_regression");
  });

  test("does not classify generic load wording as performance regression", () => {
    const record = recordWithReviewComment("The avatar fails to load in Safari.");

    const [candidate] = extractFailureCandidates([record]);

    expect(candidate.candidateCategory).not.toBe("performance_regression");
  });

  test("does not classify generic cron wording as performance regression", () => {
    const record = recordWithReviewComment("The cron worker drops invoice emails on DST shift.");

    const [candidate] = extractFailureCandidates([record]);

    expect(candidate.candidateCategory).not.toBe("performance_regression");
  });

  test("does not classify generic batched wording as performance regression", () => {
    const record = recordWithReviewComment(
      "The batched webhook sender drops events when one payload is malformed.",
    );

    const [candidate] = extractFailureCandidates([record]);

    expect(candidate.candidateCategory).not.toBe("performance_regression");
  });

  test("does not classify generic unique identifier wording as insecure randomness", () => {
    const record = recordWithReviewComment(
      "The migration drops rows when legacy unique identifiers are duplicated.",
    );

    const [candidate] = extractFailureCandidates([record]);

    expect(candidate.candidateCategory).not.toBe("insecure_randomness");
  });

  test("cleans GitHub badge markdown from extracted titles", () => {
    const record = {
      ...baseRecord,
      issueComments: [],
      reviewComments: [
        {
          ...baseRecord.reviewComments[0],
          body: "**<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub> Missing query state in redirect**\n\nThis silently drops search params.",
        },
      ],
      reviews: [],
    };

    const [candidate] = extractFailureCandidates([record]);

    expect(candidate.extractedTitle).toBe("Missing query state in redirect");
  });

  test("does not infer status from unrelated PR comments", () => {
    const [candidate] = extractFailureCandidates([baseRecord]);

    expect(candidate.status).toBe("candidate");
  });

  test("infers status from review comment replies in the same thread", () => {
    const record = {
      ...baseRecord,
      issueComments: [],
      reviewComments: [
        baseRecord.reviewComments[0],
        {
          ...baseRecord.reviewComments[0],
          id: 2002,
          body: "Good catch, fixed in the follow-up commit.",
          inReplyToId: 2001,
        },
      ],
      reviews: [],
    };

    const [candidate] = extractFailureCandidates([record]);

    expect(candidate.id).toBe("failure-pr-91-review_comment-2001");
    expect(candidate.status).toBe("resolved");
  });

  test.each([
    [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
  ])("orders reply timestamps before inference: %d,%d,%d", (first, second, third) => {
    const order = [first, second, third];
    for (const bodies of [
      ["Not fixed yet.", "Fixed in abc123.", "Thanks for the update."],
      ["Fixed in abc123.", "I have not yet added the null check.", "Thanks for the update."],
    ]) {
      const replies = bodies.map((body, index) => ({
        ...baseRecord.reviewComments[0],
        id: 2002 + index,
        inReplyToId: 2001,
        body,
        createdAt: `2026-05-02T03:0${index + 1}:00Z`,
      }));
      const record = {
        ...baseRecord,
        reviewComments: [baseRecord.reviewComments[0], ...order.map((index) => replies[index])],
        reviewThreads: [{ ...baseRecord.reviewThreads[0], isResolved: true }],
      };
      const inputOrder = record.reviewComments.map((comment) => comment.id);
      const [candidate] = extractFailureCandidates([record]);
      const expected = inferStatus(baseRecord.reviewComments[0].body, bodies, record.reviewThreads[0]);

      expect(expected.replyIndex).toBe(1);
      expect(candidate.status).toBe(expected.status);
      expect(record.reviewComments.map((comment) => comment.id)).toEqual(inputOrder);
    }
  });

  test.each(["Fixed in abc123.", "Not fixed yet.", "Can you confirm this is fixed?"])(
    "keeps replies and flags isolated to their own thread: %s",
    (body) => {
      const record = {
        ...baseRecord,
        reviewComments: [
          baseRecord.reviewComments[0],
          { ...baseRecord.reviewComments[0], id: 3001 },
          { ...baseRecord.reviewComments[0], id: 3002, inReplyToId: 3001, body },
        ],
        reviewThreads: [
          baseRecord.reviewThreads[0],
          {
            ...baseRecord.reviewThreads[0],
            id: "other-thread",
            isResolved: true,
            isOutdated: true,
            commentIds: ["3001", "3002"],
          },
        ],
      };
      const candidates = extractFailureCandidates([record]);

      expect(candidates).toHaveLength(2);
      expect(candidates.find((candidate) => candidate.id.endsWith("-2001"))?.status).toBe("candidate");
      expect(candidates.find((candidate) => candidate.id.endsWith("-3001"))?.status).toBe(
        inferStatus("This is unsafe", [body], record.reviewThreads[1]).status,
      );
    },
  );

  test("extracts transaction existence-check regressions and treats requested fixes as resolved", () => {
    const record = {
      ...baseRecord,
      issueComments: [],
      reviewComments: [
        {
          ...baseRecord.reviewComments[0],
          body: "Moving event lookup outside the transaction removes the in-transaction existence check, so if the event is deleted before insert, the foreign-key violation can bubble as a generic 500 instead of the controlled 404 this route returned before.",
        },
        {
          ...baseRecord.reviewComments[0],
          id: 2002,
          body: "Added the null check as requested.",
          inReplyToId: 2001,
        },
      ],
      reviews: [],
    };

    const [candidate] = extractFailureCandidates([record]);

    expect(candidate).toMatchObject({
      candidateCategory: "context_omission",
      status: "resolved",
    });
  });

  test("infers resolved status from resolved GitHub review threads without replies", () => {
    const record = {
      ...baseRecord,
      issueComments: [],
      reviewThreads: [
        {
          ...baseRecord.reviewThreads[0],
          isResolved: true,
          commentIds: ["2001"],
        },
      ],
    };

    const [candidate] = extractFailureCandidates([record]);

    expect(candidate.status).toBe("resolved");
  });

  test("infers superseded status from outdated GitHub review threads without stronger signals", () => {
    const record = {
      ...baseRecord,
      issueComments: [],
      reviewThreads: [
        {
          ...baseRecord.reviewThreads[0],
          isOutdated: true,
          commentIds: ["2001"],
        },
      ],
    };

    const [candidate] = extractFailureCandidates([record]);

    expect(candidate.status).toBe("superseded");
  });

  test("lets explicit same-thread replies override outdated review-thread state", () => {
    const record = {
      ...baseRecord,
      issueComments: [],
      reviewComments: [
        baseRecord.reviewComments[0],
        {
          ...baseRecord.reviewComments[0],
          id: 2002,
          body: "I disagree, this is not an issue.",
          inReplyToId: 2001,
        },
      ],
      reviewThreads: [
        {
          ...baseRecord.reviewThreads[0],
          isOutdated: true,
          commentIds: ["2001", "2002"],
        },
      ],
      reviews: [],
    };

    const [candidate] = extractFailureCandidates([record]);

    expect(candidate.status).toBe("rejected");
  });

  test("does not extract review comment replies as standalone candidates", () => {
    const record = {
      ...baseRecord,
      issueComments: [],
      reviewComments: [
        {
          ...baseRecord.reviewComments[0],
          id: 2002,
          body: "Good catch, fixed in the follow-up commit.",
          inReplyToId: 2001,
        },
      ],
      reviews: [],
    };

    expect(extractFailureCandidates([record])).toEqual([]);
  });

  test("does not use review comment replies to classify non-review-comment sources", () => {
    const record = {
      ...baseRecord,
      body: "Root cause: Buffer.from(mac, \"hex\") accepted trailing malformed token data.",
      issueComments: [],
      reviewComments: [
        {
          ...baseRecord.reviewComments[0],
          id: 2002,
          body: "Good catch, fixed in the follow-up commit.",
          inReplyToId: 91,
        },
      ],
      reviews: [],
    };

    const [candidate] = extractFailureCandidates([record]);

    expect(candidate.sourceType).toBe("pr_body");
    expect(candidate.status).toBe("candidate");
  });

  test("does not extract neutral domain comments without a failure cue", () => {
    const record = {
      ...baseRecord,
      issueComments: [],
      reviewComments: [
        {
          ...baseRecord.reviewComments[0],
          body: "The search params are passed through the redirect helper.",
        },
      ],
      reviews: [],
    };

    expect(extractFailureCandidates([record])).toEqual([]);
  });

  test("does not extract neutral does-not comments without a stronger failure cue", () => {
    const record = {
      ...baseRecord,
      issueComments: [],
      reviewComments: [
        {
          ...baseRecord.reviewComments[0],
          body: "This does not need further changes.",
        },
      ],
      reviews: [],
    };

    expect(extractFailureCandidates([record])).toEqual([]);
  });

  test("extracts EventSnaps renderer parity omissions", () => {
    const record = recordWithReviewComment(
      "Backend PNG renderer omits eventDate and footer fields that are shown in the preview customization UI.",
    );

    const [candidate] = extractFailureCandidates([record]);

    expect(candidate).toMatchObject({
      candidateCategory: "preview_output_parity_failure",
      sourceType: "review_comment",
    });
  });

  test("extracts EventSnaps user input loss during refetch", () => {
    const record = recordWithReviewComment(
      "Template modal resets text edits when React Query refetches while the user is editing.",
    );

    const [candidate] = extractFailureCandidates([record]);

    expect(candidate).toMatchObject({
      candidateCategory: "user_input_loss",
      sourceType: "review_comment",
    });
  });

  test("extracts EventSnaps auth header forwarding as security risk", () => {
    const record = recordWithReviewComment(
      "Sensitive authorization and cookie headers are forwarded to the third-party analytics proxy.",
    );

    const [candidate] = extractFailureCandidates([record]);

    expect(candidate).toMatchObject({
      candidateCategory: "security_privacy_regression",
      sourceType: "review_comment",
    });
  });

  test("maps hardcoded production APP_URL findings to environment config", () => {
    const record = recordWithReviewComment(
      "The pricing link hardcoded a production domain instead of using APP_URL for preview and self-hosted environments.",
    );

    const [candidate] = extractFailureCandidates([record]);

    expect(candidate.candidateCategory).toBe("environment_config_contract_violation");
  });

  test("maps downloaded PNG preview mismatch to preview output parity", () => {
    const record = recordWithReviewComment(
      "The downloaded PNG output omits fields that render in the preview customization UI.",
    );

    const [candidate] = extractFailureCandidates([record]);

    expect(candidate.candidateCategory).toBe("preview_output_parity_failure");
  });

  test("maps query redirect template state loss to query or stale intent", () => {
    const record = recordWithReviewComment(
      "The protected redirect drops the template query state and leaves a stale localStorage template intent.",
    );

    const [candidate] = extractFailureCandidates([record]);

    expect(["query_state_preservation_failure", "stale_persisted_intent"]).toContain(
      candidate.candidateCategory,
    );
  });

  test("maps corporate board renderer eventName omission to preview output parity", () => {
    const record = recordWithReviewComment(
      "The backend renderer never draws texts.eventName even though the customization UI allows editing it and the React preview displays it.",
    );

    const [candidate] = extractFailureCandidates([record]);

    expect(candidate.candidateCategory).toBe("preview_output_parity_failure");
  });
});

describe("status inference evidence", () => {
  const threadStates: Array<StatusThread | null> = [
    null,
    { isResolved: false, isOutdated: false },
    { isResolved: true, isOutdated: false },
    { isResolved: false, isOutdated: true },
    { isResolved: true, isOutdated: true },
  ];
  const acknowledgementFixtures: Array<[string, StatusInference["status"]]> = [
    ["Fixed.", "resolved"],
    ["Fixed in abc123.", "resolved"],
    ["Good catch, fixed in the follow-up commit.", "resolved"],
    ["I've fixed the issue.", "resolved"],
    ["We have resolved this.", "resolved"],
    ["This is now fixed.", "resolved"],
    ["The issue has been resolved.", "resolved"],
    ["Addressed in abc123.", "resolved"],
    ["Added the null check as requested.", "resolved"],
    ["I have added the requested guard.", "resolved"],
    ["We've added regression tests.", "resolved"],
    ["Added validation.", "resolved"],
    ["Added error handling.", "resolved"],
    ["Added the early return as requested.", "resolved"],
    ["Good catch.", "accepted"],
    ["Good catch, I'll fix this.", "accepted"],
    ["This is valid.", "accepted"],
    ["Valid point.", "accepted"],
    ["Your concern is valid.", "accepted"],
    ["Done.", "accepted"],
    ["Addressed.", "accepted"],
    ["Agreed.", "accepted"],
    ["I agree with your concern.", "accepted"],
    ["You're right.", "accepted"],
    ["I disagree, this is not an issue.", "rejected"],
    ["This is not valid.", "rejected"],
    ["This isn't valid.", "rejected"],
    ["Not a valid concern.", "rejected"],
    ["This is a false positive.", "rejected"],
    ["Leaving as-is.", "rejected"],
    ["Not fixed yet.", "candidate"],
    ["This has not been resolved.", "candidate"],
    ["It wasn't actually fixed.", "candidate"],
    ["I have never addressed this.", "candidate"],
    ["Not added the null check as requested.", "candidate"],
    ["I have not yet added the null check.", "candidate"],
    ["I haven't added the requested guard.", "candidate"],
    ["We haven’t yet added validation.", "candidate"],
    ["I did not add the test.", "candidate"],
    ["Good catch, but this is not fixed yet.", "candidate"],
    ["Not a good catch.", "candidate"],
    ["This isn't a good catch.", "candidate"],
    ["Not done yet.", "candidate"],
    ["We have not agreed.", "candidate"],
    ["You are not right.", "candidate"],
    ["This has never been valid.", "candidate"],
    ["This is not yet valid.", "candidate"],
    ["I won't fix this.", "candidate"],
    ["This will not be fixed in this PR.", "candidate"],
    ["I will add the null check as requested.", "candidate"],
    ["Will fix.", "candidate"],
    ["I'll fix this tomorrow.", "candidate"],
    ["This would be fixed by the guard.", "candidate"],
    ["This would have been fixed by validation.", "candidate"],
    ["This should be resolved after the follow-up.", "candidate"],
    ["We plan to add regression tests.", "candidate"],
    ["I would agree after another review.", "candidate"],
    ["Can you confirm this is fixed?", "contested"],
    ["Is this fixed?", "contested"],
    ["Fixed?", "contested"],
    ["Not sure this is resolved.", "contested"],
    ["I think this is fixed.", "contested"],
    ["Perhaps this is resolved.", "contested"],
    ["This is probably fixed.", "contested"],
    ["This seems fixed.", "contested"],
    ["Is this right?", "contested"],
    ["Is this valid?", "contested"],
    ["Good catch?", "contested"],
    ["Added the null check as requested?", "contested"],
    ["Have you added the requested guard?", "contested"],
    ["Will you fix this?", "contested"],
  ];

  test.each(acknowledgementFixtures)("%s => %s with matching reply provenance", (body, status) => {
    for (const thread of threadStates) {
      const replies = ["", body, "Thanks for the update."];
      const original = [...replies];
      expect(inferStatus("This is unsafe", replies, thread)).toEqual({
        status,
        basis: "reply",
        replyIndex: 1,
      });
      expect(detectStatus("This is unsafe", replies, thread)).toBe(status);
      expect(replies).toEqual(original);
    }
  });

  test.each([
    "",
    "Thanks for the update.",
    "Valid JSON is required here.",
    "This is valid JSON.",
    "This isn't valid JSON.",
    "The response is valid according to the JSON schema.",
    "The parser accepts a valid identifier.",
    "We use fixed-width fields.",
    "Fixed-width values are documented here.",
    "Fixed width columns are easier to read.",
    "The agreed schema is in the docs.",
    "The done callback returns a boolean.",
    "The example mentions an added null check.",
    "The docs describe a good catch phrase.",
    "What does fixed-width mean?",
    "Does this return valid JSON?",
  ])("neutral text does not manufacture outcome evidence: %s", (body) => {
    for (const thread of threadStates) {
      const expected: StatusInference = thread?.isResolved
        ? { status: "resolved", basis: "thread_resolved", replyIndex: null }
        : thread?.isOutdated
          ? { status: "superseded", basis: "thread_outdated", replyIndex: null }
          : { status: "candidate", basis: "none", replyIndex: null };
      expect(inferStatus("This is unsafe", [body], thread)).toEqual(expected);
      expect(inferStatus("This is unsafe", ["Fixed in abc123.", body], thread)).toEqual({
        status: "resolved",
        basis: "reply",
        replyIndex: 0,
      });
    }
  });

  const provenanceFixtures: Array<{
    name: string;
    source?: string;
    replies: string[];
    thread?: StatusThread;
    expected: StatusInference;
  }> = [
    {
      name: "no evidence",
      replies: [],
      expected: { status: "candidate", basis: "none", replyIndex: null },
    },
    {
      name: "completion in a source finding is not reply confirmation",
      source: "The bug was fixed in a prior release.",
      replies: [],
      expected: { status: "candidate", basis: "none", replyIndex: null },
    },
    {
      name: "source uncertainty",
      source: "I think this is unsafe. Thoughts?",
      replies: ["Thanks for the update."],
      expected: { status: "contested", basis: "source", replyIndex: null },
    },
    {
      name: "metadata-only resolved thread",
      replies: [],
      thread: { isResolved: true, isOutdated: false },
      expected: { status: "resolved", basis: "thread_resolved", replyIndex: null },
    },
    {
      name: "metadata-only outdated thread",
      replies: [],
      thread: { isResolved: false, isOutdated: true },
      expected: { status: "superseded", basis: "thread_outdated", replyIndex: null },
    },
    {
      name: "resolved flag precedes outdated flag and source uncertainty",
      source: "I think this is unsafe. Thoughts?",
      replies: [],
      thread: { isResolved: true, isOutdated: true },
      expected: { status: "resolved", basis: "thread_resolved", replyIndex: null },
    },
    {
      name: "source uncertainty precedes outdated metadata",
      source: "I think this is unsafe. Thoughts?",
      replies: [],
      thread: { isResolved: false, isOutdated: true },
      expected: { status: "contested", basis: "source", replyIndex: null },
    },
    {
      name: "later fix supersedes earlier negation",
      replies: ["Not fixed yet.", "Fixed in abc123."],
      expected: { status: "resolved", basis: "reply", replyIndex: 1 },
    },
    {
      name: "later negation supersedes earlier fix and resolved flag",
      replies: ["Fixed in abc123.", "Not fixed yet.", "Thanks."],
      thread: { isResolved: true, isOutdated: false },
      expected: { status: "candidate", basis: "reply", replyIndex: 1 },
    },
    {
      name: "later rejection supersedes acceptance",
      replies: ["Good catch.", "I disagree, this is not an issue.", ""],
      expected: { status: "rejected", basis: "reply", replyIndex: 1 },
    },
    {
      name: "later acknowledgement supersedes rejection",
      replies: ["This is a false positive.", "", "Good catch."],
      expected: { status: "accepted", basis: "reply", replyIndex: 2 },
    },
    {
      name: "later uncertainty supersedes resolution",
      replies: ["Fixed.", "Can you confirm this is fixed?", "Thanks."],
      thread: { isResolved: true, isOutdated: true },
      expected: { status: "contested", basis: "reply", replyIndex: 1 },
    },
  ];

  for (const { name, source = "This is unsafe", replies, thread, expected } of provenanceFixtures) {
    test(name, () => {
      expect(inferStatus(source, replies, thread)).toEqual(expected);
      expect(detectStatus(source, replies, thread)).toBe(expected.status);
    });
  }
});

describe("deterministic extraction helpers", () => {
  test("detects AI and agent markers from authors and text", () => {
    expect(
      detectAgentMarkers("Generated with Claude Code\nCo-Authored-By: Claude", "Jules[bot]"),
    ).toEqual(["Claude Code", "Generated with Claude Code", "Co-Authored-By: Claude", "Jules", "bot"]);
  });

  test("maps priority badges and text to rough severity", () => {
    expect(detectSeverity("[P0] critical token leak")).toBe("high");
    expect(detectSeverity("MEDIUM risk regression")).toBe("medium");
    expect(detectSeverity("[P3] low polish issue")).toBe("low");
    expect(detectSeverity("Missing query state")).toBeNull();
  });

  test("detects status heuristics from source and nearby replies", () => {
    expect(detectStatus("I think this is unsafe. Thoughts?", [])).toBe("contested");
    expect(detectStatus("This is unsafe", ["I disagree, this is not an issue."])).toBe("rejected");
    expect(detectStatus("This is unsafe", ["Good catch, addressed in abc123."])).toBe("resolved");
    expect(detectStatus("This is unsafe", ["Added the null check as requested."])).toBe(
      "resolved",
    );
    expect(detectStatus("This is unsafe", ["This is valid."])).toBe("accepted");
    expect(detectStatus("This is unsafe", ["Not fixed yet."])).toBe("candidate");
    expect(detectStatus("This is unsafe", ["This is not resolved."])).toBe("candidate");
    expect(detectStatus("This is unsafe", ["Not fixed yet.", "Fixed in abc123."])).toBe(
      "resolved",
    );
    expect(detectStatus("This is unsafe", ["This isn't valid."])).toBe("rejected");
    expect(detectStatus("This is unsafe", ["Not done yet."])).toBe("candidate");
    expect(detectStatus("This is unsafe", ["Fixed as intended."])).toBe("resolved");
    expect(detectStatus("This is unsafe", [], { isResolved: true, isOutdated: false })).toBe(
      "resolved",
    );
    expect(detectStatus("This is unsafe", [], { isResolved: false, isOutdated: true })).toBe(
      "superseded",
    );
    expect(detectStatus("This is unsafe", ["Not fixed yet."], { isResolved: true, isOutdated: false })).toBe(
      "candidate",
    );
  });

  test("maps representative keyword categories", () => {
    expect(detectCategory("Authorization cookie headers leak to third-party proxy")).toBe(
      "security_privacy_regression",
    );
    expect(detectCategory("APP_URL was replaced with a hardcoded production domain")).toBe(
      "environment_config_contract_violation",
    );
    expect(detectCategory("Downloaded PNG output omits fields shown in the preview renderer")).toBe(
      "preview_output_parity_failure",
    );
    expect(detectCategory("Template text is overwritten after React Query refetch while editing")).toBe(
      "user_input_loss",
    );
    expect(
      detectCategory(
        "Reject invalid manual decision values instead of coercing human-edited rule-decisions.json input.",
      ),
    ).toBe("human_editable_artifact_validation");
    expect(detectCategory("Manual decision dialog shows invalid tooltip state")).not.toBe(
      "human_editable_artifact_validation",
    );
    expect(detectCategory("Manual decision panel opens export modal")).not.toBe(
      "human_editable_artifact_validation",
    );
    expect(detectCategory("Status inference uses runId metadata when grouping replies")).toBe(
      "status_inference_error",
    );
    expect(detectCategory("Validate draft-rules runId before creating rule decisions")).toBe(
      "human_editable_artifact_validation",
    );
    expect(detectCategory("Validate export runId before accepting manual decisions")).toBe(
      "human_editable_artifact_validation",
    );
    expect(detectCategory("Validate human-editable export file before normalizing")).toBe(
      "human_editable_artifact_validation",
    );
    expect(detectCategory("Human-editable export file UI crashes")).not.toBe(
      "human_editable_artifact_validation",
    );
    expect(detectCategory("Export runId handling docs for the local UI")).not.toBe(
      "human_editable_artifact_validation",
    );
    expect(detectCategory("Reject manual decisions that reference unknown rule IDs")).toBe(
      "human_editable_artifact_validation",
    );
    expect(detectCategory("Unknown rule IDs page crashes while filtering docs")).not.toBe(
      "human_editable_artifact_validation",
    );
    expect(detectCategory("rule-decisions parser fails on trailing whitespace")).toBe(
      "parser_permissiveness",
    );
    expect(detectCategory("Manual decision dialog crashes when focus is lost")).not.toBe(
      "human_editable_artifact_validation",
    );
    expect(detectCategory("Human-editable form resets while editing")).toBe("user_input_loss");
    expect(detectCategory("Edited fields schema parser fails validation")).toBe(
      "parser_permissiveness",
    );
    expect(detectCategory("Accepted/edited tab crashes when opening settings")).not.toBe(
      "human_editable_artifact_validation",
    );
    expect(detectCategory("Accepted/edited tab crashes in rule-decisions UI")).not.toBe(
      "human_editable_artifact_validation",
    );
    expect(detectCategory("Validate accepted/edited rule decisions before export")).toBe(
      "human_editable_artifact_validation",
    );
    expect(detectCategory("Parser coercion accepts malformed values during decode")).toBe(
      "parser_permissiveness",
    );
    expect(
      detectCategory(
        "Detect candidate IDs reused across multiple enriched records so duplicate sourceCandidateIds cannot overwrite earlier records.",
      ),
    ).toBe("identifier_collision_record_loss");
    expect(
      detectCategory("sourceCandidateIds need disambiguation to avoid mixing records"),
    ).toBe("identifier_collision_record_loss");
    expect(detectCategory("Missing sourceCandidateId disambiguation in tooltips")).not.toBe(
      "identifier_collision_record_loss",
    );
    expect(detectCategory("Duplicate candidate IDs reset selected filters")).not.toBe(
      "identifier_collision_record_loss",
    );
    expect(detectCategory("Duplicate candidate IDs show wrong record tooltip")).not.toBe(
      "identifier_collision_record_loss",
    );
    expect(detectCategory("CSS selector collisions break layout rendering")).not.toBe(
      "identifier_collision_record_loss",
    );
    expect(detectCategory("Duplicate DOM IDs break label focus")).not.toBe(
      "identifier_collision_record_loss",
    );
    expect(detectCategory("DOM ID collisions break accessibility labels")).not.toBe(
      "identifier_collision_record_loss",
    );
    expect(detectCategory("CSS collisions in enriched records table break layout")).not.toBe(
      "identifier_collision_record_loss",
    );
    expect(detectCategory("Overwrites records table columns while dragging")).not.toBe(
      "identifier_collision_record_loss",
    );
    expect(detectCategory("Records list drops selection when scrolling")).not.toBe(
      "identifier_collision_record_loss",
    );
    expect(detectCategory("Suffixing IDs in DOM labels breaks accessibility")).not.toBe(
      "identifier_collision_record_loss",
    );
    expect(detectCategory("Filename suffixing bug drops uploaded files")).not.toBe(
      "identifier_collision_record_loss",
    );
    expect(detectCategory("Enriched records table omits cluster title")).not.toBe(
      "identifier_collision_record_loss",
    );
    expect(detectCategory("Include sourceCandidateIds in export output")).not.toBe(
      "identifier_collision_record_loss",
    );
    expect(detectCategory("Preserve sourceCandidateIds in export output")).not.toBe(
      "identifier_collision_record_loss",
    );
    expect(detectCategory("mapRecordsByCandidateId drops duplicate candidate IDs")).toBe(
      "identifier_collision_record_loss",
    );
    expect(detectCategory("mapRecordsByCandidateId resets form state unexpectedly")).not.toBe(
      "identifier_collision_record_loss",
    );
    expect(detectCategory("React Query refetch overwrites form values while editing")).toBe(
      "user_input_loss",
    );
    expect(detectCategory("React Query refetch overwrites existing form values while editing")).toBe(
      "user_input_loss",
    );
    expect(
      detectCategory(
        "A stale eventId can hit a foreign-key violation and return a generic 500 after moving the existence check outside the transaction.",
      ),
    ).toBe("context_omission");
    expect(
      detectCategory(
        "Handle negated acceptance phrases in status inference so not fixed yet stays candidate.",
      ),
    ).toBe("status_inference_error");
    expect(detectCategory("This breaks protected redirects and is not fixed yet")).toBe(
      "query_state_preservation_failure",
    );
    expect(detectCategory("Parser mishandles negated predicate")).toBe("parser_permissiveness");
    expect(detectCategory("API schema preserves inReplyTo for review comments")).not.toBe(
      "status_inference_error",
    );
    expect(detectCategory("Persist inReplyTo thread IDs in API responses")).not.toBe(
      "status_inference_error",
    );
    expect(detectCategory("Thread context menu fails to open")).not.toBe("status_inference_error");
    expect(detectCategory("Need whole PR context when rendering replies sidebar")).not.toBe(
      "status_inference_error",
    );
    expect(detectCategory("Replies aggregate list in the sidebar crashes when scrolling")).not.toBe(
      "status_inference_error",
    );
    expect(
      detectCategory("Review comment thread replies sidebar crashes when scrolling"),
    ).not.toBe("status_inference_error");
    expect(
      detectCategory("Review comment thread replies infer accepted status incorrectly"),
    ).toBe("status_inference_error");
    expect(
      detectCategory(
        "Support importing more than 100 requested PRs with fixed per_page pagination instead of one truncated pulls page request.",
      ),
    ).toBe("pagination_boundary_error");
    expect(detectCategory("UI pagination resets current page after refetch")).not.toBe(
      "pagination_boundary_error",
    );
    expect(detectCategory("per_page docs fail to render")).not.toBe("pagination_boundary_error");
    expect(detectCategory("per_page request validator rejects invalid value")).not.toBe(
      "pagination_boundary_error",
    );
    expect(detectCategory("per_page pagination control resets in UI")).not.toBe(
      "pagination_boundary_error",
    );
    expect(detectCategory("Pagination request debounce bug in UI")).not.toBe(
      "pagination_boundary_error",
    );
    expect(detectCategory("Pagination bug in PRs table drops selection")).not.toBe(
      "pagination_boundary_error",
    );
    expect(detectCategory("Pagination UI fails when page=2 is preserved in URL")).not.toBe(
      "pagination_boundary_error",
    );
    expect(detectCategory("Pagination control truncates page size label in UI")).not.toBe(
      "pagination_boundary_error",
    );
    expect(detectCategory("Quota allows more than 100 users")).not.toBe(
      "pagination_boundary_error",
    );
    expect(detectCategory("Requested PR list UI drops selection")).not.toBe(
      "pagination_boundary_error",
    );
    expect(detectCategory("Requested PRs table silently truncated at 40 chars")).not.toBe(
      "pagination_boundary_error",
    );
    expect(detectCategory("Base64 content is silently truncated")).toBe("parser_permissiveness");
    expect(detectCategory("Redirect drops query state when page=2 is preserved")).toBe(
      "query_state_preservation_failure",
    );
  });
});

function recordWithReviewComment(body: string): NormalizedPullRequestRecord {
  return {
    ...baseRecord,
    issueComments: [],
    reviewComments: [
      {
        ...baseRecord.reviewComments[0],
        body,
      },
    ],
    reviews: [],
  };
}
