// Loads loopfinder/config.json and fills in defaults.
// Everything loopfinder keeps in a workspace is in one folder, `loopfinder/`: config.json, flows.json
// (written by an AI agent) and AGENTS.md (written by loopfinder). Paths in the config are relative to
// the workspace, the folder that holds `loopfinder/`. A config file elsewhere is read relative to its own folder.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULTS = {
  // The workspace being drawn. Files under it get ids relative to it.
  root: '.',
  // Folders searched for the `script:<name>` shorthand in declarations.
  scriptDirs: ['scripts'],
  // Files outside the root but under home are folded to two levels (~/.cache/app/).
  home: null,
  // Optional folder that holds your repositories, so `repo:<name>` can be drawn.
  repos: null,
  // The flows an AI agent wrote after surveying the workspace (see AGENTS.md).
  flows: 'loopfinder/flows.json',
  // Optional: also read ```flow blocks from these files (globs, relative to root).
  declarations: [],
  // Folders never walked while expanding declaration globs.
  ignore: ['.git', 'node_modules', '.obsidian', '.trash', '.loopfinder', 'loopfinder'],
  // Where the graph and the trace cache are written. They list your file paths: keep them out of version control.
  output: '.loopfinder/flow.json',
  cache: '.loopfinder/traces',
  // Parts of a path that change every run are folded into one node ({date}, {week}).
  placeholders: [
    { pattern: '\\d{4}-\\d{2}-\\d{2}', name: '{date}' },
    { pattern: '\\d{4}-W\\d{2}', name: '{week}' },
  ],
  // Display names for URLs that the host alone does not explain.
  webLabels: [],
  // Who does a hand-declared step. Drawn as filled (human), hollow (ai) or dashed (other).
  actors: { human: ['me'], ai: ['AI'] },
  // A script that reads more files than this (and only reads them) is folded into one "scan" node.
  scanThreshold: 12,
  python: 'python',
  // Hub views: one thing in the middle, writers on the left, readers on the right.
  hubs: [],
  // Extra checks run after a build (modules exporting `(ctx) => ({ title, warnings })`).
  checks: [],
  // UI language when the viewer has not chosen one ('en' or 'ja').
  lang: 'en',
};

function toSlash(p) {
  return String(p).replace(/\\/g, '/');
}

function loadConfig(file) {
  const configPath = path.resolve(file || path.join('loopfinder', 'config.json'));
  const raw = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
  const dir = path.dirname(configPath);
  const base = path.basename(dir) === 'loopfinder' ? path.dirname(dir) : dir;
  const c = { ...DEFAULTS, ...raw, actors: { ...DEFAULTS.actors, ...(raw.actors || {}) } };
  const abs = p => toSlash(path.resolve(base, p));
  c.configPath = toSlash(configPath);
  c.workspace = toSlash(base);
  c.flowsFile = abs(c.flows);
  c.root = abs(c.root);
  c.home = toSlash(c.home ? path.resolve(base, c.home) : os.homedir());
  c.repos = c.repos ? abs(c.repos) : null;
  c.output = abs(c.output);
  c.cache = abs(c.cache);
  c.checks = c.checks.map(abs);
  c.placeholders = c.placeholders.map(p => ({ re: new RegExp(p.pattern, 'g'), name: p.name }));
  c.webLabels = c.webLabels.map(w => ({ re: new RegExp(w.match), label: w.label }));
  return c;
}

module.exports = { loadConfig, toSlash, DEFAULTS };
