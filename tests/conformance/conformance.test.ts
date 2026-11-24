import { describe, expect, it } from "vitest";
import { unusedKnownDivergenceIds } from "./harness";
import { registerPipelineTests } from "./pipeline";
import { registerUnitTests } from "./units";

// 本家（kouchou-ai analysis-core）との適合性テスト。説明は conformance/README.md。
// 期待値は conformance/generate_expected.py が本家を実際に動かして作る。

registerUnitTests();
registerPipelineTests();

describe("既知の差の一覧（conformance/known-divergences.json）", () => {
  it("どの id も、いずれかのテストに対応している", () => {
    expect(unusedKnownDivergenceIds()).toEqual([]);
  });
});
