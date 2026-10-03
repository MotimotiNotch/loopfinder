'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { simpleCycles, nameLoops } = require('../src/cycles');
const { parseDeclarations, globToRegExp } = require('../src/declarations');
const { makeNodes } = require('../src/nodes');
const { loadConfig } = require('../src/config');
const { build } = require('../src/build');
const { writeAgentsGuide } = require('../src/agents');
const { spawnSync } = require('child_process');

const E = (from, to) => ({ from, to });

test('cycles: two loops sharing a node stay two loops', () => {
  // a -> b -> a and a -> c -> a: a strongly connected component would merge them into one blob
  const { cycles } = simpleCycles(['a', 'b', 'c'], [E('a', 'b'), E('b', 'a'), E('a', 'c'), E('c', 'a')]);
  assert.deepStrictEqual(cycles.map(c => c.join('')).sort(), ['ab', 'ac']);
});

test('cycles: each cycle is listed once, whatever node it is entered from', () => {
  const { cycles } = simpleCycles(['x', 'y', 'z'], [E('x', 'y'), E('y', 'z'), E('z', 'x')]);
  assert.strictEqual(cycles.length, 1);
});

test('cycles: a dense graph stops at the limit and says so', () => {
  const ids = [...'abcdefgh'];
  const edges = ids.flatMap(a => ids.filter(b => b !== a).map(b => E(a, b)));
  const { cycles, truncated } = simpleCycles(ids, edges, 100);
  assert.strictEqual(cycles.length, 100);
  assert.ok(truncated);
});

test('naming: an exact name wins over a contains name; branches of one loop share a name', () => {
  const cycles = [['a', 'b'], ['a', 'b', 'c'], ['a', 'd', 'c']];
  const names = [
    { name: 'wide', contains: true, refs: ['a'] },
    { name: 'pair', contains: false, refs: ['a', 'b'] },
  ];
  const { loops, missing } = nameLoops(cycles, names);
  const byName = Object.fromEntries(loops.map(l => [l.name, l.paths.length]));
  assert.strictEqual(byName.pair, 1, 'the exact pair takes a-b');
  assert.strictEqual(byName.wide, 2, 'the two longer cycles share the contains name');
  assert.deepStrictEqual(missing, []);
});

test('naming: a declared loop that does not exist is reported, an undeclared one stays unnamed', () => {
  const { loops, missing } = nameLoops([['a', 'b']], [{ name: 'gone', contains: false, refs: ['x', 'y'] }]);
  assert.strictEqual(loops[0].name, null);
  assert.deepStrictEqual(missing, ['gone']);
});

