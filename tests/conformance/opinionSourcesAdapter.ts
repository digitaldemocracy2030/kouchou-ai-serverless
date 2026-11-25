import { parseResultJson } from "../../src/lib/export";
import { buildClusterTable } from "../../src/lib/pipeline/clusterTable";
import { aggregation } from "../../src/lib/pipeline/steps/aggregation";
import { buildPublicResult } from "../../src/lib/publicResult";
import { projectFromResult } from "../../src/lib/reportProject";
import { DEFAULT_SETTINGS } from "../../src/types/settings";

type Case = {
  legacyReport?: string;
  arguments: { arg_id: string; comment_id?: unknown; comment_ids?: unknown }[];
  relations: { opinion: string; source: string }[] | null;
  comments: { id: string; body: string }[];
  publish: boolean;
  inputCount: number | null;
};

export function runOpinionSources(input: Case) {
  const comments = input.comments.map(({ id, body }) => ({ commentId: id, body, attributes: {} }));
  let published: ReturnType<typeof buildPublicResult>;
  if (input.relations === null) {
    try {
      if (input.legacyReport === undefined) throw new Error("legacyReport is required");
      published = buildPublicResult(parseResultJson(input.legacyReport));
    } catch (error) {
      if (error instanceof Error && /comment_ids?/.test(error.message)) return { error: true };
      throw error;
    }
  } else {
    const args = input.arguments.map(({ arg_id }) => ({ argId: arg_id, argument: arg_id }));
    const argIds = args.map(({ argId }) => argId);
    const table = buildClusterTable(args, {
      argIds,
      x: Float32Array.from(args.keys()),
      y: new Float32Array(args.length),
      clusterNums: [1],
      assignments: [new Int32Array(args.length)],
    });
    const report = aggregation({
      project: {
        title: "意見と出典",
        question: "",
        intro: "",
        attributeColumns: [],
        inputCommentCount: input.inputCount ?? undefined,
        enableOriginalComments: input.publish,
        clusterNums: [1],
        prompts: { extraction: "", initialLabelling: "", mergeLabelling: "", overview: "" },
        samplingNum: 1,
      },
      comments,
      extractionResult: {
        args,
        relations: input.relations.map(({ opinion, source }) => ({ argId: opinion, commentId: source })),
      },
      table,
      labels: { byLevel: { 1: [{ clusterId: "1_0", label: "試験", description: "説明" }] } },
      overviewText: "",
      chatModel: "test",
      embeddingModel: "test",
      workers: 1,
    });
    published = buildPublicResult(report);
  }
  const { extraction } = projectFromResult(parseResultJson(JSON.stringify(published)), {
    id: "contract",
    reportId: "report",
    title: "意見と出典",
    settings: DEFAULT_SETTINGS,
  });
  return { published, restored: extraction.relations };
}
