/**
 * Playwright によるブラウザ実機スモークテスト(開発検証用。CI では実行しない)。
 *   npx vite-node scripts/browser-smoke.ts
 * 前提: pnpm dev が起動していること(PORT 環境変数、既定 5174)、.env に OPENAI_API_KEY。
 * 初回設定だけの確認: node scripts/browser-smoke.ts --setup-only (模擬API、.env不要)
 * 検証項目:
 *  1. ホーム表示
 *  2. 本家 example-hierarchical-polis JSON のインポート表示(M7 受け入れ基準)
 *  3. 設定画面でプロバイダ登録 → スロット選択 → 疎通確認
 *  4. ウィザードで CSV 取込 → 実行 → レポート表示(実 API・30件)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromium, type Page } from "playwright";
import { FIRST_ANALYSIS_PRESETS } from "../src/types/settings.ts";

const BASE = `http://localhost:${process.env.PORT ?? 5174}`;
const EXAMPLE_JSON =
  "e:/GitHub/kouchou-ai/apps/api/broadlistening/pipeline/outputs/example-hierarchical-polis/hierarchical_result.json";

function env(name: string): string {
  const match = readFileSync(".env", "utf-8").match(new RegExp(`^${name}=(.*)$`, "m"));
  return match?.[1]?.trim() ?? "";
}

async function checkFirstAnalysisSetup(page: Page) {
  const openAi = FIRST_ANALYSIS_PRESETS.find((preset) => preset.id === "openai");
  assert.ok(openAi);
  const models = new Set<string>();
  await page.route(`${openAi.baseUrl}/**`, (route) => {
    const request = route.request();
    const embedding = new URL(request.url()).pathname.endsWith("/embeddings");
    const accepted = request.headers().authorization === "Bearer sk-test-accepted";
    const rejected = embedding && !accepted;
    if (accepted) models.add(request.postDataJSON().model);
    return route.fulfill({
      status: rejected ? 401 : 200,
      headers: { "access-control-allow-origin": "*" },
      json: rejected
        ? { error: { message: "Invalid API key" } }
        : embedding
          ? { data: [{ index: 0, embedding: [0.25, 0.5] }] }
          : { choices: [{ message: { content: "OK" } }] },
    });
  });

  await page.goto(`${BASE}/#/`);
  const guide = page.getByRole("dialog", { name: "広聴AI サーバレス版の使い方" });
  await guide.getByRole("link", { name: "自分のCSVを分析する" }).click();
  await page.getByRole("heading", { name: "はじめての分析設定" }).waitFor();
  assert.equal(
    await page.getByRole("link", { name: "接続先やモデルを自分で指定する" }).getAttribute("href"),
    "#/settings",
  );
  assert.equal(
    await page.getByRole("link", { name: "設定なしでサンプルを見る" }).getAttribute("href"),
    "#/report/sample",
  );

  const keyInput = page.getByLabel("OpenAIのAPIキー", { exact: true });
  const provider = page.getByLabel("分析に使うAI");
  assert.equal(await provider.inputValue(), "");
  assert.equal(await page.locator('input[type="password"]').count(), 0);
  await provider.selectOption("openai");
  const confirm = page.getByRole("button", { name: "確認してCSV選択へ" });
  assert.ok(await confirm.isDisabled());
  await keyInput.fill("sk-test-rejected");
  await confirm.click();
  await page.getByText("OpenAIに接続できませんでした。APIキーと利用権限を確認してください。").waitFor();
  assert.ok(
    await page.evaluate(() => !localStorage.getItem("kouchou-ai-settings")?.includes("sk-test-rejected")),
    "片方の接続確認に失敗したキーを保存しない",
  );
  await keyInput.fill("sk-test-accepted");
  await confirm.click();
  await page.waitForURL("**/#/new");
  await page.getByRole("heading", { name: /CSV を選択/ }).waitFor();
  assert.deepEqual(models, new Set([openAi.chatModel, openAi.embeddingModel]));
  assert.ok(!(await page.getByRole("link", { name: "はじめての分析設定へ" }).isVisible()));

  await page.reload();
  await page.getByRole("heading", { name: /CSV を選択/ }).waitFor();
  assert.equal(await page.getByRole("link", { name: "新規作成", exact: true }).getAttribute("href"), "#/new");
  assert.ok(!(await page.getByRole("link", { name: "はじめての分析設定へ" }).isVisible()));
  assert.ok(!(await page.getByText("AIの接続確認がまだです").isVisible()));
  console.log("初回設定 OpenAI と失敗からの再試行 OK");
}

