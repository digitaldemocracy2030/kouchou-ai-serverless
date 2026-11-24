import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseResultJson } from "../src/lib/export";
import { clusterXY } from "../src/lib/pipeline/clusteringCore";
import { buildClusterTable, uniqueClusterIds } from "../src/lib/pipeline/clusterTable";
import { type AggregationInput, aggregation } from "../src/lib/pipeline/steps/aggregation";
import { buildPublicResult } from "../src/lib/publicResult";
import { canRecluster, projectFromResult } from "../src/lib/reportProject";
import type { Result } from "../src/types/result";
import type { Settings } from "../src/types/settings";

// サンプルレポート(生成元プロジェクトが存在しない)から、クラスタリング再実行用の
// プロジェクトを復元できることを確認する。

const result = JSON.parse(readFileSync("public/sample-report.json", "utf8")) as Result;

const settings = {
  chatSlot: { provider: null, model: "" },
  embeddingSlot: { provider: null, model: "" },
  imageSlot: { provider: null, model: "" },
  concurrency: 8,
} as unknown as Settings;

describe("projectFromResult", () => {
  it("サンプルレポートは再クラスタリング可能", () => {
    expect(canRecluster(result)).toBe(true);
  });

  it("意見・コメント・座標・階層割当を復元する", () => {
    const { project, extraction, clustering } = projectFromResult(result, {
      id: "p1",
      reportId: "sample",
      title: "サンプル",
      settings,
    });

    expect(extraction.args).toHaveLength(result.arguments.length);
    expect(extraction.relations).toHaveLength(result.arguments.length);
    expect(project.comments).toHaveLength(Object.keys(result.comments).length);
    expect(project.reportId).toBe("sample");
    expect(project.attributeColumns).toEqual(Object.keys(result.propertyMap));
    // 属性は意見側から引き当てる
    expect(project.comments[0].attributes.age).toBe(String(result.arguments[0].attributes?.age));

    // 座標は意見と同順・同数
    expect(clustering.argIds).toHaveLength(result.arguments.length);
    expect(clustering.x[0]).toBeCloseTo(result.arguments[0].x, 5);
    expect(clustering.y[0]).toBeCloseTo(result.arguments[0].y, 5);
    // cluster_ids から階層ごとの割当を復元(未割当 -1 が残らないこと)
    expect(clustering.assignments).toHaveLength(2);
    for (const labels of clustering.assignments) {
      expect(Math.min(...labels)).toBeGreaterThanOrEqual(0);
    }
    expect(clustering.clusterNums).toEqual(result.config.hierarchical_clustering.cluster_nums);
    // プロンプトはレポートの config から引き継ぐ
    expect(project.prompts.extraction).toBe(result.config.extraction.prompt);
  });

  it("座標の無いレポートは再クラスタリング不可", () => {
    const broken = { ...result, arguments: result.arguments.map((a) => ({ ...a, x: Number.NaN })) };
    expect(canRecluster(broken)).toBe(false);
  });
});

describe("インポートした公開JSONを再クラスタリングして書き出す", () => {
  it.each([
    ["属性表あり", true, 8],
    ["空の属性表", false, 8],
    ["入力件数不明", false, undefined],
  ] as const)("%sでも意見ごとの属性・スコア・入力件数を保持する", (_, withPropertyMap, originalCount) => {
    const original = {
      ...result,
      comment_num: originalCount,
      comments: {},
      config: {
        ...result.config,
        intro: "作成時の調査概要",
        model: "original-extractor",
        extraction: { ...result.config.extraction, model: "original-extractor" },
        enable_original_comments: false,
      },
      arguments: [0.8, -0.5, 0, 0.3].map((score, i) => ({
        ...result.arguments[i],
        comment_id: i < 2 ? "001" : "2",
        x: [0, 1, 20, 24][i],
        y: i % 2,
        attributes: { area: "01", score },
      })),
    };
    original.propertyMap = withPropertyMap ? { area: { [original.arguments[0].arg_id]: "01" } } : {};
    const source = parseResultJson(JSON.stringify(original));
    const { project, extraction, clustering } = projectFromResult(source, {
      id: "restored",
      reportId: "source",
      title: "復元",
      settings,
    });
    const newClustering = clusterXY(
      Array.from(clustering.x, (x, i) => [x, clustering.y[i]]),
      [2],
      "recluster",
    );
    const table = buildClusterTable(extraction.args, { ...clustering, ...newClustering });
    const input: AggregationInput = {
      project,
      comments: project.comments,
      extractionResult: extraction,
      table,
      labels: {
        byLevel: {
          1: uniqueClusterIds(table, 1).map((clusterId) => ({ clusterId, label: "新しいラベル", description: "説明" })),
        },
      },
      overviewText: "新しい概要",
      chatModel: "new-labeller",
      embeddingModel: "embedding",
      workers: 1,
      sourceReport: source,
    };
    const exported = parseResultJson(JSON.stringify(buildPublicResult(aggregation(input))));

    expect(exported.arguments.map((arg) => arg.attributes)).toEqual(original.arguments.map((arg) => arg.attributes));
    expect(exported.arguments.map((arg) => arg.comment_id)).toEqual(["001", "001", "2", "2"]);
    expect(exported.arguments.every((arg) => arg.cluster_ids.length === 2)).toBe(true);
    expect(exported.propertyMap).toEqual(original.propertyMap);
    expect(exported.comment_num).toBe(originalCount);
    expect(exported.comments).toEqual({});
    expect(exported.config.enable_original_comments).toBe(false);
    expect(exported.config.intro).toBe("作成時の調査概要");
    expect(exported.config.model).toBe("original-extractor");
    expect(exported.config.extraction.model).toBe("original-extractor");
    expect(exported.config.hierarchical_initial_labelling.model).toBe("new-labeller");
    expect(exported.config.hierarchical_clustering.cluster_nums).toEqual([2]);
    expect(exported.overview).toBe("新しい概要");
  });
});
