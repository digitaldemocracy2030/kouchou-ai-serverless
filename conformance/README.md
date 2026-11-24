# PythonとTypeScriptの共通契約テスト

Hypothesisが生成した同じ入力を、[kouchou-ai](https://github.com/digitaldemocracy2030/kouchou-ai)のanalysis-coreとブラウザ版に渡します。両方の出力に同じ検査器を適用します。

- **抽出と集計**。同じ回答内の同文はまとめ、異なる回答の同文は別の意見として残します。先頭ゼロや長い数字を含む回答IDを区別し、元の回答と属性を意見に結び付けます。
- **木構造**。IDが一意で、親が上の階層に実在し、意見の所属経路がrootから最下層までつながります。入力の所属グループを保ち、各クラスタの件数は所属意見数と一致します。
- **公開JSON**。公開する意見・属性・参照・件数を保持し、元コメント本文は公開指定がある時だけ出します。ブラウザ版のJSON読込へ両方の公開結果を渡します。
- **クラスタリング**。同じ点群でKMeansとWardを実行し、全点の割り当て、指定したクラスタ数の上限、隣接階層の入れ子をそれぞれ検査します。

レポートのテストではクラスタ所属とLLM応答を用意し、実際の抽出・ラベル付け・概要・集計・公開JSON変換を通します。クラスタリングのテストは既に座標のある点群から始まります。実LLM・埋め込み・UMAPはこのスイートの対象外です。クラスタ番号、生成文、座標、乱数による分け方は実装間で比較しません。入力条件が異なる空白のみの回答の件数、応答形式の寛容さ、再クラスタリング時のデータ復元はそれぞれの契約がある場所で扱います。

デフォルトの4つのプロンプトは逐語移植が要件なので、共通契約テストとは独立した照合で検査します。以前の期待値JSON、既知の不一致リスト、再生成ジョブは廃止しました。

## 実行

Node.js 22.12以降、pnpm、Python 3.12を使います。本家を隣にcloneし、PRで使う履歴を再現する場合は `.github/workflows/conformance.yml` に記載されたcommitを使います。

```sh
pnpm install --frozen-lockfile
python -m pip install -e "../kouchou-ai/packages/analysis-core[clustering]" -r conformance/requirements.txt
KOUCHOU_AI_SOURCE=../kouchou-ai OMP_NUM_THREADS=1 python -m pytest -q conformance --hypothesis-show-statistics
```

失敗時はHypothesisが縮小した入力を出力します。特定seedで実行する場合は `--hypothesis-seed=整数` を指定し、失敗した入力をそのまま再現する場合は出力の `@reproduce_failure(...)` を該当テストに一時的に付けます。

CIはPRとmainへのpushで本家の固定commitを使い、毎週と手動実行では本家mainを使って同じ検査を行います。通常の `pnpm test` はブラウザ版の単体テストとして単独で実行できます。
