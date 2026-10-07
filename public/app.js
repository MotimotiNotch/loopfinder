// loopfinder viewer. Reads flow.json (written by `loopfinder build`) and draws each flow left to right
// with dagre. Only the loop you pick gets colour; everything else sinks.

const SVG = 'http://www.w3.org/2000/svg';

let graph = null;
let current = null;      // name of the flow on screen
let selectedLoop = null; // id of the picked loop
let selectedNode = null;
let flowPaths = new Map(); // "from\u0000to" -> drawn path d (the track dots move along)
let dotLayer = null;
let dotsFor;               // which loop the moving dots belong to (picking a node does not redraw them)

// Set by the VS Code extension (vscode/media/host.js): it hands over the graph, sends a new one after
// every build, and opens a file in the editor. In a browser it is absent and flow.json is fetched.
const host = window.loopfinderHost || null;

// Dots moving along edges. Away from the picked loop they are faint and sparse, so the screen stays calm.
const DOT_SPEED = 40;            // px per second
const DOT_TRAVEL = [1.5, 5];     // seconds to cross one edge (min, max), so long arcs are not always busy
const DOT_REST = [6, 12];        // pause between trips when nothing is picked (seconds)
const LOOP_TRAVEL = [3, 18];     // seconds for one round of a picked loop (min, max)
const LOOP_REST = 1.2;           // pause between rounds of a picked loop (seconds)
const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

function el(name, attrs = {}, parent) {
  const e = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}

function drawMark(g, node) {
  const kind = node.kind;
  if (kind === 'web') el('circle', { r: 6, class: 'mark-web' }, g);
  else if (kind === 'script') el('rect', { x: -5, y: -5, width: 10, height: 10, class: 'mark-script' }, g);
  else if (kind === 'repo') el('rect', { x: -6, y: -6, width: 12, height: 12, class: 'mark-repo' }, g);
  else if (kind === 'step') {
    // Your steps are filled, AI steps hollow, anyone else's dashed (so a visitor is not read as an AI).
    const k = node.actorKind || 'ai';
    el('path', { d: 'M0,-7 L7,0 L0,7 L-7,0 Z', class: `mark-step-${k}` }, g);
  } else if (kind === 'section') {
    // A hub item: a short wide frame, like one line of a note.
    el('rect', { x: -9, y: -4, width: 18, height: 8, rx: 2, class: 'mark-section' }, g);
  } else el('circle', { r: 5, class: 'mark-file' }, g);
  if (node.origin) el('path', { d: 'M-22,-5 L-16,0 L-22,5', class: 'origin-tick' }, g);
  // A dead end gets a short wall on the side the data would leave from.
  if (node.deadEnd) el('path', { d: 'M15,-6 L15,6', class: 'deadend-tick' }, g);
  else if (node.intendedEnd) el('path', { d: 'M15,-6 L15,6', class: 'deadend-tick intended' }, g);
}

