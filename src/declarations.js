// Reads the flows: loopfinder/flows.json (written by an AI agent, see AGENTS.md), and optionally
// ```flow blocks in the files listed in config.declarations, in the same line syntax:
//
//   ```flow <name>
//   trace: scripts/sync.js --flag          run this script under the trace hook and record what it touches
//   start: [me] Write a note               where to begin reading the diagram (optional)
//   A -> B -> C                            data flows from A to B, then to C
//   notes/daily/{date}.md#Tasks            a reference can point at a section of a note (for section hubs)
//   group <name>: A, B                     draw A and B inside one frame
//   loop <name>: A, B                      the cycle made of exactly these nodes gets this name
//   loop <name> (contains): A, B           otherwise-unnamed cycles that pass through A and B get this name
//   end <why>: A, B                        A and B are meant to be written and not read (an archive, a backup)
//   # comment
//   ```
'use strict';
const fs = require('fs');
const path = require('path');

const CONTAINS = /\s*\((?:contains|含む)\)$/;

function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*' && glob[i + 1] === '*') {
      re += '.*';
      i++;
      if (glob[i + 1] === '/') i++;
    } else if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

// Root-relative files that match any of the globs.
function expandGlobs(root, globs, ignore) {
  const literal = globs.filter(g => !/[*?]/.test(g));
  const patterns = globs.filter(g => /[*?]/.test(g)).map(globToRegExp);
  const out = new Set(literal.filter(f => fs.existsSync(path.join(root, f))));
  if (!patterns.length) return [...out];
  const skip = new Set(ignore);
  const walk = rel => {
    let entries = [];
    try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!skip.has(e.name)) walk(r); }
      else if (patterns.some(p => p.test(r))) out.add(r);
    }
  };
  walk('');
  return [...out].sort();
}

// The body of one flow, as lines (a ```flow block, or flows.json turned into the same lines).
function parseFlowLines(name, source, lines, nodes) {
  const flow = { name, source, traces: [], declared: [], groups: [], loops: [], ends: [], start: [], sections: [] };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('start:')) {
      flow.start.push(...line.slice(6).split(',').map(s => s.trim()).filter(Boolean).map(r => nodes.nodeFromRef(r).id));
      continue;
    }
    if (line.startsWith('trace:')) {
      flow.traces.push(line.slice(6).trim().split(/\s+/));
      continue;
    }
    const named = /^(group|loop|end)\s+([^:]+):\s*(.+)$/.exec(line);
    if (named) {
      const refs = named[3].split(',').map(s => s.trim()).filter(Boolean);
      const label = named[2].trim();
      if (named[1] === 'group') flow.groups.push({ name: label, refs });
      else if (named[1] === 'end') flow.ends.push({ name: label, refs });
      else flow.loops.push({ name: label.replace(CONTAINS, ''), contains: CONTAINS.test(label), refs });
      continue;
    }
    const parts = line.split('->').map(s => s.trim()).filter(Boolean);
    if (parts.length < 2) continue;
    // `note.md#Heading` points at a section. The flow diagram treats the note as one node;
    // section hubs use the heading.
    const refs = parts.map(r => r.replace(/#.*$/, ''));
    const secs = parts.map(r => (r.includes('#') ? r.slice(r.indexOf('#') + 1) : null));
    for (let i = 0; i + 1 < refs.length; i++) {
      flow.declared.push([refs[i], refs[i + 1]]);
      if (secs[i] || secs[i + 1]) {
        flow.sections.push({ from: nodes.nodeFromRef(refs[i]).id, to: nodes.nodeFromRef(refs[i + 1]).id, fromSec: secs[i], toSec: secs[i + 1] });
      }
    }
  }
  return flow;
}

