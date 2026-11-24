import type {
  ClusteringResult,
  EmbeddingResult,
  ExtractionResult,
  LabellingResult,
  PipelineStepName,
  Project,
} from "../../types/project";
import type { Result } from "../../types/result";
import { parseOverviewResponse } from "../llm/jsonParse";
import { isLocalEmbedding } from "../llm/localEmbedding";
import { chatCacheKey, embeddingCacheKey, extractionCacheKey, cacheKey as key } from "./cacheKeys";
import { buildClusterTable } from "./clusterTable";
import type { PipelineContext } from "./context";
import { aggregation } from "./steps/aggregation";
import { type ClusteringProgressExtra, clustering } from "./steps/clustering";
import { embedding } from "./steps/embedding";
import { extraction } from "./steps/extraction";
import { initialLabelling, isValidClusterLabel, mergeLabelling } from "./steps/labelling";
import { overview } from "./steps/overview";

// パイプラインの逐次実行(DESIGN §6)。
// 各ステップの完了済み出力は store に確定保存し、再実行時はそこから再開する。
// ステップ内部の細かい再開(コメント単位・バッチ単位・クラスタ単位)は ctx.checkpoints が担う。

export type StepStore = {
  // biome-ignore lint/suspicious/noExplicitAny: ステップごとに型が異なる
  get(step: PipelineStepName, cacheKey?: string): Promise<any | undefined>;
  // biome-ignore lint/suspicious/noExplicitAny: ステップごとに型が異なる
  put(step: PipelineStepName, data: any, cacheKey?: string): Promise<void>;
};

export type OrchestratorDeps = {
  ctx: PipelineContext;
  store: StepStore;
  onStepChange?: (step: PipelineStepName) => void;
  clusteringExtra?: ClusteringProgressExtra;
};

export async function runPipeline(project: Project, deps: OrchestratorDeps): Promise<Result> {
  const { ctx, store, onStepChange } = deps;

  const chatKey = chatCacheKey(ctx.chat);
  // 旧版の回答横断集約・失敗ラベル・ward.D の完了済み工程を、新仕様で再利用しない。
  // コメント単位の成功キャッシュは引き続き利用する。
  const extractionKey = extractionCacheKey(project);
  onStepChange?.("extraction");
  let extractionResult: ExtractionResult | undefined = await store.get("extraction", extractionKey);
  if (!extractionResult) {
    extractionResult = await extraction(project.comments, project.prompts.extraction, ctx);
    await store.put("extraction", extractionResult, extractionKey);
  }

  const embeddingKey = embeddingCacheKey(extractionResult.args, ctx.embedding);
  onStepChange?.("embedding");
  let embeddingResult: EmbeddingResult | undefined = await store.get("embedding", embeddingKey);
  if (!embeddingResult) {
    embeddingResult = await embedding(extractionResult.args, ctx);
    await store.put("embedding", embeddingResult, embeddingKey);
  }

  const clusteringKey = key("ward2", embeddingKey, project.clusterNums, project.umap, project.umapSeed);
  onStepChange?.("clustering");
  let clusteringResult: ClusteringResult | undefined = await store.get("clustering", clusteringKey);
  if (!clusteringResult) {
    clusteringResult = await clustering(embeddingResult, project.clusterNums, ctx, deps.clusteringExtra, {
      umap: project.umap,
      seed: project.umapSeed,
    });
    await store.put("clustering", clusteringResult, clusteringKey);
  }

  const table = buildClusterTable(extractionResult.args, clusteringResult);

  const initialKey = key(clusteringKey, project.prompts.initialLabelling, project.samplingNum, chatKey);
  onStepChange?.("initial_labelling");
  let deepestLabels = await store.get("initial_labelling", initialKey);
  const refreshLabels =
    !Array.isArray(deepestLabels) || !deepestLabels.length || !deepestLabels.every(isValidClusterLabel);
  if (refreshLabels) {
    deepestLabels = await initialLabelling(table, project.prompts.initialLabelling, project.samplingNum, ctx);
    await store.put("initial_labelling", deepestLabels, initialKey);
  }

  const mergeKey = key(initialKey, deepestLabels, project.prompts.mergeLabelling);
  onStepChange?.("merge_labelling");
  let labels: LabellingResult | undefined = await store.get("merge_labelling", mergeKey);
  const refreshOverview = refreshLabels || !labels || !Object.values(labels.byLevel).flat().every(isValidClusterLabel);
  if (!labels || refreshOverview) {
    labels = await mergeLabelling(table, deepestLabels, project.prompts.mergeLabelling, project.samplingNum, ctx);
    await store.put("merge_labelling", labels, mergeKey);
  }

  const overviewKey = key(labels, project.prompts.overview, chatKey);
  onStepChange?.("overview");
  let overviewText: string | undefined = await store.get("overview", overviewKey);
  try {
    if (overviewText !== undefined) parseOverviewResponse(overviewText);
  } catch {
    overviewText = undefined;
  }
  if (refreshOverview || overviewText === undefined) {
    overviewText = await overview(labels, project.prompts.overview, ctx);
    await store.put("overview", overviewText, overviewKey);
  }

  onStepChange?.("aggregation");
  const result = aggregation({
    project,
    comments: project.comments,
    extractionResult,
    table,
    labels,
    overviewText,
    chatModel: ctx.chat.model,
    embeddingModel: ctx.embedding.model,
    workers: ctx.concurrency,
    embeddedAtLocal: isLocalEmbedding(ctx.embedding),
  });
  await store.put("aggregation", result);
  return result;
}
