import { afterEach, expect, it, vi } from "vitest";
import { buildClusterTable } from "../src/lib/pipeline/clusterTable";
import { memoryCheckpoints } from "../src/lib/pipeline/context";
import { restoreAnswerReferences } from "../src/lib/pipeline/restoreReferences";
import { aggregation } from "../src/lib/pipeline/steps/aggregation";
import { extraction } from "../src/lib/pipeline/steps/extraction";
import { extractAndEnrich } from "../src/stance-spectrum/extractEnrich";

const endpoint = { baseUrl: "https://mock.invalid/v1", apiKey: "", model: "test" };
const context = () => ({ chat: endpoint, embedding: endpoint, concurrency: 2, checkpoints: memoryCheckpoints() });
afterEach(() => vi.unstubAllGlobals());
it("同じ回答内の重複だけをまとめ、別回答の属性・件数を維持する", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"extractedOpinionList":["バスを増やす","バスを増やす"]}' } }],
          }),
        ),
    ),
  );
  const comments = [
    { commentId: "001", body: "a", attributes: { age: "20代" } },
    { commentId: "1", body: "b", attributes: { age: "60代" } },
  ];
  const extracted = await extraction(comments, "p", context());
  expect(extracted.args.map((a) => a.argId)).toEqual(["A001_0", "A1_0"]);
  expect(extracted.relations).toEqual([
    { argId: "A001_0", commentId: "001" },
    { argId: "A1_0", commentId: "1" },
  ]);
  const table = buildClusterTable(extracted.args, {
    argIds: extracted.args.map((a) => a.argId),
    x: Float32Array.from([0, 1]),
    y: Float32Array.from([0, 1]),
    clusterNums: [2],
    assignments: [Int32Array.from([0, 1])],
  });
  const result = aggregation({
    project: {
      title: "T",
      question: "Q",
      intro: "",
      attributeColumns: ["age"],
      clusterNums: [2],
      prompts: { extraction: "e", initialLabelling: "i", mergeLabelling: "m", overview: "o" },
      samplingNum: 30,
    },
    comments,
    extractionResult: extracted,
    table,
    labels: {
      byLevel: {
        1: [
          { clusterId: "1_0", label: "L", description: "D" },
          { clusterId: "1_1", label: "L", description: "D" },
        ],
      },
    },
    overviewText: "概要",
    chatModel: "test",
    embeddingModel: "test",
    workers: 2,
  });
  expect(result.arguments.map((a) => [a.comment_id, a.attributes?.age])).toEqual([
    ["001", "20代"],
    ["1", "60代"],
  ]);
  expect(result.clusters[0].value).toBe(2);
  expect(result.comments).toEqual({});
});
it("賛否スペクトラムも同文の別回答のenrichmentを残す", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) => {
      const input = JSON.parse(String(init?.body)).messages.at(-1).content;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ opinions: [{ argument: "同じ意見", target: input }] }) } }],
        }),
      );
    }),
  );
  const result = await extractAndEnrich(
    [
      { commentId: "a", body: "対象A", attributes: {} },
      { commentId: "b", body: "対象B", attributes: {} },
    ],
    "p",
    context(),
  );
  expect(result.args).toHaveLength(2);
  expect(result.enrichments.map((e) => e.target)).toEqual(["対象A", "対象B"]);
});
it("旧前処理ファイルはLLMなしで回答とベクトルの対応を復元する", () => {
  const result = restoreAnswerReferences(
    {
      args: [
        { argId: "A001_0", argument: "同じ" },
        { argId: "A1_1", argument: "別" },
      ],
      relations: [
        { argId: "A001_0", commentId: "001" },
        { argId: "A001_0", commentId: "001" },
        { argId: "A001_0", commentId: "1" },
        { argId: "A1_1", commentId: "1" },
      ],
    },
    { argIds: ["A001_0", "A1_1"], dim: 2, vectors: Float32Array.from([1, 2, 3, 4]) },
  );
  expect(result.extraction.args.map((a) => a.argId)).toEqual(["A001_0", "A1_0", "A1_1"]);
  expect(result.embedding.argIds).toEqual(["A001_0", "A1_0", "A1_1"]);
  expect(Array.from(result.embedding.vectors)).toEqual([1, 2, 1, 2, 3, 4]);
});
