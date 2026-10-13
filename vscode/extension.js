// loopfinder inside VS Code: the same CLI and the same viewer, with the viewer in a webview.
// Init and build run the CLI as a child process (build really runs the workspace's scripts, so both are
// off in an untrusted workspace). Show only reads the built graph, and works anywhere.
'use strict';
const vscode = require('vscode');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fork } = require('child_process');

// The packaged extension carries a copy of the CLI in core/ (scripts/prepare.js).
// Run from the repository (Extension Development Host), it uses the repository itself.
const CORE = fs.existsSync(path.join(__dirname, 'core', 'bin')) ? path.join(__dirname, 'core') : path.join(__dirname, '..');
const CLI = path.join(CORE, 'bin', 'loopfinder.js');
const PUBLIC = path.join(CORE, 'public');
const { loadConfig } = require(path.join(CORE, 'src', 'config'));

const PROMPT = 'Read loopfinder/AGENTS.md and survey this workspace.';
// Messages go through vscode.l10n (l10n/bundle.l10n.ja.json); the menus through package.nls.*.json.
const t = (message, ...args) => vscode.l10n.t(message, ...args);
const configOf = folder => path.join(folder, 'loopfinder', 'config.json');

let output;
let viewer = null; // { panel, folder, config, watcher }

// The workspace folder to work on. Folders without loopfinder/ are left out unless setting one up.
async function pickFolder(needConfig) {
  const folders = (vscode.workspace.workspaceFolders || []).filter(f => f.uri.scheme === 'file');
  const candidates = needConfig ? folders.filter(f => fs.existsSync(configOf(f.uri.fsPath))) : folders;
  if (!candidates.length) {
    if (!folders.length) vscode.window.showWarningMessage(t('loopfinder: open a folder first.'));
    else {
      const init = t('Set up');
      const choice = await vscode.window.showWarningMessage(t('loopfinder: no loopfinder/config.json in this workspace.'), ...(vscode.workspace.isTrusted ? [init] : []));
      if (choice === init) vscode.commands.executeCommand('loopfinder.init');
    }
    return null;
  }
  if (candidates.length === 1) return candidates[0].uri.fsPath;
  const pick = await vscode.window.showQuickPick(candidates.map(f => ({ label: f.name, description: f.uri.fsPath })), { placeHolder: t('Which folder?') });
  return pick ? pick.description : null;
}

// Runs the CLI with the editor's own Node (ELECTRON_RUN_AS_NODE), so no Node install is needed.
// The traced scripts inherit it the same way.
function runCli(folder, args, token) {
  return new Promise(resolve => {
    output.appendLine(`> loopfinder ${args.join(' ')}  (${folder})`);
    const child = fork(CLI, args, { cwd: folder, silent: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    child.stdout.on('data', d => output.append(d.toString()));
    child.stderr.on('data', d => output.append(d.toString()));
    const cancel = token?.onCancellationRequested(() => child.kill());
    child.on('error', e => { output.appendLine(e.message); });
    child.on('close', code => { cancel?.dispose(); output.appendLine(`(exit ${code})`); resolve(code); });
  });
}

// `enablement` only greys out the menus; a command run from code still arrives here.
function trusted() {
  if (vscode.workspace.isTrusted) return true;
  offerTrust(t('loopfinder: trust this workspace first. Building runs its scripts.'));
  return false;
}

// Trust is VS Code's own screen; the button only opens it, the choice stays there.
async function offerTrust(message) {
  const manage = t('Manage Workspace Trust');
  if (await vscode.window.showWarningMessage(message, manage) === manage) {
    await vscode.commands.executeCommand('workbench.trust.manage');
  }
}

async function cmdInit() {
  if (!trusted()) return;
  const folder = await pickFolder(false);
  if (!folder) return;
  const code = await runCli(folder, ['init']);
  if (code !== 0) { showFailure(t('loopfinder: init failed.')); return; }
  refreshStatus();
  const copy = t('Copy the request');
  const choice = await vscode.window.showInformationMessage(
    t('loopfinder: set up. Next, ask your AI agent: "{0}" It writes loopfinder/flows.json; then build.', PROMPT), copy);
  if (choice === copy) cmdCopyPrompt();
}

function cmdCopyPrompt() {
  vscode.env.clipboard.writeText(PROMPT);
  vscode.window.setStatusBarMessage(t('loopfinder: copied the request for your AI agent'), 4000);
}

async function cmdBuild() {
  if (!trusted()) return;
  const folder = await pickFolder(true);
  if (folder) buildFolder(folder);
}

async function buildFolder(folder) {
  if (!trusted()) return;
  const settings = vscode.workspace.getConfiguration('loopfinder', vscode.Uri.file(folder));
  const args = ['build', '--config', configOf(folder), '--budget', String(settings.get('layoutBudget', 15))];
  if (settings.get('allowNetwork')) args.push('--allow-network');
  if (settings.get('allowSubprocess')) args.push('--allow-subprocess');
  const code = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: t('loopfinder: tracing the scripts and building the graph'), cancellable: true },
    (_, token) => runCli(folder, args, token));
  refreshStatus();
  if (code !== 0) { showFailure(t('loopfinder: build failed.')); return; }
  // An open viewer picks the new graph up through its watcher.
  if (!viewer || viewer.folder !== folder) show(folder);
}

