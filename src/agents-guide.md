# Surveying this workspace for loopfinder

You are an AI agent, and the user asked you to survey this workspace for loopfinder. Your job is to
find how data flows here — the scripts that run, the notes they read and write, the steps the user
and AI assistants take by hand — and write it to `loopfinder/flows.json`. loopfinder then runs the
scripts you list with writes blocked, records what they actually touch, adds the steps you
declared, and draws every loop, including the ones nobody declared.

The format is easy to learn from the example at the end. The rest of this file is what you cannot
learn by looking at the files: the judgement calls.

The workspace may have its own `AGENTS.md`, `CLAUDE.md` or similar at the root. Those are the
user's instructions for their assistants, and for this survey they are evidence: the routines they
describe are flows. This file is the only one about the survey itself.

## What you may write

- Only `loopfinder/flows.json` and `loopfinder/config.json`.
- Never the user's notes, scripts or settings. The survey reads; it does not fix. If you find
  something broken, tell the user.
- Never `.loopfinder/` (build output) or this file (it is rewritten every time loopfinder runs).

## How to survey

1. **Find what runs, and what the user does on a schedule.**
   - Schedulers: crontab, Windows Task Scheduler, launchd, systemd timers, CI workflows, editor or
     note-app plugins that run scripts (for Obsidian, `.obsidian/plugins/*/data.json`).
   - Script folders, `package.json` scripts, Makefiles.
   - Instructions for AI assistants: `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, rule and skill folders.
     A routine written there ("at the start of a session, run …", "when done, append to the daily
     note") is a flow, with the assistant as one of its steps.
   - Notes that describe a routine: an index note, a README, a "how I do X" note.
2. **One flow per routine or purpose** ("daily note", "weekly review", "publishing"). Loops are
   counted inside each flow, so one giant flow multiplies loops nobody would recognise, and many
   tiny ones hide the loops that cross steps.
3. **For each step, decide whether it is traced or declared** (next section).
4. **Write `flows.json`.** In `sources`, list every file that told you how the flow works —
   scripts, schedulers, instructions, and notes you read only as evidence — so the next survey
   knows what to read again.
5. **Have `loopfinder build` run.** Ask the user to run it, or run it yourself if they asked you to.
   Then read its output:
   - **Unnamed loop**: feedback nobody declared. Show it to the user and ask whether it is
     intended. If it is, add it to `loops` with a name the user agrees with. If it is not, that is
     a finding: report it. Do not make it disappear by editing edges.
   - **Declared but not found**: a loop you declared does not exist in the graph. Either your
     declaration is wrong or a step has changed. Read the flow's `sources` again before changing
     anything.
   - **Dead end**: a file that something writes and no flow reads. Reading by a person is not
     recorded, so ask the user whether someone reads it. If someone does, declare that reading
     step (with the user's words for it). If nobody does, that is a finding: report it (output
     nobody collects, a hand-off the other side stopped reading). Do not add a reading edge just
     to make it go away.
6. **Report in a few lines**: the flows, the loops, the unnamed loops, the dead ends, and what you
   could not determine (and why).

**When the user cannot be asked** (they told you to work alone, or are away): do not guess on their
behalf. Leave loops unnamed, leave undecided scripts out of `trace`, and end your report with the
questions you would have asked. The next survey starts from those answers.

## Traced or declared

`trace` runs the script for real. Writes are recorded and dropped; the network and subprocesses are
blocked unless the user passes `--allow-network` / `--allow-subprocess`. It is a recorder, not a
sandbox.

Trace a script only when all of these hold:

- the user runs it anyway, as part of a routine in this workspace;
- it is JavaScript (Node) or Python;
- what matters about it is which files it reads and writes;
- it does not send, post, publish, pay, delete remote data or change an account. Declare those,
  even though the network is blocked by default.

If you find a script but nothing tells you whether or how the user runs it (no scheduler, no
instructions, no note), ask. Until they answer, declare it as a node in `edges` where you know its
inputs and outputs, leave it out of `trace`, and list it in your report. Running code because it
happens to be in the folder is exactly what the first condition is there to prevent. Put it in the
flow whose files it reads or writes; only if it touches none of them, give it a flow of its own
and begin that flow's `about` with "Unconfirmed:". A flow with no `trace` is fine.

Fetching (reading from the network) is not one of the excluded effects; sending is. A script that
only downloads is traced like any other, and the network question above applies.

A script that has to fetch something before it writes anything shows little with the network
blocked. Tell the user, and let them decide on `--allow-network`; do not decide it for them.

Everything else is declared in `edges`: steps done by hand (`[me] ...`), steps done by an AI
assistant (`[AI] ...`), services (`web:...`), and scripts you chose not to trace.

- When a trace and a declared edge describe the same arrow, keep the trace and remove the edge,
  or the diagram shows two arrows.
- If a script takes a date or a file, pass one that exists (today's date, a real note).
- A trace that fails still contributes what it recorded before failing; the build prints a warning.
  Report it rather than retrying with different flags.

## Naming nodes

The text of a reference is the node's identity: write the same thing the same way every time.

| Write | For |
|---|---|
| `notes/ideas.md`, `notes/daily/` | A file or folder, relative to the workspace, with `/`. Folders end with `/`. |
| `notes/daily/{date}.md` | Dates in paths fold to `{date}`, ISO weeks to `{week}` (see `placeholders` in the config). |
| `notes/daily/{date}.md#Tasks` | One section of a note: the heading text, without the `#` marks. The flow diagram still draws the whole note as one node (traced writes are file-level too); the section only matters to section hubs, which is where `#Reading` and a traced write to the same note are reconciled heading by heading. |
| `[me] Plan the week` | A step done by hand. The actor in brackets is matched against `actors` in the config. |
| `[AI] Summarise the week` | A step done by an AI assistant. |
| `web:Feed reader` | A service. A traced fetch appears under its host (`web:example.com`) unless a `webLabels` entry in the config names it; use `webLabels` to join a traced service with the name you declared. |
| `script:sync.js` | A script, found in `scriptDirs`. A plain path works too. |
| `~/.cache/app/`, `/abs/path`, `repo:name/path` | Outside the workspace (`repo:` needs `repos` in the config). |

