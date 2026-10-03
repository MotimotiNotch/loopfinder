// The trace hooks must not change anything on disk, and must block network and subprocesses by default.
// Each test makes a scratch workspace, runs a script that tries every kind of write it can,
// and checks that the files are byte-for-byte the same afterwards and that the attempts were recorded.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const TRACE_JS = path.join(__dirname, '..', 'trace', 'trace.js');
const TRACE_PY = path.join(__dirname, '..', 'trace', 'trace.py');

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loopfinder-test-'));
  fs.writeFileSync(path.join(dir, 'note.md'), '# Note\n\n## Tasks\n- a\n\n## Log\n- b\n');
  fs.writeFileSync(path.join(dir, 'data.json'), '{"n":1}\n');
  fs.mkdirSync(path.join(dir, 'keep'));
  fs.writeFileSync(path.join(dir, 'keep', 'inner.txt'), 'inner\n');
  return dir;
}

// A fingerprint of every file and folder under dir.
function snapshot(dir) {
  const out = {};
  const walk = rel => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (r === 'trace.json') continue;
      if (e.isDirectory()) { out[`${r}/`] = 'dir'; walk(r); }
      else out[r] = crypto.createHash('sha1').update(fs.readFileSync(path.join(dir, r))).digest('hex');
    }
  };
  walk('');
  return out;
}

