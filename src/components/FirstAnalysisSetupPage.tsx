import { type FormEvent, useEffect, useRef, useState } from "react";
import { LlmError, requestChat, requestEmbeddings } from "../lib/llm/client";
import { geminiNanoAvailability, prepareAndTestGeminiNano } from "../lib/llm/geminiNano";
import { embedLocallyViaWorker } from "../lib/llm/localEmbedding";
import { navigate } from "../lib/router";
import { SAMPLE_REPORT_ID } from "../lib/sampleReport";
import { useSettings } from "../store/settings";
import {
  FIRST_ANALYSIS_PRESETS,
  needsInitialAnalysisSetup,
  type PresetId,
  pipelineReadiness,
  resolveEndpoint,
  withInitialAnalysisSettings,
} from "../types/settings";

const API_KEY_PAGES: Partial<Record<PresetId, string>> = {
  openai: "https://platform.openai.com/api-keys",
  anthropic: "https://platform.claude.com/settings/keys",
  grok: "https://console.x.ai/",
  openrouter: "https://openrouter.ai/settings/keys",
};

export function FirstAnalysisSetupPage() {
  const { settings, saveInitialAnalysisSetup } = useSettings();
  const [selected, setSelected] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [nanoAvailable, setNanoAvailable] = useState<boolean | null>(null);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const requestRef = useRef<AbortController>(null);
  const provider = FIRST_ANALYSIS_PRESETS.find((preset) => preset.id === selected);
  const localChat = provider?.id === "gemini-nano";
  const localEmbedding = provider !== undefined && !provider.embeddingModel;
  const keyPage = provider && API_KEY_PAGES[provider.id];
  const savedProvider = provider && settings.providers[provider.id];
  const savedKey =
    !savedProvider?.baseUrl || savedProvider.baseUrl === provider?.baseUrl ? (savedProvider?.apiKey ?? "") : "";
  const key = localChat ? "" : apiKey.trim() || savedKey;
  const checking = progress !== "";
  const canCheck = provider !== undefined && (localChat ? nanoAvailable === true : key !== "");

  useEffect(() => () => requestRef.current?.abort(), []);

  useEffect(() => {
    if (!localChat) return;
    let cancelled = false;
    void geminiNanoAvailability().then((availability) => {
      if (!cancelled) setNanoAvailable(availability !== "unavailable" && availability !== "no");
    });
    return () => {
      cancelled = true;
    };
  }, [localChat]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const currentSettings = useSettings.getState().settings;
    if (requestRef.current || !provider || !canCheck || !needsInitialAnalysisSetup(currentSettings)) return;

    const controller = new AbortController();
    const { signal } = controller;
    requestRef.current = controller;
    setProgress("接続を確認中…");
    setError("");

    const proposed = withInitialAnalysisSettings(currentSettings, provider, key);
    const chat = resolveEndpoint(proposed, "chat");
    const embedding = resolveEndpoint(proposed, "embedding");
    let preparingEmbedding = false;

    const showDownloadProgress = (message: string) => {
      if (signal.aborted) return;
      const percent = message.match(/\d+%$/)?.[0];
      setProgress(percent ? `ブラウザ内のモデルをダウンロード中… ${percent}` : "ブラウザ内のモデルを準備中…");
    };

    try {
      if (localChat) {
        setProgress("ブラウザ内のモデルを準備中…");
        const result = await prepareAndTestGeminiNano(showDownloadProgress, signal);
        if (!result.output) throw new Error("Gemini Nanoの応答が空です");
      } else {
        await requestChat(chat, {
          messages: [{ role: "user", content: "接続確認です。「OK」と答えてください。" }],
          signal,
          timeoutMs: 30_000,
        });
      }

      preparingEmbedding = localEmbedding;
      if (localEmbedding) setProgress("ブラウザ内のモデルを準備中…");
      const texts = ["接続確認"];
      const vectors = localEmbedding
        ? await embedLocallyViaWorker(texts, embedding.model, showDownloadProgress, signal)
        : await requestEmbeddings(embedding, { texts, signal, timeoutMs: 30_000 });

      if (!vectors[0]?.length) throw new Error("埋め込み応答が空です");
      if (signal.aborted || window.location.hash !== "#/setup") return;
      saveInitialAnalysisSetup(provider, key);
      navigate("/new", { replace: true });
    } catch (cause) {
      if (signal.aborted) return;
      if (preparingEmbedding || localChat) {
        setError(
          "ブラウザ内のモデルを準備できませんでした。通信状況や端末の空き容量を確認して、もう一度お試しください。",
        );
      } else if (cause instanceof LlmError && (cause.status === 401 || cause.status === 403)) {
        setError(`${provider.label}に接続できませんでした。APIキーと利用権限を確認してください。`);
      } else {
        setError(`${provider.label}に接続できませんでした。通信状況やサービスの利用設定を確認してください。`);
      }
    } finally {
      requestRef.current = null;
      if (!signal.aborted) setProgress("");
      controller.abort();
    }
  };

  const needsSetup = needsInitialAnalysisSetup(settings);
  const canCreate = !pipelineReadiness(settings).blocked;

  return (
    <main className="first-analysis-setup">
      <h1>はじめての分析設定</h1>
      {needsSetup ? (
        <form className="card" onSubmit={submit}>
          <label htmlFor="first-analysis-provider">分析に使うAI</label>
          <ul className="note first-analysis-hints" id="first-analysis-provider-hints">
            <li>
              <b>APIキーをお持ちなら</b>、そのサービスを選んでください。
            </li>
            <li>
              新しくキーを作るなら <b>OpenAI</b>。意見の整理と類似度計算に同じキーを使えます。
            </li>
            <li>
              キーなしで自分のCSVを試すなら <b>Gemini Nano</b>。対応するChromeで使えます。
            </li>
          </ul>
          <select
            id="first-analysis-provider"
            aria-describedby="first-analysis-provider-hints"
            value={selected}
            disabled={checking}
            onChange={(event) => {
              setSelected(event.target.value);
              setApiKey("");
              setError("");
              setNanoAvailable(null);
            }}
          >
            <option value="">使うAIを選んでください</option>
            {FIRST_ANALYSIS_PRESETS.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.id === "gemini-nano" ? "Gemini Nano（Chrome内蔵・APIキー不要）" : preset.label}
              </option>
            ))}
          </select>
          {provider && (
            <>
              {!localChat && (
                <>
                  <label htmlFor="first-analysis-key">{provider.label}のAPIキー</label>
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
                    キーは接続確認が通った後、このブラウザに保存します。回答は選んだサービスに送信され、接続確認や分析にAPI利用料がかかる場合があります。
                  </p>
                </>
              )}
              {localEmbedding && (
                <p className="note">
                  {localChat && nanoAvailable === false
                    ? "このブラウザではGemini Nanoを使えません。別のAIを選ぶか、サンプルをご覧ください。"
                    : localChat
                      ? "分析はブラウザ内で行います。初回はモデルをダウンロードすることがあります。"
                      : "意見の類似度はブラウザ内で計算します。初回はそのためのモデルをダウンロードします。"}
                </p>
              )}
              <div className="row">
                <button type="submit" className="primary" disabled={checking || !canCheck}>
                  {checking ? "確認中…" : "確認してCSV選択へ"}
                </button>
                {keyPage && (
                  <a href={keyPage} target="_blank" rel="noreferrer">
                    APIキーを作る
                  </a>
                )}
              </div>
            </>
          )}
          <div role="status">{checking && <p className="note">{progress}</p>}</div>
          <div role="alert">{error && <p className="error-box">{error}</p>}</div>
        </form>
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
        <a href={`#/report/${SAMPLE_REPORT_ID}`}>設定なしでサンプルを見る</a>
        <a href="#/settings">{needsSetup ? "接続先やモデルを自分で指定する" : "AIの設定を開く"}</a>
      </div>
    </main>
  );
}
