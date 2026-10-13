'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { OVERVIEW, overviewParts, layoutOverview } = require('../public/overview');

const N = (id, flows, kind = 'file') => ({ id, kind, label: id, flows });
const E = (from, to, flows, extra = {}) => ({ from, to, flows, kind: 'write', source: 'trace', ...extra });

// Three flows sharing a file, plus a hub flow over the same data.
const graph = {
  flows: [
    { name: 'Daily note', kind: 'hub' },
    { name: 'reading' },
    { name: 'weekly' },
    { name: 'ideas' },
  ],
  nodes: [
    N('a.js', ['reading'], 'script'),
    N('shared.md', ['reading', 'weekly', 'ideas', 'Daily note']),
    N('b.py', ['weekly'], 'script'),
    N('c.md', ['ideas']),
    N('section:Tasks', ['Daily note'], 'section'),
  ],
  edges: [
    E('a.js', 'shared.md', ['reading']),
    E('a.js', 'shared.md', ['weekly'], { source: 'declared', kind: 'declared' }),
    E('shared.md', 'b.py', ['weekly'], { kind: 'read' }),
    E('b.py', 'c.md', ['ideas'], { source: 'declared', kind: 'declared' }),
    E('c.md', 'shared.md', ['ideas']),
    E('shared.md', 'section:Tasks', ['Daily note'], { source: 'hub' }),
  ],
};

test('overview: the sentinel cannot be mistaken for an ordinary flow name', () => {
  assert.ok(OVERVIEW.includes('\u0000'));
});

test('overview: hub flows are left out', () => {
  const parts = overviewParts(graph);
  assert.deepStrictEqual(parts.flows, ['reading', 'weekly', 'ideas']);
  assert.ok(!parts.nodes.some(n => n.id === 'section:Tasks'), 'a node only in a hub flow is dropped');
  assert.ok(!parts.edges.some(e => e.to === 'section:Tasks'), 'a hub edge is dropped');
  const shared = parts.nodes.find(n => n.id === 'shared.md');
  assert.deepStrictEqual(shared.flows, ['reading', 'weekly', 'ideas']);
});

test('overview: lines between the same two nodes are merged across flows', () => {
  const parts = overviewParts(graph);
  const ab = parts.edges.filter(e => e.from === 'a.js' && e.to === 'shared.md');
  assert.strictEqual(ab.length, 1);
  assert.deepStrictEqual(ab[0].flows.sort(), ['reading', 'weekly']);
  // One of the merged lines was recorded, so the merged line is drawn as recorded.
  assert.strictEqual(ab[0].declared, false);
  assert.strictEqual(parts.edges.find(e => e.from === 'b.py').declared, true);
  // Opposite directions stay two lines.
  assert.strictEqual(parts.edges.length, 4);
});

test('overview: the layout is deterministic and centred', () => {
  const parts = overviewParts(graph);
  const one = layoutOverview(parts.nodes, parts.edges);
  // Fresh copies in another order: same input, same picture.
  const again = overviewParts(JSON.parse(JSON.stringify(graph)));
  const two = layoutOverview([...again.nodes].reverse(), [...again.edges].reverse());
  assert.strictEqual(one.pos.size, parts.nodes.length);
  for (const [id, p] of one.pos) assert.deepStrictEqual(two.pos.get(id), p);
  const c = ['x', 'y', 'z'].map(k => [...one.pos.values()].reduce((s, p) => s + p[k], 0) / one.pos.size);
  for (const v of c) assert.ok(Math.abs(v) < 1e-9, `centroid ${c}`);
  // Nodes do not sit on top of each other.
  const ps = [...one.pos.values()];
  for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
    assert.ok(Math.hypot(ps[i].x - ps[j].x, ps[i].y - ps[j].y, ps[i].z - ps[j].z) > 10);
  }
  assert.strictEqual(one.degree.get('shared.md'), 3);
});

test('overview: an empty graph lays out to nothing', () => {
  const { pos } = layoutOverview([], []);
  assert.strictEqual(pos.size, 0);
});