function run(cmd, args, dir, env = {}) {
  const out = path.join(dir, 'trace.json');
  const r = spawnSync(cmd, args, {
    cwd: dir, encoding: 'utf8', timeout: 60000,
    env: { ...process.env, LOOPFINDER_OUT: out, LOOPFINDER_ROOT: dir, ...env },
  });
  assert.ok(fs.existsSync(out),
    `no trace written (status ${r.status}, signal ${r.signal}, error ${r.error?.message}). stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  return { r, trace: JSON.parse(fs.readFileSync(out, 'utf8')) };
}

const JS_WRITER = `
const fs = require('fs');
const done = [];
const tryIt = (name, f) => { try { f(); done.push(name); } catch (e) { done.push(name + ':threw:' + e.code); } };
tryIt('writeFileSync', () => fs.writeFileSync('note.md', '# Note\\n\\n## Tasks\\n- CHANGED\\n\\n## Log\\n- b\\n'));
tryIt('appendFileSync', () => fs.appendFileSync('data.json', 'x'));
tryIt('renameSync', () => fs.renameSync('data.json', 'moved.json'));
tryIt('unlinkSync', () => fs.unlinkSync('data.json'));
tryIt('rmSync', () => fs.rmSync('keep', { recursive: true, force: true }));
tryIt('mkdirSync', () => fs.mkdirSync('newdir'));
tryIt('copyFileSync', () => fs.copyFileSync('data.json', 'copy.json'));
tryIt('truncateSync', () => fs.truncateSync('data.json', 0));
tryIt('openSync+writeSync', () => { const fd = fs.openSync('data.json', 'w'); fs.writeSync(fd, 'zzz'); fs.closeSync(fd); });
tryIt('createWriteStream', () => { const s = fs.createWriteStream('stream.txt'); s.write('x'); s.end(); });
tryIt('mkdtempSync', () => fs.mkdtempSync('tmp-'));
fs.writeFile('cb.txt', 'x', () => {});
fs.unlink('keep/inner.txt', () => {});
(async () => {
  await fs.promises.writeFile('promise.txt', 'x');
  await fs.promises.rm('keep', { recursive: true, force: true });
  await fs.promises.rename('note.md', 'renamed.md');
  const h = await fs.promises.open('data.json', 'w'); await h.write('y'); await h.close();
  const text = fs.readFileSync('note.md', 'utf8');
  let net = 'not tried', exec = 'not tried';
  // Only under the hook: the positive control runs this file bare and must not reach the internet.
  if (process.env.LOOPFINDER_OUT) {
    try { await fetch('https://example.com/x'); net = 'went through'; } catch (e) { net = e.code || e.message; }
    try { require('child_process').execSync('echo hi'); exec = 'went through'; } catch (e) { exec = e.code || e.message; }
    try { require('https').get('https://example.com/y'); } catch (e) { /* blocked */ }
  }
  console.log(JSON.stringify({ done, net, exec, read: text.length }));
})();
`;

const JS_ESM = `
import { writeFileSync, rmSync } from 'fs';
import { writeFile } from 'fs/promises';
writeFileSync('note.md', 'esm overwrite');
rmSync('keep', { recursive: true, force: true });
await writeFile('data.json', 'esm promise');
`;

test('node hook: no write of any kind reaches the disk', () => {
  const dir = scratch();
  fs.writeFileSync(path.join(dir, 'writer.js'), JS_WRITER);
  const before = snapshot(dir);
  const { r, trace } = run(process.execPath, ['-r', TRACE_JS, 'writer.js'], dir);
  assert.deepStrictEqual(snapshot(dir), before);
  const result = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.strictEqual(result.net, 'ELOOPFINDER_NET');
  assert.strictEqual(result.exec, 'ELOOPFINDER_EXEC');
  const kinds = new Set(trace.events.map(e => e.kind));
  for (const k of ['read', 'write', 'fetch', 'exec']) assert.ok(kinds.has(k), `no ${k} event recorded`);
  const noteWrite = trace.events.find(e => e.kind === 'write' && e.target.endsWith('/note.md') && e.sections);
  assert.deepStrictEqual(noteWrite.sections, ['Tasks'], 'the changed heading is recorded');
  assert.ok(trace.events.every(e => e.by.endsWith('/writer.js')), 'every event is attributed to the script');
});

test('node hook: ES module named imports are covered too', () => {
  const dir = scratch();
  fs.writeFileSync(path.join(dir, 'esm.mjs'), JS_ESM);
  const before = snapshot(dir);
  const { trace } = run(process.execPath, ['-r', TRACE_JS, 'esm.mjs'], dir);
  assert.deepStrictEqual(snapshot(dir), before);
  assert.ok(trace.events.some(e => e.kind === 'write' && e.target.endsWith('/note.md')));
});

test('node hook: --allow-network lets fetch through (it is only recorded)', () => {
  const dir = scratch();
  fs.writeFileSync(path.join(dir, 'net.js'), `
    const http = require('http');
    const srv = http.createServer((q, s) => s.end('ok')).listen(0, async () => {
      const port = srv.address().port;
      const r = await fetch('http://127.0.0.1:' + port + '/');
      console.log(await r.text());
      // https goes through tls.connect underneath (the handshake against a plain server fails; that is fine)
      require('https').request({ host: '127.0.0.1', port, path: '/b' }).on('error', () => srv.close()).end();
    });`);
  const { r, trace } = run(process.execPath, ['-r', TRACE_JS, 'net.js'], dir, { LOOPFINDER_ALLOW_NETWORK: '1' });
  assert.match(r.stdout, /ok/);
  const fetches = trace.events.filter(e => e.kind === 'fetch').map(e => e.target);
  assert.strictEqual(fetches.length, 2, `one record per request, not one more for its socket: ${fetches}`);
  assert.ok(fetches.every(t => /^https?:\/\/127\.0\.0\.1:/.test(t)));
});

test('node hook: an explicit default port does not change the recorded URL', () => {
  const dir = scratch();
  fs.writeFileSync(path.join(dir, 'port.js'), `
    try { require('https').request({ hostname: 'example.com', port: 443, path: '/x' }); } catch { /* blocked */ }`);
  const { trace } = run(process.execPath, ['-r', TRACE_JS, 'port.js'], dir);
  assert.deepStrictEqual(trace.events.filter(e => e.kind === 'fetch').map(e => e.target), ['https://example.com/x']);
});

const PY_WRITER = `
import os, shutil, sqlite3, pathlib, subprocess, urllib.request
done = []
def try_it(name, f):
    try:
        f(); done.append(name)
    except Exception as e:
        done.append(name + ':threw:' + type(e).__name__)
try_it('open w', lambda: open('note.md', 'w', encoding='utf-8').write('# Note\\n\\n## Tasks\\n- CHANGED\\n\\n## Log\\n- b\\n'))
try_it('open a', lambda: open('data.json', 'a').write('x'))
try_it('pathlib write_text', lambda: pathlib.Path('data.json').write_text('pathlib'))
try_it('pathlib unlink', lambda: pathlib.Path('data.json').unlink())
try_it('pathlib mkdir', lambda: pathlib.Path('newdir').mkdir())
try_it('pathlib touch', lambda: pathlib.Path('touched.txt').touch())
try_it('os.remove', lambda: os.remove('data.json'))
try_it('os.rename', lambda: os.rename('data.json', 'moved.json'))
try_it('os.open', lambda: os.write(os.open('data.json', os.O_WRONLY | os.O_TRUNC), b'zz'))
try_it('shutil.rmtree', lambda: shutil.rmtree('keep'))
try_it('shutil.copy', lambda: shutil.copy('data.json', 'copy.json'))
try_it('shutil.move', lambda: shutil.move('data.json', 'moved2.json'))
def sql():
    c = sqlite3.connect('db.sqlite'); c.execute('create table t(x)'); c.commit()
try_it('sqlite', sql)
net = 'not tried'
ex = 'not tried'
# Only under the hook: the positive control runs this file bare and must not reach the internet.
if os.environ.get('LOOPFINDER_OUT'):
    try:
        urllib.request.urlopen('https://example.com/x'); net = 'went through'
    except Exception as e:
        net = type(e).__name__
    try:
        subprocess.run(['echo', 'hi']); ex = 'went through'
    except Exception as e:
        ex = type(e).__name__
import json; print(json.dumps({'done': done, 'net': net, 'exec': ex}))
`;

// Positive controls: the same scripts without the hook DO change the files.
// Without these, a broken snapshot (or a script that writes nothing) would make the tests above pass.
test('control: the node writer changes files when run without the hook', () => {
  const dir = scratch();
  fs.writeFileSync(path.join(dir, 'writer.js'), JS_WRITER);
  const before = snapshot(dir);
  spawnSync(process.execPath, ['writer.js'], { cwd: dir, encoding: 'utf8', timeout: 60000 });
  assert.notDeepStrictEqual(snapshot(dir), before);
});

test('control: the python writer changes files when run without the hook', { skip: !pythonAvailable() && 'python not found' }, () => {
  const dir = scratch();
  fs.writeFileSync(path.join(dir, 'writer.py'), PY_WRITER);
  const before = snapshot(dir);
  spawnSync('python', ['writer.py'], { cwd: dir, encoding: 'utf8', timeout: 60000 });
  assert.notDeepStrictEqual(snapshot(dir), before);
});

function pythonAvailable() {
  const r = spawnSync('python', ['--version'], { encoding: 'utf8' });
  return r.status === 0;
}

test('python hook: no write of any kind reaches the disk', { skip: !pythonAvailable() && 'python not found' }, () => {
  const dir = scratch();
  fs.writeFileSync(path.join(dir, 'writer.py'), PY_WRITER);
  const before = snapshot(dir);
  const { r, trace } = run('python', [TRACE_PY, 'writer.py'], dir);
  assert.deepStrictEqual(snapshot(dir), before, `files changed. stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  const result = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.strictEqual(result.net, 'NetworkBlocked');
  assert.strictEqual(result.exec, 'SubprocessBlocked');
  const noteWrite = trace.events.find(e => e.kind === 'write' && e.target.endsWith('/note.md') && e.sections);
  assert.deepStrictEqual(noteWrite.sections, ['Tasks']);
  for (const k of ['write', 'fetch', 'exec']) assert.ok(trace.events.some(e => e.kind === k), `no ${k} event recorded`);
});

