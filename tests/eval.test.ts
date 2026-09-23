import { describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertSnapshot, buildReviewPacket, checkReviewPacket, evaluate, hashSnapshot, main, topLevelSources, validateLabels, writeReviewPacket } from "../scripts/eval";
import type { EvalSource, LabelFile, Prediction, ReviewPacket } from "../scripts/eval";
import type { NormalizedPullRequestRecord } from "../src/types";

const source = (id: number): EvalSource => ({
  key: `review_comment:${id}`, pr: 1, sourceType: "review_comment", body: "A finding.",
  replies: [], threadResolved: true, threadOutdated: false,
});
const prediction = (id: number): Prediction => ({
  key: `review_comment:${id}`, category: "context_omission", status: "resolved", basis: "thread_resolved",
});
const snapshotHash = "a".repeat(64);

function answeredPacket(): ReviewPacket {
  const packet = buildReviewPacket("traceback-ai", [source(1), source(2)], snapshotHash);
  packet.review = { reviewer: "Synthetic test reviewer", reviewedAt: "2026-09-23T00:00:00Z", rubricAccepted: true, humanReviewed: true };
  packet.entries.forEach((entry) => {
    entry.decision = { isFinding: true, category: null, status: null, note: "Synthetic ambiguity requiring human judgement." };
  });
  return packet;
}

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

