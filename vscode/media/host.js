// The bridge between the viewer (public/app.js) and the extension. Loaded before app.js, which looks for
// window.loopfinderHost: the graph comes by message instead of fetch('flow.json'), a rebuilt graph comes
// the same way, a path click opens the file in the editor, "auto" theme follows the editor's theme, and the
// editor's display language is the default language.
(() => {
  const vscode = acquireVsCodeApi();
  let waiting = null;  // load() before the first graph arrived
  let onGraph = null;  // later graphs (after a build)
  let lang = null;     // the editor's display language, e.g. "ja" or "en-us"

  window.addEventListener('message', e => {
    const m = e.data;
    if (!m || m.type !== 'graph') return;
    if (typeof m.lang === 'string') lang = m.lang.split('-')[0];
    if (waiting) { const resolve = waiting; waiting = null; resolve(m.graph); }
    else if (onGraph) onGraph(m.graph);
  });

  // VS Code marks the theme on <body>: vscode-light, vscode-dark, vscode-high-contrast(-light).
  const theme = () => {
    const c = document.body.classList;
    if (c.contains('vscode-light') || c.contains('vscode-high-contrast-light')) return 'light';
    if (c.contains('vscode-dark') || c.contains('vscode-high-contrast')) return 'dark';
    return null;
  };

  window.loopfinderHost = {
    load() {
      return new Promise(resolve => { waiting = resolve; vscode.postMessage({ type: 'ready' }); });
    },
    onGraph(fn) { onGraph = fn; },
    open(path) { vscode.postMessage({ type: 'open', path }); },
    lang: () => lang,
    theme,
    onTheme(fn) { new MutationObserver(fn).observe(document.body, { attributes: true, attributeFilter: ['class'] }); },
  };
})();
