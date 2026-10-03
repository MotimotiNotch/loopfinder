/**
 * loopfinder trace hook for Node. Loaded with `node -r trace.js <script>` by `loopfinder build`.
 *
 * The script really runs; this hook records what it reads, writes, fetches and spawns.
 *   - Writes are NOT performed: every fs write API (sync, callback, promise, stream) is recorded and
 *     dropped. A file opened for writing is opened on the null device instead.
 *   - Network and subprocesses are blocked unless LOOPFINDER_ALLOW_NETWORK / LOOPFINDER_ALLOW_SUBPROCESS
 *     is set. When blocked, the call is recorded and then fails, so the script sees an error.
 *   - Not covered: native addons, worker threads, and anything that bypasses the fs/net/child_process
 *     modules. This is a recorder, not a sandbox.
 *
 * Who did it is the nearest stack frame in a file under LOOPFINDER_ROOT (not this hook, not node_modules).
 * The record is written to LOOPFINDER_OUT on exit (the only real write).
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const ROOT = String(process.env.LOOPFINDER_ROOT || process.cwd()).replace(/\\/g, '/').replace(/\/$/, '');
const OUT = process.env.LOOPFINDER_OUT;
const ALLOW_NET = !!process.env.LOOPFINDER_ALLOW_NETWORK;
const ALLOW_EXEC = !!process.env.LOOPFINDER_ALLOW_SUBPROCESS;
const LEVEL = '#'.repeat(Number(process.env.LOOPFINDER_HEADING_LEVEL || 2));
const SELF = __filename.replace(/\\/g, '/');
const events = [];

// The same folder can be reached by two spellings (a Windows short name like RUNNER~1, a symlink).
// ES module stack frames carry the real path, so it is mapped back onto ROOT as it was given.
const REAL_ROOT = (() => {
  try { return fs.realpathSync.native(ROOT).replace(/\\/g, '/').replace(/\/$/, ''); } catch { return ROOT; }
})();
const toRoot = f => (REAL_ROOT !== ROOT && (f === REAL_ROOT || f.startsWith(`${REAL_ROOT}/`)) ? ROOT + f.slice(REAL_ROOT.length) : f);
const norm = p => toRoot(path.resolve(String(p instanceof URL ? p.pathname.replace(/^\/([A-Za-z]:)/, '$1') : p)).replace(/\\/g, '/'));
const underRoot = f => f === ROOT || f.startsWith(`${ROOT}/`);

function caller() {
  const stack = new Error().stack.split('\n').slice(2);
  for (const line of stack) {
    // "at fn (/a/b.js:1:2)", "at /a/b.js:1:2", "at async /a/b.js:1:2" or a file:// URL. Without the
    // parentheses, the leading "at " must not become part of a POSIX path.
    const m = /(?:\(|^at (?:async )?)(?:file:\/\/(?:\/(?=[A-Za-z]:))?)?((?:[A-Za-z]:)?[^():]+\.(?:js|mjs|cjs|ts)):\d+:\d+\)?$/.exec(line.trim());
    if (!m) continue;
    const file = norm(m[1]);
    if (file === SELF || file.includes('/node_modules/')) continue;
    if (underRoot(file)) return file;
  }
  return null;
}

function record(kind, target, extra) {
  const by = caller();
  if (!by) return;
  const t = kind === 'fetch' || kind === 'exec' ? String(target) : norm(target);
  events.push({ by, kind, target: t, ...extra });
}
const isPath = p => typeof p === 'string' || p instanceof URL || Buffer.isBuffer(p);

// ---- what a Markdown write would change, by heading (for section hubs) ----
const orig = {};
for (const k of ['readFileSync', 'writeFileSync', 'openSync', 'writeSync', 'closeSync', 'createWriteStream', 'open']) orig[k] = fs[k];
const origPromises = { open: fs.promises.open };

function splitSections(raw) {
  const text = String(raw).replace(/\r\n/g, '\n');
  const out = new Map();
  const fm = /^---\n[\s\S]*?\n---/.exec(text);
  if (fm) out.set('frontmatter', fm[0]);
  const body = fm ? text.slice(fm[0].length) : text;
  const re = new RegExp(`^${LEVEL} (.+?)\\s*$`);
  let head = '(before the first heading)';
  for (const line of body.split('\n')) {
    const m = re.exec(line);
    if (m) { head = m[1]; out.set(head, ''); continue; }
    out.set(head, (out.get(head) || '') + line + '\n');
  }
  return out;
}
function changedSections(p, data, append) {
  if (!String(p).endsWith('.md')) return undefined;
  let before = '';
  try { before = orig.readFileSync.call(fs, p, 'utf8'); } catch { /* new file */ }
  const after = append ? before + String(data) : String(data);
  const a = splitSections(before), b = splitSections(after);
  return [...new Set([...a.keys(), ...b.keys()])].filter(k => a.get(k) !== b.get(k));
}

