import { afterEach, describe, expect, it, vi } from "vitest";
import fixture from "../src/components/dev/viewer-fixture.json";
import { exportResultJson, exportSingleHtml } from "../src/lib/export";
import { buildPublicResult } from "../src/lib/publicResult";
import type { Result } from "../src/types/result";

const makeResult = () => ({ ...structuredClone(fixture), comments: { "1": { comment: "元コメント" } } }) as Result;
afterEach(() => vi.unstubAllGlobals());

describe("公開用結果", () => {
  it.each([undefined, false, true, "true"])("元コメント本文はboolean trueのときだけ: %s", (flag) => {
    const result = makeResult();
    Object.assign(result.config, { enable_original_comments: flag });
    const before = JSON.stringify(result);
    const output = buildPublicResult(result);
    expect(output.schema_version).toBe(2);
    expect(output.comments).toEqual(flag === true ? result.comments : {});
    expect(output.arguments).toEqual(result.arguments.map((arg) => ({ ...arg, comment_id: String(arg.comment_id) })));
    expect(output.comment_num).toBe(result.comment_num);
    expect(JSON.stringify(result)).toBe(before);
  });
  it("外部JSONに含まれる未知の設定・秘密・非公開属性表を持ち出さない", () => {
    const result = makeResult();
    Object.assign(result.config, {
      user_api_key: "secret",
      local_llm_address: "private",
      unknown_step: { key: "secret" },
    });
    Object.assign(result.config.extraction, { user_api_key: "secret" });
    Object.assign(result.arguments[0], { internal: "secret" });
    result.config.hierarchical_aggregation.hidden_properties = { private: ["hidden"] };
    result.propertyMap.private = { A0: "hidden" };
    result.translations.ja = { overview: "概要", meta: { key: "secret" } };
    const output = buildPublicResult(result);
    const text = JSON.stringify(output);
    expect(text).not.toContain("secret");
    expect(output.config).not.toHaveProperty("name");
    expect(output.config).not.toHaveProperty("status");
    expect(output.config.hierarchical_aggregation).not.toHaveProperty("hidden_properties");
    expect(output.propertyMap).not.toHaveProperty("private");
    expect(output.translations.ja).toEqual({ overview: "概要" });
  });
  it("JSONと単一HTMLの両方が同じ公開変換を通る", async () => {
    const result = makeResult();
    result.comments = { private: { comment: "PRIVATE-ORIGINAL" } };
    const blobs: Blob[] = [];
    const anchor = { href: "", download: "", click: vi.fn() };
    vi.stubGlobal("document", { createElement: () => anchor });
    vi.stubGlobal("URL", {
      createObjectURL: (blob: Blob) => {
        blobs.push(blob);
        return "blob:mock";
      },
      revokeObjectURL: vi.fn(),
    });
    exportResultJson(result);
    expect(anchor.download).toBe("public_result.json");
    expect(JSON.parse(await blobs[0].text())).toEqual(buildPublicResult(result));
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            '<script type="application/json" id="report-data">null</script><script type="application/json" id="report-meta">null</script>',
          ),
      ),
    );
    await exportSingleHtml(result);
    expect(await blobs[1].text()).not.toContain("PRIVATE-ORIGINAL");
    expect(await blobs[1].text()).toContain('"schema_version":2');
    expect(await blobs[1].text()).toContain(result.config.name);
  });
});