// --- Getting started: one command to the request, then one click once the agent has written the flows ---
// loopfinder has no AI of its own. "Get started" takes a folder to its next step: set up, hand the request
// to whichever agent the person uses, build, or show. Building still waits for a click, because it really
// runs the workspace's scripts.

const flowsOf = folder => path.join(folder, 'loopfinder', 'flows.json');
const mtimeOf = file => { try { return fs.statSync(file).mtimeMs; } catch { return 0; } };

function flowCount(folder) {
  try {
    const data = JSON.parse(fs.readFileSync(flowsOf(folder), 'utf8'));
    return Array.isArray(data.flows) ? data.flows.length : 0;
  } catch { return 0; }
}

// setup: no loopfinder/ / ask: no flows yet / build: the flows are newer than the graph / show: up to date
function stageOf(folder) {
  if (!fs.existsSync(configOf(folder))) return 'setup';
  if (flowCount(folder) === 0) return 'ask';
  let graph;
  try { graph = loadConfig(configOf(folder)).output; } catch { return 'build'; }
  return mtimeOf(graph) >= mtimeOf(flowsOf(folder)) ? 'show' : 'build';
}

function onPath(name) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (dir && exts.some(ext => fs.existsSync(path.join(dir, name + ext)))) return true;
  }
  return false;
}

// The agents this editor can reach, the one picked last time first.
async function agentChoices(state) {
  const items = [];
  let chat = false;
  try { chat = ((await vscode.lm?.selectChatModels?.()) || []).length > 0; } catch { /* no chat models */ }
  if (chat) items.push({ id: 'chat', label: t('VS Code chat (agent mode)'), detail: t('Opens the chat with the request filled in. Send it to start.') });
  if (onPath('claude')) items.push({ id: 'claude', label: t('Claude Code in a terminal'), detail: t('Starts claude in a new terminal with the request.') });
  items.push({ id: 'copy', label: t('Another AI agent'), detail: t('Copies the request. Paste it to your agent.') });
  items.push({ id: 'manual', label: t('No AI: write the flows yourself'), detail: t('Opens loopfinder/flows.json next to the guide (loopfinder/AGENTS.md).') });
  const last = state.get('loopfinder.agent');
  return items.sort((a, b) => (b.id === last) - (a.id === last));
}

async function askAgent(folder, state) {
  const pick = await vscode.window.showQuickPick(await agentChoices(state), {
    placeHolder: t('Who surveys this workspace and writes the flows?'),
  });
  if (!pick) return;
  state.update('loopfinder.agent', pick.id);
  const after = t('loopfinder: when loopfinder/flows.json has flows, loopfinder offers to build. Nothing runs before you click.');
  if (pick.id === 'chat') {
    try {
      await vscode.commands.executeCommand('workbench.action.chat.open', { query: PROMPT, isPartialQuery: true, mode: 'agent' });
      vscode.window.showInformationMessage(after);
      return;
    } catch { /* an older editor, or chat turned off: fall back to the clipboard */ }
  }
  if (pick.id === 'claude') {
    const term = vscode.window.createTerminal({ name: 'loopfinder: Claude Code', cwd: folder });
    term.show();
    term.sendText(`claude "${PROMPT}"`);
    vscode.window.showInformationMessage(after);
    return;
  }
  if (pick.id === 'manual') {
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path.join(folder, 'loopfinder', 'AGENTS.md')), { viewColumn: vscode.ViewColumn.Beside, preview: true });
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(flowsOf(folder)), { viewColumn: vscode.ViewColumn.Active });
    return;
  }
  vscode.env.clipboard.writeText(PROMPT);
  vscode.window.showInformationMessage(t('loopfinder: copied the request: "{0}" Paste it to your AI agent.', PROMPT) + ' ' + after);
}

