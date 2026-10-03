# loopfinder

[English](README.md)

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/motimotinotch)

**自分のワークスペースにあるフィードバックの輪を、意図していなかったものも含めて見つける道具。**

ノートの Vault に、いくつかのスクリプトと AI のアシスタントと自分の習慣が乗ると、それは1つの系になります。
スクリプトがノートに書き、自分がそれを読んで何かを決め、その決めごとが別のノートに入り、それを翌日スクリプトが読む。
そうした輪の一部は自分で設計したものですが、残りは気づかないうちにできています。

loopfinder はその系を描き、中にある輪をすべて並べます。

1. **ワークスペースの調査は、いつも使っている AI エージェントが行います。** loopfinder 自体は AI を持っていません。代わりに案内書 `loopfinder/AGENTS.md` を書き出すので、それを読んで調べるよう、使っているエージェント（Claude Code、Codex、Cursor など）に頼みます。エージェントは調べた結果を `loopfinder/flows.json` に書きます。中身は、どのスクリプトを動かすかと、コードに現れない段（自分の作業、AI の作業）です。自分のノートには手を入れません。
2. **スクリプトを実際に動かして、触ったものを記録します**（読み・書き・通信・サブプロセス）。書き込みは止めるので、ディスクの上は何も変わりません。
3. **単純閉路をすべて数え、宣言した名前を当て、残りを知らせます**。*名前のない輪*は、宣言していないフィードバックです。*見つからない輪*は、宣言したのにもう無い輪です（手順が変わって輪が切れた合図）。あわせて*末端*も知らせます。書かれるのに、どの流れからも読まれないファイルです（誰も回収していない出力か、宣言し忘れた「読む段」）。

![デモの reading の流れで輪を1本選んだところ](docs/demo-reading.png)

## 安全について: 記録がすること・しないこと

記録は**スクリプトを本当に実行します**。記録フック（Node は `trace/trace.js`、Python は `trace/trace.py`）は、スクリプトが始まる前に入出力の関数を差し替えます。

- **書き込みは記録して、捨てます。** Node の fs の書き込みはすべて（同期・コールバック・Promise・ストリーム・書き込み用の `open`）。Python は `open`/`io.open`（なので `pathlib` も）、`os.open`、名前変更・削除・rmdir・truncate・リンク・chmod、`shutil` の move/copy/rmtree。SQLite は読み取り専用で開きます。
- **通信とサブプロセスは、既定で止めます。** 試みは記録したうえで失敗させるので、スクリプトにはエラーとして見えます。`--allow-network` / `--allow-subprocess` で通せます（そのときも記録はします）。
- **これは記録係で、サンドボックスではありません。** ネイティブ拡張、ワーカースレッド、これらのモジュールを通らない処理は対象外です。自分で実行しないコードは記録にかけないでください。

テスト（`npm test`）は、上の書き込みの経路をすべて一時フォルダに対して試し、1バイトも変わらないことを確かめます。対照として、同じスクリプトをフックなしで走らせると実際に変わることも確かめています。

## はじめかた

Node 18 以上（Python のスクリプトを記録するなら Python 3 も）。依存パッケージはありません。

```sh
git clone https://github.com/MotimotiNotch/loopfinder
cd loopfinder
npm run demo                 # デモのワークスペースを組み立てて http://127.0.0.1:7878/ で開く
```

自分のワークスペースでは:

```sh
cd /path/to/your/vault
node /path/to/loopfinder/bin/loopfinder.js init     # loopfinder/ を作る（config.json・flows.json・AGENTS.md）
```

続けて、AI エージェントにこう頼みます。

> loopfinder/AGENTS.md を読んで、このワークスペースを調べて。

エージェントは `loopfinder/flows.json` を書きます。輪に名前を付ける前には、こちらに確かめます。そのあとで:

```sh
node /path/to/loopfinder/bin/loopfinder.js build
node /path/to/loopfinder/bin/loopfinder.js serve
```

