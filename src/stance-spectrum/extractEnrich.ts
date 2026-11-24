import { requestChat, Semaphore } from "../lib/llm/client";
import { parseJsonObjectLoose } from "../lib/llm/jsonParse";
import type { PipelineContext } from "../lib/pipeline/context";
import { settleAll, throwIfAborted, throwIfCacheOnly } from "../lib/pipeline/context";
import type { CommentRow, ExtractedArgument, Relation } from "../types/project";
import { fallbackEnrichment, normalizeEnrichment } from "./enrich";
import { buildExtractEnrichPrompt, EXTRACT_ENRICH_SCHEMA } from "./prompts";
import { CHUNK_STEP } from "./storageKeys";
import type { OpinionEnrichment } from "./types";

// 賛否スペクトラム分析の投入口: 生コメントから「意見抽出 + 構造化属性付与(stance/topics/reasons 等)」を
// コメント1件=チャット1回でまとめて行う。通常版の extraction には依存しない。
// - 同じ回答内の同文だけをまとめる。別回答の文面・属性・enrichment は別々に保持
// - 失敗は正常0件と区別し、成功分だけ保存してから中断する
// - チェックポイント: コメント単位(chunkCache step CHUNK_STEP.extract)

/** 1意見ぶんの抽出結果(意見文 + 構造化属性) */
export type RawOpinion = { argument: string; enrichment: OpinionEnrichment };

/** args と enrichments は同順・同長(ユニークな argId ごと) */
export type ExtractEnrichResult = {
  args: ExtractedArgument[];
  relations: Relation[];
  enrichments: OpinionEnrichment[];
};

export type ExtractEnrichProgress = (done: number, total: number) => void;

export async function extractAndEnrich(
  comments: CommentRow[],
  extractionPrompt: string,
  ctx: PipelineContext,
  onProgress?: ExtractEnrichProgress,
): Promise<ExtractEnrichResult> {
  const systemPrompt = buildExtractEnrichPrompt(extractionPrompt);
  const semaphore = new Semaphore(ctx.concurrency);
  let done = 0;
  const total = comments.length;
  onProgress?.(0, total);

  // コメント単位で抽出+分類(チェックポイント優先)。結果はコメント順を保つ。
  const perComment: RawOpinion[][] = new Array(comments.length);
  await settleAll(
    comments.map((comment, index) =>
      semaphore.run(async () => {
        throwIfAborted(ctx.signal);
        const cached = await ctx.checkpoints.getChunk(CHUNK_STEP.extract, comment.commentId);
        const emptyConfirmed = await ctx.checkpoints.getChunk(`${CHUNK_STEP.extract}-empty`, comment.commentId);
        if (Array.isArray(cached) && (cached.length > 0 || emptyConfirmed === true)) {
          perComment[index] = cached as RawOpinion[];
        } else {
          throwIfCacheOnly(ctx, `意見抽出 (コメント ${comment.commentId})`);
          perComment[index] = await extractEnrichOne(comment.body, systemPrompt, ctx);
          await ctx.checkpoints.putChunk(CHUNK_STEP.extract, comment.commentId, perComment[index]);
          if (perComment[index].length === 0)
            await ctx.checkpoints.putChunk(`${CHUNK_STEP.extract}-empty`, comment.commentId, true);
        }
        done++;
        onProgress?.(done, total);
      }),
    ),
  );

  const argumentMap = new Map<string, { arg: ExtractedArgument; enrichment: OpinionEnrichment }>();
  const relations: Relation[] = [];
  for (let i = 0; i < comments.length; i++) {
    const commentId = comments[i].commentId;
    for (const [j, op] of (perComment[i] ?? []).entries()) {
      const key = JSON.stringify([commentId, op.argument]);
      if (argumentMap.has(key)) continue;
      const argId = `A${commentId}_${j}`;
      argumentMap.set(key, { arg: { argId, argument: op.argument }, enrichment: op.enrichment });
      relations.push({ argId, commentId });
    }
  }

  const entries = [...argumentMap.values()];
  if (entries.length === 0) {
    throw new Error("意見が1件も抽出できませんでした。プロンプトまたはモデル設定を確認してください。");
  }
  return {
    args: entries.map((e) => e.arg),
    relations,
    enrichments: entries.map((e) => e.enrichment),
  };
}

async function extractEnrichOne(body: string, systemPrompt: string, ctx: PipelineContext): Promise<RawOpinion[]> {
  const response = await requestChat(ctx.chat, {
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: body },
    ],
    jsonSchema: EXTRACT_ENRICH_SCHEMA,
    signal: ctx.signal,
    onUsage: ctx.onUsage,
  });
  return parseExtractEnrich(response);
}

/**
 * 結合抽出レスポンスのパース。
 * 期待形: {"opinions": [{"argument": "...", ...enrichment}]}。
 * モデルが従来形式に戻った場合(extractedOpinionList / 素の文字列配列)も拾い、
 * その場合 enrichment はフォールバック(unknown 立場)にする。
 */
export function parseExtractEnrich(response: string): RawOpinion[] {
  const obj = parseJsonObjectLoose(response);
  if (!obj) throw new Error("賛否スペクトラムの抽出応答がJSONではありません");
  const list = Array.isArray(obj.opinions)
    ? obj.opinions
    : Array.isArray(obj.extractedOpinionList)
      ? obj.extractedOpinionList
      : null;
  if (!list) throw new Error("賛否スペクトラムの抽出応答に opinions がありません");
  const out: RawOpinion[] = [];
  for (const item of list) {
    if (typeof item === "string") {
      const text = item.trim();
      if (text) out.push({ argument: text, enrichment: fallbackEnrichment() });
    } else if (item && typeof item === "object") {
      const record = item as Record<string, unknown>;
      if (typeof record.argument !== "string") throw new Error("抽出した意見の本文が文字列ではありません");
      const text = record.argument.trim();
      if (text) out.push({ argument: text, enrichment: normalizeEnrichment(record) });
    } else throw new Error("抽出した意見の形式が不正です");
  }
  return out;
}
