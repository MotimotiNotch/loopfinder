# loopfinder for VS Code

[English](README.md)

**ワークスペースのフィードバックループを見つける。意図せず作っていたものも含めて。**

[loopfinder](https://github.com/MotimotiNotch/loopfinder) の CLI と画面を、エディタの中で使えるようにしたものです。
Node を入れる必要はありません。エディタに入っている実行環境で動きます（Python は `.py` のスクリプトを記録するときだけ要ります）。

## 使い方

コマンドパレットで **loopfinder: はじめる** を選ぶか、準備が済んだあとはステータスバーの **loopfinder** を押します。
そのフォルダの次の一歩に進みます:

- まだ準備していなければ、`loopfinder/` を作ってから、誰にワークスペースを調べてもらうかを尋ねます:
  - **VS Code のチャット（エージェントモード）** — 依頼文を入れた状態でチャットを開きます。送信は自分で押します。エディタにチャットのモデルがあるときだけ出ます。
  - **ターミナルの Claude Code** — 新しいターミナルで、依頼文を付けて `claude` を起動します。`claude` が PATH にあるときだけ出ます。
  - **ほかの AI エージェント** — 依頼文をコピーします。貼り付けてください。
  - **AI を使わない** — `loopfinder/flows.json` を書き方の手引きと並べて開きます。流れを自分で書きます。
- エージェントが `loopfinder/flows.json` を書くと、loopfinder が1回だけ **ビルドして表示** を尋ねます。ビルドはワークスペースの
  スクリプトを実際に動かすので、押すまでは何も動きません。
- そのあとは同じコマンド（またはステータスバー）で、輪を表示します。流れが変わっていれば、もう一度ビルドします。

1つずつの手順（コマンドパレットから）:

1. **loopfinder: このワークスペースを準備** — `loopfinder/`（config.json・flows.json・AGENTS.md）を作ります。
2. 使っている AI エージェント（Claude Code・Codex・Cursor・Copilot など）に頼みます:
   *"Read loopfinder/AGENTS.md and survey this workspace."*
   （**loopfinder: AI エージェントへの依頼文をコピー** でクリップボードに入ります。）エージェントが `loopfinder/flows.json` を書きます。
3. **loopfinder: 図をビルド** — 書き込みを止めた状態でスクリプトを動かして記録し、図を組み立てます。
4. **loopfinder: 輪を表示** — 画面を開きます。ビルドするたびに自動で描き直します（コマンドパレットからでも、
   端末で `loopfinder build` を実行しても）。右の一覧のパスを押すと、そのファイルが開きます。

画面の言語は、最初はエディタの表示言語に合わせます。画面の上の言語ボタンで切り替えると、そちらが優先されます。

## 安全について

ビルドは**スクリプトを実際に動かします**。書き込みは記録して捨て、通信とほかのプログラムの起動は
`loopfinder.allowNetwork` / `loopfinder.allowSubprocess` を有効にしない限り止めます。記録係であって
サンドボックスではないので、動かしたくないコードは記録しないでください。

[信頼](https://code.visualstudio.com/docs/editor/workspace-trust)していないワークスペースでは、準備とビルドは
使えません。ビルド済みの図を見ることはできます。

`.loopfinder/`（ビルドの出力）にはファイルのパスが並びます。バージョン管理には入れないでください。

## 支援

[Ko-fi](https://ko-fi.com/motimotinotch) · MIT License · dagre と graphlib（MIT）、Lucide のアイコン（ISC）を同梱
