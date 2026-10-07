// Renders media/icon.svg to icon.png (256px, transparent corners) with headless Chrome or Edge.
// Run by hand when the SVG changes; icon.png is committed.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const SIZE = 256;
const ext = path.join(__dirname, '..');
const browsers = [
  process.env.CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);
const browser = browsers.find(b => fs.existsSync(b));
if (!browser) { console.error('no Chrome/Edge found; set CHROME=<path>'); process.exit(1); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loopfinder-icon-'));
const svg = fs.readFileSync(path.join(ext, 'media', 'icon.svg'), 'utf8').replace(/<!--[\s\S]*?-->\s*/, '');
const page = path.join(tmp, 'icon.html');
fs.writeFileSync(page, `<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block;width:${SIZE}px;height:${SIZE}px}</style>${svg}`);
const out = path.join(ext, 'icon.png');
const r = spawnSync(browser, ['--headless', '--disable-gpu', '--hide-scrollbars', '--default-background-color=00000000',
  `--window-size=${SIZE},${SIZE}`, `--screenshot=${out}`, `--user-data-dir=${path.join(tmp, 'profile')}`, pathToFileURL(page).href],
  { encoding: 'utf8', timeout: 60000 });
fs.rmSync(tmp, { recursive: true, force: true });
if (!fs.existsSync(out)) { console.error(r.stderr); process.exit(1); }
console.log(`wrote ${path.relative(process.cwd(), out)}`);
