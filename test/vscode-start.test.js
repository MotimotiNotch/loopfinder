'use strict';
// The VS Code extension's "Get started" steps, with a stand-in for the vscode module.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

// A minimal vscode: only what the code under test touches. Messages are recorded, not shown.
const shown = [];
let chatModels = [];
const fake = {
  l10n: { t: (m, ...a) => m.replace(/\{(\d+)\}/g, (_, i) => a[i]) },
  workspace: { isTrusted: true, workspaceFolders: [], getConfiguration: () => ({ get: (_, d) => d }) },
  window: {
    showInformationMessage: async (m, ...buttons) => { shown.push({ m, buttons }); return undefined; },
    showWarningMessage: async () => undefined,
    setStatusBarMessage: () => {},
  },
  lm: { selectChatModels: async () => chatModels },
  Uri: { file: p => ({ fsPath: p }) },
};
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return request === 'vscode' ? 'vscode' : resolve.call(this, request, ...rest);
};
require.cache.vscode = { id: 'vscode', filename: 'vscode', loaded: true, exports: fake };
const ext = require('../vscode/extension');

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-start-'));
  return dir;
}
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const touch = (file, ms) => fs.utimesSync(file, ms / 1000, ms / 1000);

test('vscode start: the next step follows the folder, from set up to show', () => {
  const dir = workspace();
  assert.strictEqual(ext.stageOf(dir), 'setup');
  write(path.join(dir, 'loopfinder', 'config.json'), '{}\n');
  write(path.join(dir, 'loopfinder', 'flows.json'), '{ "flows": [] }\n');
  // init writes an empty list: the agent has not written anything yet
  assert.strictEqual(ext.stageOf(dir), 'ask');
  write(path.join(dir, 'loopfinder', 'flows.json'), '{ "flows": [{ "name": "a" }, { "name": "b" }] }\n');
  assert.strictEqual(ext.flowCount(dir), 2);
  assert.strictEqual(ext.stageOf(dir), 'build');
  const graph = path.join(dir, '.loopfinder', 'flow.json'); // the default output (src/config.js)
  write(graph, '{}\n');
  const now = Date.now();
  touch(path.join(dir, 'loopfinder', 'flows.json'), now - 60000);
  touch(graph, now);
  assert.strictEqual(ext.stageOf(dir), 'show');
  // the agent rewrites the flows after a build: build again
  touch(path.join(dir, 'loopfinder', 'flows.json'), now + 60000);
  assert.strictEqual(ext.stageOf(dir), 'build');
});

test('vscode start: a half-written flows.json counts as no flows', () => {
  const dir = workspace();
  write(path.join(dir, 'loopfinder', 'config.json'), '{}\n');
  write(path.join(dir, 'loopfinder', 'flows.json'), '{ "flows": [{ "name": ');
  assert.strictEqual(ext.flowCount(dir), 0);
  assert.strictEqual(ext.stageOf(dir), 'ask');
});

test('vscode start: offers only the agents this editor can reach, last pick first', async () => {
  const state = new Map();
  const get = { get: k => state.get(k) };
  chatModels = [];
  const saved = process.env.PATH;
  process.env.PATH = '';
  try {
    let ids = (await ext.agentChoices(get)).map(i => i.id);
    assert.deepStrictEqual(ids, ['copy', 'manual']);
    // a chat model and a claude on PATH both show up
    chatModels = [{ id: 'm' }];
    const bin = workspace();
    write(path.join(bin, process.platform === 'win32' ? 'claude.cmd' : 'claude'), '');
    process.env.PATH = bin;
    ids = (await ext.agentChoices(get)).map(i => i.id);
    assert.deepStrictEqual(ids, ['chat', 'claude', 'copy', 'manual']);
    state.set('loopfinder.agent', 'claude');
    ids = (await ext.agentChoices(get)).map(i => i.id);
    assert.deepStrictEqual(ids, ['claude', 'chat', 'copy', 'manual']);
  } finally {
    process.env.PATH = saved;
    chatModels = [];
  }
});

test('vscode start: several saves of the flows make one offer to build, and none before there are flows', async () => {
  const dir = workspace();
  const flows = path.join(dir, 'loopfinder', 'flows.json');
  write(path.join(dir, 'loopfinder', 'config.json'), '{}\n');
  write(flows, '{ "flows": [] }\n');
  shown.length = 0;
  ext.onFlowsWritten({ fsPath: flows });
  await new Promise(r => setTimeout(r, 1700));
  assert.strictEqual(shown.length, 0, 'an empty list is not an offer');
  // the agent saves three times in a row
  for (let i = 1; i <= 3; i++) {
    write(flows, JSON.stringify({ flows: Array.from({ length: i }, (_, k) => ({ name: `f${k}` })) }));
    ext.onFlowsWritten({ fsPath: flows });
    await new Promise(r => setTimeout(r, 200));
  }
  await new Promise(r => setTimeout(r, 1700));
  assert.strictEqual(shown.length, 1);
  assert.match(shown[0].m, /\(3\)/);
  assert.deepStrictEqual(shown[0].buttons, ['Build and show']);
});

test('vscode start: in an untrusted workspace the offer has no build button', async () => {
  const dir = workspace();
  const flows = path.join(dir, 'loopfinder', 'flows.json');
  write(path.join(dir, 'loopfinder', 'config.json'), '{}\n');
  write(flows, '{ "flows": [{ "name": "a" }] }\n');
  shown.length = 0;
  fake.workspace.isTrusted = false;
  try {
    ext.onFlowsWritten({ fsPath: flows });
    await new Promise(r => setTimeout(r, 1700));
    assert.strictEqual(shown.length, 1);
    assert.deepStrictEqual(shown[0].buttons, []);
    assert.match(shown[0].m, /Trust this workspace/);
  } finally {
    fake.workspace.isTrusted = true;
  }
});