function workspace(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loopfinder-core-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

test('declarations: a ```flow quoted inside prose is not a declaration', () => {
  const dir = workspace({
    'flows.md': 'Write blocks like ```flow <name>``` in prose.\n\n```flow real\na.md -> b.md\nloop x (contains): a.md\n```\n',
    'loopfinder.config.json': '{"declarations":["flows.md"]}',
  });
  const config = loadConfig(path.join(dir, 'loopfinder.config.json'));
  const flows = parseDeclarations(config, makeNodes(config));
  assert.deepStrictEqual(flows.map(f => f.name), ['real']);
  assert.deepStrictEqual(flows[0].declared, [['a.md', 'b.md']]);
  assert.strictEqual(flows[0].loops[0].contains, true);
});

test('flows.json: reads the same as the equivalent ```flow block', () => {
  const block = [
    '```flow reading',
    'trace: scripts/fetch.js 2026-10-02',
    'start: web:example.com',
    'notes/{date}.md#Reading -> [me] Pick -> notes/ideas.md',
    'group State: scripts/seen.json, scripts/feeds.json',
    'loop Seen once: scripts/fetch.js, scripts/seen.json',
    'loop Reading becomes ideas (contains): notes/{date}.md, [me] Pick',
    'end Old items kept for reference: notes/archive/',
    '```', '',
  ].join('\n');
  const json = { flows: [{
    name: 'reading', about: 'one line', sources: ['scripts/fetch.js'],
    trace: ['scripts/fetch.js 2026-10-02'], start: ['web:example.com'],
    edges: ['notes/{date}.md#Reading -> [me] Pick -> notes/ideas.md'],
    groups: [{ name: 'State', nodes: ['scripts/seen.json', 'scripts/feeds.json'] }],
    loops: [
      { name: 'Seen once', nodes: ['scripts/fetch.js', 'scripts/seen.json'] },
      { name: 'Reading becomes ideas', nodes: ['notes/{date}.md', '[me] Pick'], contains: true },
    ],
    ends: [{ name: 'Old items kept for reference', nodes: ['notes/archive/'] }],
  }] };
  const a = workspace({ 'loopfinder/config.json': '{"declarations":["flows.md"]}', 'flows.md': block });
  const b = workspace({ 'loopfinder/config.json': '{}', 'loopfinder/flows.json': JSON.stringify(json) });
  const read = dir => { const c = loadConfig(path.join(dir, 'loopfinder', 'config.json')); return parseDeclarations(c, makeNodes(c)); };
  const strip = ({ source, about, ...f }) => f;
  const [fa] = read(a);
  const [fb] = read(b);
  assert.ok(fa.declared.length && fa.loops.length && fa.groups.length && fa.traces.length && fa.ends.length, 'the block itself was read');
  assert.deepStrictEqual(strip(fb), strip(fa));
  assert.strictEqual(fb.about, 'one line');
  assert.strictEqual(fb.source, 'loopfinder/flows.json');
});

test('flows.json: a mistake is reported with where it is, for the agent that has to fix it', () => {
  const bad = (flow, expected) => {
    const dir = workspace({ 'loopfinder/config.json': '{}', 'loopfinder/flows.json': JSON.stringify({ flows: [flow] }) });
    const c = loadConfig(path.join(dir, 'loopfinder', 'config.json'));
    assert.throws(() => parseDeclarations(c, makeNodes(c)), expected);
  };
  bad({ name: 'has space' }, /flows\[0\]: "name" must be a short id/);
  bad({ name: 'x', edges: ['a.md'] }, /flows\[0\] \(x\): edges\[0\] needs at least one "->"/);
  bad({ name: 'x', loops: [{ name: 'l', nodes: [] }] }, /loops\[0\]\.nodes is empty/);
  bad({ name: 'x', loops: [{ name: 'a: b', nodes: ['a.md'] }] }, /must not contain ":"/);
  bad({ name: 'x', trace: 'scripts/a.js' }, /"trace" must be a list of strings/);
});

test('flows.json and ```flow blocks may not declare the same flow twice', () => {
  const dir = workspace({
    'loopfinder/config.json': '{"declarations":["flows.md"]}',
    'loopfinder/flows.json': JSON.stringify({ flows: [{ name: 'x', edges: ['a.md -> b.md'] }] }),
    'flows.md': '```flow x\nb.md -> a.md\n```\n',
  });
  const c = loadConfig(path.join(dir, 'loopfinder', 'config.json'));
  assert.throws(() => parseDeclarations(c, makeNodes(c)), /flow "x" is declared twice/);
});

test('config: inside loopfinder/, paths are relative to the workspace', () => {
  const dir = workspace({ 'loopfinder/config.json': '{}' });
  const c = loadConfig(path.join(dir, 'loopfinder', 'config.json'));
  const ws = dir.replace(/\\/g, '/');
  assert.strictEqual(c.root, ws);
  assert.strictEqual(c.flowsFile, `${ws}/loopfinder/flows.json`);
  assert.strictEqual(c.output, `${ws}/.loopfinder/flow.json`);
});

test('AGENTS.md: written next to flows.json, and left alone when nothing changed', () => {
  const dir = workspace({ 'loopfinder/config.json': '{}' });
  const c = loadConfig(path.join(dir, 'loopfinder', 'config.json'));
  const first = writeAgentsGuide(c);
  assert.ok(first.changed);
  assert.strictEqual(first.file, path.join(dir, 'loopfinder', 'AGENTS.md'));
  assert.match(fs.readFileSync(first.file, 'utf8'), /^> Written by loopfinder \d+\.\d+\.\d+/);
  assert.strictEqual(writeAgentsGuide(c).changed, false);
  fs.writeFileSync(first.file, 'edited by hand');
  assert.strictEqual(writeAgentsGuide(c).changed, true, 'a hand edit is overwritten');
});

test('init: makes loopfinder/ and never overwrites what is there', () => {
  const dir = workspace({ 'loopfinder/flows.json': '{"flows":[{"name":"mine","edges":["a.md -> b.md"]}]}' });
  const bin = path.join(__dirname, '..', 'bin', 'loopfinder.js');
  const r = spawnSync(process.execPath, [bin, 'init'], { cwd: dir, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /exists, left alone: loopfinder.flows\.json/);
  assert.match(fs.readFileSync(path.join(dir, 'loopfinder', 'flows.json'), 'utf8'), /"mine"/);
  for (const f of ['config.json', 'AGENTS.md']) assert.ok(fs.existsSync(path.join(dir, 'loopfinder', f)), f);
  assert.match(r.stdout, /Read loopfinder\/AGENTS\.md and survey this workspace/);
});

test('declarations: globs', () => {
  assert.ok(globToRegExp('skills/*/SKILL.md').test('skills/sync/SKILL.md'));
  assert.ok(!globToRegExp('skills/*/SKILL.md').test('skills/a/b/SKILL.md'));
  assert.ok(globToRegExp('**/MOC.md').test('a/b/MOC.md'));
  assert.ok(globToRegExp('**/MOC.md').test('MOC.md'));
});

test('nodes: a traced path and a script: reference land on the same node', () => {
  // Traces report absolute paths; declarations may use the script: shorthand. They must agree,
  // or one script shows up as two unconnected nodes.
  const dir = workspace({ 'tools/run.js': '', 'loopfinder.config.json': '{"scriptDirs":["scripts","tools"]}' });
  const config = loadConfig(path.join(dir, 'loopfinder.config.json'));
  const n = makeNodes(config);
  const abs = path.join(dir, 'tools', 'run.js').replace(/\\/g, '/');
  assert.strictEqual(n.authorNode(abs).id, n.nodeFromRef('script:run.js').id);
  assert.strictEqual(n.nodeFromRef('tools/run.js').id, 'tools/run.js');
});

test('nodes: dates fold into a placeholder, steps carry who does them', () => {
  const dir = workspace({ 'loopfinder.config.json': '{"actors":{"human":["me"],"ai":["AI"]}}' });
  const n = makeNodes(loadConfig(path.join(dir, 'loopfinder.config.json')));
  assert.strictEqual(n.nodeFromRef('notes/2026-10-02.md').id, 'notes/{date}.md');
  assert.strictEqual(n.nodeFromRef('[me] Plan').actorKind, 'human');
  assert.strictEqual(n.nodeFromRef('[AI] Draft').actorKind, 'ai');
  assert.strictEqual(n.nodeFromRef('[visitor] Share').actorKind, 'other');
});

test('dead ends: written and never read, counted over all flows; sending out is not one', () => {
  const flows = { flows: [
    { name: 'write', edges: ['notes/in.md -> [me] Write it up -> notes/handoff.md', '[me] Write it up -> web:chat'] },
    { name: 'read', edges: ['notes/handoff.md -> [AI] Pick it up -> notes/log.md'] },
  ] };
  const dir = workspace({ 'loopfinder/config.json': '{}', 'loopfinder/flows.json': JSON.stringify(flows) });
  const graph = build(loadConfig(path.join(dir, 'loopfinder', 'config.json')), { warn: () => {} });
  // handoff.md ends the first flow but the second reads it; the message to web:chat is an exit.
  assert.deepStrictEqual(graph.deadEnds, ['notes/log.md']);
  assert.strictEqual(graph.nodes.find(nd => nd.id === 'notes/log.md').deadEnd, true);
  // Control: once nobody reads the hand-off, it is reported too.
  flows.flows.pop();
  fs.writeFileSync(path.join(dir, 'loopfinder', 'flows.json'), JSON.stringify(flows));
  const alone = build(loadConfig(path.join(dir, 'loopfinder', 'config.json')), { warn: () => {} });
  assert.deepStrictEqual(alone.deadEnds, ['notes/handoff.md']);
});

test('ends: a declared end is listed apart, and reported once it is read again', () => {
  const flows = { flows: [
    { name: 'backup', edges: ['notes/a.md -> [me] Back up -> backups/'], ends: [{ name: 'Backups', nodes: ['backups/'] }] },
  ] };
  const dir = workspace({ 'loopfinder/config.json': '{}', 'loopfinder/flows.json': JSON.stringify(flows) });
  const cfg = path.join(dir, 'loopfinder', 'config.json');
  const graph = build(loadConfig(cfg), { warn: () => {} });
  assert.deepStrictEqual(graph.deadEnds, [], 'a declared end is not a finding');
  assert.deepStrictEqual(graph.intendedEnds.map(d => [d.id, d.name]), [['backups/', 'Backups']]);
  assert.strictEqual(graph.nodes.find(nd => nd.id === 'backups/').intendedEnd, 'Backups');
  assert.deepStrictEqual(graph.staleEnds, []);
  // Someone starts reading the backups: the declaration no longer holds and is reported.
  flows.flows[0].edges.push('backups/ -> [me] Restore');
  fs.writeFileSync(path.join(dir, 'loopfinder', 'flows.json'), JSON.stringify(flows));
  const read = build(loadConfig(cfg), { warn: () => {} });
  assert.deepStrictEqual(read.intendedEnds, []);
  assert.deepStrictEqual(read.staleEnds, ['backup: Backups (backups/)']);
});

function snapshot(dir) {
  const out = {};
  const walk = rel => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else out[r] = crypto.createHash('sha1').update(fs.readFileSync(path.join(dir, r))).digest('hex');
    }
  };
  walk('');
  return out;
}

