import type { CommentRow, ExtractionResult, LabellingResult, Project } from "../../../types/project";
import type { Argument, Cluster, Result, ResultConfig } from "../../../types/result";
import type { ClusterTable } from "../clusterTable";
import { rowsInCluster, uniqueClusterIds } from "../clusterTable";

// 本家 hierarchical_aggregation.py の移植。
// Result JSON(本家 hierarchical_result.json 互換)を組み立てる。

/** 本家 _build_parent_child_mapping の移植。level1 の親は "0"。 */
export function buildParentChildMapping(table: ClusterTable): Map<string, string> {
  const parentById = new Map<string, string>();
  for (const id of uniqueClusterIds(table, 1)) {
    parentById.set(id, "0");
  }
  for (let levelIndex = 0; levelIndex < table.levels.length - 1; levelIndex++) {
    const level = table.levels[levelIndex];
    const childLevel = table.levels[levelIndex + 1];
    for (const parentId of uniqueClusterIds(table, level)) {
      const rows = rowsInCluster(table, level, parentId);
      const childIds = new Set(rows.map((row) => table.idsByLevel[childLevel - 1][row]));
      for (const childId of childIds) {
        parentById.set(childId, parentId);
      }
    }
  }
  return parentById;
}

/** 本家 calculate_density: 重心からの平均距離の逆数 */
export function calculateDensity(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n === 0) return 0;
  const cx = xs.reduce((a, b) => a + b, 0) / n;
  const cy = ys.reduce((a, b) => a + b, 0) / n;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += Math.hypot(xs[i] - cx, ys[i] - cy);
  }
  const avgDistance = sum / n;
  return 1 / (avgDistance + 1e-10);
}

type MeltedCluster = {
  level: number;
  id: string;
  label: string;
  description: string;
  value: number;
  parent: string;
  density: number;
  densityRankPercentile: number;
};

/** クラスタを縦持ちに変換し、密度ランクパーセンタイルを計算する */
export function meltClusters(table: ClusterTable, labels: LabellingResult): MeltedCluster[] {
  const parentById = buildParentChildMapping(table);
  const melted: MeltedCluster[] = [];
  for (const level of table.levels) {
    const labelById = new Map((labels.byLevel[level] ?? []).map((l) => [l.clusterId, l]));
    for (const clusterId of uniqueClusterIds(table, level)) {
      const rows = rowsInCluster(table, level, clusterId);
      const label = labelById.get(clusterId);
      melted.push({
        level,
        id: clusterId,
        label: label?.label ?? "",
        description: label?.description ?? "",
        value: rows.length,
        parent: parentById.get(clusterId) ?? "0",
        density: calculateDensity(
          rows.map((row) => table.x[row]),
          rows.map((row) => table.y[row]),
        ),
        densityRankPercentile: 0,
      });
    }
  }
  // レベル内で密度降順の順位 → パーセンタイル(本家 rank(descending, ordinal) / count)
  for (const level of table.levels) {
    const inLevel = melted.filter((c) => c.level === level);
    const sorted = [...inLevel].sort((a, b) => b.density - a.density);
    sorted.forEach((cluster, index) => {
      cluster.densityRankPercentile = (index + 1) / inLevel.length;
    });
  }
  return melted;
}

export type AggregationInput = {
  project: Pick<
    Project,
    | "title"
    | "question"
    | "intro"
    | "attributeColumns"
    | "clusterNums"
    | "prompts"
    | "samplingNum"
    | "enableOriginalComments"
  >;
  comments: CommentRow[];
  extractionResult: ExtractionResult;
  table: ClusterTable;
  labels: LabellingResult;
  overviewText: string;
  chatModel: string;
  chatInBrowser?: boolean;
  embeddingModel: string;
  workers: number;
  embeddedAtLocal?: boolean;
  /** 再クラスタリング元のレポート。属性・件数・抽出時の来歴を引き継ぐ。 */
  sourceReport?: Result;
};

