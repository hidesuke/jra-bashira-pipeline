# プロンプト

プロンプトの本文は、非公開リポジトリ `hidesuke/jra-bashira-prompts` にだけ置きます。このファイルに書いてあるのは、Worker が KV から読む形と、user 文の差し込み名です。本文を KV へ入れる手順は、このリポジトリにはありません。

## KV の形

キーは `prompt:v2:course` と `prompt:v2:race` です。値は `{"version","system","user"}` です。`version`、`system`、`user` のいずれかが空なら、そのジョブは失敗します。以前の `{"text"}` だけの値は読みません。`text` が残っていても、読むのは `version`、`system`、`user` だけです。

Gemini は `system` を `systemInstruction`、`user` を `contents` の user メッセージに分けます。レース予想の応答は Markdown として読み、見出しから指数分布・自信度・波乱度・印を取ります。見出しが足りないときだけ、本文中の JSON を試します。取り方は [notion.md](notion.md) です。

user 文の差し込みは次の名前です。置換したあとに `{{` が残っていると（`{{name}}` も `{{#…#}}` も）ジョブは失敗します。KV を新しい名前へ替えるまでのあいだ、右の Dify ノード ID にも同じ値を入れます。天気の Dify トークンは、DSL の綴り `weathre` のままです。

コース集計（`get_stats`）の結果は、どちらの user 文にも入れません。

## コース特徴（`prompt:v2:course`）

| 差し込み | 入るもの | 出典 | 移行中の Dify トークン |
| --- | --- | --- | --- |
| `{{venue}}` | 競馬場 | リクエストの開催場（BASHIRA `get_races` の `race_track`） | `{{#1788717846587.course#}}` |
| `{{surface}}` | 芝 / ダート / 障害。無いときは「不明」 | BASHIRA `get_races` の `surface` | `{{#1788717846587.type#}}` |
| `{{distance}}` | 距離（メートルの数値）。無いときは「不明」 | BASHIRA `get_races` の `distance` | `{{#1788717846587.distance#}}` |

## レース予想（`prompt:v2:race`）

| 差し込み | 入るもの | 出典 | 移行中の Dify トークン |
| --- | --- | --- | --- |
| `{{umabashira}}` | 馬柱。近走は最大 10 走 | [umabashira.md](umabashira.md)。同名馬は [same-name-horses.md](same-name-horses.md) | `{{#1788721223615.output#}}` |
| `{{course_analysis}}` | コース分析の本文 | 第 1 段階（course）の出力 | `{{#1788721380442.output#}}` |
| `{{weather}}` | 天気。どちらも無いときは「不明」 | 馬場 API を土台にし、BASHIRA `get_races` の `weather` があるときはそれで上書き | `{{#1788103991048.weathre#}}` |
| `{{condition}}` | 馬場状態。どちらも無いときは「不明」 | 馬場 API の芝またはダートの区分を土台にし、BASHIRA `get_races` の `track_condition` があるときはそれで上書き。障害には馬場 API 側の区分が無い | `{{#1788103991048.condition#}}` |
| `{{remarks}}` | 備考。両方空のときは「なし」 | `POST /run` の任意の `remarks` と、馬場 API にしか無い詳細。日付・場コード・レース番号のサマリを付ける | `{{#1787386477043.remarks#}}` |

馬場 API 側の詳細は、測定時刻、クッション値、芝とダートの含水率、当日雨量、使用コース、芝丈、芝の状態です。ユーザー備考があるときはその前に置き、改行でつなぎます。馬場の詳細があるときは `日付 場:場コード レース番号R ｜ 詳細` の形にします。馬場の取り方は [course-odds.md](course-odds.md) です。