test('demo: builds the expected loops and leaves the workspace untouched', () => {
  const src = path.join(__dirname, '..', 'examples', 'demo');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loopfinder-demo-'));
  fs.cpSync(src, dir, { recursive: true });
  // keep the build output out of the workspace being checked
  const cfgFile = path.join(dir, 'loopfinder', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  cfg.output = path.join(os.tmpdir(), `lf-out-${process.pid}`, 'flow.json');
  cfg.cache = path.join(os.tmpdir(), `lf-out-${process.pid}`, 'traces');
  fs.writeFileSync(cfgFile, JSON.stringify(cfg));
  const before = snapshot(dir);
  const graph = build(loadConfig(cfgFile), { warn: () => {} });
  assert.deepStrictEqual(snapshot(dir), before, 'tracing changed the workspace');
  const loops = graph.loops.filter(l => !l.kind);
  assert.deepStrictEqual(loops.filter(l => l.name).map(l => l.name).sort(), [
    'Do not show the same item twice',
    "Next week's tasks come from this week's summary",
    'Reading becomes tasks',
    'The Reading section is rewritten in place',
    'The weekly review changes what the feed collects',
  ]);
  // The outer loop: the weekly review rewrites the topic list the feed loop runs on.
  const outer = loops.find(l => l.name === 'The weekly review changes what the feed collects');
  assert.ok(outer.paths.every(p => p.includes('scripts/feed_topics.json') && p.includes('scripts/fetch_feed.js')));
  // The one dead end left on purpose: statistics the weekly script writes and nobody reads.
  assert.deepStrictEqual(graph.deadEnds, ['summary/stats.csv']);
  assert.strictEqual(loops.filter(l => !l.name).length, 1, 'the one loop left undeclared on purpose');
  assert.deepStrictEqual(graph.missingLoops, []);
  // The section hub knows which heading each step touches.
  const hub = graph.loops.filter(l => l.kind === 'section').map(l => l.name);
  assert.ok(hub.includes('Reading') && hub.includes('Tasks'));
  const feedNode = graph.nodes.find(n => n.id === 'web:Garden feed');
  assert.ok(feedNode, 'the blocked fetch is still recorded and labelled');
});
