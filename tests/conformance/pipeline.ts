import Papa from "papaparse";
import { afterAll, beforeAll, describe, expect, vi } from "vitest";
import { normalizeComments } from "../../src/lib/csv";
import { memoryCheckpoints, type PipelineContext } from "../../src/lib/pipeline/context";
import { runPipeline, type StepStore } from "../../src/lib/pipeline/orchestrator";
import { extraction } from "../../src/lib/pipeline/steps/extraction";
import { extractionPrompt, initialLabellingPrompt, mergeLabellingPrompt, overviewPrompt } from "../../src/prompts";
import type {
  ClusteringResult,
  CommentRow,
  ExtractionResult,
  PipelineStepName,
  Project,
} from "../../src/types/project";
import type { Result } from "../../src/types/result";
import { fakeFetch, type RecordedRequest, type Stage } from "./fakeLlm";
import { caseIds, conform, readCase, readExpected, sortByCodePoint } from "./harness";

// 同じ入力・同じ LLM 応答を与えたとき、serverless が本家と同じ依頼を LLM に送り、
// 同じ結果を出すことを確かめる。埋め込みと UMAP は実装ごとの乱数で一致しないので、
// 座標とクラスタの割り当ては本家に渡したものと同じものを入力として渡す。

type Case = {
  id: string;
  description: string;
  title: string;
  question: string;
  intro: string;
  model: string;
  csv: string;
  attribute_columns: string[];
  cluster_nums: number[];
  sampling_num: number;
  downstream: boolean;
};

type Expected = {
  extraction: { args: { arg_id: string; argument: string }[]; relations: { arg_id: string; comment_id: string }[] };
  llm_requests: Partial<Record<Stage, string[]>>;
  clustering?: { arg_id: string; x: number; y: number; cluster_ids: string[] }[];
  // biome-ignore lint/suspicious/noExplicitAny: 本家の JSON をそのまま読む
  hierarchical_result?: Record<string, any>;
};

const PROMPTS: Record<Stage, string> = {
  extraction: extractionPrompt,
  initial_labelling: initialLabellingPrompt,
  merge_labelling: mergeLabellingPrompt,
  overview: overviewPrompt,
};

function parseComments(c: Case): CommentRow[] {
  const parsed = Papa.parse<Record<string, string>>(c.csv, { header: true, skipEmptyLines: true });
  return normalizeComments(parsed.data, "comment-body", "comment-id", c.attribute_columns);
}

function makeCtx(model: string): PipelineContext {
  const endpoint = { baseUrl: "https://conformance.invalid/v1", apiKey: "test", model };
  return {
    chat: endpoint,
    embedding: { ...endpoint, model: "text-embedding-3-small" },
    concurrency: 1,
    checkpoints: memoryCheckpoints(),
    random: () => 0.5,
  };
}

function requestsOf(recorded: RecordedRequest[], stage: Stage, ordered: boolean): string[] {
  const users = recorded.filter((r) => r.stage === stage).map((r) => r.user);
  return ordered ? users : sortByCodePoint(users);
}

export function registerPipelineTests(): void {
  for (const id of caseIds()) {
    const c = readCase<Case>(id);
    const expected = readExpected<Expected>(`case-${id}.json`);

    describe(`ケース ${id}: ${c.description}`, () => {
      const recorded: RecordedRequest[] = [];
      let extracted: ExtractionResult;

      beforeAll(async () => {
        vi.stubGlobal("fetch", fakeFetch(PROMPTS, recorded));
        extracted = await extraction(parseComments(c), PROMPTS.extraction, makeCtx(c.model));
      });
      afterAll(() => {
        vi.unstubAllGlobals();
      });

      conform(`case.${id}.extraction.requests`, "抽出で LLM に送る本文（回答の順）", () => {
        expect(requestsOf(recorded, "extraction", true)).toEqual(expected.llm_requests.extraction ?? []);
      });
      conform(`case.${id}.extraction.args`, "抽出した意見と arg_id", () => {
        expect(extracted.args.map((a) => ({ arg_id: a.argId, argument: a.argument }))).toEqual(
          expected.extraction.args,
        );
      });
      conform(`case.${id}.extraction.relations`, "意見と回答の対応", () => {
        expect(extracted.relations.map((r) => ({ arg_id: r.argId, comment_id: r.commentId }))).toEqual(
          expected.extraction.relations,
        );
      });

      if (!c.downstream) return;
      describeDownstream(c, expected);
    });
  }
}