export function aggregation(input: AggregationInput): Result {
  const { project, comments, extractionResult, table, labels, overviewText } = input;

  // arg-id -> comment-id(最初の出現を採用)
  const commentIdByArgId = new Map<string, string>();
  for (const relation of extractionResult.relations) {
    if (!commentIdByArgId.has(relation.argId)) {
      commentIdByArgId.set(relation.argId, relation.commentId);
    }
  }
  const commentById = new Map(comments.map((c) => [c.commentId, c]));

  // ---- arguments ----
  const argumentsList: Argument[] = table.argIds.map((argId, row) => {
    const clusterIds = ["0", ...table.levels.map((level) => table.idsByLevel[level - 1][row])];
    const commentId = commentIdByArgId.get(argId) ?? "";
    const argument: Argument = {
      arg_id: argId,
      argument: table.argumentTexts[row],
      comment_id: commentId,
      x: table.x[row],
      y: table.y[row],
      p: 0,
      cluster_ids: clusterIds,
    };
    const comment = commentById.get(commentId);
    if (comment && project.attributeColumns.length > 0) {
      const attributes: Record<string, string | number> = {};
      let hasValue = false;
      for (const col of project.attributeColumns) {
        const value = comment.attributes[col];
        if (value !== undefined && value !== "") {
          attributes[col] = value;
          hasValue = true;
        }
      }
      if (hasValue) argument.attributes = attributes;
    }
    return argument;
  });

  // ---- clusters(ルート "0" + 各レベル) ----
  const melted = meltClusters(table, labels);
  const clusters: Cluster[] = [
    {
      level: 0,
      id: "0",
      label: "全体",
      takeaway: "",
      value: table.argIds.length,
      parent: "",
      density_rank_percentile: 0,
    },
    ...melted.map((c) => ({
      level: c.level,
      id: c.id,
      label: c.label,
      takeaway: c.description,
      value: c.value,
      parent: c.parent,
      density_rank_percentile: c.densityRankPercentile,
    })),
  ];

  // ---- comments(抽出に使われたコメントのみ) ----
  const usefulCommentIds = new Set(commentIdByArgId.values());
  const commentsMap: Record<string, { comment: string }> = {};
  for (const comment of comments) {
    if (project.enableOriginalComments === true && usefulCommentIds.has(comment.commentId)) {
      commentsMap[comment.commentId] = { comment: comment.body };
    }
  }

  // ---- propertyMap ----
  // biome-ignore lint/suspicious/noExplicitAny: 本家互換
  const propertyMap: Record<string, any> = {};
  for (const col of project.attributeColumns) {
    const map: Record<string, string | null> = {};
    for (const argId of table.argIds) {
      const commentId = commentIdByArgId.get(argId) ?? "";
      const value = commentById.get(commentId)?.attributes[col];
      map[argId] = value !== undefined && value !== "" ? value : null;
    }
    propertyMap[col] = map;
  }

  // ---- intro(本家 create_custom_intro と同じ文面) ----
  const llmProviderDisplay = input.chatInBrowser
    ? `ブラウザ内実行 (${input.chatModel})`
    : `OpenAI 互換 API (${input.chatModel})`;
  const customIntro = `${project.intro}\n分析対象となったデータの件数は${comments.length}件で、これらのデータに対して${llmProviderDisplay}を用いて${table.argIds.length}件の意見（議論）を抽出し、クラスタリングを行った。\n`;

  const config: ResultConfig = {
    name: project.title,
    question: project.question,
    input: project.title,
    model: input.chatModel,
    intro: customIntro,
    output_dir: "",
    is_embedded_at_local: input.embeddedAtLocal ?? false,
    enable_original_comments: project.enableOriginalComments === true,
    extraction: {
      workers: input.workers,
      limit: comments.length,
      properties: project.attributeColumns,
      categories: {},
      category_batch_size: 0,
      source_code: "",
      prompt: project.prompts.extraction,
      model: input.chatModel,
    },
    hierarchical_clustering: {
      cluster_nums: table.levels.map((level) => uniqueClusterIds(table, level).length),
      source_code: "",
    },
    embedding: {
      model: input.embeddingModel,
      source_code: "",
    },
    hierarchical_initial_labelling: {
      workers: input.workers,
      source_code: "",
      prompt: project.prompts.initialLabelling,
      model: input.chatModel,
    },
    hierarchical_merge_labelling: {
      workers: input.workers,
      source_code: "",
      prompt: project.prompts.mergeLabelling,
      model: input.chatModel,
    },
    hierarchical_overview: {
      source_code: "",
      prompt: project.prompts.overview,
      model: input.chatModel,
    },
    hierarchical_aggregation: {
      hidden_properties: {},
      source_code: "",
    },
    plan: [],
    status: "completed",
  };

  const result: Result = {
    arguments: argumentsList,
    clusters,
    comments: commentsMap,
    propertyMap,
    translations: {},
    overview: overviewText,
    config,
    comment_num: comments.length,
  };
  return input.sourceReport ? preserveSourceData(result, input.sourceReport) : result;
}

function preserveSourceData(reclustered: Result, source: Result): Result {
  const originalById = new Map(source.arguments.map((arg) => [arg.arg_id, arg]));
  const currentIds = new Set(reclustered.arguments.map((arg) => arg.arg_id));
  const originalConfig = source.config;
  return {
    ...reclustered,
    arguments: reclustered.arguments.map((arg) => {
      const original = originalById.get(arg.arg_id);
      if (!original) return arg;
      return { ...arg, attributes: original.attributes, url: original.url, p: original.p };
    }),
    propertyMap: Object.fromEntries(
      Object.entries(source.propertyMap ?? {}).map(([column, values]) => [
        column,
        Object.fromEntries(Object.entries(values ?? {}).filter(([id]) => currentIds.has(id))),
      ]),
    ),
    comment_num: source.comment_num,
    config: {
      ...reclustered.config,
      intro: originalConfig?.intro ?? "",
      model: originalConfig?.model ?? originalConfig?.extraction?.model ?? "",
      provider: originalConfig?.provider,
      enable_source_link: originalConfig?.enable_source_link,
      extraction: {
        ...reclustered.config.extraction,
        ...originalConfig?.extraction,
        model: originalConfig?.extraction?.model ?? originalConfig?.model ?? "",
      },
      hierarchical_aggregation: {
        ...reclustered.config.hierarchical_aggregation,
        hidden_properties: originalConfig?.hierarchical_aggregation?.hidden_properties,
      },
    },
  };
}