## Loops

- `nodes` lists nodes on the cycle. With `"contains": false` the name goes to exactly that cycle;
  with `"contains": true` it goes to every otherwise-unnamed cycle that passes through all of them.
- The name says what the loop does for the user, in the user's language: "Items already read are
  not shown again", not "fetch_feed.js ↔ seen.json".
- Name only loops the user has confirmed are intended. A comment in a script ("skip items already
  seen") is evidence to quote in your question, not a confirmation: the point is to find where what
  the code does and what the user means have drifted apart. An unnamed loop in the output is the
  useful part of the result.
- A script that reads a file and then rewrites it (a note it updates in place, a state file it
  appends to) is a real loop: its next output depends on its last one. It is often harmless, and
  sometimes it is how a script ends up promoting its own output. Describe it to the user in those
  terms and let them decide; do not drop the edge to make it go away.
- A loop through a folded node (`notes/daily/{date}.md`) can join two different days, or two
  different sections of the same note: "Reading -> you -> Tasks" in one note, or "this week's
  summary -> Monday's tasks -> next week's summary". Both are real at the level loopfinder draws,
  but say which one it is when you ask; the user cannot tell from the node name.

## Surveying again

When the user asks for another survey:

- Start from each flow's `sources`; update the flows whose sources changed.
- Keep the names the user confirmed. Do not delete a flow without telling the user.
- Add new routines as new flows.

## flows.json

```json
{
  "flows": [
    {
      "name": "reading",
      "about": "A script collects new items into the daily note; I pick what to try.",
      "sources": ["scripts/fetch_feed.js", "notes/README.md"],
      "trace": ["scripts/fetch_feed.js 2026-10-02"],
      "start": ["web:example.com"],
      "edges": [
        "notes/daily/{date}.md#Reading -> [me] Read and pick something to try",
        "[me] Read and pick something to try -> notes/daily/{date}.md#Tasks"
      ],
      "groups": [
        { "name": "Feed state", "nodes": ["scripts/seen.json", "scripts/feeds.json"] }
      ],
      "loops": [
        { "name": "Items already read are not shown again", "nodes": ["scripts/fetch_feed.js", "scripts/seen.json"] },
        { "name": "Reading becomes tasks", "nodes": ["notes/daily/{date}.md", "[me] Read and pick something to try"], "contains": true }
      ]
    }
  ]
}
```

| Key | |
|---|---|
| `name` | Short id: letters, digits, `-`, `_`, `.`. |
| `about` | One line, in the user's language: what this flow is for. |
| `sources` | Files you read to learn the flow. |
| `trace` | Command lines (script, then arguments) to run under the trace hook. |
| `start` | Optional. Where the routine begins (what triggers it), so the diagram is read from there. |
| `edges` | `A -> B -> C`: data flows from A to B, then to C. |
| `groups` | Optional. Draw two or more related nodes inside one frame (a script's state files, say). |
| `loops` | Names for loops the user confirmed. |

## config.json

You may set `scriptDirs`, `actors`, `webLabels`, `placeholders`, `repos` and `scanThreshold` when the
workspace needs them. Leave `output` and `cache` alone.

`hubs` and `checks` are the user's choices: keep the entries that are there, and ask before adding
one. A hub is an extra view, not a flow: it puts one thing in the middle (a daily note, by its
headings) and gathers from every flow what writes to it and what reads it. It shows up in the viewer
next to the flows but is not counted among them in the build summary.