async function cmdStart(state) {
  const folder = await pickFolder(false);
  if (!folder) return;
  let stage = stageOf(folder);
  if (stage === 'setup') {
    if (!trusted()) return;
    if (await runCli(folder, ['init']) !== 0) { showFailure(t('loopfinder: init failed.')); return; }
    refreshStatus();
    stage = 'ask';
  }
  if (stage === 'ask') return askAgent(folder, state);
  if (stage === 'build') return buildFolder(folder);
  return show(folder);
}

// The agent writes loopfinder/flows.json, often in several saves. Once it settles with flows in it,
// offer the build once. A save while the offer is still up is folded into it.
const offering = new Set();
const settleTimers = new Map();

function onFlowsWritten(uri) {
  const folder = path.dirname(path.dirname(uri.fsPath));
  clearTimeout(settleTimers.get(folder));
  settleTimers.set(folder, setTimeout(async () => {
    refreshStatus();
    if (offering.has(folder) || stageOf(folder) !== 'build') return;
    offering.add(folder);
    try {
      const build = t('Build and show');
      if (!vscode.workspace.isTrusted) {
        await offerTrust(t('loopfinder: the flows were written ({0}). Trust this workspace to build the graph.', flowCount(folder)));
        return;
      }
      // The toast folds away after a few seconds and the agent may take minutes, so the status bar
      // keeps saying "build" (see refreshStatus) until the graph is newer than flows.json.
      const message = t('loopfinder: the flows were written ({0}). Build the graph and show it? Building runs the traced scripts.', flowCount(folder));
      const choice = await vscode.window.showInformationMessage(message, build);
      if (choice === build) await buildFolder(folder);
    } finally {
      offering.delete(folder);
    }
  }, 1500));
}

// The status bar shows the next step for the first folder that has loopfinder/, and takes it on click.
let status;
function refreshStatus() {
  if (!status) return;
  const folders = (vscode.workspace.workspaceFolders || []).filter(f => f.uri.scheme === 'file').map(f => f.uri.fsPath);
  const folder = viewer?.folder || folders.find(f => fs.existsSync(configOf(f)));
  if (!folder) { status.hide(); return; }
  const stage = stageOf(folder);
  const look = {
    ask: ['$(sparkle) loopfinder', t('loopfinder: ask your AI agent to write the flows')],
    // Spelled out, not just the icon: the offer toast folds away, this stays until the graph is built
    build: [`$(play) loopfinder: ${t('Build the graph')}`, t('loopfinder: the flows changed. Build the graph')],
    show: ['$(type-hierarchy) loopfinder', t('loopfinder: show the loops')],
  }[stage] || ['$(type-hierarchy) loopfinder', t('loopfinder: set up this workspace')];
  status.text = look[0];
  status.tooltip = look[1];
  status.show();
}

async function showFailure(message) {
  const open = t('Show output');
  if (await vscode.window.showErrorMessage(message, open) === open) output.show();
}

async function cmdShow() {
  const folder = await pickFolder(true);
  if (folder) show(folder);
}

function readGraph(config) {
  try { return JSON.parse(fs.readFileSync(config.output, 'utf8')); } catch { return null; }
}

