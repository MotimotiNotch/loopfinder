// Turns paths (from traces) and references (from declarations) into graph nodes.
//
// One rule keeps traces and declarations on the same node: a file under the
// workspace root always gets its root-relative path as id, however it was
// reached. (`script:<name>` in a declaration is only a shorthand that is
// resolved to that path.)
'use strict';
const fs = require('fs');
const path = require('path');

const SCRIPT_EXT = /\.(py|js|mjs|cjs|ts)$/;
// File names that say nothing on their own; the parent folder is added to the label.
const GENERIC_NAMES = new Set(['SKILL.md', 'README.md', 'index.md', 'index.js', 'main.py', '__init__.py']);
const SCAN_ID = 'scan:workspace';

const isAbsolute = p => /^[A-Za-z]:\//.test(p) || p.startsWith('/');

function makeNodes(config) {
  const root = config.root.replace(/\/$/, '');
  const home = config.home.replace(/\/$/, '');
  const repos = config.repos ? config.repos.replace(/\/$/, '') : null;

  const fold = s => config.placeholders.reduce((acc, p) => acc.replace(p.re, p.name), s);

  function labelOf(rel) {
    const parts = rel.split('/').filter(Boolean);
    const last = parts[parts.length - 1] || rel;
    if (GENERIC_NAMES.has(last) && parts.length > 1) return `${parts[parts.length - 2]}/${last}`;
    return last + (rel.endsWith('/') ? '/' : '');
  }

  // A file or folder under the root.
  function fileNode(rel) {
    const id = fold(rel.replace(/^\.\//, ''));
    return { id, kind: SCRIPT_EXT.test(id) ? 'script' : 'file', label: labelOf(id), path: id };
  }

  function homeNode(rel) {
    const id = `~/${rel}`;
    return { id, kind: 'file', label: id, path: id };
  }

  function scanNode() {
    return { id: SCAN_ID, kind: 'file', label: 'workspace (scan)', path: '(many files read together)' };
  }

  function webNode(url) {
    for (const w of config.webLabels) {
      if (w.re.test(url)) return { id: `web:${w.label}`, kind: 'web', label: w.label, url };
    }
    let host = url;
    try { host = new URL(url).host; } catch { /* tcp://host:port and the like */ }
    host = host.replace(/^tcp:\/\//, '');
    return { id: `web:${host}`, kind: 'web', label: host, url };
  }

  // From an absolute path seen in a trace.
  function nodeFromPath(abs) {
    const p = String(abs).replace(/\\/g, '/');
    if (p === root || p.startsWith(`${root}/`)) return fileNode(p.slice(root.length + 1) || '.');
    if (repos && p.startsWith(`${repos}/`)) {
      const [repo, ...rest] = p.slice(repos.length + 1).split('/');
      return { id: `repo:${repo}`, kind: 'repo', label: repo, file: rest.join('/') };
    }
    if (p.startsWith(`${home}/`)) {
      // Data outside the workspace is folded to two levels under home (~/.app/cache/).
      const parts = p.slice(home.length + 1).split('/');
      return homeNode(parts.slice(0, 2).join('/') + (parts.length > 2 ? '/' : ''));
    }
    const id = fold(p);
    return { id: `file:${id}`, kind: 'file', label: path.basename(id) || id, path: id };
  }

  // From a reference written in a ```flow block.
  function nodeFromRef(ref) {
    if (ref.startsWith('group:')) return { id: ref, kind: 'group', label: ref.slice(6) };
    if (ref === SCAN_ID || ref === 'scan:') return scanNode();
    if (ref.startsWith('~/')) return homeNode(ref.slice(2));
    const step = /^\[([^\]]+)\]\s*(.+)$/.exec(ref);
    if (step) return { id: `step:${step[2]}`, kind: 'step', label: step[2], actor: step[1], actorKind: actorKind(step[1]) };
    if (ref.startsWith('script:')) {
      const name = ref.slice(7);
      const dir = config.scriptDirs.find(d => fs.existsSync(path.join(root, d, name))) || config.scriptDirs[0] || '.';
      return fileNode(`${dir}/${name}`);
    }
    if (ref.startsWith('web:')) return { id: ref, kind: 'web', label: ref.slice(4) };
    if (ref.startsWith('repo:')) {
      const [repo, ...rest] = ref.slice(5).split('/');
      const inner = rest.join('/');
      const at = repos ? `${repos}/${repo}/${inner}` : inner;
      if (inner && SCRIPT_EXT.test(inner)) return { id: ref, kind: 'script', label: labelOf(inner), path: at };
      // Data inside a repository is named by its path, or nodes/, goals/ and docs/ would all read "repo".
      if (inner) return { id: ref, kind: 'file', label: `${repo}/${inner}`, path: at };
      return { id: ref, kind: 'repo', label: repo };
    }
    if (isAbsolute(ref)) return nodeFromPath(ref);
    return fileNode(ref);
  }

  // Who wrote or read, from the absolute path a trace reports.
  function authorNode(abs) {
    return nodeFromPath(abs);
  }

  function actorKind(actor) {
    const a = String(actor).toLowerCase();
    const hit = list => (list || []).some(x => a.includes(String(x).toLowerCase()));
    if (hit(config.actors.human)) return 'human';
    if (hit(config.actors.ai)) return 'ai';
    return 'other';
  }

  return { fileNode, homeNode, scanNode, webNode, nodeFromPath, nodeFromRef, authorNode, actorKind, fold, SCAN_ID };
}

module.exports = { makeNodes, SCAN_ID };
