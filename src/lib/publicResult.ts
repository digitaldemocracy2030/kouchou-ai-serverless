import type { Result, ResultConfig } from "../types/result";
import { commentSourceFields, readCommentIds } from "./opinionSources";

// 本体 public_result.json schema_version=1 の公開フィールドだけを写す。
const ARGUMENT_KEYS = ["arg_id", "argument", "x", "y", "p", "cluster_ids", "attributes", "url"] as const;
const CLUSTER_KEYS = ["level", "id", "label", "takeaway", "value", "parent", "density_rank_percentile"] as const;
const CONFIG_KEYS = [
  "question",
  "intro",
  "model",
  "provider",
  "analysis_mode",
  "is_embedded_at_local",
  "enable_source_link",
  "enable_original_comments",
] as const;
const STEP_KEYS: Record<string, readonly string[]> = {
  extraction: ["workers", "limit", "properties", "categories", "category_batch_size", "source_code", "prompt", "model"],
  embedding: ["model", "source_code"],
  hierarchical_clustering: ["cluster_nums", "source_code"],
  hierarchical_initial_labelling: ["workers", "source_code", "prompt", "model"],
  hierarchical_merge_labelling: ["workers", "source_code", "prompt", "model"],
  hierarchical_overview: ["source_code", "prompt", "model"],
  hierarchical_aggregation: ["source_code"],
  hierarchical_visualization: ["source_code"],
  opinion_classification: ["enabled", "labels"],
};
function pick(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  return Object.fromEntries(keys.filter((key) => Object.hasOwn(record, key)).map((key) => [key, record[key]]));
}

/** 旧JSON・外部JSONでも、元コメントは明示trueのときだけ配布する。入力は変更しない。 */
export function buildPublicResult(result: Result): Result {
  const source = (result.config ?? {}) as unknown as Record<string, unknown>;
  const config = pick(source, CONFIG_KEYS);
  const includeComments = source.enable_original_comments === true;
  config.enable_original_comments = includeComments;
  for (const [step, keys] of Object.entries(STEP_KEYS)) {
    if (source[step] && typeof source[step] === "object") config[step] = pick(source[step], keys);
  }
  if (Array.isArray(source.plan)) config.plan = source.plan.map((item) => pick(item, ["step", "run", "reason"]));
  const hidden = new Set(Object.keys(result.config?.hierarchical_aggregation?.hidden_properties ?? {}));
  const linkedIds = new Set<string>();
  const args = result.arguments.map((arg) => {
    const ids = readCommentIds(arg);
    for (const id of ids) linkedIds.add(id);
    return { ...pick(arg, ARGUMENT_KEYS), ...commentSourceFields(ids) };
  });
  return {
    schema_version: 1,
    arguments: args as unknown as Result["arguments"],
    clusters: result.clusters.map((cluster) => pick(cluster, CLUSTER_KEYS)) as unknown as Result["clusters"],
    comments: includeComments
      ? Object.fromEntries(
          Object.entries(result.comments ?? {})
            .filter(([id, value]) => linkedIds.has(id) && typeof value?.comment === "string")
            .map(([id, value]) => [id, { comment: value.comment }]),
        )
      : {},
    propertyMap: Object.fromEntries(Object.entries(result.propertyMap ?? {}).filter(([key]) => !hidden.has(key))),
    translations: Object.fromEntries(
      Object.entries(result.translations ?? {}).map(([language, entry]) => [
        language,
        entry && typeof entry === "object"
          ? Object.fromEntries(Object.entries(entry).filter(([key]) => key !== "meta"))
          : entry,
      ]),
    ),
    overview: result.overview ?? "",
    config: config as ResultConfig,
    comment_num: result.comment_num,
  };
}
