import type { EmbeddingResult, ExtractionResult } from "../../types/project";

/** 旧版の前処理ファイルの多対多参照を、元のベクトルを複製して回答単位へ戻す。LLMは呼ばない。 */
export function restoreAnswerReferences(
  extraction: ExtractionResult,
  embedding: EmbeddingResult,
): { extraction: ExtractionResult; embedding: EmbeddingResult } {
  const seen = new Set<string>();
  const owner = new Map<string, string>();
  const needsUpgrade = extraction.relations.some(({ argId, commentId }) => {
    const pair = JSON.stringify([argId, commentId]);
    const duplicate = seen.has(pair) || (owner.has(argId) && owner.get(argId) !== commentId);
    seen.add(pair);
    owner.set(argId, commentId);
    return duplicate;
  });
  if (!needsUpgrade) return { extraction, embedding };
  const byId = new Map(extraction.args.map((arg) => [arg.argId, arg]));
  const vectorIndex = new Map(embedding.argIds.map((id, index) => [id, index]));
  const counters = new Map<string, number>();
  const used = new Set<string>();
  const args: ExtractionResult["args"] = [];
  const relations: ExtractionResult["relations"] = [];
  const sourceIndices: number[] = [];
  for (const relation of extraction.relations) {
    const old = byId.get(relation.argId);
    const index = vectorIndex.get(relation.argId);
    if (!old || index === undefined) throw new Error("前処理データの意見とベクトルの対応が不正です");
    const j = counters.get(relation.commentId) ?? 0;
    counters.set(relation.commentId, j + 1);
    const pair = JSON.stringify([relation.commentId, old.argument]);
    if (used.has(pair)) continue;
    used.add(pair);
    const argId = `A${relation.commentId}_${j}`;
    args.push({ ...old, argId });
    relations.push({ argId, commentId: relation.commentId });
    sourceIndices.push(index);
  }
  const vectors = new Float32Array(args.length * embedding.dim);
  sourceIndices.forEach((index, row) => {
    vectors.set(embedding.vectors.subarray(index * embedding.dim, (index + 1) * embedding.dim), row * embedding.dim);
  });
  return {
    extraction: { args, relations },
    embedding: { argIds: args.map((arg) => arg.argId), dim: embedding.dim, vectors },
  };
}