// ---- reads ----
for (const name of ['readFileSync', 'existsSync', 'statSync', 'lstatSync', 'readdirSync', 'createReadStream', 'readFile', 'readdir', 'stat', 'lstat']) {
  const fn = fs[name];
  if (typeof fn !== 'function') continue;
  fs[name] = function (p, ...rest) {
    if (isPath(p)) record('read', name.startsWith('readdir') ? `${norm(p)}/` : p);
    return fn.call(this, p, ...rest);
  };
}
for (const name of ['readFile', 'readdir', 'stat', 'lstat', 'access']) {
  const fn = fs.promises[name];
  if (typeof fn !== 'function') continue;
  fs.promises[name] = function (p, ...rest) {
    if (isPath(p)) record('read', name === 'readdir' ? `${norm(p)}/` : p);
    return fn.call(this, p, ...rest);
  };
}

// ---- writes: recorded, never performed ----
const WRITE_FLAGS = /[wa+]/;
const isWriteFlag = f => (typeof f === 'string' ? WRITE_FLAGS.test(f)
  : typeof f === 'number' ? (f & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_TRUNC)) !== 0 : false);

// [name, which argument is the target, does it carry data (for heading diffs), is it an append]
const WRITERS = [
  ['writeFile', 0, true, false], ['appendFile', 0, true, true],
  ['rename', 1], ['unlink', 0], ['rm', 0], ['rmdir', 0], ['mkdir', 0, false, false, 'silent'],
  ['copyFile', 1], ['cp', 1], ['truncate', 0], ['symlink', 1], ['link', 1],
  ['chmod', 0], ['chown', 0], ['utimes', 0], ['lchown', 0], ['lutimes', 0],
];
function recordWrite(name, args, spec) {
  const [, at, data, append, silent] = spec;
  if (silent) return; // creating a folder writes no data
  const target = args[at];
  if (!isPath(target)) return;
  if (name === 'copyFile' || name === 'cp') record('read', args[0]);
  record('write', target, data ? { sections: changedSections(norm(target), args[1], append) } : undefined);
}
for (const spec of WRITERS) {
  const [name] = spec;
  if (typeof fs[`${name}Sync`] === 'function') {
    fs[`${name}Sync`] = function (...args) { recordWrite(name, args, spec); return undefined; };
  }
  if (typeof fs[name] === 'function') {
    fs[name] = function (...args) {
      recordWrite(name, args, spec);
      const cb = args.reverse().find(a => typeof a === 'function');
      if (cb) process.nextTick(cb, null);
    };
  }
  if (typeof fs.promises[name] === 'function') {
    fs.promises[name] = async function (...args) { recordWrite(name, args, spec); };
  }
}
const fakeTemp = prefix => `${prefix}loopfinder-blocked`;
fs.mkdtempSync = prefix => fakeTemp(prefix);
fs.mkdtemp = (prefix, ...rest) => { const cb = rest.reverse().find(a => typeof a === 'function'); if (cb) process.nextTick(cb, null, fakeTemp(prefix)); };
fs.promises.mkdtemp = async prefix => fakeTemp(prefix);

// Opening for write gives a handle on the null device, so later fd writes go nowhere.
fs.openSync = function (p, flags, ...rest) {
  if (isPath(p) && isWriteFlag(flags)) { record('write', p); return orig.openSync.call(fs, os.devNull, 'w'); }
  if (isPath(p)) record('read', p);
  return orig.openSync.call(fs, p, flags, ...rest);
};
fs.open = function (p, flags, ...rest) {
  if (isPath(p) && isWriteFlag(flags)) { record('write', p); return orig.open.call(fs, os.devNull, 'w', ...rest.filter(a => typeof a === 'function')); }
  if (isPath(p)) record('read', p);
  return orig.open.call(fs, p, flags, ...rest);
};
fs.promises.open = function (p, flags, ...rest) {
  if (isPath(p) && isWriteFlag(flags)) { record('write', p); return origPromises.open.call(fs.promises, os.devNull, 'w'); }
  if (isPath(p)) record('read', p);
  return origPromises.open.call(fs.promises, p, flags, ...rest);
};
fs.createWriteStream = function (p) {
  if (isPath(p)) record('write', p);
  return orig.createWriteStream.call(fs, os.devNull);
};

