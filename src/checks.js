// Extra checks that run after a build. Each module in config.checks exports a function:
//
//   module.exports = (ctx) => ({ title: 'Templates load', warnings: ['...'] })
//
// ctx = { config, graph }. A check is the place for workspace-specific rules
// ("every page of my site appears in the declaration", "no script in this folder runs on import").
'use strict';

async function runChecks(config, graph, log = console.log) {
  const results = [];
  for (const file of config.checks) {
    let result;
    try {
      const check = require(file);
      result = await (typeof check === 'function' ? check : check.default)({ config, graph });
    } catch (e) {
      result = { title: file, warnings: [`the check itself failed: ${e.message}`] };
    }
    results.push(result);
    const w = result.warnings || [];
    log(`${result.title}: ${w.length ? `${w.length} warning(s)` : 'ok'}`);
    for (const m of w) log(`  ! ${m}`);
  }
  return results;
}

module.exports = { runChecks };
