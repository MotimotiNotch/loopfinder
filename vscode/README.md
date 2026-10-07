# loopfinder for VS Code

[日本語](https://github.com/MotimotiNotch/loopfinder/blob/main/vscode/README.ja.md)

**Find the feedback loops in your workspace — including the ones you never meant to build.**

The [loopfinder](https://github.com/MotimotiNotch/loopfinder) CLI and viewer, inside the editor. No Node install
needed: it runs on the editor's own runtime (Python is needed only to trace `.py` scripts).

## Use

From the Command Palette:

1. **loopfinder: Set up this workspace** — makes `loopfinder/` (config.json, flows.json, AGENTS.md).
2. Ask your AI agent (Claude Code, Codex, Cursor, Copilot, ...):
   *"Read loopfinder/AGENTS.md and survey this workspace."*
   (**loopfinder: Copy the request for your AI agent** puts it on the clipboard.) It writes `loopfinder/flows.json`.
3. **loopfinder: Build the graph** — runs the traced scripts with writes blocked and draws the graph.
4. **loopfinder: Show the loops** — opens the viewer. It redraws by itself after every build, from the
   palette or from `loopfinder build` in a terminal. Click a path in the side pane to open the file.

The viewer starts in the editor's display language. Picking a language with the button at the top of the viewer wins over it.

## Safety

Building **really runs your scripts**. Writes are recorded and dropped; network and subprocesses are blocked
unless you turn on `loopfinder.allowNetwork` / `loopfinder.allowSubprocess`. It is a recorder, not a sandbox:
do not trace code you would not run.

In a workspace you have not [trusted](https://code.visualstudio.com/docs/editor/workspace-trust), set up and
build are off; you can still view a graph that is already built.

`.loopfinder/` (the build output) lists your file paths. Keep it out of version control.

## Support

[Ko-fi](https://ko-fi.com/motimotinotch) · MIT License · bundles dagre and graphlib (MIT) and Lucide icons (ISC)
