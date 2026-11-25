import { navigate } from "../lib/router";
import { useSettings } from "../store/settings";
import { pipelineReadiness } from "../types/settings";

// 環境構築(LLM プロバイダ設定 + 疎通確認)が済んでいないことを知らせるバナー。
// 新規作成ウィザードと賛否スペクトラム新規作成で共用する。

export function SetupBanner() {
  const { settings } = useSettings();
  const { ready, blocked, slots } = pipelineReadiness(settings);
  if (ready) return null;

  const missing = slots.filter((s) => s.readiness.state !== "ok");

  return (
    <div className="warn-box">
      <b>{blocked ? "分析を実行するにはAIの設定が必要です" : "AIの接続確認がまだです"}</b>
      <ul style={{ margin: "6px 0", paddingLeft: "1.2em" }}>
        {missing.map((s) => (
          <li key={s.slot}>{s.readiness.reason}</li>
        ))}
      </ul>
      <div className="row" style={{ alignItems: "center" }}>
        <button type="button" className="primary" onClick={() => navigate("/settings")}>
          設定画面へ
        </button>
        <span className="note" style={{ margin: 0 }}>
          {blocked
            ? "使うAIサービスとモデルを設定してください。"
            : "設定画面の「接続を確認する」で、使うモデルが応答するか確かめられます。"}
        </span>
      </div>
    </div>
  );
}
