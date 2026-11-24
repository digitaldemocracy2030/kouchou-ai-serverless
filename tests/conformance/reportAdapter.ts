import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeComments } from "../../src/lib/csv";
import { parseResultJson } from "../../src/lib/export";
import { clusterXY } from "../../src/lib/pipeline/clusteringCore";
import { buildClusterTable } from "../../src/lib/pipeline/clusterTable";
import { memoryCheckpoints, type PipelineContext } from "../../src/lib/pipeline/context";
import { aggregation } from "../../src/lib/pipeline/steps/aggregation";
import { extraction } from "../../src/lib/pipeline/steps/extraction";
import { initialLabelling, mergeLabelling } from "../../src/lib/pipeline/steps/labelling";
import { overview } from "../../src/lib/pipeline/steps/overview";
import { buildPublicResult } from "../../src/lib/publicResult";
import { extractionPrompt, initialLabellingPrompt, mergeLabellingPrompt, overviewPrompt } from "../../src/prompts";

type Case = {
  comments: { id: string; body: string; region: string; opinions: string[]; paths: number[][] }[];
  publishComments: boolean;
  depth: number;
};

async function makeReport(input: Case) {
  const comments = normalizeComments(
    input.comments.map(({ id, body, region }) => ({ id, body, region })),
    "body",
    "id",
    ["region"],
  );
  const responses = new Map(input.comments.map((comment) => [comment.body, comment.opinions]));
  const placements = new Map(
    input.comments.map((comment) => [
      comment.id,
      new Map(comment.opinions.map((opinion, i) => [opinion, comment.paths[i]])),
    ]),
  );
  const endpoint = { baseUrl: "https://conformance.invalid/v1", apiKey: "test", model: "test" };
  const ctx: PipelineContext = {
    chat: endpoint,
    embedding: endpoint,
    concurrency: 1,
    checkpoints: memoryCheckpoints(),
    random: () => 0.5,
  };
  const prompts = {
    extraction: "extraction",
    initialLabelling: "labelling",
    mergeLabelling: "labelling",
    overview: "overview",
  };
  globalThis.fetch = async (_url, init) => {
    const { messages } = JSON.parse(String(init?.body));
    const prompt: string = messages[0].content;
    let response: object;
    switch (prompt) {
      case prompts.extraction: {
        const opinions = responses.get(messages.at(-1).content);
        assert(opinions, "extraction request must refer to an input comment");
        response = { extractedOpinionList: opinions };
        break;
      }
      case prompts.overview:
        response = { summary: "調査の概要" };
        break;
      case prompts.initialLabelling:
        response = { label: "クラスタ", description: "クラスタの説明" };
        break;
      default:
        throw new Error(`unexpected prompt: ${prompt}`);
    }
    return Response.json({ choices: [{ message: { content: JSON.stringify(response) }, finish_reason: "stop" }] });
  };

  const extracted = await extraction(comments, prompts.extraction, ctx);
  const commentByArg = new Map(extracted.relations.map(({ argId, commentId }) => [argId, commentId]));
  const paths = extracted.args.map(({ argId, argument }) => {
    const commentId = commentByArg.get(argId);
    const path = commentId === undefined ? undefined : placements.get(commentId)?.get(argument);
    assert(path, "extracted opinion must belong to the right input comment");
    return path;
  });
  const assignments = Array.from({ length: input.depth }, (_, level) => Int32Array.from(paths, (path) => path[level]));
  const clusterNums = assignments.map((level) => new Set(level).size);
  const table = buildClusterTable(extracted.args, {
    argIds: extracted.args.map(({ argId }) => argId),
    assignments,
    clusterNums,
    x: Float32Array.from(paths, (_, i) => i * 0.25),
    y: Float32Array.from(paths, (_, i) => (i % 3) * 0.5),
  });
  const deepest = await initialLabelling(table, prompts.initialLabelling, 30, ctx);
  const labels = await mergeLabelling(table, deepest, prompts.mergeLabelling, 30, ctx);
  const overviewText = await overview(labels, prompts.overview, ctx);
  const report = aggregation({
    project: {
      title: "調査",
      question: "調査",
      intro: "",
      attributeColumns: ["region"],
      clusterNums,
      prompts,
      samplingNum: 30,
      enableOriginalComments: input.publishComments,
    },
    comments,
    extractionResult: extracted,
    table,
    labels,
    overviewText,
    chatModel: endpoint.model,
    embeddingModel: endpoint.model,
    workers: 1,
  });
  return { report, public: parseResultJson(JSON.stringify(buildPublicResult(report))) };
}

// 逐語移植が明示要件になっているデフォルトプロンプトだけは比較する。
function checkPrompts(upstream: string) {
  for (const [name, prompt] of Object.entries({
    extractionPrompt,
    initialLabellingPrompt,
    mergeLabellingPrompt,
    overviewPrompt,
  })) {
    const source = readFileSync(join(upstream, "apps/admin/app/create", `${name}.ts`), "utf8");
    const templates = [...source.matchAll(/`([^`]*)`/gs)];
    assert.equal(templates.length, 1, name);
    assert.equal(prompt, templates[0][1], name);
  }
}

if (process.argv[2] === "prompts") {
  checkPrompts(process.argv[3]);
} else if (process.argv[2] === "clustering") {
  const { points, cuts } = JSON.parse(readFileSync(0, "utf8"));
  const { assignments } = clusterXY(points, cuts, "contract");
  process.stdout.write(JSON.stringify(assignments.map((labels) => Array.from(labels))));
} else {
  const { input, pythonPublic } = JSON.parse(readFileSync(0, "utf8"));
  const result = await makeReport(input);
  process.stdout.write(JSON.stringify({ ...result, importedPython: parseResultJson(JSON.stringify(pythonPublic)) }));
}
