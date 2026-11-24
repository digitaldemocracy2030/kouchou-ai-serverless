import { afterEach, describe, expect, vi } from "vitest";
import { clusterXY, mergeClustersWithHierarchy } from "../../src/lib/pipeline/clusteringCore";
import { calculateRecommendedClusterNums } from "../../src/lib/pipeline/clusterNums";
import { buildClusterTable } from "../../src/lib/pipeline/clusterTable";
import { memoryCheckpoints, type PipelineContext } from "../../src/lib/pipeline/context";
import { clustering, umapCheckpointKey } from "../../src/lib/pipeline/steps/clustering";
import { extraction } from "../../src/lib/pipeline/steps/extraction";
import { initialLabelling, LABEL_ERROR_PLACEHOLDER } from "../../src/lib/pipeline/steps/labelling";
import { overview } from "../../src/lib/pipeline/steps/overview";
import { extractionPrompt, initialLabellingPrompt, mergeLabellingPrompt, overviewPrompt } from "../../src/prompts";
import { fakeFetch, type Stage } from "./fakeLlm";
import { conform, partition, readExpected } from "./harness";

// 個々の判定（クラスタ数・ward での統合・LLM 応答の読み取り・プロンプト）を本家と比べる。

type Outcome<T> = { input: string; ok?: T; error?: string };
type Units = {
  recommended_cluster_nums: { count: number; expected: number[] }[];
  normalize_cluster_nums: { requested: number[]; count: number; expected: number[] }[];
  ward_merge: { centroids: number[][]; cut: number; labels: number[] }[];
  separated_blobs: { points: number[][]; cluster_nums: number[]; labels: number[][] };
  parse: {
    extraction: Outcome<string[]>[];
    label: Outcome<{ label: string; description: string }>[];
    overview: Outcome<string>[];
  };
};

const units = readExpected<Units>("units.json");
const PROMPTS: Record<Stage, string> = {
  extraction: extractionPrompt,
  initial_labelling: initialLabellingPrompt,
  merge_labelling: mergeLabellingPrompt,
  overview: overviewPrompt,
};

function makeCtx(): PipelineContext {
  const endpoint = { baseUrl: "https://conformance.invalid/v1", apiKey: "test", model: "gpt-4o-mini" };
  return { chat: endpoint, embedding: endpoint, concurrency: 1, checkpoints: memoryCheckpoints(), random: () => 0.5 };
}

