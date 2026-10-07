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
const configOf = folder => path.join(folder, 'loopfinder', 'config.json');

let output;
let viewer = null; // { panel, folder, config, watcher }

// The workspace folder to work on. Folders without loopfinder/ are left out unless setting one up.
async function pickFolder(needConfig) {
  const folders = (vscode.workspace.workspaceFolders || []).filter(f => f.uri.scheme === 'file');
  const candidates = needConfig ? folders.filter(f => fs.existsSync(configOf(f.uri.fsPath))) : folders;
  if (!candidates.length) {
    if (!folders.length) vscode.window.showWarningMessage('loopfinder: open a folder first.');
    else {
      const init = 'Set up';
      const choice = await vscode.window.showWarningMessage('loopfinder: no loopfinder/config.json in this workspace.', ...(vscode.workspace.isTrusted ? [init] : []));
      if (choice === init) vscode.commands.executeCommand('loopfinder.init');
    }
    return null;
  }
  if (candidates.length === 1) return candidates[0].uri.fsPath;
  const pick = await vscode.window.showQuickPick(candidates.map(f => ({ label: f.name, description: f.uri.fsPath })), { placeHolder: 'Which folder?' });
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
  vscode.window.showWarningMessage('loopfinder: trust this workspace first. Building runs its scripts.');
  return false;
}

async function cmdInit() {
  if (!trusted()) return;
  const folder = await pickFolder(false);
  if (!folder) return;
  const code = await runCli(folder, ['init']);
  if (code !== 0) { showFailure('init'); return; }
  const copy = 'Copy the request';
  const choice = await vscode.window.showInformationMessage(
    `loopfinder: set up. Next, ask your AI agent: "${PROMPT}" It writes loopfinder/flows.json; then build.`, copy);
  if (choice === copy) cmdCopyPrompt();
}

function cmdCopyPrompt() {
  vscode.env.clipboard.writeText(PROMPT);
  vscode.window.setStatusBarMessage('loopfinder: copied the request for your AI agent', 4000);
}

async function cmdBuild() {
  if (!trusted()) return;
  const folder = await pickFolder(true);
  if (!folder) return;
  const settings = vscode.workspace.getConfiguration('loopfinder', vscode.Uri.file(folder));
  const args = ['build', '--config', configOf(folder), '--budget', String(settings.get('layoutBudget', 15))];
  if (settings.get('allowNetwork')) args.push('--allow-network');
  if (settings.get('allowSubprocess')) args.push('--allow-subprocess');
  const code = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'loopfinder: tracing the scripts and building the graph', cancellable: true },
    (_, token) => runCli(folder, args, token));
  if (code !== 0) { showFailure('build'); return; }
  // An open viewer picks the new graph up through its watcher.
  if (!viewer || viewer.folder !== folder) show(folder);
}

async function showFailure(what) {
  const open = 'Show output';
  if (await vscode.window.showErrorMessage(`loopfinder: ${what} failed.`, open) === open) output.show();
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
    const build = 'Build';
    const choice = await vscode.window.showInformationMessage('loopfinder: no graph yet. Build it first.', ...(vscode.workspace.isTrusted ? [build] : []));
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
    if (graph) panel.webview.postMessage({ type: 'graph', graph });
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
  panel.onDidDispose(() => {
    watcher.dispose();
    clearTimeout(timer);
    if (viewer?.panel === panel) viewer = null;
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
  else vscode.window.showInformationMessage(`loopfinder: not a single file: ${p}`);
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
  context.subscriptions.push(
    output,
    vscode.commands.registerCommand('loopfinder.show', cmdShow),
    vscode.commands.registerCommand('loopfinder.build', cmdBuild),
    vscode.commands.registerCommand('loopfinder.init', cmdInit),
    vscode.commands.registerCommand('loopfinder.copyPrompt', cmdCopyPrompt),
    { dispose: () => viewer?.panel.dispose() },
  );
}

function deactivate() {}

module.exports = { activate, deactivate, viewerHtml, openPath };