async function mockLocalEmbedding(page: Page) {
  await page.route("**/embedding.worker.ts?*", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: `self.onmessage = ({ data }) => self.postMessage({
        id: data.id, type: "done", dim: 2, flat: new Float32Array([0.25, 0.5])
      });`,
    }),
  );
}

async function checkAnthropicSetup(page: Page) {
  const anthropic = FIRST_ANALYSIS_PRESETS.find((preset) => preset.id === "anthropic");
  assert.ok(anthropic);
  const requests: string[] = [];
  await mockLocalEmbedding(page);
  await page.route(`${anthropic.baseUrl}/**`, (route) => {
    const request = route.request();
    requests.push(new URL(request.url()).pathname);
    return route.fulfill({
      headers: { "access-control-allow-origin": "*" },
      json: { choices: [{ message: { content: "OK" } }] },
    });
  });

  await page.goto(`${BASE}/#/setup`);
  const provider = page.getByLabel("分析に使うAI");
  await provider.selectOption("openai");
  await page.getByLabel("OpenAIのAPIキー").fill("sk-test-previous-provider");
  await provider.selectOption("anthropic");
  const key = page.getByLabel("Anthropic (Claude)のAPIキー");
  assert.equal(await key.inputValue(), "");
  await key.fill("sk-test-anthropic");
  await page.getByText(/意見の類似度はブラウザ内で計算/).waitFor();
  await page.getByRole("button", { name: "確認してCSV選択へ" }).click();
  await page.waitForURL("**/#/new");
  assert.deepEqual(requests, ["/v1/chat/completions"]);
  const settings = await readAnalysisSlots(page);
  assert.deepEqual(settings, { chat: "anthropic", embedding: "local-embedding" });
  console.log("初回設定 Claude とブラウザ内の埋め込み OK");
}

async function checkBrowserOnlySetup(page: Page) {
  await mockLocalEmbedding(page);
  await page.addInitScript(() => {
    Object.defineProperty(globalThis, "LanguageModel", {
      value: {
        availability: async () => "available",
        create: async () => ({
          prompt: async (_text: string, options?: { responseConstraint?: object }) =>
            options?.responseConstraint ? '{"sum":2}' : "2",
          destroy: () => {},
        }),
      },
    });
  });
  await page.goto(`${BASE}/#/setup`);
  await page.getByLabel("分析に使うAI").selectOption("gemini-nano");
  assert.equal(await page.locator('input[type="password"]').count(), 0);
  await page.getByRole("button", { name: "確認してCSV選択へ" }).click();
  await page.waitForURL("**/#/new");
  const settings = await readAnalysisSlots(page);
  assert.deepEqual(settings, { chat: "gemini-nano", embedding: "local-embedding" });
  console.log("初回設定 ブラウザ内だけで分析する場合 OK");
}

function readAnalysisSlots(page: Page) {
  return page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem("kouchou-ai-settings") ?? "{}").state.settings;
    return { chat: saved.chatSlot.provider, embedding: saved.embeddingSlot.provider };
  });
}

