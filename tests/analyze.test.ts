import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildAnalysisInput,
  callOpenAIProvider,
  parseAnalysisOutput,
  runAnalysis,
} from "../src/analyze";
import type { FailureCandidate } from "../src/types";

describe("runAnalysis", () => {
  test("writes dry-run analysis artifacts without calling a provider", async () => {
    const repoRoot = await repoWithFailures([candidate("failure-pr-42-review_comment-7")]);
    let providerCalls = 0;

    try {
      const result = await runAnalysis(repoRoot, {
        mode: "dry-run",
        now: new Date("2026-05-17T09:45:22Z"),
        providerClient: async () => {
          providerCalls += 1;
          throw new Error("provider should not be called");
        },
      });

      expect(providerCalls).toBe(0);
      expect(result.runId).toBe("2026-05-17T09-45-22Z");

      const runDir = path.join(repoRoot, ".traceback", "analysis", "runs", result.runId);
      const manifest = await readJson(path.join(runDir, "manifest.json"));
      const input = await readJson(path.join(runDir, "input.json"));
      const prompt = await readFile(path.join(runDir, "prompt.md"), "utf8");

      expect(manifest).toMatchObject({
        runId: "2026-05-17T09-45-22Z",
        mode: "dry-run",
        provider: null,
        createdAt: "2026-05-17T09:45:22.000Z",
        source: {
          failureCandidateCount: 1,
        },
        files: {
          input: "input.json",
          prompt: "prompt.md",
          response: null,
          enrichedRecords: null,
          clusters: null,
          summary: null,
        },
      });
      expect(manifest.source.recordsHash).toMatch(/^sha256-[a-f0-9]{64}$/);
      expect(input.failureCandidates).toHaveLength(1);
      expect(input.failureCandidates[0].id).toBe("failure-pr-42-review_comment-7");
      expect(input.failureCandidates[0]).toEqual({
        id: "failure-pr-42-review_comment-7",
        sourcePrNumber: 42,
        sourcePrUrl: "https://github.com/acme/widgets/pull/42",
        sourceCommentUrl: "https://github.com/acme/widgets/pull/42#discussion_r7",
        sourceType: "review_comment",
        title: "Query params are dropped",
        candidateCategory: "query_state_preservation_failure",
        candidateSeverity: "high",
        confidence: "high",
        status: "candidate",
        evidenceExcerpt: "The protected redirect drops query params and loses template state.",
        detectedAgentMarkers: ["codex", "bot"],
        surroundingSummary:
          "PR #42 review_comment: Query params are dropped. The protected redirect drops query params and loses template state.",
      });
      expect(prompt).toContain("enrich only the deterministic failure candidates");
      expect(prompt).toContain("preserve source references");
      expect(prompt).toContain("distinguish deterministic candidate category from enriched failure type");
      expect(prompt).toContain("avoid exposing unnecessary raw code");
      expect(prompt).toContain("failure-pr-42-review_comment-7");
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("provider analysis writes response, enriched records, clusters, and summary", async () => {
    const repoRoot = await repoWithFailures([
      candidate("failure-pr-42-review_comment-7"),
      candidate("failure-pr-41-pr_body-41"),
    ]);

    try {
      const result = await runAnalysis(repoRoot, {
        mode: "provider",
        provider: "openai",
        now: new Date("2026-05-17T10:00:00Z"),
        providerClient: async ({ input }) => ({
          rawResponse: {
            id: "resp_test",
          provider: "openai",
        },
        analysis: {
          enrichedRecords: input.failureCandidates.map((item) => ({
              id: `enriched-${item.id}`,
              sourceCandidateIds: [item.id],
              title: `Enriched ${item.id}`,
              failureType: "contract_drift",
              summary: `Enriched ${item.id}`,
              whatTheAgentMissed: "The implementation missed an existing contract.",
              evidenceSummary: item.evidenceExcerpt,
              likelyFixOrCorrection: "Restore the missing contract behavior.",
              preventionRule: "Check existing contracts before changing the flow.",
              confidence: "medium",
              sourcePrs: [item.sourcePrNumber],
              sourceComments: item.sourceCommentUrl ? [item.sourceCommentUrl] : [],
              notes: ["Generated from deterministic candidate evidence."],
            })),
            clusters: [
              {
                id: "cluster-contract-drift",
                title: "Contract drift",
                summary: "Multiple candidates point to missed local contracts.",
                candidateIds: input.failureCandidates.map((item) => item.id),
                failureTypes: ["contract_drift"],
                sourcePrs: input.failureCandidates.map((item) => item.sourcePrNumber),
                evidenceSummary: "Candidates show missed contracts.",
                whatTheAgentMissed: "The agent did not preserve established flow behavior.",
                preventionRule: "Preserve existing contracts.",
                confidence: "medium",
              },
            ],
            summary: {
              overview: "Two deterministic candidates were enriched.",
              highestRiskPatterns: ["Contract drift"],
              recommendedNextActions: ["Review proposed prevention rules."],
            },
          },
        }),
      });

      const runDir = path.join(repoRoot, ".traceback", "analysis", "runs", result.runId);
      const manifest = await readJson(path.join(runDir, "manifest.json"));
      const response = await readJson(path.join(runDir, "response.json"));
      const enrichedRecords = await readJson(path.join(runDir, "enriched-records.json"));
      const clusters = await readJson(path.join(runDir, "clusters.json"));
      const summary = await readFile(path.join(runDir, "analysis-summary.md"), "utf8");

      expect(manifest).toMatchObject({
        mode: "provider",
        provider: "openai",
        files: {
          response: "response.json",
          enrichedRecords: "enriched-records.json",
          clusters: "clusters.json",
          summary: "analysis-summary.md",
        },
      });
      expect(response.id).toBe("resp_test");
      expect(enrichedRecords).toHaveLength(2);
      expect(enrichedRecords[0].sourceCandidateIds).toEqual(["failure-pr-42-review_comment-7"]);
      expect(clusters).toEqual([
        {
          id: "cluster-contract-drift",
          title: "Contract drift",
          summary: "Multiple candidates point to missed local contracts.",
          candidateIds: ["failure-pr-42-review_comment-7", "failure-pr-41-pr_body-41"],
          failureTypes: ["contract_drift"],
          sourcePrs: [42, 41],
          evidenceSummary: "Candidates show missed contracts.",
          whatTheAgentMissed: "The agent did not preserve established flow behavior.",
          preventionRule: "Preserve existing contracts.",
          confidence: "medium",
        },
      ]);
      expect(summary).toContain("# Traceback AI Analysis Summary");
      expect(summary).toContain("- Run ID: 2026-05-17T10-00-00Z");
      expect(summary).toContain("- Mode: provider");
      expect(summary).toContain("- Provider: openai");
      expect(summary).toContain("Two deterministic candidates were enriched.");
      expect(summary).toContain("Contract drift");
      expect(summary).toContain("failure-pr-42-review_comment-7");
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("uses a stable records hash for the same candidates regardless of file write order", async () => {
    const firstRepo = await repoWithFailures([
      candidate("failure-pr-42-review_comment-7"),
      candidate("failure-pr-41-pr_body-41"),
    ]);
    const secondRepo = await repoWithFailures([
      candidate("failure-pr-41-pr_body-41"),
      candidate("failure-pr-42-review_comment-7"),
    ]);

    try {
      const first = await runAnalysis(firstRepo, {
        mode: "dry-run",
        now: new Date("2026-05-17T11:00:00Z"),
      });
      const second = await runAnalysis(secondRepo, {
        mode: "dry-run",
        now: new Date("2026-05-17T11:01:00Z"),
      });

      const firstManifest = await readJson(first.manifestPath);
      const secondManifest = await readJson(second.manifestPath);
      expect(firstManifest.source.recordsHash).toBe(secondManifest.source.recordsHash);
    } finally {
      await rm(firstRepo, { recursive: true, force: true });
      await rm(secondRepo, { recursive: true, force: true });
    }
  });

  test("keeps repeated runs in distinct timestamp-like directories", async () => {
    const repoRoot = await repoWithFailures([candidate("failure-pr-42-review_comment-7")]);

    try {
      const first = await runAnalysis(repoRoot, {
        mode: "dry-run",
        now: new Date("2026-05-17T11:30:00Z"),
      });
      const second = await runAnalysis(repoRoot, {
        mode: "dry-run",
        now: new Date("2026-05-17T11:30:00Z"),
      });

      expect(first.runId).toBe("2026-05-17T11-30-00Z");
      expect(second.runId).toBe("2026-05-17T11-30-00Z-1");
      expect(await readJson(first.manifestPath)).toMatchObject({
        runId: "2026-05-17T11-30-00Z",
      });
      expect(await readJson(second.manifestPath)).toMatchObject({
        runId: "2026-05-17T11-30-00Z-1",
      });
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("missing OpenAI API key fails clearly while preserving generated input and prompt", async () => {
    const repoRoot = await repoWithFailures([candidate("failure-pr-42-review_comment-7")]);
    const previousApiKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    try {
      await expect(
        runAnalysis(repoRoot, {
          mode: "provider",
          provider: "openai",
          now: new Date("2026-05-17T12:00:00Z"),
        }),
      ).rejects.toThrow("OPENAI_API_KEY is required");

      const runDir = path.join(repoRoot, ".traceback", "analysis", "runs", "2026-05-17T12-00-00Z");
      expect(await readJson(path.join(runDir, "manifest.json"))).toMatchObject({
        mode: "provider",
        provider: "openai",
        files: {
          input: "input.json",
          prompt: "prompt.md",
          response: null,
          enrichedRecords: null,
          clusters: null,
          summary: null,
        },
      });
      expect(await readJson(path.join(runDir, "input.json"))).toMatchObject({
        failureCandidateCount: 1,
      });
      expect(await readFile(path.join(runDir, "prompt.md"), "utf8")).toContain(
        "failure-pr-42-review_comment-7",
      );
    } finally {
      if (previousApiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousApiKey;
      }
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});

describe("analysis helpers", () => {
  test("buildAnalysisInput keeps model input compact", () => {
    const input = buildAnalysisInput([candidate("failure-pr-42-review_comment-7")], "2026-05-17T00:00:00Z");

    expect(input.failureCandidates[0]).not.toHaveProperty("notes");
    expect(input.failureCandidates[0]).not.toHaveProperty("createdAt");
    expect(input.failureCandidates[0]).toHaveProperty("surroundingSummary");
  });

  test("parseAnalysisOutput accepts the expected enriched record and cluster schema", () => {
    const parsed = parseAnalysisOutput(
      JSON.stringify({
        enrichedRecords: [
          {
            id: "enriched-query-lifecycle",
            sourceCandidateIds: ["failure-pr-42-review_comment-7"],
            title: "Template intent lifecycle failure",
            failureType: "lifecycle_state_loss",
            summary: "The protected-route flow loses template intent state.",
            whatTheAgentMissed: "The agent missed a route lifecycle contract.",
            evidenceSummary: "Review evidence says query params were dropped.",
            likelyFixOrCorrection: "Preserve search params through redirect.",
            preventionRule: "Before changing auth redirects, verify query state is preserved.",
            confidence: "high",
            sourcePrs: [42],
            sourceComments: ["https://github.com/acme/widgets/pull/42#discussion_r7"],
            notes: ["Single source candidate."],
          },
        ],
        clusters: [
          {
            id: "cluster-template-lifecycle",
            title: "Template intent and protected-route lifecycle failure",
            summary: "Related candidates show state loss across auth redirect lifecycle.",
            candidateIds: ["failure-pr-42-review_comment-7"],
            failureTypes: ["lifecycle_state_loss"],
            sourcePrs: [42],
            evidenceSummary: "Query params were dropped during redirect.",
            whatTheAgentMissed: "The agent missed the lifecycle contract.",
            preventionRule: "Verify auth redirects preserve template intent state.",
            confidence: "high",
          },
        ],
        summary: {
          overview: "One candidate was enriched.",
          highestRiskPatterns: ["Lifecycle state loss"],
          recommendedNextActions: ["Review auth redirect prevention rule."],
        },
      }),
    );

    expect(parsed.enrichedRecords[0].id).toBe("enriched-query-lifecycle");
    expect(parsed.clusters[0].preventionRule).toBe(
      "Verify auth redirects preserve template intent state.",
    );
  });

  test("parseAnalysisOutput rejects malformed JSON", () => {
    expect(() => parseAnalysisOutput("not json")).toThrow("valid JSON analysis output");
  });

  test("callOpenAIProvider warns before sending selected evidence", async () => {
    const previousApiKey = process.env.OPENAI_API_KEY;
    const previousFetch = globalThis.fetch;
    const previousWarn = console.warn;
    const warnings: string[] = [];
    let fetchCalled = false;
    process.env.OPENAI_API_KEY = "test-key";
    console.warn = (message?: unknown) => {
      warnings.push(String(message));
    };
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response(
        JSON.stringify({
          output_text: JSON.stringify(validAnalysisOutput()),
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    try {
      const input = buildAnalysisInput(
        [candidate("failure-pr-42-review_comment-7")],
        "2026-05-17T00:00:00Z",
      );
      const result = await callOpenAIProvider({ input, prompt: "test prompt" });

      expect(fetchCalled).toBe(true);
      expect(warnings[0]).toContain("selected local PR/comment evidence");
      expect(result.analysis.enrichedRecords[0].sourceCandidateIds).toEqual([
        "failure-pr-42-review_comment-7",
      ]);
    } finally {
      if (previousApiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousApiKey;
      }
      globalThis.fetch = previousFetch;
      console.warn = previousWarn;
    }
  });
});

async function repoWithFailures(candidates: FailureCandidate[]): Promise<string> {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "traceback-analyze-"));
  const failuresDir = path.join(repoRoot, ".traceback", "records", "failures");
  await mkdir(failuresDir, { recursive: true });

  for (const item of candidates) {
    await writeFile(path.join(failuresDir, `${item.id}.json`), `${JSON.stringify(item, null, 2)}\n`, "utf8");
  }

  return repoRoot;
}

function candidate(id: string): FailureCandidate {
  const prNumber = id.includes("pr-41") ? 41 : 42;
  return {
    schemaVersion: 1,
    id,
    sourcePrNumber: prNumber,
    sourcePrUrl: `https://github.com/acme/widgets/pull/${prNumber}`,
    sourceCommentUrl: id.includes("review_comment")
      ? `https://github.com/acme/widgets/pull/${prNumber}#discussion_r7`
      : null,
    sourceAuthor: "chatgpt-codex-connector[bot]",
    sourceType: id.includes("pr_body") ? "pr_body" : "review_comment",
    extractedTitle: "Query params are dropped",
    evidenceExcerpt: "The protected redirect drops query params and loses template state.",
    candidateCategory: "query_state_preservation_failure",
    candidateSeverity: "high",
    confidence: "high",
    status: "candidate",
    detectedAgentMarkers: ["codex", "bot"],
    createdAt: "2026-05-17T00:00:00Z",
    updatedAt: "2026-05-17T00:00:00Z",
    notes: ["test fixture"],
  };
}

async function readJson(filePath: string): Promise<any> {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function validAnalysisOutput(): unknown {
  return {
    enrichedRecords: [
      {
        id: "enriched-query-lifecycle",
        sourceCandidateIds: ["failure-pr-42-review_comment-7"],
        title: "Template intent lifecycle failure",
        failureType: "lifecycle_state_loss",
        summary: "The protected-route flow loses template intent state.",
        whatTheAgentMissed: "The agent missed a route lifecycle contract.",
        evidenceSummary: "Review evidence says query params were dropped.",
        likelyFixOrCorrection: "Preserve search params through redirect.",
        preventionRule: "Before changing auth redirects, verify query state is preserved.",
        confidence: "high",
        sourcePrs: [42],
        sourceComments: ["https://github.com/acme/widgets/pull/42#discussion_r7"],
        notes: ["Single source candidate."],
      },
    ],
    clusters: [
      {
        id: "cluster-template-lifecycle",
        title: "Template intent and protected-route lifecycle failure",
        summary: "Related candidates show state loss across auth redirect lifecycle.",
        candidateIds: ["failure-pr-42-review_comment-7"],
        failureTypes: ["lifecycle_state_loss"],
        sourcePrs: [42],
        evidenceSummary: "Query params were dropped during redirect.",
        whatTheAgentMissed: "The agent missed the lifecycle contract.",
        preventionRule: "Verify auth redirects preserve template intent state.",
        confidence: "high",
      },
    ],
    summary: {
      overview: "One candidate was enriched.",
      highestRiskPatterns: ["Lifecycle state loss"],
      recommendedNextActions: ["Review auth redirect prevention rule."],
    },
  };
}
