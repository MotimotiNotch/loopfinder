// Layout shared by the browser (app.js) and Node (src/layout-search.js).
// The node order is searched once when flow.json is built; the browser lays out once in that order.

function textWidth(s) {
  // Rough width of a label that may mix CJK (11px) and Latin (6.5px) characters.
  let w = 0;
  for (const ch of s) w += ch.charCodeAt(0) > 0xff ? 11 : 6.5;
  return w;
}

// The nodes, edges, feedback edges and frames of one flow.
function flowParts(graph, current) {
  // Origins and frames differ per flow, so they are resolved for the flow being drawn.
  const nodes = graph.nodes.filter(n => n.flows.includes(current))
    .map(n => ({ ...n, origin: (n.originIn || []).includes(current), group: n.groupBy?.[current] }));
  const ids = new Set(nodes.map(n => n.id));
  const edges = graph.edges.filter(e => e.flows.includes(current) && ids.has(e.from) && ids.has(e.to));
  const start = graph.flows.find(f => f.name === current)?.start || [];
  const back = feedbackEdges(nodes, edges, start);
  const groups = (graph.groups || []).filter(gr => gr.flow === current && gr.members.some(id => ids.has(id)));
  return { nodes, edges, back, groups };
}

// dagre's result depends on input order; `order` (from layout-search) fixes it.
function layoutFlow(parts, order) {
  const { nodes, edges, back, groups } = parts;
  const byId = new Map(nodes.map(n => [n.id, n]));
  const nodeOrder = order && order.nodes.length === nodes.length && order.nodes.every(id => byId.has(id))
    ? order.nodes.map(id => byId.get(id)) : nodes;
  const edgeOrder = order && order.edges.length === edges.length ? order.edges : edges.map((e, i) => i);
  return layoutOnce(nodeOrder, edges, edgeOrder, back, groups);
}

function layoutOnce(nodes, edges, edgeOrder, back, groups) {
  const g = new dagre.graphlib.Graph({ multigraph: true, compound: true });
  g.setGraph({ rankdir: 'LR', nodesep: 22, ranksep: 70, marginx: 40, marginy: 30 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const gr of groups) g.setNode(gr.id, { paddingTop: 22, paddingBottom: 10, paddingLeft: 10, paddingRight: 10 });
  for (const n of nodes) {
    const w = Math.max(40, textWidth(n.label) + 8);
    g.setNode(n.id, { width: w, height: n.kind === 'step' ? 44 : 38 });
    if (n.group && groups.some(gr => gr.id === n.group)) g.setParent(n.id, n.group);
  }
  for (const i of edgeOrder) if (!back.has(i)) g.setEdge(edges[i].from, edges[i].to, {}, `e${i}`);
  dagre.layout(g);
  return g;
}

// Counts crossings. Feedback edges are drawn as arcs under the graph, so they are sampled as such.
// Forward/forward crossings are the hardest to read, so they weigh most; arc/arc crossings least.
function countCrossings(g, edges, back) {
  const lines = [];
  edges.forEach((e, i) => {
    if (!back.has(i)) { lines.push(g.edge(e.from, e.to, `e${i}`).points.map(p => ({ x: p.x, y: p.y - 6 }))); return; }
    const a = g.node(e.from), b = g.node(e.to);
    const depth = 24 + Math.abs(a.x - b.x) * 0.18, y1 = a.y + 8, y2 = b.y + 8;
    const pts = [];
    for (let k = 0; k <= 12; k++) {
      const t = k / 12, u = 1 - t;
      pts.push({
        x: u * u * u * a.x + 3 * u * u * t * a.x + 3 * u * t * t * b.x + t * t * t * b.x,
        y: u * u * u * y1 + 3 * u * u * t * (y1 + depth) + 3 * u * t * t * (y2 + depth) + t * t * t * y2,
      });
    }
    lines.push(Object.assign(pts, { back: true }));
  });
  const d = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const cross = (p1, p2, p3, p4) => d(p3, p4, p1) * d(p3, p4, p2) < 0 && d(p1, p2, p3) * d(p1, p2, p4) < 0;
  const c = { forward: 0, mixed: 0, arcs: 0 };
  for (let a = 0; a < lines.length; a++) for (let b = a + 1; b < lines.length; b++) {
    const A = lines[a], B = lines[b];
    let n = 0;
    for (let i = 1; i < A.length; i++) for (let j = 1; j < B.length; j++) if (cross(A[i - 1], A[i], B[j - 1], B[j])) n++;
    c[A.back && B.back ? 'arcs' : A.back || B.back ? 'mixed' : 'forward'] += n;
  }
  c.score = c.forward * 10000 + c.mixed * 100 + c.arcs;
  return c;
}

// Depth-first from the origins; an edge back to a node still on the path is a feedback edge.
// Origins are visited in the order: external services, hand-written steps (triggers), the rest.
// `start` (from a declaration's start: line) is visited first.
function feedbackEdges(nodes, edges, start = []) {
  const out = new Map(nodes.map(n => [n.id, []]));
  edges.forEach((e, i) => out.get(e.from).push({ to: e.to, i }));
  const rank = n => (n.kind === 'web' ? 0 : n.kind === 'step' ? 1 : 2);
  const starts = [...nodes.filter(n => start.includes(n.id)), ...nodes.filter(n => n.origin).sort((a, b) => rank(a) - rank(b)), ...nodes];
  const state = new Map(); // 1 = on the current path, 2 = done
  const back = new Set();
  const visit = id => {
    state.set(id, 1);
    for (const { to, i } of out.get(id)) {
      if (state.get(to) === 1) back.add(i);
      else if (!state.has(to)) visit(to);
    }
    state.set(id, 2);
  };
  for (const n of starts) if (!state.has(n.id)) visit(n.id);
  return back;
}

if (typeof module !== 'undefined') module.exports = { flowParts, layoutFlow, layoutOnce, countCrossings, feedbackEdges };