function describeDownstream(c: Case, expected: Expected): void {
  const id = c.id;
  const recorded: RecordedRequest[] = [];
  let result: Result;
  // biome-ignore lint/suspicious/noExplicitAny: 本家の JSON をそのまま読む
  const reference = expected.hierarchical_result as Record<string, any>;

  beforeAll(async () => {
    const placements = expected.clustering ?? [];
    const levelCount = placements[0].cluster_ids.length;
    const assignments = Array.from({ length: levelCount }, (_, level) =>
      Int32Array.from(placements.map((p) => Number(p.cluster_ids[level].split("_")[1]))),
    );
    const clusteringResult: ClusteringResult = {
      argIds: placements.map((p) => p.arg_id),
      x: Float32Array.from(placements.map((p) => p.x)),
      y: Float32Array.from(placements.map((p) => p.y)),
      clusterNums: assignments.map((a) => new Set(a).size),
      assignments,
    };
    // 抽出結果も本家のものを入力にして、抽出の差が下流の比較に混ざらないようにする
    const extractionResult: ExtractionResult = {
      args: expected.extraction.args.map((a) => ({ argId: a.arg_id, argument: a.argument })),
      relations: expected.extraction.relations.map((r) => ({ argId: r.arg_id, commentId: r.comment_id })),
    };
    const preset: Partial<Record<PipelineStepName, unknown>> = {
      extraction: extractionResult,
      embedding: { argIds: clusteringResult.argIds, dim: 1, vectors: new Float32Array(clusteringResult.argIds.length) },
      clustering: clusteringResult,
    };
    const store: StepStore = {
      get: async (step) => preset[step],
      put: async () => {},
    };
    const project: Project = {
      id: `conformance-${id}`,
      title: c.title,
      question: c.question,
      intro: c.intro,
      createdAt: 0,
      comments: parseComments(c),
      attributeColumns: c.attribute_columns,
      settingsSnapshot: {
        chat: makeCtx(c.model).chat,
        embedding: makeCtx(c.model).embedding,
        concurrency: 1,
      },
      clusterNums: c.cluster_nums,
      prompts: {
        extraction: PROMPTS.extraction,
        initialLabelling: PROMPTS.initial_labelling,
        mergeLabelling: PROMPTS.merge_labelling,
        overview: PROMPTS.overview,
      },
      samplingNum: c.sampling_num,
      status: "running",
      currentStep: null,
      tokenUsage: { input: 0, output: 0, total: 0 },
    };
    vi.stubGlobal("fetch", fakeFetch(PROMPTS, recorded));
    result = await runPipeline(project, { ctx: makeCtx(c.model), store });
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  for (const stage of ["initial_labelling", "merge_labelling", "overview"] as const) {
    conform(`case.${id}.${stage}.requests`, `${stage} で LLM に送る依頼（並び順は問わない）`, () => {
      expect(requestsOf(recorded, stage, false)).toEqual(expected.llm_requests[stage] ?? []);
    });
  }

  const byArgId = <T extends { arg_id: string }>(list: T[]) =>
    Object.fromEntries(list.map((a) => [a.arg_id, a])) as Record<string, T>;

  conform(
    `case.${id}.result.arguments`,
    "arguments の意見・所属クラスタ・座標（座標は Float32 の丸め誤差まで許す）",
    () => {
      const pick = (a: Record<string, unknown>) => ({
        arg_id: a.arg_id,
        argument: a.argument,
        p: a.p,
        cluster_ids: a.cluster_ids,
      });
      expect(result.arguments.map((a) => pick(a as unknown as Record<string, unknown>))).toEqual(
        // biome-ignore lint/suspicious/noExplicitAny: 本家の JSON
        reference.arguments.map((a: any) => pick(a)),
      );
      // serverless は座標を Float32Array で持つので、本家（float64）とは 1e-6 程度ずれる
      reference.arguments.forEach((ref: { x: number; y: number }, i: number) => {
        expect(result.arguments[i].x).toBeCloseTo(ref.x, 4);
        expect(result.arguments[i].y).toBeCloseTo(ref.y, 4);
      });
    },
  );
  conform(`case.${id}.result.arguments.comment_id`, "arguments の comment_id（型も含めて）", () => {
    const actual = byArgId(result.arguments as unknown as { arg_id: string; comment_id: unknown }[]);
    for (const ref of reference.arguments) {
      expect([ref.arg_id, actual[ref.arg_id]?.comment_id]).toEqual([ref.arg_id, ref.comment_id]);
    }
  });
  conform(`case.${id}.result.arguments.attributes`, "arguments の属性（無い時は null と同じ扱い）", () => {
    const actual = byArgId(result.arguments as unknown as { arg_id: string; attributes?: unknown }[]);
    for (const ref of reference.arguments) {
      expect([ref.arg_id, actual[ref.arg_id]?.attributes ?? null]).toEqual([ref.arg_id, ref.attributes]);
    }
  });
  conform(`case.${id}.result.arguments.url`, "arguments の url（無い時は null と同じ扱い）", () => {
    const actual = byArgId(result.arguments as unknown as { arg_id: string; url?: unknown }[]);
    for (const ref of reference.arguments) {
      expect([ref.arg_id, actual[ref.arg_id]?.url ?? null]).toEqual([ref.arg_id, ref.url]);
    }
  });
  conform(`case.${id}.result.clusters`, "clusters（ラベル・件数・親・密度の順位）", () => {
    // biome-ignore lint/suspicious/noExplicitAny: 本家の JSON
    const sortById = (list: any[]) => [...list].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    expect(sortById(result.clusters)).toEqual(sortById(reference.clusters));
  });
  conform(`case.${id}.result.comments`, "comments（元コメント本文。既定では公開しない）", () => {
    expect(result.comments).toEqual(reference.comments);
  });
  conform(`case.${id}.result.comment_num`, "comment_num", () => {
    expect(result.comment_num).toEqual(reference.comment_num);
  });
  conform(`case.${id}.result.propertyMap`, "propertyMap", () => {
    expect(result.propertyMap).toEqual(reference.propertyMap);
  });
  conform(`case.${id}.result.overview`, "overview", () => {
    expect(result.overview).toEqual(reference.overview);
  });
  conform(`case.${id}.result.translations`, "translations", () => {
    expect(result.translations).toEqual(reference.translations);
  });
  conform(`case.${id}.result.config.intro`, "config.intro（件数とモデルを添えた調査概要）", () => {
    expect(result.config.intro).toEqual(reference.config.intro);
  });
}
