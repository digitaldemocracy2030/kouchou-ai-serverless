import { type FormEvent, useEffect, useRef, useState } from "react";
import { LlmError, requestChat, requestEmbeddings } from "../lib/llm/client";
import { navigate } from "../lib/router";
import { SAMPLE_REPORT_ID } from "../lib/sampleReport";
import { useSettings } from "../store/settings";
import { needsInitialAnalysisSetup, OPENAI_PRESET, pipelineReadiness } from "../types/settings";

export function FirstAnalysisSetupPage() {
  const { settings, saveInitialOpenAiSetup } = useSettings();
  const [apiKey, setApiKey] = useState("");
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const requestRef = useRef<AbortController>(null);
  const savedOpenAi = settings.providers.openai;
  const savedKey =
    !savedOpenAi?.baseUrl || savedOpenAi.baseUrl === OPENAI_PRESET.baseUrl ? (savedOpenAi?.apiKey ?? "") : "";
  const key = apiKey.trim() || savedKey;

  useEffect(() => () => requestRef.current?.abort(), []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (requestRef.current || !key || !needsInitialAnalysisSetup(useSettings.getState().settings)) return;

    const controller = new AbortController();
    requestRef.current = controller;
    setChecking(true);
    setError("");

    const endpoint = { baseUrl: OPENAI_PRESET.baseUrl, apiKey: key };
    const sampleText = "接続確認です。「OK」と答えてください。";
    try {
      const [, vectors] = await Promise.all([
        requestChat(
          { ...endpoint, model: OPENAI_PRESET.chatModel },
          { messages: [{ role: "user", content: sampleText }], signal: controller.signal, timeoutMs: 30_000 },
        ),
        requestEmbeddings(
          { ...endpoint, model: OPENAI_PRESET.embeddingModel },
          { texts: ["接続確認"], signal: controller.signal, timeoutMs: 30_000 },
        ),
      ]);
      if (!vectors[0]?.length) throw new Error("埋め込み応答が空です");
      if (controller.signal.aborted || window.location.hash !== "#/setup") return;
      saveInitialOpenAiSetup(key);
      navigate("/new", { replace: true });
    } catch (cause) {
      if (controller.signal.aborted) return;
      setError(
        cause instanceof LlmError && (cause.status === 401 || cause.status === 403)
          ? "OpenAIに接続できませんでした。APIキーと利用権限を確認してください。"
          : "OpenAIに接続できませんでした。通信状況やOpenAI APIの利用設定を確認して、もう一度お試しください。",
      );
    } finally {
      requestRef.current = null;
      if (!controller.signal.aborted) setChecking(false);
      controller.abort();
    }
  };

  const needsSetup = needsInitialAnalysisSetup(settings);
  const canCreate = !pipelineReadiness(settings).blocked;

  return (
    <main className="first-analysis-setup">
      <h1>はじめての分析設定</h1>
      {needsSetup ? (
        <>
          <p>OpenAIのAPIキーを入力すると、分析に使うモデルが自動で設定されます。</p>
          <form className="card" onSubmit={submit}>
            <label htmlFor="first-analysis-key">OpenAIのAPIキー</label>
            <input
              id="first-analysis-key"
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={savedKey ? "保存済みのキーを使えます" : undefined}
              disabled={checking}
              aria-describedby="first-analysis-key-note"
            />
            <p id="first-analysis-key-note" className="note">
              キーは接続確認が通った後、このブラウザに保存します。分析する回答はOpenAIに送信されます。接続確認と分析にはAPI利用料がかかる場合があります。
            </p>
            <div className="row">
              <button type="submit" className="primary" disabled={checking || !key}>
                {checking ? "接続を確認中…" : "接続を確認してCSV選択へ"}
              </button>
              <a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer">
                OpenAIでAPIキーを作る
              </a>
            </div>
            <div role="alert">{error && <p className="error-box">{error}</p>}</div>
          </form>
        </>
      ) : (
        <>
          <p>{canCreate ? "分析に使うAIは設定されています。" : "設定画面で、分析に使うAIの設定を続けられます。"}</p>
          {canCreate && (
            <a className="action-link primary" href="#/new">
              CSV選択へ
            </a>
          )}
        </>
      )}
      <div className="row">
        <a href="#/settings">{needsSetup ? "別のAIを使う" : "AIの設定を開く"}</a>
        <a href={`#/report/${SAMPLE_REPORT_ID}`}>設定なしでサンプルを見る</a>
      </div>
    </main>
  );
}
