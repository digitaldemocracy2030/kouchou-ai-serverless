# 本家との適合性テスト

serverless 版が本家（[kouchou-ai](https://github.com/digitaldemocracy2030/kouchou-ai) の analysis-core。管理画面から作るレポートと同じ経路）と同じ振る舞いをするかを確かめるテストです。

## 何を確かめるか

同じ入力と同じ LLM 応答を与えたとき、次が本家と一致するかを確かめます。

| 範囲 | 中身 |
|---|---|
| プロンプト | 4 段（抽出・初期ラベル・統合ラベル・概要）のプロンプトが、本家の管理画面のものと一字一句同じか |
| LLM への依頼 | 各段で LLM に送る本文。抽出は回答の順番まで、ラベル付けと概要は並び順を問わず比べる |
| 抽出結果 | 意見の文面、`arg_id`、意見と回答の対応 |
| 結果 JSON | `arguments`（意見・所属クラスタ・座標・`comment_id`・属性・URL）、`clusters`（ラベル・件数・親・密度の順位）、`comments`、`comment_num`、`propertyMap`、`overview`、`translations`、`config.intro` |
| クラスタ数 | 推奨クラスタ数（cube-root）、指定したクラスタ数の整え方 |
| 上位クラスタへの統合 | KMeans の重心を固定したときの ward による統合（分け方と番号） |
| KMeans + ward | はっきり分かれた塊を同じ分け方にするか |
| LLM 応答の読み取り | 形式の崩れた応答（空・途中で切れた JSON・`<think>` 付きなど）を、各段が成功として読むか失敗にするか |

## 確かめないもの

- **埋め込みと UMAP の座標**: 実装も乱数も違うので一致しません。座標とクラスタの割り当ては、本家・serverless の両方に同じものを入力として渡します（`generate_expected.py` の `layout`）
- **KMeans の細かい結果**: 塊がはっきりしない入力では、初期値の取り方の違いで分け方が変わりえます。はっきり分かれた塊だけを比べます
- **実際の LLM の出力の良し悪し**: 偽の LLM（`fake_llm.py` / `tests/conformance/fakeLlm.ts`）を使います。応答は依頼文だけから決まるので、依頼文が同じなら同じ応答になります
- **ラベル付けのサンプリング**: 本家と serverless で乱数が違います。テストは `sampling_num` をクラスタの大きさ以上にして、全件を送らせて比べます
- 本家にしかない機能（意見の分類・賛否・新規性のスコア、翻訳、LLM 直接グルーピング）と、serverless にしかない機能（賛否スペクトラム、再クラスタリング）

## 仕組み

1. `generate_expected.py` が本家の analysis-core を実際に動かし（LLM 呼び出しだけ偽物に差し替える）、期待値を `expected/` に書きます。管理画面から作った時と同じ形の config と入力 CSV（属性列は `attribute_` 付き）を使います
2. `tests/conformance/` が serverless の同じ処理に同じ入力を流し、期待値と比べます。通常の `pnpm test` に含まれます
3. 本家と違うと分かっている点は `known-divergences.json` に理由つきで載せます。載っている項目は「今は一致しない」ことを確かめるテスト（`it.fails`）になるので、直して一致するようになるとテストが落ちます。その時は一覧から項目を消します。一覧にあるのに対応するテストが無い id もテストが落とします

ケースは `cases/` にあります。`downstream: true` のケースだけ、抽出の後の段（ラベル付け・概要・結果 JSON）まで比べます。抽出の差が後の段の比較に混ざらないよう、後の段には本家の抽出結果を入力として渡します。

## 実行する

```bash
pnpm exec vitest run tests/conformance
```

## 期待値を作り直す

本家を隣に clone し、analysis-core を Python 3.12 の環境に入れてから実行します。

```bash
pip install -e "../kouchou-ai/packages/analysis-core[clustering]"
python conformance/generate_expected.py --kouchou-ai ../kouchou-ai
```

`expected/*.json` の `kouchou_ai_commit` に、使った本家の commit が入ります。差分をレビューし、本家の変更に追いつくべきもの（serverless を直す）と、意図して違えるもの（`known-divergences.json` に理由を書く）に分けてください。

CI（`.github/workflows/conformance.yml`）は、期待値が記録した commit から再生成したものと一致するかを PR ごとに確かめ、本家 main で期待値が古くなっていないかを毎週確かめます。

## 偽の LLM を変える時

`fake_llm.py` と `tests/conformance/fakeLlm.ts` は同じ振る舞いでなければなりません。片方を変えたらもう片方も変え、期待値を作り直してください。
