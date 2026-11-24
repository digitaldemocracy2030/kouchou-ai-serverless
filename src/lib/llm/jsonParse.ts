// 本家 services/parse_json_list.py の移植 + 寛容な JSON パース(DESIGN §4.3)。

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** 応答の先頭にある推論ブロックを除く。本文中の同じタグは残す。 */
function stripLeadingThinking(text: string): string {
  return text.trim().replace(/^(?:<think\b[^>]*>[\s\S]*?<\/think>\s*)+/, "");
}

const JSON_WHITESPACE = /[\t\n\r ]/;

/** 先頭のコンテナを読み取り、文字列の外側の末尾カンマだけを除く。 */
function readContainer(text: string, start: number): { source: string; end: number } | null {
  let depth = 0;
  let quoted = false;
  let previous = "";
  let segmentStart = start;
  const parts: string[] = [];
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === "\\")
        i++; // エスケープされた次の文字は引用符・括弧として扱わない
      else if (char === '"') quoted = false;
      continue;
    }

    if (char === '"') quoted = true;
    else if (char === "{" || char === "[") depth++;
    else if (char === "}" || char === "]") {
      if (--depth === 0) {
        parts.push(text.slice(segmentStart, i + 1));
        return { source: parts.join(""), end: i + 1 };
      }
    } else if (char === "," && previous !== "[" && previous !== "{" && previous !== ",") {
      // 要素のない [,] や {,} は空のコンテナに直さない。
      let next = i + 1;
      while (next < text.length && JSON_WHITESPACE.test(text[next])) next++;
      if (text[next] === "]" || text[next] === "}") {
        parts.push(text.slice(segmentStart, i));
        segmentStart = i + 1;
      }
    }
    if (!JSON_WHITESPACE.test(char)) previous = char;
  }
  return null;
}

function parseJsonLoose(text: string): unknown {
  const direct = parseJson(text);
  if (direct !== undefined) return direct;

  // 前置きやフェンスはコンテナの外に置いたまま、JSON部分だけを切り出す。
  const body = stripLeadingThinking(text);
  const start = body.search(/[[{]/);
  if (start === -1) return undefined;
  const container = readContainer(body, start);
  if (!container || /[[\]{}]/.test(stripLeadingThinking(body.slice(container.end)))) return undefined;
  return parseJson(container.source);
}

/** 寛容な JSON オブジェクトパース。失敗時は null を返す。 */
export function parseJsonObjectLoose(text: string): Record<string, unknown> | null {
  const value = parseJsonLoose(text);
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * extraction レスポンスのパース(本家 parse_extraction_response 相当)。
 * {"extractedOpinionList": [...]} 形式を期待し、失敗時は空リスト。
 */
export function parseExtractionResponse(response: string | Record<string, unknown>): string[] {
  try {
    const obj = typeof response === "string" ? parseJsonObjectLoose(response) : response;
    if (!obj) return parseListFallback(typeof response === "string" ? response : "");
    const list = obj.extractedOpinionList;
    if (!Array.isArray(list)) return [];
    return list.filter((item): item is string => typeof item === "string" && item.trim() !== "").map((s) => s.trim());
  } catch {
    return [];
  }
}

/** 本家 parse_response 相当: extractedOpinionList 形式でない配列・文字列へのフォールバック。 */
export function parseListFallback(response: string): string[] {
  const value = parseJsonLoose(response);
  if (typeof value === "string") return value.trim() ? [value] : [];
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

/** label/description レスポンスのパース。失敗時は null。 */
export function parseLabelResponse(response: string): { label: string; description: string } | null {
  const obj = parseJsonObjectLoose(response);
  if (!obj) return null;
  const label = obj.label;
  const description = obj.description;
  if (typeof label !== "string" || !label.trim() || typeof description !== "string" || !description.trim()) return null;
  return {
    label,
    description,
  };
}

/** 本家と同じく、通常の要約文は許すが空応答・壊れたJSONは公開しない。 */
export function parseOverviewResponse(response: string): string {
  const obj = parseJsonObjectLoose(response);
  if (obj) {
    if (typeof obj.summary === "string" && obj.summary.trim()) return obj.summary;
    throw new Error("概要の応答に有効な summary がありません");
  }
  const text = stripLeadingThinking(response);
  if (!text || /^(?:[[{]|```)|\{\s*["}]/.test(text)) {
    throw new Error("概要の応答から summary を取り出せませんでした");
  }
  return text;
}
