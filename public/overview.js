// The overview: every flow drawn on one picture. The per-flow diagram reads left to right ("upstream to
// downstream", plus the arcs that come back); here all flows are overlaid, each file appears once, and
// what you look for are the knots where flows meet. There is no direction axis.
// Placement is a spring-and-repulsion simulation (Fruchterman–Reingold) in 3D. No randomness: the same
// graph always gives the same picture.

// Stands in for a flow name in `current`. A NUL can never come from a config's flow name in practice, and
// it is not put in the URL: the hash for the overview is `#overview` (see app.js).
const OVERVIEW = '\u0000overview';

// Hub flows (sections of a note, items of a hub) are a different cut of the same data, so they are left out.
function overviewParts(graph) {
  const hubFlows = new Set(graph.flows.filter(f => f.kind === 'hub').map(f => f.name));
  const nodes = graph.nodes
    .map(n => ({ ...n, flows: (n.flows || []).filter(f => !hubFlows.has(f)) }))
    .filter(n => n.flows.length > 0);
  const ids = new Set(nodes.map(n => n.id));
  // Lines between the same two nodes are merged into one, even across flows; the line keeps which flows it carries.
  const pairs = new Map();
  for (const e of graph.edges) {
    const flows = (e.flows || []).filter(f => !hubFlows.has(f));
    if (!flows.length || e.from === e.to || !ids.has(e.from) || !ids.has(e.to)) continue;
    const key = `${e.from}\u0000${e.to}`;
    const p = pairs.get(key) || { from: e.from, to: e.to, flows: new Set(), sources: new Set(), kinds: new Set() };
    flows.forEach(f => p.flows.add(f));
    p.sources.add(e.source);
    p.kinds.add(e.kind);
    pairs.set(key, p);
  }
  const edges = [...pairs.values()].map(p => ({
    from: p.from, to: p.to, flows: [...p.flows],
    // Solid if any of the merged lines was recorded by running a script; dashed if all were declared by hand.
    declared: !p.sources.has('trace'),
    // Dotted (no data flows) only when every merged line is a call.
    calls: [...p.kinds].every(k => k === 'calls'),
  }));
  const flows = graph.flows.filter(f => !hubFlows.has(f.name)).map(f => f.name);
  return { nodes, edges, flows };
}

// Returns { pos: id -> {x, y, z}, degree: id -> number of neighbours }. The centroid is the origin, which
// is also the point the view rotates around. 3D because in a plane a few hundred nodes piled into one
// blob; the depth axis gives them room. The forces are the same as in 2D, with one more axis.
function layoutOverview(nodes, edges) {
  const K = 46;            // natural spring length (rough spacing between neighbours)
  const ITERATIONS = 500;
  const GRAVITY = 0.9;     // pull toward the centre, so all-pairs repulsion does not spread the picture too far
  const degree = new Map(nodes.map(n => [n.id, 0]));
  const links = new Set();
  for (const e of edges) {
    const key = e.from < e.to ? `${e.from}\u0000${e.to}` : `${e.to}\u0000${e.from}`;
    if (links.has(key)) continue;
    links.add(key);
    degree.set(e.from, degree.get(e.from) + 1);
    degree.set(e.to, degree.get(e.to) + 1);
  }
  // Seeding instead of random: most-connected first, placed from the inside out on a golden-angle spiral
  // (a Fibonacci lattice on a sphere whose radius grows with the index).
  const order = [...nodes].sort((a, b) => degree.get(b.id) - degree.get(a.id) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const index = new Map(order.map((n, i) => [n.id, i]));
  const N = order.length;
  const pos = new Map();
  if (!N) return { pos, degree };
  const P = [new Float64Array(N), new Float64Array(N), new Float64Array(N)];
  const D = [new Float64Array(N), new Float64Array(N), new Float64Array(N)];
  order.forEach((n, i) => {
    const r = K * 0.9 * Math.cbrt(i + 0.5), a = i * 2.399963;
    const h = 1 - 2 * ((i + 0.5) / N), w = Math.sqrt(1 - h * h);
    P[0][i] = r * w * Math.cos(a); P[1][i] = r * h; P[2][i] = r * w * Math.sin(a);
  });
  // Sorted, so the order the edges arrive in does not change the floating-point sums (or the picture).
  const L = [...links].sort().map(k => k.split('\u0000').map(id => index.get(id)));
  const e = [0, 0, 0];
  let t = K * 3;
  const cool = Math.pow(0.5 / t, 1 / ITERATIONS); // cool until the last step is 0.5px
  for (let it = 0; it < ITERATIONS; it++) {
    D.forEach(a => a.fill(0));
    for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
      let d2 = 0;
      for (let k = 0; k < 3; k++) { e[k] = P[k][i] - P[k][j]; d2 += e[k] * e[k]; }
      if (d2 < 0.01) { e[0] = 0.1; e[1] = 0; e[2] = 0; d2 = 0.01; }
      const f = (K * K) / d2; // repulsion K²/d along the unit vector e/d, i.e. K²/d² · e
      for (let k = 0; k < 3; k++) { D[k][i] += e[k] * f; D[k][j] -= e[k] * f; }
    }
    for (const [i, j] of L) {
      let d2 = 0;
      for (let k = 0; k < 3; k++) { e[k] = P[k][i] - P[k][j]; d2 += e[k] * e[k]; }
      const f = (Math.sqrt(d2) || 0.1) / K; // attraction d²/K along e/d, i.e. d/K · e
      for (let k = 0; k < 3; k++) { D[k][i] -= e[k] * f; D[k][j] += e[k] * f; }
    }
    for (let i = 0; i < N; i++) {
      let d2 = 0;
      for (let k = 0; k < 3; k++) { D[k][i] -= P[k][i] * GRAVITY; d2 += D[k][i] * D[k][i]; }
      const d = Math.sqrt(d2);
      if (d > 0) { const s = Math.min(d, t) / d; for (let k = 0; k < 3; k++) P[k][i] += D[k][i] * s; }
    }
    t *= cool;
  }
  const c = P.map(a => a.reduce((s, v) => s + v, 0) / N);
  order.forEach((n, i) => pos.set(n.id, { x: P[0][i] - c[0], y: P[1][i] - c[1], z: P[2][i] - c[2] }));
  return { pos, degree };
}

if (typeof module !== 'undefined') module.exports = { OVERVIEW, overviewParts, layoutOverview };
