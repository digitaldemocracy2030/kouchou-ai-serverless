import { describe, expect, it } from "vitest";
import {
  parseExtractionResponse,
  parseJsonObjectLoose,
  parseLabelResponse,
  parseListFallback,
  parseOverviewResponse,
} from "../src/lib/llm/jsonParse";

describe("parseExtractionResponse", () => {
  it("正常な JSON をパースする", () => {
    expect(parseExtractionResponse('{"extractedOpinionList": ["a", "b"]}')).toEqual(["a", "b"]);
  });

  it("json フェンス付きをパースする", () => {
    expect(parseExtractionResponse('```json\n{"extractedOpinionList": ["a"]}\n```')).toEqual(["a"]);
  });

  it("<think> タグを除去する", () => {
    expect(parseExtractionResponse('<think>考え中...</think>{"extractedOpinionList": ["a"]}')).toEqual(["a"]);
  });

  it("末尾カンマを許容する", () => {
    expect(parseExtractionResponse('{"extractedOpinionList": ["a", "b", ]}')).toEqual(["a", "b"]);
  });

  it("リストでない場合は空", () => {
    expect(parseExtractionResponse('{"extractedOpinionList": "a"}')).toEqual([]);
  });

  it("壊れた JSON は空", () => {
    expect(parseExtractionResponse("これはJSONではありません")).toEqual([]);
  });

  it("dict をそのまま受ける", () => {
    expect(parseExtractionResponse({ extractedOpinionList: ["x"] })).toEqual(["x"]);
  });

  it("空文字列の要素を除去する", () => {
    expect(parseExtractionResponse('{"extractedOpinionList": ["a", "", "  "]}')).toEqual(["a"]);
  });
});

describe("parseListFallback(本家 parse_response 相当)", () => {
  it("説明文に埋まった JSON 配列を抽出する", () => {
    expect(parseListFallback('Response was: なんか説明\n[ "x", "y" ] さらに何か')).toEqual(["x", "y"]);
  });

  it("末尾カンマの配列を許容する", () => {
    expect(parseListFallback('["a", "b" , ]')).toEqual(["a", "b"]);
  });

  it("単一文字列は1要素リスト", () => {
    expect(parseListFallback('"a"')).toEqual(["a"]);
  });

  it("フェンス付き配列でも本文中の閉じ括弧と末尾カンマ風の文字を保持", () => {
    const text = "「,]」と <think>引用</think>";
    expect(parseListFallback(` \`\`\`json\n[${JSON.stringify(text)},]\n\`\`\``)).toEqual([text]);
  });
});

describe("parseLabelResponse", () => {
  it("label/description をパースする", () => {
    expect(parseLabelResponse('{"label": "L", "description": "D"}')).toEqual({ label: "L", description: "D" });
  });

  it("フェンス・前置きに寛容", () => {
    expect(parseLabelResponse('もちろんです!\n```json\n{"label": "L", "description": "D"}\n```')).toEqual({
      label: "L",
      description: "D",
    });
  });

  it("label がなければ null", () => {
    expect(parseLabelResponse('{"description": "D"}')).toBeNull();
  });

  it("応答の外側だけを除き、ラベル内のタグと説明内のフェンスを保持", () => {
    const label = "<think>という要素</think>";
    const description = "使い方は ```json を参照";
    const payload = JSON.stringify({ label, description });
    expect(parseLabelResponse(`<think>推論 {例}</think>\n\`\`\`json\n${payload}\n\`\`\``)).toEqual({
      label,
      description,
    });
  });
});

describe("parseOverviewResponse", () => {
  it("summary をパースする", () => {
    expect(parseOverviewResponse('{"summary": "全体の要約"}')).toBe("全体の要約");
  });

  it("失敗時は <think> を除去した生テキスト(本家と同じ)", () => {
    expect(parseOverviewResponse("<think>推論</think>要約テキスト")).toBe("要約テキスト");
  });

  it("JSONと通常の本文の双方で概要内のタグを保持する", () => {
    const summary = "要約 <think>引用</think> と ```json の話";
    expect(parseOverviewResponse(JSON.stringify({ summary }))).toBe(summary);
    expect(parseOverviewResponse(`<think>推論</think>${summary}`)).toBe(summary);
  });

  it.each(['結果: {"summary":"途中で切れ', '結果: {"summary":"一つ目"} {"summary":"二つ目"}'])(
    "前置きがあっても不完全な応答を本文にしない: %s",
    (response) => expect(() => parseOverviewResponse(response)).toThrow(),
  );
});

describe("parseJsonObjectLoose", () => {
  it("入れ子の JSON も抽出する", () => {
    expect(parseJsonObjectLoose('前置き {"a": {"b": 1}} 後書き')).toEqual({ a: { b: 1 } });
  });

  it("正しいJSONの文字列をそのまま返す", () => {
    const value = { text: "文字列 <think>ここは本文</think> と ```json を残す" };
    expect(parseJsonObjectLoose(JSON.stringify(value))).toEqual(value);
  });

  it("引用符・バックスラッシュ・閉じ括弧を含む文字列は保持してから末尾カンマだけ除く", () => {
    const text = '引用 "、パス \\、文字列,] と ,}';
    const payload = `{"nested": [{"text":${JSON.stringify(text)}},], "end":"\\\\",}`;
    expect(parseJsonObjectLoose(payload)).toEqual({ nested: [{ text }], end: "\\" });
  });

  it.each(['{"a":[,]}', '[{"a":1},]', '{"a":1} {"b":2}', '前置き {"outer":{"inner":1}', '{"a":1}]'])(
    "曖昧な応答や途中のJSONを修復しない: %s",
    (response) => expect(parseJsonObjectLoose(response)).toBeNull(),
  );
});