// Plain `import` does not go through the patched functions, but stdlib/library code that scans the
// interpreter's own folders (sysconfig, pkgutil, numpy's init...) does, and its frames resolve to the script.
test('python hook: the interpreter\'s own files are not recorded as the script reading them', { skip: !pythonAvailable() && 'python not found' }, () => {
  const dir = scratch();
  fs.writeFileSync(path.join(dir, 'imports.py'), 'import os, sysconfig, pkgutil\nsysconfig.get_config_vars()\nlist(pkgutil.iter_modules())\nlist(os.walk("keep"))\nopen("data.json").read()\n');
  const homes = spawnSync('python', ['-c', 'import sys;print("\\n".join({sys.prefix, sys.base_prefix}))'], { encoding: 'utf8' })
    .stdout.trim().split(/\r?\n/).map(p => p.replace(/\\/g, '/').replace(/\/$/, '') + '/');
  const { trace } = run('python', [TRACE_PY, 'imports.py'], dir);
  const leaked = trace.events.filter(e => homes.some(h => (e.target + '/').startsWith(h)));
  assert.deepStrictEqual(leaked, [], 'interpreter files leaked into the record');
  assert.ok(trace.events.some(e => e.kind === 'read' && e.target.endsWith('/data.json')), 'the script\'s own read is still recorded');
  // os.walk lives in <frozen os>; resolved against the root it used to become the author
  assert.deepStrictEqual([...new Set(trace.events.map(e => e.by.split('/').pop()))], ['imports.py']);
});
