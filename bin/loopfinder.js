#!/usr/bin/env node
'use strict';
const fs = require('fs');
const http = require('http');
const path = require('path');
const { loadConfig } = require('../src/config');
const { build } = require('../src/build');
const { searchLayouts } = require('../src/layout-search');
const { runChecks } = require('../src/checks');
const { writeAgentsGuide } = require('../src/agents');

const HELP = `loopfinder - find the feedback loops in your workspace

Usage:
  loopfinder init                 make loopfinder/ here (config.json, flows.json, AGENTS.md)
  loopfinder build [options]      trace the scripts, read the flows, write the graph
  loopfinder serve [options]      open the viewer on http://127.0.0.1:<port>

Options:
  --config <file>        config file (default: ./loopfinder/config.json)
  --reuse                reuse the last trace records instead of running the scripts again
  --allow-network        let traced scripts reach the network (it is always recorded; blocked by default)
  --allow-subprocess     let traced scripts start other programs (blocked by default)
  --budget <seconds>     time spent searching each flow's layout (default 15)
  --port <n>             port for serve (default 7878)

The flows are written by your AI agent: ask it to read loopfinder/AGENTS.md and survey the workspace.
loopfinder rewrites that file on every run, so it follows the installed version.

Tracing really runs your scripts. Writes are recorded and dropped, network and subprocesses are
blocked unless allowed, but it is a recorder, not a sandbox: do not trace code you would not run.`;

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
}
const flag = name => process.argv.includes(name);

// The guide for AI agents is rewritten on every run, like an app that keeps its own docs next to its data.
function guide(config) {
  const { file, changed } = writeAgentsGuide(config);
  if (changed) console.log(`wrote ${path.relative(process.cwd(), file) || file}`);
}

async function cmdBuild() {
  const config = loadConfig(arg('--config'));
  guide(config);
  const graph = build(config, {
    reuse: flag('--reuse'),
    allowNetwork: flag('--allow-network'),
    allowSubprocess: flag('--allow-subprocess'),
  });
  searchLayouts(graph, { budgetMs: Number(arg('--budget', 15)) * 1000, log: m => console.log(`  layout ${m}`) });
  fs.mkdirSync(path.dirname(config.output), { recursive: true });
  fs.writeFileSync(config.output, JSON.stringify(graph, null, 2));
  const flows = graph.flows.filter(f => f.kind !== 'hub');
  if (!flows.length) {
    console.log('No flows yet. Ask your AI agent: "Read loopfinder/AGENTS.md and survey this workspace."');
    return;
  }
  const real = graph.loops.filter(l => !l.kind);
  console.log(`${flows.length} flows, ${graph.nodes.length} nodes, ${graph.edges.length} edges, ${real.length} loops -> ${config.output}`);
  for (const l of real) console.log(`  ${l.flow}: ${l.name || '(unnamed loop)'}`);
  const unnamed = real.filter(l => !l.name);
  if (unnamed.length) console.log(`! ${unnamed.length} unnamed loop(s): feedback you did not declare. Check whether it is intended.`);
  for (const m of graph.missingLoops) console.log(`! declared but not found: ${m} (a step changed and the loop broke?)`);
  await runChecks(config, graph);
}

function cmdServe() {
  const config = loadConfig(arg('--config'));
  guide(config);
  const port = Number(arg('--port', 7878));
  const pub = path.join(__dirname, '..', 'public');
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = url === '/flow.json' ? config.output : path.join(pub, url === '/' ? 'index.html' : url);
    // Only files under public/ (and the graph) are served.
    if (url !== '/flow.json' && !path.resolve(file).startsWith(path.resolve(pub))) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end(url === '/flow.json' ? 'run `loopfinder build` first' : 'not found'); return; }
      res.writeHead(200, { 'content-type': `${types[path.extname(file)] || 'application/octet-stream'}; charset=utf-8`, 'cache-control': 'no-store' });
      res.end(data);
    });
  });
  // Bound to localhost: the graph lists your file paths and should not be visible on the network.
  server.listen(port, '127.0.0.1', () => console.log(`loopfinder: http://127.0.0.1:${port}/`));
}

function cmdInit() {
  const dir = 'loopfinder';
  fs.mkdirSync(dir, { recursive: true });
  const write = (file, text) => {
    if (fs.existsSync(file)) { console.log(`exists, left alone: ${file}`); return; }
    fs.writeFileSync(file, text);
    console.log(`wrote ${file}`);
  };
  write(path.join(dir, 'config.json'), `${JSON.stringify({
    scriptDirs: ['scripts'],
    actors: { human: ['me'], ai: ['AI'] },
    webLabels: [],
    hubs: [],
    lang: 'en',
  }, null, 2)}\n`);
  write(path.join(dir, 'flows.json'), `${JSON.stringify({ flows: [] }, null, 2)}\n`);
  guide(loadConfig(path.join(dir, 'config.json')));
  console.log([
    '',
    'Next: ask your AI agent (Claude Code, Codex, Cursor, ...):',
    '  "Read loopfinder/AGENTS.md and survey this workspace."',
    'It writes loopfinder/flows.json. Then run `loopfinder build` and `loopfinder serve`.',
    'Keep .loopfinder/ (the build output, which lists your file paths) out of version control.',
  ].join('\n'));
}

const cmd = process.argv[2];
if (cmd === 'build') cmdBuild().catch(e => { console.error(e.message); process.exit(1); });
else if (cmd === 'serve') cmdServe();
else if (cmd === 'init') cmdInit();
else { console.log(HELP); process.exit(cmd && cmd !== '--help' && cmd !== '-h' ? 1 : 0); }
