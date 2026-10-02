// Hub views: one kind of thing in the middle, what writes to it on the left, what reads it on the right,
// gathered across every flow. Two kinds:
//
//   { "type": "sections", "name": "Daily note", "note": "notes/daily/{date}.md", "dir": "notes/daily", "level": 2 }
//     The headings of a note are the middle. Which heading a step touches is taken from the most
//     reliable source first: a recorded write (the trace hook diffs the blocked write by heading),
//     then a declaration (`note.md#Heading`), then a guess (the heading text appears in the script's code).
//
//   { "type": "match", "name": "Content", "match": "^web:store\\((.+)\\)$", "flows": ["content"] }
//     Nodes whose id matches the pattern are the middle (the first capture group is the label).
//
// Evidence is stored as codes ('trace' | 'declared' | 'guess' | 'unknown'); the UI words it.
'use strict';
const fs = require('fs');
const path = require('path');

const PICTO = /[\p{Extended_Pictographic}️]/gu;
const RANK = { trace: 0, declared: 1, guess: 2, unknown: 3 };

function makeHubBuilder(hub) {
  const out = { name: hub.name, nodes: [], edges: [], loops: [] };
  const hubNodes = new Map();
  const edges = new Map();
  const node = (id, base) => {
    if (!hubNodes.has(id)) hubNodes.set(id, { ...base, id, flows: [hub.name], evidence: [] });
    return hubNodes.get(id);
  };
  const edge = (from, to, kind, how) => {
    const key = `${from}\u0000${to}`;
    const cur = edges.get(key);
    if (!cur || RANK[how] < RANK[cur.how]) edges.set(key, { from, to, kind, how, source: 'hub', flows: [hub.name], count: 1 });
  };
  const note = (n, ev) => { if (!n.evidence.some(x => JSON.stringify(x) === JSON.stringify(ev))) n.evidence.push(ev); };
  const finish = (order) => {
    out.edges = [...edges.values()];
    out.nodes = [...hubNodes.values()].map(n => ({ ...n, originIn: n.id.startsWith('w:') ? [hub.name] : [] }));
    // The side list shows the middle items; picking one lights up its writers and readers.
    for (const n of out.nodes.filter(x => x.kind === 'section').sort((a, b) => order(a) - order(b))) {
      const ins = out.edges.filter(e => e.to === n.id).map(e => e.from);
      const outs = out.edges.filter(e => e.from === n.id).map(e => e.to);
      const paths = [];
      for (const w of (ins.length ? ins : [null])) for (const r of (outs.length ? outs : [null])) paths.push([w, n.id, r].filter(Boolean));
      out.loops.push({ name: n.label, flow: hub.name, kind: 'section', paths });
    }
    return out;
  };
  return { out, node, edge, note, finish };
}

// ---- sections ----

function collectSections(config, hub) {
  const level = '#'.repeat(hub.level || 2);
  const headRe = new RegExp(`^${level} (.+?)\\s*$`, 'gm');
  const heads = new Map();
  // Headings are grouped by their leading emoji when they have one (the text after it may change).
  const keyOf = h => (/^\p{Extended_Pictographic}/u.test(h) ? [...h][0] : h);
  const add = (h, onlyKnown) => {
    const k = keyOf(h);
    if (!heads.has(k)) { if (onlyKnown) return; heads.set(k, new Set()); }
    heads.get(k).add(h);
  };
  const dir = hub.dir ? path.join(config.root, hub.dir) : null;
  if (dir && fs.existsSync(dir)) {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort().slice(-(hub.recent || 14));
    for (const f of files) for (const m of fs.readFileSync(path.join(dir, f), 'utf8').matchAll(headRe)) add(m[1], false);
  }
  if (hub.template && fs.existsSync(path.join(config.root, hub.template))) {
    for (const m of fs.readFileSync(path.join(config.root, hub.template), 'utf8').matchAll(headRe)) add(m[1], !!dir);
  }
  const sections = [...heads.entries()].map(([key, names]) => {
    const list = [...names];
    const keys = new Set();
    const core = [];
    for (const h of list) {
      keys.add(h);
      const c = h.replace(PICTO, '').trim();
      core.push(c);
      // The text without the emoji also counts as a mention, but only when it is long enough not to collide.
      if (c.length >= 6) keys.add(c);
    }
    return { id: `sec:${list[0]}`, label: list[0], key, names: list, keys: [...keys], core };
  });
  sections.push({ id: 'sec:frontmatter', label: 'frontmatter', key: 'frontmatter', names: ['frontmatter'], keys: [], core: ['frontmatter'] });
  return sections;
}

function resolveSection(sections, name) {
  const n = name.trim();
  const emoji = /^\p{Extended_Pictographic}/u.test(n) ? [...n][0] : null;
  const core = n.replace(PICTO, '').trim();
  return sections.find(s => s.names.includes(n))
    || (emoji && sections.find(s => s.key === emoji))
    || sections.find(s => s.core.includes(core));
}