`build` は、見つけた輪、名前のない輪、宣言したのに見つからない輪、末端を出力します。
名前のない輪と末端はエージェントに戻してください。どの輪が意図どおりかをこちらに聞いて名前を付け、末端は誰かが読んでいるかを聞きます。手順が変わったら、もう一度調査を頼みます。そのときエージェントは、それぞれの流れを読み取った元のファイルから見直します。

loopfinder が置くものは2つのフォルダだけです。`loopfinder/`（流れと設定。バージョン管理に入れておく価値があります）と、`.loopfinder/`（組み立ての出力。ファイルのパスが並ぶので、入れないでください）。
`AGENTS.md` は、入っている loopfinder の版に合わせて毎回書き直されます。手で直しても、次の実行で消えます。
画面は `127.0.0.1` でだけ待ち受けます（グラフにはファイルのパスが並ぶため）。画面では、英語と日本語、配色（自動＝OS に合わせる・ライト・ダーク）を切り替えられ、どちらの選択もブラウザが覚えます。

## flows.json

書くのはエージェントで、人は読んで、必要なら直します。エージェントが従う規則の全文は、案内書の元 [`src/agents-guide.md`](src/agents-guide.md) にあります。

```json
{
  "flows": [
    {
      "name": "reading",
      "about": "スクリプトが新着をデイリーに集め、自分が試すものを選ぶ",
      "sources": ["scripts/fetch_feed.js"],
      "trace": ["scripts/fetch_feed.js 2026-10-02"],
      "start": ["web:example.com"],
      "edges": [
        "notes/daily/{date}.md#Reading -> [me] Read and pick something to try",
        "[me] Read and pick something to try -> notes/daily/{date}.md#Tasks"
      ],
      "loops": [
        { "name": "Do not show the same item twice", "nodes": ["scripts/fetch_feed.js", "scripts/seen.json"] },
        { "name": "Reading becomes tasks", "nodes": ["notes/daily/{date}.md", "[me] Read and pick something to try"], "contains": true }
      ]
    }
  ]
}
```

| キー | 意味 |
|---|---|
| `trace` | 記録フックの下で動かすスクリプト（引数つき） |
| `edges` | `A -> B -> C`: A から B、B から C へデータが流れる |
| `[担い手] 何をするか` | 手で行う段。担い手は設定の `actors` と照らし合わせる（自分: 塗り、AI: 中抜き、それ以外: 破線） |
| `note.md#見出し` | ノートの節（節の中心図で使う） |
| `groups` | `{ "name", "nodes" }`: これらを1つの枠で囲んで描く |
| `loops` | `{ "name", "nodes" }` は、ちょうどこのノードでできた輪に名前を付ける。`"contains": true` なら、名前の付かなかった輪のうちこれらを通るものすべてに付ける |
| `start` | 図を読みはじめる位置 |
| `about`、`sources` | 何のための流れか、どのファイルから読み取ったか（次の調査のため） |

ノードの書き方: ルートからの相対パス（`notes/ideas.md`、フォルダは末尾に `/`）、`script:<名前>`（`scriptDirs` から探す）、`web:<名前>`、`repo:<名前>[/パス]`、`~/パス`、絶対パス。
パスの中の日付は `{date}`、ISO 週は `{week}` に畳みます（設定で変えられます）。

名前は順に当てます。ぴったり合う名前が `contains` より先で、同じ種類の中では先に宣言したものが勝ちます。

