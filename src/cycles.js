// Counting loops and naming them. Pure functions, so they can be tested on their own.
//
// Loops are simple cycles, not strongly connected components: components merge
// separate loops into one blob, and the point here is to tell loops apart.
'use strict';

// Every simple cycle, each started from its smallest node (in the given order) so it is listed once.
// A plain DFS is enough for workspace-sized flows; `limit` keeps a dense graph from running away.
function simpleCycles(ids, edges, limit = 5000) {
  const adj = new Map(ids.map(id => [id, []]));
  for (const e of edges) {
    if (adj.has(e.from) && adj.has(e.to) && !adj.get(e.from).includes(e.to)) adj.get(e.from).push(e.to);
  }
  const order = new Map(ids.map((id, i) => [id, i]));
  const cycles = [];
  let truncated = false;
  for (const s of ids) {
    const si = order.get(s);
    const stack = [s];
    const on = new Set([s]);
    const dfs = v => {
      for (const w of adj.get(v)) {
        if (cycles.length >= limit) { truncated = true; return; }
        if (w === s) { cycles.push([...stack]); continue; }
        if (order.get(w) < si || on.has(w)) continue;
        stack.push(w); on.add(w);
        dfs(w);
        stack.pop(); on.delete(w);
      }
    };
    dfs(s);
    if (truncated) break;
  }
  cycles.sort((a, b) => a.length - b.length);
  return { cycles, truncated };
}

// Gives each cycle the first declared name that fits.
//   exact:    the cycle visits all of the named nodes and nothing else
//   contains: the cycle visits all of the named nodes (it may visit others)
// Exact names are tried before `contains` ones; within each kind, the order of declaration decides.
// `hits(ref, id)` says whether a declared ref matches a node (a group ref matches any member).
function nameLoops(cycles, names, hits = (ref, id) => ref === id) {
  const loops = [];
  for (const cyc of cycles) {
    const covers = n => n.refs.every(r => cyc.some(id => hits(r, id)));
    const hit = names.find(n => !n.contains && covers(n) && cyc.every(id => n.refs.some(r => hits(r, id))))
      || names.find(n => n.contains && covers(n));
    const name = hit ? hit.name : null;
    const existing = name && loops.find(l => l.name === name);
    if (existing) existing.paths.push(cyc);
    else loops.push({ name, paths: [cyc] });
  }
  const missing = names.filter(n => !loops.some(l => l.name === n.name)).map(n => n.name);
  return { loops, missing: [...new Set(missing)] };
}

module.exports = { simpleCycles, nameLoops };