function codeWithoutComments(file, text) {
  if (/\.py$/.test(file)) return text.replace(/"""[\s\S]*?"""/g, '').replace(/(^|\s)#.*$/gm, '$1');
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}

function sectionsHub(config, hub, ctx) {
  const { flows, traces, nodes, edges, n: nn } = ctx;
  const noteId = nn.fileNode(hub.note).id;
  const sections = collectSections(config, hub);
  const unknown = { id: 'sec:(unknown)', label: '(unknown)', names: [] };
  const codeCache = new Map();
  const code = rel => {
    if (!codeCache.has(rel)) {
      let t = '';
      try { t = codeWithoutComments(rel, fs.readFileSync(path.join(config.root, rel), 'utf8')); } catch { /* not readable */ }
      codeCache.set(rel, t);
    }
    return codeCache.get(rel);
  };
  const mentioned = n => (n.kind === 'script' && n.path ? sections.filter(s => s.keys.some(k => code(n.path).includes(k))) : []);
  const links = [];
  flows.forEach((flow, fi) => {
    const fe = edges.filter(e => e.flows.includes(flow.name));
    const done = new Set();
    const push = (n, dir, sec, how) => { if (n) { links.push({ n, flow: flow.name, dir, sec, how }); done.add(`${dir}\u0000${n.id}`); } };
    for (const t of traces[fi]) for (const e of t.events) {
      if (e.kind !== 'write' || !e.sections || !e.sections.length) continue;
      if (nn.nodeFromPath(e.target).id !== noteId) continue;
      const author = nodes.get(nn.authorNode(e.by).id);
      for (const name of e.sections) {
        const sec = resolveSection(sections, name);
        if (sec) push(author, 'write', sec, 'trace');
      }
    }
    for (const d of flow.sections) {
      if (d.to === noteId && d.toSec) { const sec = resolveSection(sections, d.toSec); push(nodes.get(d.from), 'write', sec || unknown, sec ? 'declared' : 'unknown'); }
      if (d.from === noteId && d.fromSec) { const sec = resolveSection(sections, d.fromSec); push(nodes.get(d.to), 'read', sec || unknown, sec ? 'declared' : 'unknown'); }
    }
    for (const e of fe) {
      const dir = e.to === noteId ? 'write' : e.from === noteId ? 'read' : null;
      if (!dir) continue;
      const n = nodes.get(dir === 'write' ? e.from : e.to);
      if (!n || done.has(`${dir}\u0000${n.id}`)) continue;
      // Hand-written steps are never guessed from: they are usually described in prose that mentions everything.
      const guess = mentioned(n);
      if (guess.length) for (const sec of guess) push(n, dir, sec, 'guess');
      else push(n, dir, unknown, 'unknown');
    }
  });
  const b = makeHubBuilder(hub);
  for (const l of links) {
    const sec = b.node(l.sec.id, { kind: 'section', label: l.sec.label, path: (l.sec.names || []).join(' / ') });
    const side = b.node(`${l.dir === 'write' ? 'w' : 'r'}:${l.flow}:${l.n.id}`,
      { kind: l.n.kind, label: l.n.label, actor: l.n.actor, actorKind: l.n.actorKind, path: l.n.path, sub: l.flow });
    b.note(sec, { flow: l.flow, node: l.n.label, dir: l.dir, how: l.how });
    b.note(side, { target: l.sec.label, dir: l.dir, how: l.how });
    const [from, to] = l.dir === 'write' ? [side.id, sec.id] : [sec.id, side.id];
    b.edge(from, to, l.how === 'guess' || l.how === 'unknown' ? 'guess' : l.dir, l.how);
  }
  const order = new Map(sections.map((s, i) => [s.id, i]));
  return b.finish(n => order.get(n.id) ?? 999);
}

// ---- match ----

function matchHub(config, hub, ctx) {
  const { nodes, edges } = ctx;
  const re = new RegExp(hub.match);
  const within = hub.flows && hub.flows.length ? f => hub.flows.includes(f) : () => true;
  const faces = new Map();
  const faceOf = id => {
    const m = re.exec(id);
    if (!m) return null;
    if (!faces.has(id)) faces.set(id, { id: `hub:${m[1] || id}`, label: m[1] || id, order: faces.size });
    return faces.get(id);
  };
  const b = makeHubBuilder(hub);
  for (const e of edges.filter(x => x.flows.some(within))) {
    const how = e.source === 'trace' ? 'trace' : 'declared';
    const ff = faceOf(e.from), ft = faceOf(e.to);
    if (!ff && !ft) continue;
    if (ff && ft) {
      if (ff === ft) continue;
      const a = b.node(ff.id, { kind: 'section', label: ff.label, path: '' });
      const c = b.node(ft.id, { kind: 'section', label: ft.label, path: '' });
      b.note(c, { flow: e.flows.filter(within).join(', '), node: ff.label, dir: 'write', how });
      b.edge(a.id, c.id, 'write', how);
      continue;
    }
    const dir = ft ? 'write' : 'read';
    const face = ft || ff;
    const faceNode = b.node(face.id, { kind: 'section', label: face.label, path: '' });
    const n = nodes.get(ft ? e.from : e.to);
    if (!n) continue;
    for (const flow of e.flows.filter(within)) {
      const side = b.node(`${dir === 'write' ? 'w' : 'r'}:${flow}:${n.id}`,
        { kind: n.kind, label: n.label, actor: n.actor, actorKind: n.actorKind, path: n.path, sub: flow });
      b.note(faceNode, { flow, node: n.label, dir, how });
      b.note(side, { target: face.label, dir, how });
      const [from, to] = dir === 'write' ? [side.id, faceNode.id] : [faceNode.id, side.id];
      b.edge(from, to, dir, how);
    }
  }
  const order = new Map([...faces.values()].map(f => [f.id, f.order]));
  return b.finish(n => order.get(n.id) ?? 999);
}

function buildHubs(config, ctx) {
  return config.hubs.map(hub => {
    if (hub.type === 'sections') return { hub, ...sectionsHub(config, hub, ctx) };
    if (hub.type === 'match') return { hub, ...matchHub(config, hub, ctx) };
    throw new Error(`unknown hub type: ${hub.type}`);
  });
}

module.exports = { buildHubs, resolveSection, collectSections };