流れを、それが表す手順の隣に置いておきたい場合は、同じ行を ` ```flow <名前> ` ブロックとして `declarations` に挙げたファイルに書くこともできます（`trace: ...`、`start: ...`、`A -> B`、`group <名前>: A, B`、`loop <名前>: A, B`、`loop <名前> (contains): A, B`。`(含む)` とも書けます）。

## 設定（`loopfinder/config.json`）

パスはワークスペース（`loopfinder/` を置いたフォルダ）からの相対です。

| キー | 既定 | |
|---|---|---|
| `root` | `.` | ワークスペース。この下のファイルは、ルートからの相対パスが ID になる |
| `flows` | `loopfinder/flows.json` | エージェントが書いた流れ |
| `declarations` | `[]` | 任意: ` ```flow ` ブロックを読むファイルの glob（ルートからの相対） |
| `scriptDirs` | `["scripts"]` | `script:<名前>` を探すフォルダ |
| `repos` | — | リポジトリを置いているフォルダ（`repo:<名前>` 用） |
| `actors` | `{"human":["me"],"ai":["AI"]}` | `[担い手]` のうち、自分・AI とみなす名前 |
| `webLabels` | `[]` | `[{ "match": "<正規表現>", "label": "..." }]` URL の表示名 |
| `placeholders` | 日付・週 | `[{ "pattern": "<正規表現>", "name": "{date}" }]` |
| `scanThreshold` | `12` | 読むだけのファイルがこれより多いスクリプトは、1つの「走査」ノードに畳む |
| `hubs` | `[]` | 中心の図（下） |
| `checks` | `[]` | 組み立てのあとに走らせる点検（下） |
| `output`, `cache` | `.loopfinder/` | グラフと記録の置き場 |
| `lang` | `en` | 画面の既定の言語（`en` か `ja`。画面で切り替えられる） |

### 中心の図

1種類のものを真ん中に置き、すべての流れから「それに書くもの」と「それを読むもの」を集めて並べます。

```json
{ "type": "sections", "name": "Daily note", "note": "notes/daily/{date}.md", "dir": "notes/daily", "level": 2 }
{ "type": "match", "name": "Content", "match": "^web:store\\((.+)\\)$", "flows": ["content"] }
```

`sections` はノートの見出しを使います。どの見出しに触れたかは、確かな根拠から順に決めます。記録した書き込み（フックが止めた書き込みを見出しごとに比べる）、宣言した `note.md#見出し`、推定（スクリプトのコードに見出しの文字が出てくる。点線で描く）の順です。

![デモのデイリーノートの中心図](docs/demo-hub.png)

### 点検

ワークスペース固有の決まりを、組み立てのたびに確かめます。

```js
// checks/every-page-declared.js
module.exports = ({ config, graph }) => ({
  title: 'Every page is declared',
  warnings: [/* 文字列 */],
});
```

## 先行するもの

- [Automation Graph](https://www.obsidianstats.com/plugins/automation-graph)（Obsidian プラグイン）は、リポジトリの自動化をワークフローのファイルから描き、宣言された外部の自動化を「このリポジトリからは確かめられない」破線のノードとして見せます。確かめられたものと宣言だけのものを分ける考え方は、loopfinder と同じです。違いは、読むのではなく動かすことと、輪を数えて名前を付けることです。
- [putior](https://cran.r-project.org/package=putior) は、R/Python のスクリプトの `#put` 注釈からワークフロー図を作ります（静的で、輪は扱いません）。
- [Neoloopy](https://forum.obsidian.md/t/neoloopy-think-in-feedback-loops-a-systems-thinking-tool-in-your-vault/115448) は、手で描いた因果ループ図から強化ループ・均衡ループを見つけます。
- strace や [monkeyfs](https://pypi.org/project/monkeyfs/) はファイルの入出力を横取りします。loopfinder の Python のフックも、同じモンキーパッチの手法です。

レイアウトは [dagre](https://github.com/dagrejs/dagre)（MIT、`LICENSE-dagre`）。アイコンは [Lucide](https://lucide.dev) の公式 SVG を `scripts/gen-icons.js` で改変せずに取り込んでいます（ISC。`moon` と `info` は Feather 由来で MIT。`LICENSE-lucide`）。

## 支援について

loopfinder は無償です。知らなかった輪が見つかったら、[Ko-fi](https://ko-fi.com/motimotinotch) で投げ銭してもらえると嬉しいです。保守はできる範囲で行います。

## ライセンス

MIT
