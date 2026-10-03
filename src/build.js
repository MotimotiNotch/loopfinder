// Builds the graph: runs the traced scripts, adds the declarations, counts and names the loops.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { makeNodes } = require('./nodes');
const { parseDeclarations } = require('./declarations');
const { simpleCycles, nameLoops } = require('./cycles');
const { buildHubs } = require('./hubs');

const TRACE_JS = path.join(__dirname, '..', 'trace', 'trace.js');
const TRACE_PY = path.join(__dirname, '..', 'trace', 'trace.py');

function headingLevel(config) {
  const hub = config.hubs.find(h => h.type === 'sections');
  return String(hub?.level || 2);
}

// Runs one `trace:` line under the hook, or reuses the cached record.
function runTrace(config, flowName, args, opts) {
  fs.mkdirSync(config.cache, { recursive: true });
  // The same script can be traced with different arguments, so the arguments are part of the cache name.
  const tail = args.slice(1).join('_').replace(/[^\w.-]+/g, '');
  const cache = path.join(config.cache, `${flowName}__${path.basename(args[0])}${tail ? `__${tail}` : ''}.json`);
  if (!opts.reuse || !fs.existsSync(cache)) {
    const script = path.resolve(config.root, args[0]);
    const py = script.endsWith('.py');
    const env = {
      ...process.env,
      LOOPFINDER_OUT: cache,
      LOOPFINDER_ROOT: config.root,
      LOOPFINDER_HEADING_LEVEL: headingLevel(config),
      LOOPFINDER_ALLOW_NETWORK: opts.allowNetwork ? '1' : '',
      LOOPFINDER_ALLOW_SUBPROCESS: opts.allowSubprocess ? '1' : '',
    };
    const r = spawnSync(py ? config.python : process.execPath,
      py ? [TRACE_PY, script, ...args.slice(1)] : ['-r', TRACE_JS, script, ...args.slice(1)],
      { cwd: config.root, env, encoding: 'utf8', timeout: opts.timeout || 600000 });
    if (!fs.existsSync(cache)) {
      throw new Error(`trace did not finish: ${args.join(' ')} (exit ${r.status})\n${(r.stderr || '').slice(-2000)}`);
    }
    if (r.status !== 0) opts.warn(`trace exited with ${r.status}: ${args.join(' ')} (the record so far is used)\n${(r.stderr || '').trim().split('\n').slice(-3).join('\n')}`);
  }
  return JSON.parse(fs.readFileSync(cache, 'utf8'));
}