// ---- loopfinder/flows.json: what an AI agent writes after surveying the workspace ----
// The rules it follows are in AGENTS.md (written by loopfinder next to this file).
// Errors name the place (flows[2].loops[0].nodes), because the reader fixing it is usually an agent.
function flowsJsonToLines(f, at) {
  const fail = msg => { throw new Error(`${at}: ${msg}`); };
  const strings = (v, key) => {
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.some(x => typeof x !== 'string')) fail(`"${key}" must be a list of strings`);
    return v;
  };
  const refs = (list, key, field) => {
    if (list === undefined) return [];
    if (!Array.isArray(list)) fail(`"${key}" must be a list`);
    return list.map((x, i) => {
      if (!x || typeof x.name !== 'string' || !x.name.trim()) fail(`${key}[${i}] needs a "name"`);
      if (x.name.includes(':')) fail(`${key}[${i}].name must not contain ":"`);
      const nodes = strings(x[field], `${key}[${i}].${field}`);
      if (!nodes.length) fail(`${key}[${i}].${field} is empty`);
      return { name: x.name.trim(), nodes, contains: x.contains === true };
    });
  };
  const lines = [];
  for (const t of strings(f.trace, 'trace')) lines.push(`trace: ${t}`);
  const start = strings(f.start, 'start');
  if (start.length) lines.push(`start: ${start.join(', ')}`);
  for (const [i, e] of strings(f.edges, 'edges').entries()) {
    if (e.split('->').filter(s => s.trim()).length < 2) fail(`edges[${i}] needs at least one "->": ${e}`);
    lines.push(e);
  }
  for (const g of refs(f.groups, 'groups', 'nodes')) lines.push(`group ${g.name}: ${g.nodes.join(', ')}`);
  for (const l of refs(f.loops, 'loops', 'nodes')) lines.push(`loop ${l.name}${l.contains ? ' (contains)' : ''}: ${l.nodes.join(', ')}`);
  for (const e of refs(f.ends, 'ends', 'nodes')) lines.push(`end ${e.name}: ${e.nodes.join(', ')}`);
  return lines;
}

function parseFlowsJson(config, nodes) {
  if (!fs.existsSync(config.flowsFile)) return [];
  const rel = path.relative(config.root, config.flowsFile).replace(/\\/g, '/');
  let data;
  try { data = JSON.parse(fs.readFileSync(config.flowsFile, 'utf8')); } catch (e) { throw new Error(`${rel}: not valid JSON (${e.message})`); }
  if (!data || !Array.isArray(data.flows)) throw new Error(`${rel}: needs a top-level "flows" list`);
  return data.flows.map((f, i) => {
    const at = `${rel} flows[${i}]`;
    if (!f || typeof f.name !== 'string' || !/^[\w.-]+$/.test(f.name)) throw new Error(`${at}: "name" must be a short id (letters, digits, - _ .)`);
    const flow = parseFlowLines(f.name, rel, flowsJsonToLines(f, `${at} (${f.name})`), nodes);
    if (typeof f.about === 'string') flow.about = f.about;
    return flow;
  });
}

// Every flow: flows.json first, then any ```flow blocks listed in config.declarations.
function parseDeclarations(config, nodes) {
  const flows = parseFlowsJson(config, nodes);
  for (const rel of expandGlobs(config.root, config.declarations, config.ignore)) {
    const text = fs.readFileSync(path.join(config.root, rel), 'utf8');
    // Only fences at the start of a line, so ```flow quoted inside prose is not taken as a declaration.
    for (const m of text.matchAll(/^```flow[ \t]+([^\s`]+)[^\n]*\n([\s\S]*?)^```/gm)) {
      flows.push(parseFlowLines(m[1], rel, m[2].split('\n'), nodes));
    }
  }
  const seen = new Set();
  for (const f of flows) {
    if (seen.has(f.name)) throw new Error(`flow "${f.name}" is declared twice (the second is in ${f.source})`);
    seen.add(f.name);
  }
  return flows;
}

module.exports = { parseDeclarations, parseFlowLines, expandGlobs, globToRegExp };