describe("human review packets", () => {
  test("samples at most twelve sources deterministically without predictions or draft labels", () => {
    const sources = Array.from({ length: 30 }, (_, i) => source(i + 1));
    sources.push({ ...source(99), key: "pr_body:2", pr: 2, sourceType: "pr_body", threadResolved: null });
    sources.push({ ...source(98), replies: [{ body: "A complete reply ".repeat(200), author: "a" }] });
    sources.push({ ...source(97), key: "review:97", sourceType: "review", body: "", threadResolved: null });
    const before = structuredClone(sources);
    const packet = buildReviewPacket("traceback-ai", sources, snapshotHash);
    expect(packet).toEqual(buildReviewPacket("traceback-ai", [...sources].reverse(), snapshotHash));
    expect(packet.entries).toHaveLength(12);
    expect(new Set(packet.entries.map((entry) => entry.source.key)).size).toBe(12);
    expect(packet.entries.some(({ source }) => source.sourceType === "pr_body")).toBe(true);
    expect(packet.entries.some(({ source }) => source.body === "")).toBe(true);
    expect(packet.entries.find(({ source }) => source.key === "review_comment:98")?.source.replies[0].body).toBe(sources[31].replies[0].body);
    expect(packet.entries.every(({ decision }) => decision === null)).toBe(true);
    expect(packet.review).toEqual({ reviewer: "", reviewedAt: null, rubricAccepted: false, humanReviewed: false });
    expect(JSON.stringify(packet)).not.toContain('"extracted"');
    expect(JSON.stringify(packet)).not.toContain('"prediction"');
    expect(JSON.stringify(packet)).not.toContain('"labeler"');
    expect(sources).toEqual(before);
  });

  test("keeps small corpora complete and rejects empty/duplicate/holdout inputs", () => {
    expect(buildReviewPacket("EventSnaps", [source(1)], snapshotHash).entries).toHaveLength(1);
    expect(() => buildReviewPacket("traceback-ai", [], snapshotHash)).toThrow("empty corpus");
    expect(() => buildReviewPacket("traceback-ai", [source(1), source(1)], snapshotHash)).toThrow("Duplicate source");
    expect(() => buildReviewPacket("task-tracker", [source(1)], snapshotHash)).toThrow("development-only");
    expect(() => buildReviewPacket("../private", [source(1)], snapshotHash)).toThrow("development-only");
    expect(() => buildReviewPacket("traceback-ai", [source(1)], "bad")).toThrow("snapshot hash");
  });

  test("redistributes exhausted strata and retains complete source text", () => {
    const sources = Array.from({ length: 14 }, (_, i) => ({ ...source(i + 1), body: "full evidence ".repeat(1000) }));
    sources.push({ ...source(99), key: "issue_comment:99", sourceType: "issue_comment", threadResolved: null });
    const packet = buildReviewPacket("traceback-ai", sources, snapshotHash);
    expect(packet.entries).toHaveLength(12);
    expect(packet.entries.filter(({ source }) => source.sourceType === "review_comment")).toHaveLength(11);
    expect(packet.entries.find(({ source }) => source.sourceType === "review_comment")?.source.body).toBe(sources[0].body);
  });

  test("distinguishes unanswered, negative, and adjudicated null values", () => {
    const expected = buildReviewPacket("traceback-ai", [source(1), source(2)], snapshotHash);
    expect(checkReviewPacket(expected, expected)).toEqual({ answered: 0, pending: 2, attested: false, complete: false });
    const value = answeredPacket();
    value.entries[1].decision = { isFinding: false, category: null, status: null, note: "Synthetic boilerplate." };
    expect(checkReviewPacket(value, expected)).toEqual({ answered: 2, pending: 0, attested: true, complete: true });
    value.entries[0].decision = null;
    expect(checkReviewPacket(value, expected)).toEqual({ answered: 1, pending: 1, attested: true, complete: false });
    value.entries.reverse();
    expect(checkReviewPacket(value, expected).answered).toBe(1);
  });

  test.each([
    { humanReviewed: false }, { rubricAccepted: false }, { reviewer: " " }, { reviewedAt: null },
  ])("cannot complete without explicit reviewer attestation %j", (fields) => {
    const packet = answeredPacket();
    Object.assign(packet.review, fields);
    const expected = buildReviewPacket("traceback-ai", [source(1), source(2)], snapshotHash);
    expect(checkReviewPacket(packet, expected)).toMatchObject({ answered: 2, complete: false, attested: false });
  });

  test.each([
    { humanReviewed: "yes" }, { rubricAccepted: 1 }, { reviewer: ["human"] },
    { reviewedAt: "yesterday" }, { reviewedAt: "2026-09-23" }, { reviewedAt: undefined },
  ])("rejects invalid review metadata %j", (fields) => {
    const packet = answeredPacket();
    Object.assign(packet.review, fields);
    expect(() => checkReviewPacket(packet, buildReviewPacket("traceback-ai", [source(1), source(2)], snapshotHash))).toThrow("metadata");
  });

  test.each([
    { isFinding: "false" }, { category: "invented" }, { status: "fixed" },
    { isFinding: false, category: "context_omission" }, { note: " " }, { note: 123 },
    { key: "review_comment:999" }, { approved: true }, { isFinding: null },
  ])("rejects malformed responses %j", (fields) => {
    const packet = answeredPacket();
    Object.assign(packet.entries[0].decision!, fields);
    expect(() => checkReviewPacket(packet, buildReviewPacket("traceback-ai", [source(1), source(2)], snapshotHash))).toThrow();
  });

  test("rejects altered headers, sources and evidence even when the copied hash is unchanged", () => {
    const expected = buildReviewPacket("traceback-ai", [source(1), source(2)], snapshotHash);
    for (const mutate of [
      (p: any) => { p.schemaVersion = 2; },
      (p: any) => { p.repo = "EventSnaps"; },
      (p: any) => { p.snapshotHash = "b".repeat(64); },
      (p: any) => { p.packetId = "b".repeat(64); },
      (p: any) => { p.rubric.version = 2; },
      (p: any) => { p.rubric.rules[0] = "Automatically approve"; },
      (p: any) => { p.sampling.limit = 24; },
      (p: any) => { p.entries.pop(); },
      (p: any) => { p.entries.push(p.entries[0]); },
      (p: any) => { p.entries[1] = p.entries[0]; },
      (p: any) => { p.entries[0].source.key = "review_comment:99"; },
      (p: any) => { p.entries[0].source.body = "Altered evidence"; },
      (p: any) => { p.entries[0].source.replies.push({ body: "Fixed", author: "a" }); },
      (p: any) => { p.entries[0].source.threadResolved = false; },
      (p: any) => { delete p.entries[0].decision; },
    ]) {
      const packet = structuredClone(expected);
      mutate(packet);
      expect(() => checkReviewPacket(packet, expected)).toThrow();
    }
    expect(buildReviewPacket("traceback-ai", [source(1), { ...source(2), body: "Changed" }], snapshotHash).packetId).not.toBe(expected.packetId);
    expect(() => checkReviewPacket(expected, buildReviewPacket("traceback-ai", [source(1), source(2)], "b".repeat(64)))).toThrow("snapshot");
  });

  test("refuses to overwrite existing human work", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "traceback-review-"));
    try {
      const file = path.join(root, "packets", "traceback-ai.json");
      const packet = answeredPacket();
      await writeReviewPacket(file, packet);
      const original = await readFile(file, "utf8");
      await expect(writeReviewPacket(file, buildReviewPacket("traceback-ai", [source(1)], snapshotHash))).rejects.toThrow("refusing to overwrite");
      expect(await readFile(file, "utf8")).toBe(original);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.each([
    ["review-packet"], ["review-packet", "task-tracker"], ["check-review", "task-tracker"],
    ["review-packet", "--all"], ["check-review", "--all"], ["review-packet", "../private"],
    ["review-packet", "traceback-ai", "--report"], ["check-review", "EventSnaps", "extra"],
  ].map((args) => ({ args })))("rejects unsafe or ambiguous CLI arguments %j", async ({ args }) => {
    await expect(main(args)).rejects.toThrow("Invalid review arguments");
  });

  test("CLI generates and checks isolated synthetic packets without modifying draft labels", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "traceback-adjudication-cli-"));
    try {
      await cp(path.resolve(import.meta.dir, "../src"), path.join(root, "src"), { recursive: true });
      await mkdir(path.join(root, "scripts"));
      await cp(path.resolve(import.meta.dir, "../scripts/eval.ts"), path.join(root, "scripts/eval.ts"));
      await mkdir(path.join(root, "eval/data/traceback-ai"), { recursive: true });
      await mkdir(path.join(root, "eval/labels"));
      const labelFile = path.join(root, "eval/labels/traceback-ai.json");
      await writeFile(labelFile, "unchanged draft sentinel");
      const recordFile = path.join(root, "eval/data/traceback-ai/pr-1.json");
      const record = { schemaVersion: 3, repository: { owner: "vivekmaru", repo: "traceback-ai" }, prNumber: 1,
        body: "PRIVATE_SYNTHETIC_SOURCE", reviewComments: [], issueComments: [], reviews: [], reviewThreads: [] };
      await writeFile(recordFile, JSON.stringify(record));
      const cli = (...args: string[]) => {
        const child = Bun.spawnSync([process.execPath, path.join(root, "scripts/eval.ts"), ...args], {
          cwd: root, env: { ...process.env, OPENAI_API_KEY: "", GITHUB_TOKEN: "", GH_TOKEN: "" },
        });
        const output = child.stdout.toString() + child.stderr.toString();
        expect(output).not.toContain("PRIVATE_SYNTHETIC_SOURCE");
        return { code: child.exitCode, output };
      };
      expect(cli("--help").output).toContain("review-packet|check-review");
      expect(cli("review-packet", "traceback-ai").code).toBe(0);
      const file = path.join(root, "eval/data/adjudication/traceback-ai.json");
      const original = await readFile(file, "utf8");
      expect(cli("check-review", "traceback-ai")).toMatchObject({ code: 1 });
      expect(cli("review-packet", "traceback-ai").output).toContain("refusing to overwrite");
      expect(await readFile(file, "utf8")).toBe(original);
      const packet: ReviewPacket = JSON.parse(original);
      packet.review = { reviewer: "Synthetic fixture, not real human review", reviewedAt: "2026-09-23T00:00:00Z", rubricAccepted: true, humanReviewed: true };
      packet.entries[0].decision = { isFinding: false, category: null, status: null, note: "Synthetic negative." };
      await writeFile(file, JSON.stringify(packet));
      expect(cli("check-review", "traceback-ai")).toMatchObject({ code: 0 });
      expect(await readFile(labelFile, "utf8")).toBe("unchanged draft sentinel");
      await writeFile(recordFile, JSON.stringify({ ...record, body: "Changed snapshot" }));
      expect(cli("check-review", "traceback-ai").output).toContain("snapshot");
      await writeFile(file, "PRIVATE_SYNTHETIC_SOURCE{broken");
      expect(cli("check-review", "traceback-ai").output).toContain("Invalid JSON");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);
});