function render() {
  const canvas = document.getElementById('canvas');
  canvas.textContent = '';
  const parts = flowParts(graph, current);
  const { nodes, edges, back, groups } = parts;
  const g = layoutFlow(parts, graph.layout?.[current]);

  const { width, height: h0 } = g.graph();
  // Room below for the feedback arcs (an arc's depth grows with the distance it spans).
  const arcs = [...back].map(i => {
    const e = edges[i], a = g.node(e.from), b = g.node(e.to);
    const depth = 24 + Math.abs(a.x - b.x) * 0.18;
    return { i, a, b, depth };
  });
  const height = h0 + Math.max(0, ...arcs.map(r => Math.max(r.a.y, r.b.y) + r.depth - h0 + 20));
  const svg = el('svg', { width, height, viewBox: `0 0 ${width} ${height}` }, canvas);
  zoom.reset(width, height);
  const groupLayer = el('g', {}, svg);
  for (const gr of groups) {
    const b = g.node(gr.id);
    const box = el('g', { class: 'group', 'data-id': gr.id }, groupLayer);
    el('rect', { x: b.x - b.width / 2, y: b.y - b.height / 2 - 6, width: b.width, height: b.height, rx: 8, class: 'group-frame' }, box);
    const tx = el('text', { x: b.x - b.width / 2 + 10, y: b.y - b.height / 2 + 8, class: 'group-label' }, box);
    tx.textContent = gr.label;
  }
  const edgeLayer = el('g', {}, svg);
  dotLayer = el('g', { class: 'dots', 'aria-hidden': 'true' }, svg);
  dotsFor = undefined;
  const nodeLayer = el('g', {}, svg);
  flowPaths = new Map();
  // A call is not data flowing, so no dots move along it.
  const keepPath = (e, d) => { if (e.kind !== 'calls') flowPaths.set(`${e.from}\u0000${e.to}`, d); };

  const arrowHead = (tip, ang, e) => {
    const s = 5;
    el('path', {
      d: `M${tip.x},${tip.y} L${tip.x - s * Math.cos(ang - 0.45)},${tip.y - s * Math.sin(ang - 0.45)} L${tip.x - s * Math.cos(ang + 0.45)},${tip.y - s * Math.sin(ang + 0.45)} Z`,
      class: `arrow ${e.kind === 'calls' ? 'calls' : ''}`, 'data-from': e.from, 'data-to': e.to,
    }, edgeLayer);
  };
  const addTitle = (p, e, isBack) => {
    const how = t(`how_${e.how || (e.source === 'trace' ? 'trace' : 'declared')}`);
    const extra = (e.kind === 'calls' ? t('extra_call') : '') + (isBack ? t('extra_back') : '');
    el('title', {}, p).textContent = t('edgeTitle', { from: labelOf(e.from), to: labelOf(e.to), how, extra });
  };

  edges.forEach((e, i) => {
    if (back.has(i)) return;
    // Marks are drawn 6px above the node centre; edges follow.
    const pts = g.edge(e.from, e.to, `e${i}`).points.map(p => ({ x: p.x, y: p.y - 6 }));
    const d = pts.map((p, j) => `${j ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    addTitle(el('path', { d, class: `edge ${e.kind}`, 'data-from': e.from, 'data-to': e.to }, edgeLayer), e, false);
    keepPath(e, d);
    const a = pts[pts.length - 1], b = pts[pts.length - 2];
    const ang = Math.atan2(a.y - b.y, a.x - b.x);
    arrowHead({ x: a.x - Math.cos(ang) * 9, y: a.y - Math.sin(ang) * 9 }, ang, e);
  });

  for (const { i, a, b, depth } of arcs) {
    const e = edges[i];
    const y1 = a.y + 8, y2 = b.y + 8; // leaves below one mark, comes back below the other
    const d = `M${a.x},${y1} C${a.x},${y1 + depth} ${b.x},${y2 + depth} ${b.x},${y2}`;
    addTitle(el('path', { d, class: `edge ${e.kind} back`, 'data-from': e.from, 'data-to': e.to }, edgeLayer), e, true);
    keepPath(e, d);
    arrowHead({ x: b.x, y: y2 + 2 }, -Math.PI / 2, e);
  }

  for (const n of nodes) {
    const pos = g.node(n.id);
    const ng = el('g', { class: 'node', transform: `translate(${pos.x},${pos.y - 6})`, 'data-id': n.id, tabindex: 0 }, nodeLayer);
    drawMark(ng, n);
    const label = el('text', { y: 22, 'text-anchor': 'middle' }, ng);
    label.textContent = n.label;
    // Second line: who does the step, and in hub views which flow it comes from.
    const second = [n.kind === 'step' ? n.actor : null, n.sub].filter(Boolean).join(' · ');
    if (second) {
      const actor = el('text', { y: 35, 'text-anchor': 'middle', class: 'actor' }, ng);
      actor.textContent = second;
    }
    ng.addEventListener('click', () => selectNode(n.id));
    ng.addEventListener('keydown', ev => { if (ev.key === 'Enter') selectNode(n.id); });
  }
  applyFocus();
}

function labelOf(id) {
  return graph.nodes.find(n => n.id === id)?.label || graph.groups?.find(gr => gr.id === id)?.label || id;
}

function loopEdges(loop) {
  const pairs = new Set();
  for (const p of loop.paths) p.forEach((id, i) => pairs.add(`${id}\u0000${p[(i + 1) % p.length]}`));
  return pairs;
}

function applyFocus() {
  const svg = document.querySelector('#canvas svg');
  if (!svg) return;
  svg.classList.toggle('focus', selectedLoop !== null);
  const loop = graph.loops.find(l => l.id === selectedLoop);
  const pairs = loop ? loopEdges(loop) : new Set();
  const members = new Set(loop ? loop.paths.flat() : []);
  svg.querySelectorAll('.edge, .arrow').forEach(p => {
    const on = pairs.has(`${p.dataset.from}\u0000${p.dataset.to}`) && !p.classList.contains('calls');
    p.classList.toggle('in-loop', on);
  });
  svg.querySelectorAll('.group').forEach(gr => {
    const inner = graph.groups.find(x => x.id === gr.dataset.id)?.members || [];
    gr.classList.toggle('in-loop', inner.some(id => members.has(id)));
  });
  svg.querySelectorAll('.node').forEach(n => {
    n.classList.toggle('in-loop', members.has(n.dataset.id));
    n.classList.toggle('selected', n.dataset.id === selectedNode);
  });
  document.querySelectorAll('#loops button').forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.id) === selectedLoop)));
  animateDots(loop);
}

function pathLength(d) {
  const p = el('path', { d }, dotLayer);
  const len = p.getTotalLength();
  p.remove();
  return len;
}

// One dot along d: it crosses in `travel` seconds, every `period` seconds (hidden while it waits).
function addDot(d, travel, period, begin, cls) {
  const dot = el('circle', { r: cls === 'loop' ? 2.6 : 2, class: `flow-dot ${cls}` }, dotLayer);
  const f = (travel / period).toFixed(4);
  el('animateMotion', {
    path: d, dur: `${period}s`, begin: `${begin}s`, repeatCount: 'indefinite',
    calcMode: 'linear', keyPoints: '0;1;1', keyTimes: `0;${f};1`,
  }, dot);
  el('animate', {
    attributeName: 'opacity', dur: `${period}s`, begin: `${begin}s`, repeatCount: 'indefinite',
    calcMode: 'discrete', values: '1;0', keyTimes: `0;${f}`,
  }, dot);
}

function animateDots(loop) {
  if (!dotLayer) return;
  const key = `${loop?.id ?? ''}:${reducedMotion.matches}`;
  if (dotsFor === key) return;
  dotsFor = key;
  dotLayer.textContent = '';
  const now = dotLayer.ownerSVGElement.getCurrentTime();
  if (!loop) {
    // With reduced motion, no background movement. The dots around a picked loop stay:
    // you asked for them, and they are how the loop is shown.
    if (reducedMotion.matches) return;
    for (const d of flowPaths.values()) {
      const travel = clamp(pathLength(d) / DOT_SPEED, DOT_TRAVEL);
      const period = travel + DOT_REST[0] + Math.random() * (DOT_REST[1] - DOT_REST[0]);
      addDot(d, travel, period, now - Math.random() * period, 'ambient');
    }
    return;
  }
  // A picked loop: one dot per path, all leaving the same node together, so shared stretches look like one dot.
  const common = loop.paths[0].find(id => loop.paths.every(p => p.includes(id)));
  const routes = loop.paths.map(p => {
    const k = common ? p.indexOf(common) : 0;
    const r = [...p.slice(k), ...p.slice(0, k)];
    const ds = r.map((id, i) => flowPaths.get(`${id}\u0000${r[(i + 1) % r.length]}`)).filter(Boolean);
    return { d: ds.join(' '), len: ds.reduce((a, d) => a + pathLength(d), 0) };
  }).filter(r => r.d);
  if (!routes.length) return;
  const longest = Math.max(...routes.map(r => r.len));
  const speed = longest / clamp(longest / (DOT_SPEED * 1.5), LOOP_TRAVEL);
  const period = longest / speed + LOOP_REST;
  for (const r of routes) addDot(r.d, r.len / speed, period, now, 'loop');
}

function renderLoops() {
  const list = document.getElementById('loops');
  list.textContent = '';
  const loops = graph.loops.filter(l => l.flow === current);
  const flow = graph.flows.find(f => f.name === current);
  document.getElementById('list-title').textContent = t(flow?.list === 'sections' ? 'list_sections' : flow?.list === 'items' ? 'list_items' : 'list_loops');
  for (const l of loops) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.dataset.id = l.id;
    // Length as dots, not a number: how many nodes the loop passes (the shortest path when there are several).
    // For hub items: how many things touch it.
    const len = l.kind === 'section'
      ? Math.min(6, new Set(l.paths.flat()).size - 1)
      : Math.min(...l.paths.map(p => p.length));
    const dots = el('svg', { viewBox: '0 0 28 14', 'aria-hidden': 'true' });
    for (let i = 0; i < len; i++) el('circle', { cx: 3 + i * 4.4, cy: 7, r: 1.6 }, dots);
    b.appendChild(dots);
    const name = document.createElement('span');
    name.textContent = l.name || t('unnamed');
    if (!l.name) name.className = 'unnamed';
    b.appendChild(name);
    b.title = l.paths.map(p => [...p, p[0]].map(labelOf).join(' → ')).join('\n');
    b.addEventListener('click', () => {
      selectedLoop = selectedLoop === l.id ? null : l.id;
      applyFocus();
    });
    li.appendChild(b);
    list.appendChild(li);
  }
  const missing = document.getElementById('missing');
  const lost = graph.missingLoops.filter(m => m.startsWith(`${current}: `)).map(m => m.slice(current.length + 2));
  missing.hidden = lost.length === 0;
  missing.textContent = lost.length ? t('missing', { list: lost.join(LANG === 'ja' ? '、' : ', ') }) : '';
  const ends = document.getElementById('dead-ends');
  const here = graph.nodes.filter(n => n.deadEnd && (n.flows || []).includes(current)).map(n => n.label);
  ends.hidden = here.length === 0;
  ends.textContent = here.length ? t('deadEnds', { list: here.join(LANG === 'ja' ? '、' : ', ') }) : '';
  // Ends the user declared as meant to stay unread are listed quietly; one that is read again is a warning.
  const sep = LANG === 'ja' ? '、' : ', ';
  const meant = document.getElementById('intended-ends');
  const kept = graph.nodes.filter(n => n.intendedEnd && (n.flows || []).includes(current)).map(n => (LANG === 'ja' ? `${n.label}（${n.intendedEnd}）` : `${n.label} (${n.intendedEnd})`));
  meant.hidden = kept.length === 0;
  meant.textContent = kept.length ? t('intendedEnds', { list: kept.join(sep) }) : '';
  const stale = document.getElementById('stale-ends');
  const gone = (graph.staleEnds || []).filter(s => s.startsWith(`${current}: `)).map(s => s.slice(current.length + 2));
  stale.hidden = gone.length === 0;
  stale.textContent = gone.length ? t('staleEnds', { list: gone.join(sep) }) : '';
}

function evidenceText(ev) {
  const how = t(`how_${ev.how}`);
  const dir = t(`dir_${ev.dir}`);
  return ev.target ? t('ev_side', { dir, target: ev.target, how }) : t('ev_hub', { flow: ev.flow, node: ev.node, dir, how });
}

function selectNode(id) {
  selectedNode = selectedNode === id ? null : id;
  renderDetail();
  applyFocus();
}

function renderDetail() {
  const box = document.getElementById('detail');
  const n = graph.nodes.find(x => x.id === selectedNode);
  box.hidden = !n;
  box.textContent = '';
  if (!n) return;
  const h = document.createElement('h3'); h.textContent = n.label; box.appendChild(h);
  const k = document.createElement('p'); k.className = 'kind';
  k.textContent = (n.kind === 'step' ? t('stepOf', { actor: n.actor }) : t(`kind_${n.kind}`)) + ((n.originIn || []).includes(current) ? t('originSuffix') : '') + (n.deadEnd ? t('deadEndSuffix') : '') + (n.intendedEnd ? t('intendedEndSuffix', { why: n.intendedEnd }) : '');
  box.appendChild(k);
  const dl = document.createElement('dl');
  // With a host that can open files, paths become buttons; the host decides whether the path is a file.
  const value = (parent, v, openable) => {
    if (!openable || !host?.open) { parent.textContent = v; return; }
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'open-file'; b.textContent = v; b.title = t('openFile');
    b.addEventListener('click', () => host.open(v));
    parent.appendChild(b);
  };
  const add = (term, values, openable = false) => {
    if (!values || values.length === 0) return;
    const dt = document.createElement('dt'); dt.textContent = term; dl.appendChild(dt);
    const dd = document.createElement('dd');
    if (values.length === 1) value(dd, values[0], openable);
    else { const ul = document.createElement('ul'); for (const v of values) { const li = document.createElement('li'); value(li, v, openable); ul.appendChild(li); } dd.appendChild(ul); }
    dl.appendChild(dd);
  };
  add(t('d_location'), n.path ? [n.path] : null, n.kind === 'script' || n.kind === 'file');
  add(t('d_files'), n.files, true);
  add(t('d_frame'), n.groupBy?.[current] ? [labelOf(n.groupBy[current])] : null);
  // Reads folded into the scan node: only counts per top-level folder are kept.
  add(t('d_folded'), n.foldedBy?.[current] ? Object.entries(n.foldedBy[current]).sort((a, b) => b[1] - a[1]).map(([f, c]) => `${f}  ${t('d_count', { n: c })}`) : null);
  add(t('d_urls'), n.urls ? [...n.urls, ...(n.urlCount > n.urls.length ? [t('d_more', { n: n.urlCount - n.urls.length })] : [])] : null);
  add(t('d_evidence'), n.evidence?.length ? n.evidence.map(evidenceText) : null);
  const inLoops = graph.loops.filter(l => l.flow === current && l.kind !== 'section' && l.paths.some(p => p.includes(n.id))).map(l => l.name || t('unnamed'));
  add(t('d_loops'), inLoops);
  box.appendChild(dl);
}

function renderGenerated() {
  document.getElementById('generated').textContent = t('generated', {
    time: new Date(graph.generatedAt).toLocaleString(LANG === 'ja' ? 'ja-JP' : 'en-GB', { dateStyle: 'short', timeStyle: 'short' }),
  });
}

function renderAll() {
  applyStaticText();
  document.getElementById('lang-name').textContent = t('lang');
  sideToggle.refresh();
  themeToggle.refresh();
  renderGenerated();
  render();
  renderLoops();
  renderDetail();
  applyFocus();
}

// Puts the Lucide SVG into every element marked data-icon.
function fillIcons() {
  document.querySelectorAll('[data-icon]').forEach(e => { e.innerHTML = ICONS[e.dataset.icon] || ''; });
}

async function main() {
  fillIcons();
  graph = host ? await host.load() : await (await fetch('flow.json', { cache: 'no-store' })).json();
  pickLang(graph.lang);
  const select = document.getElementById('flow');
  fillFlows(select);
  // #flow=<name> opens that flow
  const fm = /flow=([^&]+)/.exec(location.hash);
  const want = fm && decodeURIComponent(fm[1]);
  current = graph.flows.some(f => f.name === want) ? want : graph.flows[0]?.name;
  select.value = current;
  select.addEventListener('change', () => { current = select.value; selectedLoop = null; selectedNode = null; render(); renderLoops(); renderDetail(); });
  // #loop=<id> opens with that loop picked (only if it belongs to the flow on screen)
  const m = /loop=(\d+)/.exec(location.hash);
  if (m && graph.loops.some(l => l.id === Number(m[1]) && l.flow === current)) selectedLoop = Number(m[1]);
  document.getElementById('lang-toggle').addEventListener('click', () => { setLang(LANG === 'ja' ? 'en' : 'ja'); renderAll(); });
  host?.onGraph(replaceGraph);
  renderAll();
}

function fillFlows(select) {
  select.textContent = '';
  for (const f of graph.flows) {
    const o = document.createElement('option');
    o.value = f.name; o.textContent = f.name;
    select.appendChild(o);
  }
}

// A rebuilt graph keeps the flow on screen. Loop ids are renumbered by every build, so the picked loop
// is kept only if a loop with the same name is still there; the picked node is kept if it still exists.
function replaceGraph(next) {
  const loopName = graph.loops.find(l => l.id === selectedLoop)?.name;
  graph = next;
  const select = document.getElementById('flow');
  fillFlows(select);
  if (!graph.flows.some(f => f.name === current)) current = graph.flows[0]?.name;
  select.value = current;
  selectedLoop = loopName ? graph.loops.find(l => l.flow === current && l.name === loopName)?.id ?? null : null;
  if (!graph.nodes.some(n => n.id === selectedNode)) selectedNode = null;
  renderAll();
}

// Drag the diagram to scroll. A small move counts as a drag, and the click that ends a drag is swallowed
// so it does not select the node under the pointer. Mouse only; touch already scrolls.
const DRAG_SLOP_PX = 4;
function enableDragScroll(canvas) {
  let dragEndPending = false;
  const onScrollbar = e => {
    const r = canvas.getBoundingClientRect();
    return e.clientX - r.left >= canvas.clientWidth || e.clientY - r.top >= canvas.clientHeight;
  };
  canvas.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'mouse' || e.button !== 0 || onScrollbar(e)) return;
    dragEndPending = false;
    const start = { x: e.clientX, y: e.clientY, left: canvas.scrollLeft, top: canvas.scrollTop };
    let dragged = false;
    const move = ev => {
      const dx = ev.clientX - start.x, dy = ev.clientY - start.y;
      if (!dragged && Math.abs(dx) + Math.abs(dy) < DRAG_SLOP_PX) return;
      if (!dragged) { dragged = true; canvas.classList.add('dragging'); }
      canvas.scrollLeft = start.left - dx;
      canvas.scrollTop = start.top - dy;
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      canvas.classList.remove('dragging');
      if (dragged) dragEndPending = true;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
  canvas.addEventListener('mousedown', e => { if (e.button === 0 && !onScrollbar(e)) e.preventDefault(); });
  canvas.addEventListener('click', e => {
    if (!dragEndPending) return;
    dragEndPending = false;
    e.stopPropagation();
  }, true);
}

// Wheel to zoom: the svg is resized (its viewBox stays), and the scroll is adjusted so the point
// under the pointer stays put. The diagram sits on a stage with room around it, so even when it is
// smaller than the window it can be dragged anywhere (KEEP_VISIBLE_PX of it always stays in view).
const MIN_SCALE = 0.3;
const MAX_SCALE = 3;
const WHEEL_SENSITIVITY = 0.0015;
const PINCH_SENSITIVITY = 0.01; // pinch arrives as ctrl+wheel with much smaller deltas
const KEEP_VISIBLE_PX = 48;
const zoom = (() => {
  const canvas = document.getElementById('canvas');
  const button = document.getElementById('zoom-reset');
  let k = 1, baseW = 0, baseH = 0, padX = 0, padY = 0;
  const svgOf = () => canvas.querySelector('.flow-stage > svg');
  const layoutStage = svg => {
    const stage = svg.parentNode;
    stage.style.width = `${baseW * k + padX * 2}px`;
    stage.style.height = `${baseH * k + padY * 2}px`;
    svg.style.left = `${padX}px`;
    svg.style.top = `${padY}px`;
  };
  const applyPad = svg => {
    padX = Math.max(0, canvas.clientWidth - KEEP_VISIBLE_PX);
    padY = Math.max(0, canvas.clientHeight - KEEP_VISIBLE_PX);
    layoutStage(svg);
  };
  const home = () => { canvas.scrollLeft = padX; canvas.scrollTop = padY; };
  const set = (next, px, py) => {
    const svg = svgOf();
    if (!svg) return;
    const c = canvas.getBoundingClientRect();
    const before = svg.getBoundingClientRect();
    const cx = (c.left + px - before.left) / k, cy = (c.top + py - before.top) / k;
    k = next;
    svg.setAttribute('width', baseW * k);
    svg.setAttribute('height', baseH * k);
    layoutStage(svg);
    const after = svg.getBoundingClientRect();
    canvas.scrollLeft += after.left - (c.left + px - cx * k);
    canvas.scrollTop += after.top - (c.top + py - cy * k);
    button.hidden = k === 1;
    button.textContent = `${Math.round(k * 100)}%`;
  };
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const d = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * canvas.clientHeight : e.deltaY;
    const next = clamp(k * Math.exp(-d * (e.ctrlKey ? PINCH_SENSITIVITY : WHEEL_SENSITIVITY)), [MIN_SCALE, MAX_SCALE]);
    if (next === k) return;
    const r = canvas.getBoundingClientRect();
    set(next, e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });
  button.addEventListener('click', () => { set(1, 0, 0); home(); });
  new ResizeObserver(() => {
    const svg = svgOf();
    if (!svg) return;
    const ox = padX, oy = padY;
    applyPad(svg);
    canvas.scrollLeft += padX - ox;
    canvas.scrollTop += padY - oy;
  }).observe(canvas);
  return {
    reset(w, h) {
      k = 1; baseW = w; baseH = h; button.hidden = true;
      const svg = canvas.querySelector('svg');
      if (!svg) return;
      const stage = document.createElement('div');
      stage.className = 'flow-stage';
      canvas.insertBefore(stage, svg);
      stage.appendChild(svg);
      applyPad(svg);
      home();
    },
  };
})();

// Theme: auto (follow the system) -> light -> dark -> auto. The choice is kept per browser.
// Auto removes the attribute, so the CSS media query decides. Inside VS Code, auto follows the editor's
// theme instead, which the media query does not see.
const themeToggle = (() => {
  const KEY = 'loopfinder:theme';
  const ORDER = ['auto', 'light', 'dark'];
  const button = document.getElementById('theme-toggle');
  let theme = 'auto';
  try { theme = ORDER.includes(localStorage.getItem(KEY)) ? localStorage.getItem(KEY) : 'auto'; } catch { /* storage unavailable */ }
  const apply = () => {
    const shown = theme === 'auto' ? host?.theme?.() : theme;
    if (shown) document.documentElement.setAttribute('data-theme', shown);
    else document.documentElement.removeAttribute('data-theme');
  };
  host?.onTheme?.(apply);
  const ICON = { auto: 'sun-moon', light: 'sun', dark: 'moon' };
  const refresh = () => {
    const name = t(`theme_${theme}`);
    // The icon shows the current state; the name is in the tooltip and the accessible label.
    button.innerHTML = ICONS[ICON[theme]];
    button.title = t('themeTitle', { name });
    button.setAttribute('aria-label', button.title);
  };
  apply();
  button.addEventListener('click', () => {
    theme = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length];
    apply();
    refresh();
    try { localStorage.setItem(KEY, theme); } catch { /* storage unavailable */ }
  });
  return { refresh };
})();

// Show or hide the side pane; the choice is kept per browser.
const sideToggle = (() => {
  const KEY = 'loopfinder:side-hidden';
  const button = document.getElementById('side-toggle');
  const layout = document.querySelector('.layout');
  let hidden = false;
  try { hidden = localStorage.getItem(KEY) === '1'; } catch { /* storage unavailable */ }
  const refresh = () => {
    layout.classList.toggle('side-hidden', hidden);
    button.setAttribute('aria-pressed', String(!hidden));
    button.innerHTML = ICONS[hidden ? 'panel-right-open' : 'panel-right-close'];
    const label = t(hidden ? 'showList' : 'hideList');
    button.title = label;
    button.setAttribute('aria-label', label);
  };
  button.addEventListener('click', () => {
    hidden = !hidden;
    refresh();
    try { localStorage.setItem(KEY, hidden ? '1' : '0'); } catch { /* storage unavailable */ }
  });
  return { refresh };
})();

reducedMotion.addEventListener?.('change', () => { dotsFor = undefined; applyFocus(); });
enableDragScroll(document.getElementById('canvas'));
main();