function build(config, opts = {}) {
  const warn = opts.warn || (m => console.warn(`! ${m}`));
  const n = makeNodes(config);
  const flows = parseDeclarations(config, n);
  const nodes = new Map();
  const edges = new Map();

  const addNode = (node, flow) => {
    const cur = nodes.get(node.id) || { ...node, flows: [], files: [] };
    if (!cur.flows.includes(flow)) cur.flows.push(flow);
    if (node.file && !cur.files.includes(node.file)) cur.files.push(node.file);
    if (node.url) {
      cur.urls ||= [];
      if (cur.urls.length < 5 && !cur.urls.includes(node.url)) cur.urls.push(node.url);
      cur.urlCount = (cur.urlCount || 0) + 1;
    }
    nodes.set(node.id, cur);
    return cur.id;
  };
  const addEdge = (from, to, kind, flow, source) => {
    if (from === to && kind !== 'declared') return; // a script touching itself
    const key = `${from}\u0000${to}\u0000${kind}`;
    const cur = edges.get(key) || { from, to, kind, source, flows: [], count: 0 };
    cur.count++;
    if (!cur.flows.includes(flow)) cur.flows.push(flow);
    edges.set(key, cur);
  };

  const traces = flows.map(flow => flow.traces.map(args => runTrace(config, flow.name, args, { ...opts, warn })));

  flows.forEach((flow, fi) => {
    // Files that are written or named in a declaration are never folded into the scan node.
    const keep = new Set();
    traces[fi].forEach(t => t.events.forEach(e => { if (e.kind === 'write') keep.add(n.nodeFromPath(e.target).id); }));
    flow.declared.flat().forEach(r => keep.add(n.nodeFromRef(r).id));
    [...flow.loops, ...flow.groups].forEach(l => l.refs.forEach(r => keep.add(n.nodeFromRef(r).id)));
    // Per script, the reads that could be folded, counted over every trace of this flow.
    const loose = new Map();
    for (const t of traces[fi]) for (const e of t.events) {
      if (e.kind !== 'read') continue;
      const node = n.nodeFromPath(e.target);
      if ((node.kind !== 'file' && node.kind !== 'script') || node.id.startsWith('file:') || node.id.startsWith('~/')) continue;
      if (keep.has(node.id) || node.id === n.authorNode(e.by).id) continue;
      if (!loose.has(e.by)) loose.set(e.by, new Set());
      loose.get(e.by).add(node.id);
    }
    const scanning = new Set([...loose].filter(([, ids]) => ids.size > config.scanThreshold).map(([by]) => by));
    for (const t of traces[fi]) {
      addNode(n.authorNode(t.entry), flow.name);
      for (const e of t.events) {
        const by = addNode(n.authorNode(e.by), flow.name);
        if (e.kind === 'read' && scanning.has(e.by) && loose.get(e.by).has(n.nodeFromPath(e.target).id)) {
          const scan = nodes.get(addNode(n.scanNode(), flow.name));
          // Only counts per top-level folder are kept, not the individual paths.
          const top = (n.nodeFromPath(e.target).path || '').split('/')[0] || '(root)';
          const folded = ((scan.foldedBy ||= {})[flow.name] ||= {});
          folded[top] = (folded[top] || 0) + 1;
          addEdge(scan.id, by, 'read', flow.name, 'trace');
          continue;
        }
        if (e.kind === 'fetch') addEdge(addNode(n.webNode(e.target), flow.name), by, 'read', flow.name, 'trace');
        // A required module returns data to the caller, so the arrow points from the module to the caller.
        else if (e.kind === 'require') addEdge(addNode(n.nodeFromPath(e.target), flow.name), by, 'returns', flow.name, 'trace');
        else if (e.kind === 'read') addEdge(addNode(n.nodeFromPath(e.target), flow.name), by, 'read', flow.name, 'trace');
        else if (e.kind === 'write') addEdge(by, addNode(n.nodeFromPath(e.target), flow.name), 'write', flow.name, 'trace');
        else if (e.kind === 'exec') addEdge(by, addNode({ id: `exec:${e.target}`, kind: 'web', label: e.target }, flow.name), 'calls', flow.name, 'trace');
      }
    }
    for (const [a, b] of flow.declared) {
      addEdge(addNode(n.nodeFromRef(a), flow.name), addNode(n.nodeFromRef(b), flow.name), 'declared', flow.name, 'declared');
    }
  });

  // Groups are drawn as frames around their members; the members stay separate nodes.
  const groups = [];
  const membersOf = new Map();
  for (const flow of flows) {
    for (const g of flow.groups) {
      const members = g.refs.map(r => n.nodeFromRef(r).id).filter(id => nodes.has(id));
      membersOf.set(`group:${g.name}`, new Set(members));
      groups.push({ id: `group:${g.name}`, label: g.name, flow: flow.name, members });
      for (const id of members) (nodes.get(id).groupBy ||= {})[flow.name] = `group:${g.name}`;
    }
  }

  // Loops are counted per flow, on that flow's arrows only. Flows share busy nodes (a daily note,
  // the scan node), and counting across flows multiplies loops that nobody would recognise.
  const dataEdges = [...edges.values()].filter(e => e.kind !== 'calls');
  const hits = (ref, id) => ref === id || (membersOf.get(ref)?.has(id) ?? false);
  const loops = [];
  const missing = [];
  for (const flow of flows) {
    const fe = dataEdges.filter(e => e.flows.includes(flow.name));
    const ids = [...new Set(fe.flatMap(e => [e.from, e.to]))];
    const { cycles, truncated } = simpleCycles(ids, fe);
    if (truncated) warn(`${flow.name}: too many cycles, only the first ${cycles.length} are listed`);
    const names = flow.loops.map(l => ({ name: l.name, contains: l.contains, refs: l.refs.map(r => n.nodeFromRef(r).id) }));
    const named = nameLoops(cycles, names, hits);
    loops.push(...named.loops.map(l => ({ ...l, flow: flow.name })));
    missing.push(...named.missing.map(m => `${flow.name}: ${m}`));
  }

  // A node is an origin in a flow when nothing flows into it there.
  for (const node of nodes.values()) {
    node.originIn = node.flows.filter(f => !dataEdges.some(e => e.to === node.id && e.flows.includes(f)));
  }

  // A dead end is data that something writes and nothing reads, counted over all flows together:
  // what one flow leaves behind may be what another flow reads. Writing to a web service is an
  // intended exit, so only files and repositories count. Reading by a person is not recorded, so a
  // dead end may also be a reading step nobody declared; either way it is worth asking about.
  const deadEnds = [...nodes.values()]
    .filter(nd => (nd.kind === 'file' || nd.kind === 'repo')
      && dataEdges.some(e => e.to === nd.id) && !dataEdges.some(e => e.from === nd.id))
    .map(nd => nd.id);
  for (const id of deadEnds) nodes.get(id).deadEnd = true;

  const hubs = buildHubs(config, { flows, traces, nodes, edges: dataEdges, n });
  const all = [...loops, ...hubs.flatMap(h => h.loops)].map((l, i) => ({ ...l, id: i }));
  return {
    generatedAt: new Date().toISOString(),
    lang: config.lang,
    flows: [
      ...hubs.map(h => ({ name: h.name, kind: 'hub', list: h.hub.type === 'sections' ? 'sections' : 'items', start: [] })),
      ...flows.map(f => ({ name: f.name, about: f.about, source: f.source, traces: f.traces.map(a => a.join(' ')), start: f.start })),
    ],
    nodes: [...nodes.values(), ...hubs.flatMap(h => h.nodes)],
    groups,
    edges: [...edges.values(), ...hubs.flatMap(h => h.edges)],
    loops: all,
    missingLoops: [...new Set(missing)],
    deadEnds,
  };
}

module.exports = { build, runTrace };
