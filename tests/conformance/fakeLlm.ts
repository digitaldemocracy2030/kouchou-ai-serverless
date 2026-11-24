import { createHash } from "node:crypto";

// conformance/fake_llm.py と同じ振る舞いの偽 LLM。
// 片方を変えたら必ずもう片方も同じように変えること（期待値の再生成も必要）。

export type Stage = "extraction" | "initial_labelling" | "merge_labelling" | "overview";

const EMPTY_MARKER = "特になし";
const MERGE_SEPARATOR = "\nクラスタの意見\n";
const MERGE_HEAD = "クラスタラベル\n";
const OVERVIEW_BLOCK = /# Cluster \d+\/(\d+): /g;

function sha(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// Python の sorted() と同じく、コードポイント順で並べる（localeCompare は使わない）
function sortByCodePoint(values: string[]): string[] {
  return [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function canonicalize(stage: Stage, user: string): string {
  if (stage === "extraction") return user;
  if (stage === "initial_labelling") return sortByCodePoint(user.split("\n")).join("\n");
  if (stage === "merge_labelling") {
    if (!user.startsWith(MERGE_HEAD) || !user.includes(MERGE_SEPARATOR)) return user;
    const body = user.slice(MERGE_HEAD.length);
    const index = body.indexOf(MERGE_SEPARATOR);
    const labels = body.slice(0, index);
    const opinions = body.slice(index + MERGE_SEPARATOR.length);
    return (
      MERGE_HEAD +
      sortByCodePoint(labels.split("\n")).join("\n") +
      MERGE_SEPARATOR +
      sortByCodePoint(opinions.split("\n")).join("\n")
    );
  }
  const matches = [...user.matchAll(OVERVIEW_BLOCK)];
  if (matches.length === 0) return user;
  const blocks = matches.map((match, i) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? user.length) : user.length;
    return `# Cluster ?/${match[1]}: ${user.slice(start, end)}`;
  });
  return user.slice(0, matches[0].index) + sortByCodePoint(blocks).join("");
}

// Python の json.dumps(ensure_ascii=False) と同じ区切り（", " と ": "）で書く
function pyJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(pyJson).join(", ")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .map(([k, v]) => `${JSON.stringify(k)}: ${pyJson(v)}`)
      .join(", ")}}`;
  }
  return JSON.stringify(value);
}

export function respond(stage: Stage, user: string): string {
  if (stage === "extraction") {
    if (user.includes(EMPTY_MARKER)) return pyJson({ extractedOpinionList: [] });
    const opinions = user
      .split("。")
      .filter((part) => part.trim() !== "")
      .map((part) => `${part.trim()}。`);
    return pyJson({ extractedOpinionList: opinions });
  }
  const digest = sha(`${stage}\n${canonicalize(stage, user)}`);
  if (stage === "initial_labelling" || stage === "merge_labelling") {
    const prefix = stage === "initial_labelling" ? "初期" : "統合";
    return pyJson({
      label: `${prefix}ラベル${digest.slice(0, 6)}`,
      description: `${prefix}説明${digest.slice(6, 18)}`,
    });
  }
  return pyJson({ summary: `概要${digest.slice(0, 12)}` });
}

export function stageOf(systemPrompt: string, prompts: Record<Stage, string>): Stage {
  for (const [stage, prompt] of Object.entries(prompts) as [Stage, string][]) {
    if (systemPrompt === prompt) return stage;
  }
  throw new Error("system prompt がどの段のプロンプトとも一致しません");
}

export type RecordedRequest = { stage: Stage; user: string };

/**
 * fetch を偽 LLM に差し替える関数を返す（OpenAI 互換の chat/completions 応答を返す）。
 * override を渡すと、その段の応答本文だけを差し替えられる。
 */
export function fakeFetch(
  prompts: Record<Stage, string>,
  recorded: RecordedRequest[],
  override?: (stage: Stage, user: string) => string | undefined,
) {
  return async (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body));
    const messages = body.messages as { role: string; content: string }[];
    const system = messages[0].content;
    const user = messages[messages.length - 1].content;
    const stage = stageOf(system, prompts);
    recorded.push({ stage, user: canonicalize(stage, user) });
    const content = override?.(stage, user) ?? respond(stage, user);
    return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }], usage: {} }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}
