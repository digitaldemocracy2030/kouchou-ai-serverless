/** APIキー不要。pnpm build と pnpm dev --port 5174 の後に node scripts/viewer-states-e2e.ts */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Page } from "playwright";
import type { Result } from "../src/types/result.ts";

async function searchOpinions(page: Page, query: string): Promise<void> {
  const input = page.getByPlaceholder("入力されたテキストが含まれる意見のみ表示されます");
  if (!(await input.isVisible())) await page.getByRole("button", { name: /フィルタ/ }).click();
  await input.fill(query);
}

const browser = await chromium.launch();
const dir = await mkdtemp(join(tmpdir(), "viewer-e2e-"));
const baseUrl = process.env.VIEWER_TEST_URL ?? "http://localhost:5174";
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${baseUrl}/#/dev/viewer-states`);
  await page.getByRole("button", { name: "階層リスト", exact: true }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "階層リスト", exact: true }).getAttribute("aria-pressed"),
    "true",
  );
  for (const state of ["属性なし", "空の意見", "通常"]) {
    await page.getByRole("combobox", { name: "状態" }).selectOption(state);
    await page.getByRole("button", { name: "階層リスト", exact: true }).waitFor();
  }
  await page.getByRole("button", { name: "散布図", exact: true }).click();
  await page.locator(".js-plotly-plot").waitFor();
  await page.setViewportSize({ width: 1280, height: 900 });
  assert.equal(await page.getByRole("button", { name: "散布図", exact: true }).getAttribute("aria-pressed"), "true");
  await page.reload();
  await page.locator(".js-plotly-plot").waitFor();
  const template = await readFile("public/report-template.html", "utf8");
  const data = await readFile("src/components/dev/viewer-fixture.json", "utf8");
  const html = template.replace(
    /(<script[^>]*id="report-data"[^>]*>)[\s\S]*?(<\/script>)/,
    (_all, start, end) => start + data.replaceAll("<", "\\u003c") + end,
  );
  assert.notEqual(html, template);
  const file = join(dir, "report.html");
  await writeFile(file, html);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(pathToFileURL(file).href);
  await page.getByRole("button", { name: "階層リスト", exact: true }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "階層リスト", exact: true }).getAttribute("aria-pressed"),
    "true",
  );
  await page.getByRole("button", { name: "散布図", exact: true }).click();
  await page.locator(".js-plotly-plot").waitFor();

  const source = "原文にだけある説明です。";
  const withSources: Result = JSON.parse(data);
  withSources.arguments[0].comment_ids = ["first", "second", "first"];
  withSources.comments = { first: { comment: source }, second: { comment: "もう一つの元の回答です。" } };
  for (const enabled of [false, true]) {
    withSources.config.enable_original_comments = enabled;
    const json = JSON.stringify(withSources).replaceAll("<", "\\u003c");
    const sourceReport = join(dir, `original-responses-${enabled}.html`);
    await writeFile(
      sourceReport,
      html.replace(data.replaceAll("<", "\\u003c"), () => json),
    );
    await page.goto(pathToFileURL(sourceReport).href);
    await searchOpinions(page, withSources.arguments[0].argument);
    const opinion = page.locator(".argument-list li").filter({ hasText: withSources.arguments[0].argument });
    await opinion.first().waitFor();
    if (enabled) {
      await opinion.getByText("元の回答を見る（2件）", { exact: true }).click();
      await opinion.getByText(source, { exact: true }).waitFor();
      assert.equal(await opinion.getByText(source, { exact: true }).count(), 1);
      await opinion.getByText("もう一つの元の回答です。", { exact: true }).waitFor();
    } else {
      assert.equal(await opinion.getByText(/元の回答を見る|原文にだけある説明/).count(), 0);
    }
  }

  const sampleUrl = `${baseUrl}/#/report/sample`;
  await page.goto(sampleUrl);
  await page.getByRole("heading", { name: /仮想アンケート2,000件/ }).waitFor();
  await searchOpinions(page, "便利になる反面");
  await page.getByText("元の回答を見る", { exact: true }).click();
  await page.getByText(/便利になるのも嫌だし/).waitFor();

  // 保存済みのサンプルを再訪しても、新しいサンプルデータを取り直さずに原文へたどれる。
  await page.route("**/sample-report.json", (route) => route.abort());
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.reload();
  await searchOpinions(page, "便利になる反面");
  await page.getByRole("button", { name: "検索結果をリストで見る" }).click();
  await page.getByText("元の回答を見る", { exact: true }).click();
  await page.getByText(/便利になるのも嫌だし/).waitFor();

  assert.deepEqual(errors, []);
  console.log("PASS: 状態切替、スマホ初期表示、単一HTML、原文公開ON/OFF、複数出典、保存済みサンプルの原文表示");
} finally {
  await browser.close();
  await rm(dir, { recursive: true, force: true });
}