async function show(folder) {
  const config = loadConfig(configOf(folder));
  if (!fs.existsSync(config.output)) {
    const build = t('Build');
    const choice = await vscode.window.showInformationMessage(t('loopfinder: no graph yet. Build it first.'), ...(vscode.workspace.isTrusted ? [build] : []));
    if (choice === build) cmdBuild();
    return;
  }
  if (viewer && viewer.folder === folder) { viewer.panel.reveal(); return; }
  viewer?.panel.dispose();

  const panel = vscode.window.createWebviewPanel('loopfinder', `loopfinder: ${path.basename(folder)}`, vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [vscode.Uri.file(PUBLIC), vscode.Uri.file(path.join(__dirname, 'media'))],
  });
  panel.webview.html = viewerHtml(panel.webview);
  const send = () => {
    const graph = readGraph(config);
    // A half-written file fails to parse; the watcher fires again when the write finishes.
    // The editor's display language is the viewer's default language (a choice made in the viewer wins).
    if (graph) panel.webview.postMessage({ type: 'graph', graph, lang: vscode.env.language });
  };
  panel.webview.onDidReceiveMessage(m => {
    if (m?.type === 'ready') send();
    else if (m?.type === 'open' && typeof m.path === 'string') openPath(config, m.path);
  });

  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(path.dirname(config.output)), path.basename(config.output)));
  let timer;
  const later = () => { clearTimeout(timer); timer = setTimeout(send, 300); };
  watcher.onDidChange(later);
  watcher.onDidCreate(later);

  viewer = { panel, folder, config, watcher };
  refreshStatus();
  panel.onDidDispose(() => {
    watcher.dispose();
    clearTimeout(timer);
    if (viewer?.panel === panel) viewer = null;
    refreshStatus();
  });
}

// Opens a node's path in the editor. Paths in the graph are relative to the root, or start with ~/.
// Folded names ({date}, the scan node) are not one file and are said so.
function openPath(config, p) {
  const file = p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : path.resolve(config.root, p);
  let stat = null;
  try { stat = fs.statSync(file); } catch { /* not there */ }
  if (stat?.isFile()) vscode.commands.executeCommand('vscode.open', vscode.Uri.file(file), { preview: true, viewColumn: vscode.ViewColumn.Beside });
  else if (stat?.isDirectory()) vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(file));
  else vscode.window.showInformationMessage(t('loopfinder: not a single file: {0}', p));
}

// The viewer's own index.html, with its files served through the webview and a CSP that allows only them.
function viewerHtml(webview) {
  const nonce = crypto.randomBytes(16).toString('base64');
  const uri = (...parts) => webview.asWebviewUri(vscode.Uri.file(path.join(...parts))).toString();
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource}`,
    `img-src ${webview.cspSource} data:`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');
  return fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8')
    .replace(/(href|src)="(?!https?:|#)([^"]+)"/g, (_, attr, file) => `${attr}="${uri(PUBLIC, file)}"`)
    .replace(/<script /g, `<script nonce="${nonce}" `)
    .replace('<meta charset="utf-8">', `<meta charset="utf-8">\n  <meta http-equiv="Content-Security-Policy" content="${csp}">`)
    // The host goes first: app.js looks for it when it starts.
    .replace(/<script /, `<script nonce="${nonce}" src="${uri(__dirname, 'media', 'host.js')}"></script>\n  <script `);
}

function activate(context) {
  output = vscode.window.createOutputChannel('loopfinder');
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  status.command = 'loopfinder.start';
  const flowsWatcher = vscode.workspace.createFileSystemWatcher('**/loopfinder/flows.json');
  flowsWatcher.onDidCreate(onFlowsWritten);
  flowsWatcher.onDidChange(onFlowsWritten);
  const configWatcher = vscode.workspace.createFileSystemWatcher('**/loopfinder/config.json');
  configWatcher.onDidCreate(refreshStatus);
  configWatcher.onDidDelete(refreshStatus);
  context.subscriptions.push(
    output,
    status,
    flowsWatcher,
    configWatcher,
    vscode.workspace.onDidChangeWorkspaceFolders(refreshStatus),
    vscode.workspace.onDidGrantWorkspaceTrust(refreshStatus),
    vscode.commands.registerCommand('loopfinder.start', () => cmdStart(context.workspaceState)),
    vscode.commands.registerCommand('loopfinder.show', cmdShow),
    vscode.commands.registerCommand('loopfinder.build', cmdBuild),
    vscode.commands.registerCommand('loopfinder.init', cmdInit),
    vscode.commands.registerCommand('loopfinder.copyPrompt', cmdCopyPrompt),
    { dispose: () => viewer?.panel.dispose() },
    { dispose: () => settleTimers.forEach(clearTimeout) },
  );
  refreshStatus();
}

function deactivate() {}

module.exports = { activate, deactivate, viewerHtml, openPath, stageOf, flowCount, onPath, agentChoices, onFlowsWritten };
