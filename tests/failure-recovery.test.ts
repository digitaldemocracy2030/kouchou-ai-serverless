import { afterEach, describe, expect, it, vi } from "vitest";
import { parseLabelResponse, parseOverviewResponse } from "../src/lib/llm/jsonParse";
import { buildClusterTable, compositionHash } from "../src/lib/pipeline/clusterTable";
import { memoryCheckpoints, type PipelineContext } from "../src/lib/pipeline/context";
import { initialLabelling, LABEL_ERROR_PLACEHOLDER } from "../src/lib/pipeline/steps/labelling";
import { overview } from "../src/lib/pipeline/steps/overview";
import { buildCodebook } from "../src/stance-spectrum/codebook";
import { parseEnrichment } from "../src/stance-spectrum/enrich";
import { extractAndEnrich, parseExtractEnrich } from "../src/stance-spectrum/extractEnrich";
import { CHUNK_STEP } from "../src/stance-spectrum/storageKeys";

const ctx = (): PipelineContext => ({
  chat: { baseUrl: "https://mock.invalid/v1", apiKey: "", model: "mock" },
  embedding: { baseUrl: "", apiKey: "", model: "" },
  concurrency: 2,
  checkpoints: memoryCheckpoints(),
});
const response = (value: unknown) =>
  new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }));
const table = buildClusterTable(
  [
    { argId: "A1_0", argument: "one" },
    { argId: "A2_0", argument: "two" },
  ],
  {
    argIds: ["A1_0", "A2_0"],
    x: new Float32Array([0, 1]),
    y: new Float32Array([0, 1]),
    clusterNums: [2],
    assignments: [new Int32Array([0, 1])],
  },
);
afterEach(() => vi.unstubAllGlobals());

describe("ラベルの失敗から再開", () => {
  it("一部失敗で中断し、成功済みのクラスタを再送しない", async () => {
    const context = ctx();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        const input = JSON.parse(String(init?.body)).messages.at(-1).content;
        return input.startsWith("two")
          ? new Response("error", { status: 401 })
          : response({ label: "L", description: "D" });
      }),
    );
    await expect(initialLabelling(table, "p", 30, context)).rejects.toThrow();
    const description = "説明に <think>引用</think> を残す";
    const retry = vi.fn(async () => response({ label: "回復", description }));
    vi.stubGlobal("fetch", retry);
    const labels = await initialLabelling(table, "p", 30, context);
    expect(labels.map((l) => l.label)).toEqual(["L", "回復"]);
    expect(labels[1].description).toBe(description);
    expect(retry).toHaveBeenCalledTimes(1);
  });
  it("旧版のプレースホルダも取り直す", async () => {
    const context = ctx();
    await context.checkpoints.putChunk("labelling", `initial/1_0/${compositionHash(table, 1, "1_0")}`, {
      clusterId: "1_0",
      label: LABEL_ERROR_PLACEHOLDER,
      description: "D",
    });
    const fetch = vi.fn(async () => response({ label: "回復", description: "正常" }));
    vi.stubGlobal("fetch", fetch);
    expect((await initialLabelling(table, "p", 30, context)).every((l) => l.label === "回復")).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it.each(['{"label":"L"}', '{"label":"L","description":" "}', '{"label":"","description":"D"}'])(
    "不完全なラベルを拒否: %s",
    (text) => {
      expect(parseLabelResponse(text)).toBeNull();
    },
  );
});

describe("概要の形式不正", () => {
  it.each(['{"summary":""}', '{"other":"x"}', '{"summary":"途中で切れ', "", '```json\n{"summary":', '["要約"]'])(
    "壊れたJSONを要約本文として使わない: %s",
    (text) => {
      expect(() => parseOverviewResponse(text)).toThrow();
    },
  );
  it("失敗を保存せず、再試行で取り直す", async () => {
    const context = ctx();
    const labels = { byLevel: { 1: [{ clusterId: "1_0", label: "L", description: "D" }] } };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response({ other: "x" })),
    );
    await expect(overview(labels, "p", context)).rejects.toThrow();
    const summary = "回復した概要。タグ名は <think>引用</think>";
    const fetch = vi.fn(async () => response({ summary }));
    vi.stubGlobal("fetch", fetch);
    expect(await overview(labels, "p", context)).toBe(summary);
    expect(await overview(labels, "p", context)).toBe(summary);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

it("賛否スペクトラムの属性抽出とタグ統合でJSON内の文字列を保持する", async () => {
  const tag = "話題 <think>引用</think> と ```json";
  const enriched = parseEnrichment(JSON.stringify({ target: tag, topics: [{ label: tag, weight: 1 }] }));
  expect(enriched.target).toBe(tag);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response({ canonical: [tag], mapping: [{ from: tag, to: tag }] })),
  );
  expect((await buildCodebook([enriched], ctx())).topics).toEqual([tag]);
});

describe("賛否スペクトラムの抽出失敗", () => {
  const comments = [
    { commentId: "1", body: "bad", attributes: {} },
    { commentId: "2", body: "good", attributes: {} },
  ];
  it("結合抽出で補正が必要でも本文とタグの文字列を保持", () => {
    const text = '意見 ",]" と <think>引用</think>';
    const opinion = JSON.stringify({ argument: text, topics: [{ label: text, weight: 1 }] });
    const parsed = parseExtractEnrich(`{"opinions":[${opinion},]}`);
    expect(parsed[0]).toMatchObject({ argument: text, enrichment: { topics: [{ label: text, weight: 1 }] } });
  });
  it("正常0件と区別し、失敗分だけを取り直す", async () => {
    const context = ctx();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) =>
        JSON.parse(String(init?.body)).messages.at(-1).content.startsWith("bad")
          ? new Response("error", { status: 401 })
          : response({ opinions: [{ argument: "成功" }] }),
      ),
    );
    await expect(extractAndEnrich(comments, "p", context)).rejects.toThrow();
    expect(await context.checkpoints.getChunk(CHUNK_STEP.extract, "1")).toBeUndefined();
    const fetch = vi.fn(async () => response({ opinions: [{ argument: "回復" }] }));
    vi.stubGlobal("fetch", fetch);
    expect((await extractAndEnrich(comments, "p", context)).args.map((a) => a.argument)).toEqual(["回復", "成功"]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("旧版の空キャッシュは再検証し、正常0件を以後は再利用する", async () => {
    const context = ctx();
    await context.checkpoints.putChunk(CHUNK_STEP.extract, "1", []);
    const fetch = vi.fn(async () => response({ opinions: [] }));
    vi.stubGlobal("fetch", fetch);
    await expect(extractAndEnrich(comments.slice(0, 1), "p", context)).rejects.toThrow("1件も");
    await expect(extractAndEnrich(comments.slice(0, 1), "p", context)).rejects.toThrow("1件も");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(["broken", "{}", '{"opinions":[42]}', '{"opinions":[{"argument":42}]}'])(
    "形式不正を空配列として扱わない: %s",
    (text) => {
      expect(() => parseExtractEnrich(text)).toThrow();
    },
  );
});
