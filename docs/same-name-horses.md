# 同じ名前の馬

近走は馬名で `get_entries` を呼びます。BASHIRA の `name_resolution` が曖昧なときは、生年が一致する候補がちょうど 1 件のときだけ引き直します。出走数では選びません。

## 手順

1. 馬名、開催日以下（`race_meeting_date` の `lte`）、新しい順、最大 12 行で近走を取る。
2. `name_resolution` が未解決のときだけ、次を見る。未解決は `status` が `ambiguous` のとき、`ambiguous: true` のとき、または解決済みでなく候補が複数のときです。`status` が `resolved`、`resolved` や `selected` がある、`ambiguous: false` のときは解決済みとして行を使います。
3. 出馬表の `birth_date` の西暦と、候補名の末尾「名 (YYYY)」または「名 （YYYY）」の年が一致する候補がちょうど 1 件なら、その名前で 1 回だけ引き直す。例は `マイネルエンペラー (2020)` です。
4. 引き直しの結果も未解決なら、3 回目は呼ばない。近走行は空のままにする。
5. 生年で 1 件に決まらないときも、近走行は空のままにする。「近走なし」とは書かない。

決まらなかった馬の馬柱には、次の 1 行を書きます。無い値は「—」です。

```text
同名馬のため近走取得不可（通算出走数 …、前走着順 …、前走距離 …、前走馬場 …、間隔 …）
```

通算出走数は `career_starts`、前走着順は `prev_official_result`、前走距離は `prev_distance`、前走馬場は `prev_surface`、間隔は `days_since_last_race` です。

出馬表そのもの（そのレースの `get_entries`）が曖昧なときは、候補を決め打ちせずジョブを止めます。コース集計の応答が曖昧なときも止めます。引き直しをするのは、馬ごとの近走だけです。

## 管理 API に出る状態

`GET /admin/jobs/input` の `resolution_status` は次です。フィールドの一覧は [admin.md](admin.md) です。

| 値 | 意味 |
| --- | --- |
| `unique` | 馬名のままで近走を使った |
| `resolved_by_birth_year` | 生年付きの名前で 1 回引き直し、行が返った |
| `unresolved` | 同名のまま特定できなかった |
| `scratched` | 出走取消、発走除外、競走除外で、近走タスクを作っていない |
| `pending` | 近走タスクがまだ終わっていない |
| `missing` | 上のどれにも当てはまらない |

`resolved_name` は、生年で決めたときは「名 (YYYY)」、一意なときは馬名、未解決のときは null です。