export function registerUnitTests(): void {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("プロンプト（管理画面が analysis-core に渡すもの）", () => {
    const { prompts } = readExpected<{ prompts: Record<Stage, string> }>("prompts.json");
    for (const stage of Object.keys(PROMPTS) as Stage[]) {
      conform(`prompts.${stage}`, `${stage} のプロンプトが一字一句同じ`, () => {
        expect(PROMPTS[stage]).toBe(prompts[stage]);
      });
    }
  });

  describe("クラスタ数", () => {
    conform("units.recommended_cluster_nums", "意見数から決める推奨クラスタ数（cube-root）", () => {
      for (const { count, expected } of units.recommended_cluster_nums) {
        expect([count, calculateRecommendedClusterNums(count)]).toEqual([count, expected]);
      }
    });

    conform("units.normalize_cluster_nums", "指定したクラスタ数の整え方（件数で上限・昇順・重複除去）", async () => {
      for (const { requested, count, expected } of units.normalize_cluster_nums) {
        // UMAP の座標を保存済みにして、クラスタ数の整え方と KMeans+ward だけを走らせる
        const ctx = makeCtx();
        const x = Float32Array.from({ length: count }, (_, i) => (i % 7) * 3 + i * 0.01);
        const y = Float32Array.from({ length: count }, (_, i) => Math.floor(i / 7) * 3 + i * 0.02);
        await ctx.checkpoints.putChunk("umap", umapCheckpointKey({ count, dim: 1, seed: "kouchou-ai" }), { x, y });
        const argIds = Array.from({ length: count }, (_, i) => `A${i}_0`);
        const result = await clustering({ argIds, dim: 1, vectors: new Float32Array(count) }, requested, ctx);
        expect([requested, count, result.clusterNums]).toEqual([requested, count, expected]);
      }
    });
  });

  describe("ward による上位クラスタへの統合（KMeans の重心を入力に固定）", () => {
    conform("units.ward_merge.partition", "同じ分け方になる", () => {
      for (const { centroids, cut, labels } of units.ward_merge) {
        const actual = mergeClustersWithHierarchy(centroids, Int32Array.from(centroids.map((_, i) => i)), cut);
        expect([cut, partition(actual)]).toEqual([cut, partition(labels)]);
      }
    });
    conform("units.ward_merge.labels", "クラスタ番号の振り方も同じ（ID とその並び順に効く）", () => {
      for (const { centroids, cut, labels } of units.ward_merge) {
        const actual = mergeClustersWithHierarchy(centroids, Int32Array.from(centroids.map((_, i) => i)), cut);
        expect([cut, Array.from(actual)]).toEqual([cut, labels]);
      }
    });
  });

  describe("KMeans + ward（はっきり分かれた塊）", () => {
    conform("units.separated_blobs.partition", "実装や乱数が違っても同じ分け方になる", () => {
      const { points, cluster_nums, labels } = units.separated_blobs;
      const { assignments } = clusterXY(points, cluster_nums, "kouchou-ai");
      expect(assignments.map((a) => partition(a))).toEqual(labels.map((l) => partition(l)));
    });
  });

  describe("LLM 応答の読み取り（各段に 1 件だけ流す）", () => {
    units.parse.extraction.forEach((item, index) => {
      conform(`parse.extraction.${index}`, `抽出: ${JSON.stringify(item.input)}`, async () => {
        vi.stubGlobal(
          "fetch",
          fakeFetch(PROMPTS, [], () => item.input),
        );
        const outcome = await extraction(
          [{ commentId: "1", body: "本文", attributes: {} }],
          PROMPTS.extraction,
          makeCtx(),
        )
          .then((r) => ({ ok: r.args.map((a) => a.argument) }))
          // 本家は意見 0 件でも空の結果（エラーではない）として扱う。serverless は全体で 0 件ならエラーにするので、
          // 1 件の回答だけを流すこのテストでは「0 件」を ok: [] とみなす
          .catch((error: Error) => (error.message.includes("1件も抽出できません") ? { ok: [] } : { error: "Error" }));
        expect("error" in outcome).toBe(item.error !== undefined);
        if (item.ok !== undefined) expect(outcome).toEqual({ ok: item.ok });
      });
    });

    units.parse.label.forEach((item, index) => {
      conform(`parse.label.${index}`, `ラベル: ${JSON.stringify(item.input)}`, async () => {
        vi.stubGlobal(
          "fetch",
          fakeFetch(PROMPTS, [], () => item.input),
        );
        const table = buildClusterTable([{ argId: "A1_0", argument: "意見" }], {
          argIds: ["A1_0"],
          x: Float32Array.from([0]),
          y: Float32Array.from([0]),
          clusterNums: [1],
          assignments: [Int32Array.from([0])],
        });
        const [label] = await initialLabelling(table, PROMPTS.initial_labelling, 30, makeCtx());
        // serverless は失敗をプレースホルダに置き換えて続行する。本家は失敗として扱う
        const failed = label.label === LABEL_ERROR_PLACEHOLDER;
        expect(failed).toBe(item.error !== undefined);
        if (item.ok !== undefined) expect({ label: label.label, description: label.description }).toEqual(item.ok);
      });
    });

    units.parse.overview.forEach((item, index) => {
      conform(`parse.overview.${index}`, `概要: ${JSON.stringify(item.input)}`, async () => {
        vi.stubGlobal(
          "fetch",
          fakeFetch(PROMPTS, [], () => item.input),
        );
        const outcome = await overview(
          { byLevel: { 1: [{ clusterId: "1_1", label: "ラベル", description: "説明" }] } },
          PROMPTS.overview,
          makeCtx(),
        )
          .then((summary) => ({ ok: summary }))
          .catch(() => ({ error: "Error" }));
        expect("error" in outcome).toBe(item.error !== undefined);
        if (item.ok !== undefined) expect(outcome).toEqual({ ok: item.ok });
      });
    });
  });
}