// ---- network ----
const netError = what => Object.assign(new Error(`loopfinder: network is blocked (${what}); rerun with --allow-network to let it through`), { code: 'ELOOPFINDER_NET' });
// The default port is left out, so `{ port: 443 }` and a plain https URL name the same place.
const DEFAULT_PORT = { 'http:': '80', 'https:': '443' };
const urlOf = (proto, opts) => (typeof opts === 'string' ? opts : opts instanceof URL ? opts.href
  : `${proto}//${opts.hostname || opts.host || 'localhost'}${opts.port && String(opts.port) !== DEFAULT_PORT[proto] ? `:${opts.port}` : ''}${opts.path || '/'}`);

// fetch and http(s).request open their own socket underneath. That socket is the same request,
// so a host already recorded as a URL is not recorded again as tcp://host:port.
const urlHosts = new Set();
function recordUrl(url) {
  record('fetch', url);
  try {
    const u = new URL(url);
    urlHosts.add(`${u.hostname}:${u.port || DEFAULT_PORT[u.protocol]}`);
  } catch { /* not a URL */ }
}

if (globalThis.fetch) {
  const origFetch = globalThis.fetch;
  globalThis.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    recordUrl(url);
    if (!ALLOW_NET) return Promise.reject(netError(url));
    return origFetch.call(this, input, init);
  };
}
for (const [modName, proto] of [['http', 'http:'], ['https', 'https:']]) {
  const mod = require(modName);
  for (const name of ['request', 'get']) {
    const fn = mod[name];
    mod[name] = function (opts, ...rest) {
      const url = urlOf(proto, opts);
      recordUrl(url);
      if (!ALLOW_NET) throw netError(url);
      return fn.call(this, opts, ...rest);
    };
  }
}
for (const [modName, names] of [['net', ['connect', 'createConnection']], ['tls', ['connect']]]) {
  const mod = require(modName);
  for (const name of names) {
    const fn = mod[name];
    mod[name] = function (...args) {
      const o = typeof args[0] === 'object' ? args[0] : { port: args[0], host: typeof args[1] === 'string' ? args[1] : 'localhost' };
      const target = o.path ? `unix:${o.path}` : `tcp://${o.host || 'localhost'}:${o.port}`;
      if (!urlHosts.has(`${o.host || 'localhost'}:${o.port}`)) record('fetch', target);
      if (!ALLOW_NET) throw netError(target);
      return fn.apply(this, args);
    };
  }
}

// ---- subprocesses ----
const cp = require('child_process');
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  const fn = cp[name];
  cp[name] = function (cmd, ...rest) {
    const argv = Array.isArray(rest[0]) ? [cmd, ...rest[0]] : String(cmd).split(/\s+/);
    record('exec', path.basename(String(argv[0])));
    if (!ALLOW_EXEC) throw Object.assign(new Error(`loopfinder: subprocesses are blocked (${argv[0]}); rerun with --allow-subprocess to let them run`), { code: 'ELOOPFINDER_EXEC' });
    return fn.call(this, cmd, ...rest);
  };
}

// ---- require: a module under the root returns data to its caller ----
const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id.includes('/') || id.includes('\\')) {
    try {
      const resolved = norm(Module._resolveFilename(id, this));
      if (underRoot(resolved) && !resolved.includes('/node_modules/')) record('require', resolved);
    } catch { /* unresolved */ }
  }
  return origRequire.apply(this, arguments);
};

// ES modules that `import { writeFileSync } from 'fs'` hold their own bindings; push the patches into them.
Module.syncBuiltinESMExports();

process.on('exit', () => {
  if (!OUT) return;
  // Not orig.writeFileSync: in newer Node (22.23 and 18) it opens the file through fs.openSync, which is
  // the hooked one, so the record itself went to the null device and was lost.
  const fd = orig.openSync.call(fs, OUT, 'w');
  try { orig.writeSync.call(fs, fd, JSON.stringify({ entry: norm(process.argv[1] || ''), args: process.argv.slice(2), events }, null, 2)); }
  finally { orig.closeSync.call(fs, fd); }
});
