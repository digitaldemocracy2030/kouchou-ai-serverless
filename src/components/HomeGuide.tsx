import { useEffect, useRef } from "react";
import { SAMPLE_REPORT_ID } from "../lib/sampleReport";

const STORAGE_KEY = "kouchou-ai:home-guide-seen";
let guideChecked = false;

export function HomeGuide({ hasSavedWork, needsSetup }: { hasSavedWork: boolean | undefined; needsSetup: boolean }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (hasSavedWork === undefined || guideChecked) return;
    guideChecked = true;

    // 保存が使えない場合も、同じタブでホームに戻るたびには表示しない。
    try {
      if (localStorage.getItem(STORAGE_KEY)) return;
      localStorage.setItem(STORAGE_KEY, "1");
    } catch {
      // このページの読み込み中は guideChecked で管理する。
    }
    if (!hasSavedWork) dialogRef.current?.showModal();
  }, [hasSavedWork]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="home-guide-trigger"
        aria-haspopup="dialog"
        onClick={() => dialogRef.current?.showModal()}
      >
        使い方
      </button>
      <dialog
        ref={dialogRef}
        className="home-guide"
        aria-labelledby="home-guide-title"
        aria-describedby="home-guide-intro"
        onClose={() => triggerRef.current?.focus()}
      >
        <h2 id="home-guide-title">広聴AI サーバレス版の使い方</h2>
        <p id="home-guide-intro">アンケートなどの自由記述を、似た意見ごとにまとめて、図で探索できます。</p>
        <div className="home-guide-options">
          <div>
            <a
              className="action-link primary"
              href={`#/report/${SAMPLE_REPORT_ID}`}
              aria-describedby="guide-sample-note"
            >
              サンプルを見る
            </a>
            <p id="guide-sample-note">初めてなら、まずはサンプルがおすすめです。設定なしで分析結果を見られます。</p>
          </div>
          <div>
            <a className="action-link" href={needsSetup ? "#/setup" : "#/new"} aria-describedby="guide-create-note">
              自分のCSVを分析する
            </a>
            <p id="guide-create-note">
              {needsSetup ? "使うAIを選び、分析に必要な項目だけを設定します。" : "手元のCSVからレポートを作れます。"}
            </p>
          </div>
        </div>
        <div className="home-guide-footer">
          <button type="button" onClick={() => dialogRef.current?.close()}>
            閉じる
          </button>
        </div>
      </dialog>
    </>
  );
}
