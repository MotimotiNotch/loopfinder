// Copies the CLI and the viewer into vscode/core/, so the packaged extension carries the same code as the
// npm package. Run before `vsce package` (npm run package does). core/ is build output, not in git.
'use strict';
const fs = require('fs');
const path = require('path');

const repo = path.join(__dirname, '..', '..');
const ext = path.join(__dirname, '..');
const core = path.join(ext, 'core');

fs.rmSync(core, { recursive: true, force: true });
for (const name of ['bin', 'src', 'public', 'trace', 'package.json']) {
  fs.cpSync(path.join(repo, name), path.join(core, name), { recursive: true, filter: src => !src.includes('__pycache__') });
}
for (const name of ['LICENSE', 'LICENSE-dagre', 'LICENSE-lucide']) {
  fs.copyFileSync(path.join(repo, name), path.join(ext, name));
}

// The extension's version follows the CLI's, so the AGENTS.md header and the marketplace agree.
const extPkg = JSON.parse(fs.readFileSync(path.join(ext, 'package.json'), 'utf8'));
const { version } = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
if (extPkg.version !== version) {
  extPkg.version = version;
  fs.writeFileSync(path.join(ext, 'package.json'), `${JSON.stringify(extPkg, null, 2)}\n`);
  console.log(`version -> ${version}`);
}
console.log(`copied the CLI into ${path.relative(repo, core)}`);
