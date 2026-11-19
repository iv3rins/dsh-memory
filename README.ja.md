# dsh-project-memory

**言語：** [English](./README.md) · [简体中文](./README.zh-CN.md) · 日本語 · [Español](./README.es.md)

[DeepSeek Harness](https://github.com/deepseek-ai) のためのプロジェクト記憶：ドキュメント、開発状態、そして再起動とコンテキスト圧縮（compaction）を生き延びる永続メモリ原子。ホスト側のみの cordis プラグインと、サイドバーパネル一つ。

```
MIT · Node 20+ · 実行時依存なし
```

## 解く問題

エージェントはセッションごとに白紙から始まります。だから同じ構造を何度も説明し、同じ文書を何度も読み、先週決めた決定をやり直し、すでに踏んだ穴をまた踏みます。

一つのセッションの内側では、同じ損失がもっと静かに起きます。コンテキストが長くなると harness がそれを圧縮し、元の対話は要約に置き換わります。コンテキストは安くなり、要約が書かなかった部分は永久に失われます。

このプラグインは記憶を**リポジトリの中**に置きます。コンテキストウィンドウの中ではなく。

## 仕組み

三つのストア。「何を書いたか」「今なにをしているか」「何を決めたか」は寿命が違うからです：

| システム | 保持するもの | 書き込む主体 | 耐えるもの |
|---|---|---|---|
| **A — ドキュメント** | あなたの Markdown | あなた（git 上で） | すべて |
| **B — 状態** | タスク、進捗、ブロッカー、決定 | `state_update` / `state_handoff` | 再起動、圧縮 |
| **C — 記憶クラスタ** | 話題ごとにまとめた永続的な記憶原子 | 圧縮オブザーバー、`memory_remember` | 再起動、圧縮 |

面白いのは **C** です：

```
長いセッション ──▶ 圧縮 ──▶ 不可逆な要約（モデルが次に見るもの）
                    │
                    └──▶ 記憶クラスタ ──▶ .dsh-memory/memory/atoms.jsonl
                                              │
次のステップ ──▶ タスクに関連するクラスタを検索 ─────┘
                  └──▶ トークン上限内の候補原子
```

四つの性質が、毎ステップ動かせるほど安くしています：

1. **先にクラスタを探す。** 語句、タグ、ファイルパスで関連するクラスタを探し、そこからトークン上限内の原子を選びます。
2. **記録であって、収集ではない。** 状態と原子はツール呼び出しが書きます。`state_update` を一度も呼ばないエージェントには状態記憶がありません——静かに間違うのではなく、目に見える欠落です。唯一の意図的な例外は圧縮オブザーバーで、圧縮要約を読むことこそシステム C の存在理由です。
3. **決定的な想起では常駐ルールに予算を割り当てる。** 語句が一致しなくても常駐ルールを選べます。ルーティングモデルを設定している場合、候補の本文を読み込むかどうかは実行モデルが判断します。
4. **選択は読み取り専用です。** ルーティングモデルは渡された ID から選びます。決定的なコードが未知の ID を除外し、記憶を書き込みます。

### ルーティングモデルの 3 段階

| `routerTier` | 動作 | コスト |
|---|---|---|
| `off` | 決定的な採点のみ | 無料 |
| `smart`（既定） | 決定的な採点が関連項目を見つけられない、または一致が弱いときだけ昇格 | provider と model の両方が設定されるまで無料 |
| `always` | 条件を満たす想起ごとにルーティングモデルを呼び出す | 1 回の検索につき最大 1 回 |

DSH のルーティングモデルには `routerProvider` と `routerModel` の両方が必要です。`routerStrategy`（`task` / `compliance` / `orient`）でモデルに渡す指示を変更できます。

#### 記憶の候補を確認し、検索をやり直す

ルーティングモデルを設定すると、`agent/pre-step` フックは候補の ID、種類、クラスタ、関連ファイルを実行モデルに渡せます。実行モデルは現在のプロジェクトを読んだうえで、読み込む記憶を決めます。`memory_intent` で明示的に検索する場合も同じ手順です。

1. `memory_intent({ task_summary: "設定の保存方法を確認", affected_modules: ["lib/panel.js"] })` で検索します。
2. `proposal_id` と `accept_memory_ids` を `memory_intent` に渡すと、承認した本文だけを取得できます。空のリストを渡すと候補全体を拒否します。
3. `proposal_id` と、現在のプロジェクトで確認した根拠を記載した `feedback` を渡すと再検索できます。新しい検索ではその根拠を使い、拒否済みの ID を除外します。必要に応じて確認を繰り返します。

ルーティングモデルは想起すべき記憶がないと回答できます。候補が見つからない場合や呼び出しに失敗した場合、想起の本文は追加されません。モデルが未設定または無効の場合は決定的に想起します。

### 「常駐」は「重み」ではない

重み（1–5）は**順位付け**の入力。常駐は**資格**の入力で、種別（`constraint`）で決まり、重みは見ません。両者を混ぜたのは実際のバグでした：既定の重みで保存された本物のルールが、静かにハードルールの地位を失っていました。常駐原子も件数と token の上限には従います——予算の取り分であって、免除ではありません。

## インストール

```
git clone https://github.com/iv3rins/dsh-memory.git
```

manifest が `dsh.bundle` を宣言しているので、1 コマンドで依存とバンドル項目の**両方**が入ります：

```powershell
$dsh = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
& $dsh plugin --profile desktop add -w "link:D:\path\to\dsh-memory"
```

ホストを再起動し、`project_inspect` を呼びます。プロジェクトルートが解決され、索引済みドキュメント数が返れば稼働しています。

`engines.dsh` は `>=0.2.0-rc.0 <0.3.0` と意図的に狭くしています：ホストのマイナーリリースはツール schema のサブセットやメッセージ形状を変えうるため、その場合このプラグインはインストール時ではなく**マウント時**に失敗します。新しいホストでスイートを再実行してから広げてください。

## ツール

十八個のツール。不慣れなセッションではまず `memory_status`。

| ツール | 何に答えるか |
|---|---|
| `memory_status` | 初期化済みか？どのリビジョンか？git に対して古いか？原子はいくつか？ |
| `memory_bootstrap` | 新しいセッションに必要なすべてを、予算内の 1 呼び出しで。 |
| `memory_search` | どの文書がこれを論じているか？順位付き、status/kind/path フィルタ付き。 |
| `memory_read` | 文書、またはその `##` セクション一つを、データとして読む。 |
| `memory_recall` | プロジェクトの記憶クラスタから関連する原子を決定的に検索する。 |
| `memory_intent` | タスクで記憶を検索し、候補を承認、拒否、再検索する。 |
| `memory_remember` | 永続的な事実、制約、決定を保存する。 |
| `memory_forget` | id で原子を退役させる。墓標は粘着性。 |
| `memory_lifecycle` | 原子の階層（HOT / WARM / COLD）を確認・調整する。 |
| `memory_metrics` | ルーティングモデルの呼び出し、遅延、キャッシュヒット、配信と使用、トークンコスト。 |
| `state_get` / `state_update` | 状態を読む／変更を記録する。CAS で、衝突は報告される。 |
| `state_handoff` | セッション終わりのメモ。次のセッションが向きを得た状態で始まる。 |
| `project_init` / `project_inspect` | `.dsh-memory/` を作る／読み取り専用の診断。 |
| `docs_check` / `docs_sync` | front-matter の問題／文書変更の提案（決して上書きしない）。 |
| `architecture_check` | `.dsh-memory/arch.json` に基づく決定的な import ルール検査。 |

**コマンド：** `/memory-status`、`/memory-context`、`/memory-init`、`/memory-handoff`、`/memory-recall`、`/memory-route`、`/memory-forget`、`/memory-sync`、`/architecture-check`。`/memory-route` はドライラン：現在の段階がどのルートを取るか、なぜかを、モデル呼び出しを費やさずに示します。

**サイドバーパネル。** 最近の圧縮結果、有効な記憶と忘却済みの記憶の件数、常駐ルール、記憶の内訳を表示します。ルーティングモデルの設定は初期状態で折りたたまれています。記憶の忘却には `memory_forget` を使います。パネルのエンドポイントへのアクセスはループバックアドレスに限定されます。

**コンテキスト注入。** 最初のステップで予算内のベースライン（同一性、git の事実、タスク、不変条件、次の一手、ブロッカー、決定、文書マップ）を注入し、同一性が変わったときだけ再送します。各ステップは recall ブロックも受け取れ、セッションの可視面に対して重複排除されます。どちらもプラグイン所有のメッセージとして nonce フェンス内で届きます：プロジェクトのテキストはデータであり、決して指示ではありません。

## 設定

全フィールドに既定値があります。不正な値は修復され、致命的にはなりません。

| フィールド | 既定 | 意味 |
|---|---|---|
| `enabled` | `true` | マスタースイッチ。 |
| `injectContext` / `injectRecall` | `true` | ベースライン／毎ステップの recall を注入。 |
| `l0Budget` / `l1Budget` / `l2Budget` | `300` / `1200` / `2000` | Token：最小ベースライン、完全ベースライン、1 回の読み取り。 |
| `recallBudget` / `recallLimit` | `400` / `8` | 1 回の recall の上限と件数。 |
| `routerTier` / `routerStrategy` | `smart` / `task` | 上記の段階表を参照。 |
| `routerProvider` / `routerModel` | `''` / `''` | DSH のルーティングモデル。 |
| `routerTimeoutMs` / `routerDigestBudget` | `20000` / `900` | 呼び出しの制限時間／渡すダイジェストの token 上限。 |
| `extractOnCompaction` / `extractUserRules` | `true` | 要約と明言されたルールから原子を抽出。 |
| `semanticRouting`、`lifecycleEnabled`、`taskIntentEnabled` | `false` | 任意の追加層。`false` に戻せば以前の挙動に復帰。 |
| `protectedPaths` | `AGENTS.md`、`docs/decisions/`、`docs/adr/`、`.git/` | `docs_sync` が決して書かない。 |

六つのフィールドはプロジェクト単位で上書きできます——`routerTier`、`routerStrategy`、`routerProvider`、`routerModel`、`recallBudget`、`recallLimit`——`.dsh-memory/settings/<project-key>.json` に。それ以外は意図的にグローバルです：パスや書き込み上限はインストールを記述するもので、リポジトリを記述するものではありません。

## ストレージ

すべて `.dsh-memory/` の下にあります。git にコミットすればチーム共有の記憶、無視すれば個人の記憶——どちらも整合的です。

```
.dsh-memory/
  project.json       安定した projectId + 初回観測の git 事実
  state/current.json  状態ドキュメント（リビジョン付き）
  state/journal.jsonl 受理された書き込みの追記ログ
  state/compactions.jsonl 観測した圧縮ごとに 1 行（沈黙したものも含む）
  memory/atoms.jsonl  有効なクラスタまたは墓標ごとに 1 行の JSON
  memory/metrics.json 上限付きイベントカウンタ
  index.json          派生キャッシュ —— 削除して安全
  settings/<key>.json プロジェクト単位の上書き
```

従来の原子レコードも読み込めます。次に内容が更新されるとクラスタ形式に移行し、原子 ID、来歴、常駐ルール、墓標を引き継ぎます。同じ内容が繰り返し記録されると同じ原子が強化されます。`memory_forget` は墓標を書き込んで再抽出を防ぎます。

## 測ったもの、測っていないもの

**測った**（`docs/design/benchmark-compaction-loss.md`）：実データセットの 80 問で、要約のみのコンテキストは 16.3%、生の末尾のみは 15.0%、要約＋原子 recall は 25.0% の正答率でした。すべての信頼区間がゼロをまたぐため、これは**方向の一致**であって**確立した効果ではありません**。

**測っていない**：

- **ルーティングモデルの精度と呼び出し頻度。** テストはスタブを使ってタイムアウト、中断、不正な応答、未知の ID を確認しています。実際の DSH ルーティングモデルの精度と `smart` の呼び出し頻度は未測定です。
- **クラスタ検索の性能。** 想起時は `atoms.jsonl` を解析し、関連クラスタの原子を順位付けします。従来の計測値は移行前の全件走査を対象としています。

## やらないこと

- `AGENTS.md`、`docs/decisions/`、`docs/adr/`、`.git/` を変更しません。`docs_sync` はこれらのパスを拒否し、その理由を示します。
- コミット、ブランチ作成、プッシュをしません。git の事実を記録するだけで、git 操作は行いません。
- 状態を黙って捏造しません。すべての書き込みは CAS で、同時書き込みは上書きではなく衝突として報告されます。
- 権威ある文書を上書きしません。提案は `docs/proposals/` に書きます。

## 検証

```powershell
npm run setup        # ホストパッケージを抽出してリンク（一度だけ、冪等）
npm test             # 純粋な core/ 層の 14 単体テスト
npm run test:host    # 実際の harness に対する 28 項目の連鎖検査
```

ホストスイートは、harness が強制するツール schema、注入と重複排除、実イベントを通した「圧縮 → recall → 忘却」の閉ループ、安全性とパス拒否、優雅な降格、manifest 互換性、パネルの HTTP 挙動、プロジェクト単位設定、Client 半分を覆います。スキップされた検査は `SKIP` と表示され、何も証明しません。

**スイートが緑でも、インストールが動いている証拠にはなりません。** スイートはリポジトリが組んだ cordis コンテキストにプラグインをマウントするだけです。profile が実際に読み込むことは、ホストを起動して初めて証明されます。両方を行ってください。

## 構成

```
core/   純粋な Node、DSH を import しない —— テスト可能な中核
        memory.js  clusters.js  gate.js  state.js  retrieval.js  category.js  lifecycle.js
        extract.js  config.js  index.js  search.js  store.js  paths.js  ...
lib/    cordis 層：index.js  tools.js  commands.js  panel.js  recall.js
        recall-review.js  router.js  semantic.js  delegate.js  compaction-memory.js
client.js  サイドバーパネル（Client 半分）
tests/     unit/（node --test）と *.mjs のホスト検査
docs/      設計ノートとドキュメント提案
```

`docs/design/system-c-memory-atoms.md` が原子層を掘り下げます。読むことではなくテストすることで見つかった二つの罠を含みます：生のスコアに softmax をかけると単一エキスパートに崩壊すること、そして重なりだけで順位付けると、まさにハード制約が重要な瞬間にそれを捨てること。

## ライセンス

[MIT](./LICENSE) © 2026 iverins