async function main() {
  const browser = await chromium.launch();
  if (process.argv.includes("--setup-only")) {
    try {
      await Promise.all([
        checkFirstAnalysisSetup(await browser.newPage()),
        checkAnthropicSetup(await browser.newPage()),
        checkBrowserOnlySetup(await browser.newPage()),
      ]);
    } finally {
      await browser.close();
    }
    return;
  }
  const page = await browser.newPage();
  const errors: string[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("console", (message) => {
    if (message.type() === "error") pageErrors.push(message.text());
  });

  const check = (name: string, ok: boolean, detail = "") => {
    console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
    if (!ok) errors.push(name);
  };

  // 1. ホーム
  await page.goto(`${BASE}/#/`);
  await page.waitForLoadState("networkidle");
  const guide = page.getByRole("dialog", { name: "広聴AI サーバレス版の使い方" });
  await guide.waitFor({ state: "visible" });
  await page.keyboard.press("Escape");
  await guide.waitFor({ state: "hidden" });
  const openGuide = page.getByRole("button", { name: "使い方", exact: true });
  check(
    "初回ガイドを閉じると「使い方」にフォーカスが戻る",
    await openGuide.evaluate((el) => el === document.activeElement),
  );
  await page.reload();
  await page.waitForLoadState("networkidle");
  check("初回ガイドの表示を記憶", !(await guide.isVisible()));
  await openGuide.click();
  await guide.getByRole("button", { name: "閉じる" }).click();
  check(
    "ホーム表示",
    await page
      .locator("h1")
      .first()
      .textContent()
      .then((t) => t?.includes("レポート一覧") ?? false),
  );

  // 2. 本家 JSON インポート(M7 受け入れ基準)
  await page.locator('input[type="file"][accept="application/json"]').setInputFiles(EXAMPLE_JSON);
  await page.waitForURL(/#\/report\//, { timeout: 30000 });
  await page.waitForSelector(".viewer-chart", { timeout: 30000 });
  // Plotly の WebGL 散布図が描画されるまで待つ
  await page.waitForSelector(".viewer-chart canvas, .viewer-chart .plotly", { timeout: 60000 });
  const clusterCards = await page.locator(".cluster-card").count();
  check("本家JSONインポート表示", clusterCards > 0, `クラスタカード ${clusterCards} 件`);
  const overviewText = await page.locator(".viewer-overview").textContent();
  check("本家JSON overview 表示", (overviewText?.length ?? 0) > 50);
  // ツリーマップ切替
  await page.getByRole("button", { name: "ツリーマップ" }).click();
  await page.waitForTimeout(3000);
  check("ツリーマップ描画", (await page.locator(".viewer-chart .treemap, .viewer-chart svg").count()) > 0);
  // 階層リスト切替
  await page.getByRole("button", { name: "階層リスト" }).click();
  await page.waitForTimeout(500);
  check("階層リスト描画", (await page.locator(".hierarchy-list details").count()) > 0);

  // 3. 設定画面
  await page.goto(`${BASE}/#/settings`);
  const openaiKey = env("OPENAI_API_KEY");
  const keyInputs = page.locator('input[type="password"]');
  await keyInputs.first().fill(openaiKey); // 先頭は OpenAI
  // chat スロット
  const chatSelect = page.locator(".card").filter({ hasText: "チャット(" }).locator("select").first();
  await chatSelect.selectOption("openai");
  const embSelect = page.locator(".card").filter({ hasText: "埋め込み(" }).locator("select").first();
  await embSelect.selectOption("openai");
  // 疎通確認
  await page
    .locator(".card")
    .filter({ hasText: "チャット(" })
    .getByRole("button", { name: /接続テスト/ })
    .click();
  await page.waitForFunction(
    () => document.body.textContent?.includes("接続成功") || document.body.textContent?.includes("接続失敗"),
    undefined,
    { timeout: 30000 },
  );
  check("OpenAI 疎通確認", (await page.textContent("body"))?.includes("接続成功") ?? false);

  // 4. ウィザード → 実行 → レポート
  await page.goto(`${BASE}/#/new`);
  await page.locator('input[type="file"]').setInputFiles("testdata/small30.csv");
  await page.waitForSelector("text=有効コメント");
  // 意見本文の列 = reasoning
  await page.locator("select").nth(1).selectOption("reasoning"); // [0]=エンコーディング, [1]=本文列
  // 属性: gender
  await page
    .getByLabel("gender", { exact: true })
    .check()
    .catch(() => {});
  await page.getByRole("button", { name: "次へ" }).click();
  await page.locator('input[placeholder*="生成AI"]').first();
  await page.getByRole("button", { name: "次へ" }).click(); // Step2 → 3
  await page.getByRole("button", { name: "次へ" }).click(); // Step3 → 4
  await page.waitForSelector("text=コスト見積り");
  await page.getByRole("button", { name: /プロジェクトを作成/ }).click();
  await page.waitForURL(/#\/run\//, { timeout: 15000 });
  await page.getByRole("button", { name: "実行開始" }).click();
  console.log("パイプライン実行中(実API、~2分)...");
  await page.getByRole("button", { name: "レポートを開く" }).waitFor({ timeout: 300000 });
  check("ブラウザ内パイプライン完走", true);
  await page.getByRole("button", { name: "レポートを開く" }).click();
  await page.waitForSelector(".viewer-chart", { timeout: 30000 });
  const cards2 = await page.locator(".cluster-card").count();
  check("生成レポート表示", cards2 > 0, `クラスタカード ${cards2} 件`);

  // 属性フィルタ(gender 属性を付けたので出るはず)
  const filterSelects = await page.locator(".viewer .row select").count();
  check("属性フィルタ表示", filterSelects > 0, `フィルタ ${filterSelects} 個`);

  // 単一 HTML エクスポート → ダウンロードした自己完結ファイルを file:// で開いて検証
  const downloadPromise = page.waitForEvent("download", { timeout: 60000 });
  await page.getByRole("button", { name: /単一 HTML/ }).click();
  const download = await downloadPromise;
  const htmlPath = `${process.env.TEMP ?? "."}/kouchou-smoke-report.html`;
  await download.saveAs(htmlPath);
  const standalone = await browser.newPage();
  await standalone.goto(`file:///${htmlPath.replace(/\\/g, "/")}`);
  await standalone.waitForSelector(".viewer-chart canvas, .viewer-chart .plotly", { timeout: 60000 });
  check("単一HTMLレポートがオフラインで開ける", (await standalone.locator(".cluster-card").count()) > 0);
  await standalone.close();

  // リロードして IndexedDB 永続性確認(M2 受け入れ基準)
  await page.reload();
  await page.waitForSelector(".viewer-chart", { timeout: 30000 });
  check("リロード後もレポート表示(IndexedDB)", (await page.locator(".cluster-card").count()) > 0);

  // 前処理データのエクスポート → インポート → 後処理のみ再実行(LLM抽出・埋め込みはスキップ)
  await page.getByText("書き出し・再クラスタリング", { exact: true }).click();
  await page.getByRole("button", { name: /クラスタリングを再実行/ }).click();
  await page.getByRole("button", { name: "前処理データをエクスポート" }).waitFor({ timeout: 15000 });
  const preDownloadPromise = page.waitForEvent("download", { timeout: 30000 });
  await page.getByRole("button", { name: "前処理データをエクスポート" }).click();
  const preDownload = await preDownloadPromise;
  const prePath = `${process.env.TEMP ?? "."}/kouchou-smoke.preprocessed.json`;
  await preDownload.saveAs(prePath);
  check("前処理データエクスポート", true);
  await page.goto(`${BASE}/#/`);
  await page.locator('input[type="file"][accept="application/json"]').setInputFiles(prePath);
  await page.waitForURL(/#\/run\//, { timeout: 15000 });
  await page.getByRole("button", { name: "再開" }).click();
  console.log("後処理のみ再実行中(抽出・埋め込みはスキップされるはず)...");
  const resumeStart = Date.now();
  await page.getByRole("button", { name: "レポートを開く" }).waitFor({ timeout: 300000 });
  check("前処理インポート→後処理のみ完走", true, `${Math.round((Date.now() - resumeStart) / 1000)}秒`);

  const relevantPageErrors = pageErrors.filter(
    (e) => !e.includes("favicon") && !e.includes("WebGL") && !e.includes("gpu"),
  );
  if (relevantPageErrors.length > 0) {
    console.log(`\n⚠️ ページエラー ${relevantPageErrors.length} 件:`);
    for (const e of relevantPageErrors.slice(0, 10)) console.log(`  ${e.slice(0, 200)}`);
  }

  await browser.close();
  if (errors.length > 0) {
    console.error(`\n失敗: ${errors.join(", ")}`);
    process.exit(1);
  }
  console.log("\nブラウザスモークテスト 全項目 OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
