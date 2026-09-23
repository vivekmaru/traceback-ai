import { describe, expect, test } from "bun:test";
import { assertSnapshot, evaluate, hashSnapshot, main, topLevelSources, validateLabels } from "../scripts/eval";
import type { EvalSource, LabelFile, Prediction } from "../scripts/eval";
import type { NormalizedPullRequestRecord } from "../src/types";

const source = (id: number): EvalSource => ({
  key: `review_comment:${id}`, pr: 1, sourceType: "review_comment", body: "A finding.",
  replies: [], threadResolved: true, threadOutdated: false,
});
const prediction = (id: number): Prediction => ({
  key: `review_comment:${id}`, category: "context_omission", status: "resolved", basis: "thread_resolved",
});
function labels(): LabelFile {
  return { repo: "traceback-ai", labeledAt: "2026-09-23", labeler: "test fixture", entries: [
    { key: "review_comment:1", isFinding: true, category: "context_omission", status: "resolved" },
    { key: "review_comment:2", isFinding: true, category: null, status: null },
    { key: "review_comment:3", isFinding: true, category: "context_omission", status: "candidate" },
    { key: "review_comment:4", isFinding: false, category: null, status: null },
    { key: "review_comment:5", isFinding: false, category: null, status: null },
  ] };
}

describe("evaluation correctness", () => {
  test("computes detection separately and excludes unknown labels from accuracy denominators", () => {
    const result = evaluate([1, 2, 3, 4, 5].map(source), [1, 2, 4].map(prediction), labels());
    expect(result).toMatchObject({ tp: 2, fp: 1, fn: 1, tn: 1,
      precision: 2 / 3, recall: 2 / 3, f1: 2 / 3,
      categoryCorrect: 1, categoryTotal: 1, categoryExcluded: 1, categoryAccuracy: 1,
      statusCorrect: 1, statusTotal: 1, statusExcluded: 1, statusAccuracy: 1,
      statusByBasis: { thread_resolved: { correct: 1, total: 1, excluded: 1 } },
    });
    expect(result.errors).toEqual([{ key: "review_comment:3", kind: "FN" }, { key: "review_comment:4", kind: "FP" }]);
  });

  test("reports genuine status errors and category confusion", () => {
    const value = labels();
    value.entries = value.entries.slice(0, 1);
    value.entries[0].status = "candidate";
    value.entries[0].category = "security_privacy_regression";
    const result = evaluate([source(1)], [prediction(1)], value);
    expect(result.statusAccuracy).toBe(0);
    expect(result.categoryAccuracy).toBe(0);
    expect(result.errors.map((error) => error.kind)).toEqual(["category", "status"]);
    expect(result.categoryConfusion).toEqual({ "security_privacy_regression -> context_omission": 1 });
  });

  test("reports undefined metrics as null rather than fabricated zero scores", () => {
    const value = labels();
    value.entries = [value.entries[4]];
    const result = evaluate([source(5)], [], value);
    expect(result).toMatchObject({ precision: null, recall: null, f1: null, categoryAccuracy: null, statusAccuracy: null });
  });

  test("unknown status labels never lower accuracy even when all are excluded", () => {
    const value = labels();
    value.entries = [value.entries[1]];
    expect(evaluate([source(2)], [prediction(2)], value)).toMatchObject({ statusAccuracy: null, statusExcluded: 1, statusTotal: 0 });
  });

  test("requires complete source coverage", () => {
    expect(() => evaluate([source(1), source(99)], [], labels())).toThrow("Unlabeled source");
    expect(() => evaluate([source(1)], [], labels())).toThrow("Unknown source");
    expect(() => evaluate([], [], labels())).toThrow("empty corpus");
  });

  test("rejects duplicate labels, sources, predictions and unmatched predictions", () => {
    const value = labels();
    value.entries.push(value.entries[0]);
    expect(() => evaluate([1, 2, 3, 4, 5].map(source), [], value)).toThrow("Duplicate label");
    expect(() => evaluate([source(1), source(1)], [], labels())).toThrow("Duplicate source");
    expect(() => evaluate([1, 2, 3, 4, 5].map(source), [prediction(1), prediction(1)], labels())).toThrow("Duplicate prediction");
    expect(() => evaluate([1, 2, 3, 4, 5].map(source), [prediction(99)], labels())).toThrow("Unknown source");
  });

  test.each([
    { isFinding: "false" }, { category: "invented" }, { status: "fixed" },
    { key: "../private" }, { note: 123 }, { isFinding: false },
    { category: undefined }, { status: undefined },
  ])("rejects malformed label fields %j", (fields) => {
    const value = labels();
    Object.assign(value.entries[0], fields);
    expect(() => validateLabels(value, "traceback-ai")).toThrow("Invalid label entry");
  });

  test("rejects foreign repo, version, date, metadata, and invalid hash", () => {
    for (const fields of [{ repo: "other" }, { schemaVersion: 2 }, { labeledAt: "garbage" }, { labeler: "" }, { entries: null }]) {
      expect(() => validateLabels({ ...labels(), ...fields }, "traceback-ai")).toThrow("metadata");
    }
    expect(() => validateLabels({ ...labels(), snapshotHash: "bad" }, "traceback-ai")).toThrow("snapshot hash");
  });

  test("snapshot identity is order independent but sensitive to names and content", () => {
    const a = { name: "pr-1.json", text: "one" };
    const b = { name: "pr-2.json", text: "two" };
    expect(hashSnapshot([a, b])).toBe(hashSnapshot([b, a]));
    expect(hashSnapshot([a, b])).not.toBe(hashSnapshot([a, { ...b, text: "changed" }]));
    expect(hashSnapshot([a, b])).not.toBe(hashSnapshot([a, { ...b, name: "pr-3.json" }]));
    const value = labels();
    const hash = hashSnapshot([a, b]);
    expect(() => assertSnapshot(value, hash)).toThrow("unbound");
    value.schemaVersion = 1;
    value.snapshotHash = hash;
    expect(() => assertSnapshot(value, hash)).not.toThrow();
    expect(() => assertSnapshot(value, hashSnapshot([a]))).toThrow("snapshot changed");
  });

  test("worksheets retain full evidence and exclude predictions and unrelated replies", () => {
    const body = "Finding ".repeat(200);
    const record = {
      prNumber: 1, body, reviewComments: [
        { id: 1, body, inReplyToId: null },
        { id: 2, body: "New reply", author: "a", inReplyToId: 1, createdAt: "2026-09-02" },
        { id: 3, body: "Old reply", author: "b", inReplyToId: 1, createdAt: "2026-09-01" },
        { id: 4, body: "Unrelated", inReplyToId: 42 },
      ], issueComments: [{ id: 1, body: "Issue text" }], reviews: [],
      reviewThreads: [{ commentIds: ["1", "2", "3"], isResolved: true, isOutdated: false }],
    } as unknown as NormalizedPullRequestRecord;
    const entries = topLevelSources(record);
    expect(entries).toHaveLength(3);
    expect(entries[0].body).toBe(body);
    expect(entries[0].replies.map((reply) => reply.body)).toEqual(["Old reply", "New reply"]);
    expect(entries[0]).not.toHaveProperty("extracted");
    expect(entries[0]).not.toHaveProperty("extractedCategory");
    expect(entries[1]).toMatchObject({ sourceType: "issue_comment", replies: [], threadResolved: null });
  });

  test.each([[], ["run"], ["run", "../private"], ["unknown", "task-tracker"], ["seal", "task-tracker", "--report"], ["run", "task-tracker", "--bad"]].map((args) => ({ args })))(
    "rejects invalid CLI arguments %j", async ({ args }) => {
      await expect(main(args)).rejects.toThrow("Invalid eval arguments");
    },
  );
});
