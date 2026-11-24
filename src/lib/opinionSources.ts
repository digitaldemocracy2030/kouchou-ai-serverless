/** The plural field is authoritative when present. */
export function readCommentIds(argument: { comment_id?: unknown; comment_ids?: unknown }): string[] {
  if (Object.hasOwn(argument, "comment_ids")) {
    const ids = argument.comment_ids;
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string" && id.length > 0)) {
      throw new Error("comment_ids は空でない文字列の配列である必要があります");
    }
    return [...new Set(ids)];
  }
  const id = argument.comment_id;
  if (id === undefined || id === null || id === "") return [];
  if (typeof id === "string") return [id];
  if (typeof id === "number" && Number.isSafeInteger(id)) return [String(id)];
  throw new Error("旧形式の comment_id は文字列か安全な整数である必要があります");
}

/** The first source remains available to single-source readers. */
export function commentSourceFields(ids: Iterable<string>): { comment_id: string; comment_ids?: string[] } {
  const distinct = [...new Set(ids)];
  return {
    comment_id: distinct[0] ?? "",
    ...(distinct.length > 1 ? { comment_ids: distinct } : {}),
  };
}
