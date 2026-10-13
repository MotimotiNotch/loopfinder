# Changelog

## Unreleased

- **One command to get started.** **loopfinder: Get started** (and the status bar item once a folder is set up) takes the folder to its next step: set up, hand the request to your AI agent, build, or show. It offers only the agents this editor can reach: the VS Code chat in agent mode (request filled in, you send it), Claude Code in a new terminal when `claude` is on your PATH, copying the request for any other agent, or writing the flows yourself.
- **It notices when the flows are written.** When `loopfinder/flows.json` gets flows, loopfinder asks once whether to build and show. Building still waits for your click, because it runs the workspace's scripts.

**loopfinder: はじめる**（準備のあとはステータスバーの項目）1つで、準備・AI エージェントへの依頼・ビルド・表示のうち次の一歩に進みます。頼む先は、このエディタから届くものだけを出します（エージェントモードの VS Code のチャット、PATH に `claude` があればターミナルの Claude Code、ほかのエージェント向けのコピー、AI を使わず自分で書く）。`loopfinder/flows.json` に流れが書かれると、ビルドして表示するかを1回だけ尋ねます。

## 0.1.1 (2026-10-08)

- **Building stops with a clear message when Python cannot start.** Building the bundled demo, or any flow that traces a `.py` script, used to stop with `trace did not finish: … (exit null)` when Python was not installed. It now says which script it could not trace and the `"python"` value in `loopfinder/config.json`, and asks you to install Python 3 or set that value to an interpreter (for example `py` or a full path). The Windows `python` that only opens the Microsoft Store (exit 9009) counts as missing too. ([#5](https://github.com/MotimotiNotch/loopfinder/issues/5))
- **A failed run no longer shows the previous result.** When tracing failed, the record from the last successful run could be read as this run's result. It is no longer reused.

Python が起動できないとき、`loopfinder/config.json` の `"python"` の値と直し方を出して止まるようにしました（Microsoft Store を開くだけの Windows の `python` も含む）。失敗した回に、前回の記録を今回の結果として使わないようにしました。

## 0.1.0 (2026-10-07)

- First release on the Visual Studio Marketplace and Open VSX: set up a workspace, copy the request for your AI agent, build the graph, and show the loops, without installing Node.

最初の公開。
