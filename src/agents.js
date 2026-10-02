// Writes loopfinder/AGENTS.md: the rules an AI agent follows to survey the workspace and write flows.json.
// loopfinder has no AI built in. The survey is done by whatever agent the user already works with;
// this file is how it learns the judgement calls that the files alone do not show.
// It is rewritten on every run (so it follows the installed version) and loopfinder never reads it back.
'use strict';
const fs = require('fs');
const path = require('path');
const { version } = require('../package.json');

const TEMPLATE = path.join(__dirname, 'agents-guide.md');

function agentsGuide() {
  return [
    `> Written by loopfinder ${version} every time it runs. Edits are overwritten on the next run; deleting it is fine.`,
    '',
    fs.readFileSync(TEMPLATE, 'utf8').replace(/\r\n/g, '\n'),
  ].join('\n');
}

// Returns the path, and whether the file changed.
function writeAgentsGuide(config) {
  const file = path.join(path.dirname(config.flowsFile), 'AGENTS.md');
  const text = agentsGuide();
  let current = null;
  try { current = fs.readFileSync(file, 'utf8'); } catch { /* not there yet */ }
  if (current === text) return { file, changed: false };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return { file, changed: true };
}

module.exports = { writeAgentsGuide, agentsGuide };
