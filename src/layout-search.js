// Picks, for each flow, the node and edge order that gives dagre the fewest crossings,
// and stores it in graph.layout. The browser then lays the flow out once in that order.
// (Searching in the browser on every load was far too slow: a crossing-free order can be 1 in 100.)
'use strict';
global.dagre = global.dagre || require('../public/vendor/dagre.min.js');
const { flowParts, layoutFlow, layoutOnce, countCrossings } = require('../public/layout.js');

function searchLayouts(graph, { tries = 2000, budgetMs = 15000, log = () => {} } = {}) {
  graph.layout = graph.layout || {};
  for (const flow of graph.flows) {
    const parts = flowParts(graph, flow.name);
    const { nodes, edges, back, groups } = parts;
    // A fixed seed, so the same graph gives the same order (unless the time budget cuts the search short).
    let seed = 1;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const shuffle = a => {
      const b = [...a];
      for (let k = b.length - 1; k > 0; k--) { const j = Math.floor(rand() * (k + 1)); [b[k], b[j]] = [b[j], b[k]]; }
      return b;
    };
    const first = countCrossings(layoutOnce(nodes, edges, edges.map((e, k) => k), back, groups), edges, back);
    let best = { crossings: first, nodes: nodes.map(nd => nd.id), edges: edges.map((e, k) => k) };
    const t0 = Date.now();
    let tried = 0;
    for (let t = 0; t < tries && best.crossings.score > 0 && Date.now() - t0 < budgetMs; t++, tried++) {
      const nodeOrder = shuffle(nodes);
      const edgeOrder = shuffle(edges.map((e, k) => k));
      const c = countCrossings(layoutOnce(nodeOrder, edges, edgeOrder, back, groups), edges, back);
      if (c.score < best.crossings.score) best = { crossings: c, nodes: nodeOrder.map(nd => nd.id), edges: edgeOrder };
    }
    // Lay out again the way the browser will, to make sure the order alone decides the result.
    const again = countCrossings(layoutFlow(parts, best), edges, back);
    if (again.score !== best.crossings.score) throw new Error(`${flow.name}: crossings changed when laid out again (${best.crossings.score} -> ${again.score})`);
    graph.layout[flow.name] = best;
    const fmt = c => `forward ${c.forward} / forward-arc ${c.mixed} / arc-arc ${c.arcs}`;
    const cut = tried < tries && best.crossings.score > 0 ? ` (stopped after ${Math.round(budgetMs / 1000)}s, ${tried} orders)` : '';
    log(`${flow.name}: ${fmt(first)} -> ${fmt(best.crossings)}${cut}`);
  }
  return graph;
}

module.exports = { searchLayouts };
