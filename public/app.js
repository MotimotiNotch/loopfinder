// loopfinder viewer. Reads flow.json (written by `loopfinder build`) and draws each flow left to right
// with dagre. Only the loop you pick gets colour; everything else sinks. With three or more flows there is
// also an overview (overview.js): all flows on one 3D picture.

const SVG = 'http://www.w3.org/2000/svg';

let graph = null;
let current = null;      // name of the flow on screen, or OVERVIEW (overview.js)
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
  if (current === OVERVIEW) return renderOverview(canvas);
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

// The overview (overview.js): every flow overlaid, each file once, spread out in 3D by forces.
// Drag to rotate, wheel to zoom. The list shows flows instead of loops: picking a flow lights that flow;
// picking a node lights it and its neighbours.
const OVERVIEW_MIN_FLOWS = 3;   // with fewer flows, the per-flow diagrams already show everything
let overview = null;            // { parts, pos, degree }; the same data gives the same layout, so it is computed once per graph
let selectedFlow = null;        // the flow picked in the overview's list
let ovDraw = null;              // redraws the overview (after a rotation, a zoom or a resize)
const OV_DOT_REST = [1.5, 4];   // pause between trips when nothing is picked (seconds); shorter than in a flow, since the dots show direction
// The view on open: slightly from above, since straight on hides the depth.
const ovView = { yaw: 0.6, pitch: 0.35, zoom: 1 };
const OV_ROTATE = 0.006;        // radians per dragged px
const OV_PITCH_LIMIT = 1.45;    // stop before straight up, so the picture does not flip over
const OV_ZOOM = [0.5, 5];
const OV_CAMERA = 3;            // camera distance, in radii of the picture; closer exaggerates the perspective
let ovGeom = new Map();         // "from\u0000to" -> { s, c, t, fade } in the current projection (updated by ovDraw)
let ovDotList = [];             // dots moving in the overview
let ovLoop = 0;                 // requestAnimationFrame id

const overviewOffered = () => graph.flows.filter(f => f.kind !== 'hub').length >= OVERVIEW_MIN_FLOWS;

function renderOverview(canvas) {
  if (!overview) {
    const parts = overviewParts(graph);
    overview = { parts, ...layoutOverview(parts.nodes, parts.edges) };
  }
  const { parts: { nodes, edges }, pos } = overview;
  const R = Math.max(1, ...[...pos.values()].map(p => Math.hypot(p.x, p.y, p.z)));
  // Not the flow diagrams' zoom-and-scroll: the svg fills the frame and the picture turns inside it.
  document.getElementById('zoom-reset').hidden = true;
  const svg = el('svg', { class: 'overview' }, canvas);
  const edgeLayer = el('g', {}, svg);
  dotLayer = el('g', { class: 'dots', 'aria-hidden': 'true' }, svg);
  dotsFor = undefined;
  ovGeom = new Map();
  ovDotList = [];
  const nodeLayer = el('g', {}, svg);
  flowPaths = new Map();
  const sep = LANG === 'ja' ? '・' : ', ';
  // A mark grows with the number of flows through it (a shape, not a number; at most twice the size).
  const scaleOf = n => Math.min(2, 1 + 0.2 * (n.flows.length - 1));

  const edgeEls = edges.map(e => {
    const cls = `edge${e.declared ? ' declared' : ''}${e.calls ? ' calls' : ''}`;
    const path = el('path', { class: cls, 'data-from': e.from, 'data-to': e.to, 'data-flows': e.flows.join('\u0000') }, edgeLayer);
    el('title', {}, path).textContent = t('ov_edgeTitle', { from: labelOf(e.from), to: labelOf(e.to), flows: e.flows.join(sep) });
    // No arrowheads: the dots moving along the line show the direction.
    return { e, path };
  });
  const nodeEls = nodes.map(n => {
    // Names are always shown only on knots (nodes two or more flows pass through); the rest appear when lit.
    const g = el('g', { class: `node${n.flows.length > 1 ? ' labeled' : ''}`, 'data-id': n.id, tabindex: 0 }, nodeLayer);
    const mark = el('g', {}, g);
    drawMark(mark, { ...n, origin: false, deadEnd: false, intendedEnd: false });
    el('title', {}, g).textContent = t('ov_nodeTitle', { label: n.label, flows: n.flows.join(sep) });
    const label = el('text', { 'text-anchor': 'middle' }, g);
    label.textContent = n.label;
    g.addEventListener('click', () => selectNode(n.id));
    g.addEventListener('keydown', ev => { if (ev.key === 'Enter') selectNode(n.id); });
    return { n, g, mark, label, sc: scaleOf(n) };
  });
  const sizeOf = new Map(nodeEls.map(({ n, sc }) => [n.id, sc]));
  const trim = (p, q, r) => { const l = Math.hypot(q.x - p.x, q.y - p.y) || 1; return { x: p.x + (q.x - p.x) * r / l, y: p.y + (q.y - p.y) * r / l }; };

  ovDraw = () => {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    svg.setAttribute('width', w);
    svg.setAttribute('height', h);
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    const cy = Math.cos(ovView.yaw), sy = Math.sin(ovView.yaw), cp = Math.cos(ovView.pitch), sp = Math.sin(ovView.pitch);
    // Fit to the frame: at zoom 1 the picture's radius is 45% of the shorter side.
    const fit = (Math.min(w, h) * 0.45 / R) * ovView.zoom;
    const cam = R * OV_CAMERA;
    const proj = new Map();
    for (const [id, p] of pos) {
      // Yaw around the vertical axis, pitch around the horizontal one, then project with perspective.
      const x1 = p.x * cy + p.z * sy, z1 = -p.x * sy + p.z * cy;
      const y2 = p.y * cp - z1 * sp, z2 = p.y * sp + z1 * cp;
      const s = cam / (cam - z2);
      // depth: 0 at the back, 1 at the front. Farther things are fainter, so front and back can be told apart.
      proj.set(id, { x: w / 2 + x1 * fit * s, y: h / 2 + y2 * fit * s, s, depth: (z2 / R + 1) / 2 });
    }
    for (const { e, path } of edgeEls) {
      const a = proj.get(e.from), b = proj.get(e.to);
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
      // A slight bend: A→B and B→A do not overlap, and each bulges to the left of its direction.
      const bend = Math.min(24, len * 0.12);
      const c = { x: (a.x + b.x) / 2 + uy * bend, y: (a.y + b.y) / 2 - ux * bend };
      const s = trim(a, c, 8 * sizeOf.get(e.from) * a.s), tt = trim(b, c, 8 * sizeOf.get(e.to) * b.s + 3);
      const d = `M${s.x.toFixed(1)},${s.y.toFixed(1)} Q${c.x.toFixed(1)},${c.y.toFixed(1)} ${tt.x.toFixed(1)},${tt.y.toFixed(1)}`;
      const fade = (0.25 + 0.75 * (a.depth + b.depth) / 2).toFixed(2);
      path.setAttribute('d', d);
      path.setAttribute('opacity', fade);
      const key = `${e.from}\u0000${e.to}`;
      if (!e.calls) flowPaths.set(key, d);
      ovGeom.set(key, { s, c, t: tt, fade });
    }
    // Back to front, so nearer marks cover farther ones.
    const sorted = [...nodeEls].sort((p, q) => proj.get(p.n.id).depth - proj.get(q.n.id).depth);
    for (const { n, g, mark, label, sc } of sorted) {
      const p = proj.get(n.id);
      g.setAttribute('transform', `translate(${p.x.toFixed(1)},${p.y.toFixed(1)})`);
      g.setAttribute('opacity', (0.3 + 0.7 * p.depth).toFixed(2));
      // Marks change size a little with distance; names do not, so they stay readable at any depth.
      mark.setAttribute('transform', `scale(${(sc * p.s).toFixed(3)})`);
      label.setAttribute('y', (9 * sc * p.s + 10).toFixed(1));
      nodeLayer.appendChild(g);
    }
  };
  ovDraw();

  // Rotate and zoom; redraws are batched to one per frame.
  let pending = false;
  const schedule = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; if (current === OVERVIEW) ovDraw?.(); });
  };
  let swallowClick = false;
  svg.addEventListener('pointerdown', ev => {
    if (ev.button !== 0) return;
    // Not the drag-to-scroll of the flow diagrams: here a drag rotates.
    ev.stopPropagation();
    swallowClick = false;
    const start = { x: ev.clientX, y: ev.clientY, yaw: ovView.yaw, pitch: ovView.pitch };
    let dragged = false;
    const move = m => {
      const dx = m.clientX - start.x, dy = m.clientY - start.y;
      if (!dragged && Math.abs(dx) + Math.abs(dy) < DRAG_SLOP_PX) return;
      if (!dragged) { dragged = true; svg.classList.add('rotating'); }
      ovView.yaw = start.yaw + dx * OV_ROTATE;
      ovView.pitch = clamp(start.pitch - dy * OV_ROTATE, [-OV_PITCH_LIMIT, OV_PITCH_LIMIT]);
      schedule();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      svg.classList.remove('rotating');
      // Releasing a rotation over a node does not pick it.
      if (dragged) swallowClick = true;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
  svg.addEventListener('click', ev => {
    if (!swallowClick) return;
    swallowClick = false;
    ev.stopPropagation();
  }, true);
  svg.addEventListener('wheel', ev => {
    ev.preventDefault();
    ev.stopPropagation(); // keep it from the flow diagrams' zoom on the canvas
    const d = ev.deltaMode === 1 ? ev.deltaY * 16 : ev.deltaMode === 2 ? ev.deltaY * canvas.clientHeight : ev.deltaY;
    ovView.zoom = clamp(ovView.zoom * Math.exp(-d * (ev.ctrlKey ? PINCH_SENSITIVITY : WHEEL_SENSITIVITY)), OV_ZOOM);
    schedule();
  }, { passive: false });
  applyFocus();
}

function applyOverviewFocus(svg) {
  const { parts: { nodes, edges } } = overview;
  // A picked flow lights that flow; otherwise a picked node lights itself and its neighbours.
  let onEdge = () => false;
  const members = new Set();
  if (selectedFlow) {
    onEdge = p => p.dataset.flows.split('\u0000').includes(selectedFlow);
    nodes.forEach(n => { if (n.flows.includes(selectedFlow)) members.add(n.id); });
  } else if (selectedNode) {
    onEdge = p => p.dataset.from === selectedNode || p.dataset.to === selectedNode;
    members.add(selectedNode);
    for (const e of edges) if (e.from === selectedNode || e.to === selectedNode) { members.add(e.from); members.add(e.to); }
  }
  svg.classList.toggle('focus', members.size > 0);
  // When many nodes light up, only knots keep their names (dozens of names on top of each other cannot be read).
  svg.classList.toggle('many', members.size > 40);
  const lit = new Set();
  svg.querySelectorAll('.edge').forEach(p => {
    const on = onEdge(p) && !p.classList.contains('calls');
    p.classList.toggle('in-loop', on);
    if (on) lit.add(`${p.dataset.from}\u0000${p.dataset.to}`);
  });
  svg.querySelectorAll('.node').forEach(n => {
    n.classList.toggle('in-loop', members.has(n.dataset.id));
    n.classList.toggle('selected', n.dataset.id === selectedNode);
  });
  document.querySelectorAll('#loops button[data-flow]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.flow === selectedFlow)));
  // With nothing picked, a faint dot on every line; with a flow or node picked, amber dots on the lit lines only.
  // With reduced motion the idle dots are left out; the lit ones stay, since picking asked for them.
  const key = `${selectedFlow ?? ''}\u0000${selectedFlow ? '' : selectedNode ?? ''}\u0000${reducedMotion.matches}`;
  if (dotsFor === key) return;
  dotsFor = key;
  dotLayer.textContent = '';
  ovDotList = [];
  if (!lit.size && reducedMotion.matches) return;
  const now = performance.now() / 1000;
  const lines = lit.size ? [...lit] : [...flowPaths.keys()];
  ovDotList = lines.filter(k => ovGeom.has(k)).map(k => {
    const { s, c, t: e } = ovGeom.get(k);
    // Rough length of the quadratic curve (mean of the chord and the control polygon). Rotating changes the
    // length on screen; the crossing time stays as set here.
    const len = (Math.hypot(c.x - s.x, c.y - s.y) + Math.hypot(e.x - c.x, e.y - c.y) + Math.hypot(e.x - s.x, e.y - s.y)) / 2;
    const travel = clamp(len / DOT_SPEED, DOT_TRAVEL);
    const rest = lit.size ? LOOP_REST * 2 : OV_DOT_REST[0] + Math.random() * (OV_DOT_REST[1] - OV_DOT_REST[0]);
    const period = travel + rest;
    const cls = lit.size ? 'loop' : 'ambient';
    const dot = el('circle', { r: cls === 'loop' ? 2.6 : 2, class: `flow-dot ${cls}`, visibility: 'hidden' }, dotLayer);
    return { key: k, dot, travel, period, start: now - Math.random() * period };
  });
  stepOverviewDots();
}

// The overview's dots are moved every frame by script, not by SMIL: swapping an animateMotion path on every
// rotation made Chrome stop the dots there. The lines are quadratic curves, so a position is a formula.
// The loop stops when the overview is left or no dot is left.
function stepOverviewDots() {
  if (ovLoop) return;
  const tick = () => {
    ovLoop = 0;
    if (current !== OVERVIEW || !ovDotList.length) return;
    const now = performance.now() / 1000;
    for (const p of ovDotList) {
      const g = ovGeom.get(p.key);
      const phase = (((now - p.start) % p.period) + p.period) % p.period;
      // Hidden while resting, so dots do not pile up at the ends.
      if (!g || phase >= p.travel) { p.dot.setAttribute('visibility', 'hidden'); continue; }
      const u = phase / p.travel, v = 1 - u;
      p.dot.setAttribute('cx', (v * v * g.s.x + 2 * v * u * g.c.x + u * u * g.t.x).toFixed(1));
      p.dot.setAttribute('cy', (v * v * g.s.y + 2 * v * u * g.c.y + u * u * g.t.y).toFixed(1));
      // A dot on a far line is as faint as the line.
      p.dot.setAttribute('opacity', g.fade);
      p.dot.setAttribute('visibility', 'visible');
    }
    ovLoop = requestAnimationFrame(tick);
  };
  ovLoop = requestAnimationFrame(tick);
}

// Redraw when the frame changes size (the side pane opens or closes, the window is resized).
new ResizeObserver(() => { if (current === OVERVIEW) ovDraw?.(); }).observe(document.getElementById('canvas'));

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
  if (current === OVERVIEW) return applyOverviewFocus(svg);
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
  if (current === OVERVIEW) {
    // The overview lists flows. Dead ends and declaration mismatches belong to each flow's own diagram.
    for (const id of ['missing', 'dead-ends', 'intended-ends', 'stale-ends']) {
      const w = document.getElementById(id);
      w.hidden = true;
      w.textContent = '';
    }
    document.getElementById('list-title').textContent = t('list_flows');
    for (const f of overview.parts.flows) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.dataset.flow = f;
      b.setAttribute('aria-pressed', String(f === selectedFlow));
      const name = document.createElement('span');
      name.textContent = f;
      b.appendChild(name);
      b.addEventListener('click', () => {
        selectedFlow = selectedFlow === f ? null : f;
        applyFocus();
      });
      li.appendChild(b);
      list.appendChild(li);
    }
    return;
  }
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
  const kindText = n.kind === 'step' ? t('stepOf', { actor: n.actor }) : t(`kind_${n.kind}`);
  // Origins and ends are per flow, so the overview shows the kind only.
  k.textContent = current === OVERVIEW ? kindText : kindText + ((n.originIn || []).includes(current) ? t('originSuffix') : '') + (n.deadEnd ? t('deadEndSuffix') : '') + (n.intendedEnd ? t('intendedEndSuffix', { why: n.intendedEnd }) : '');
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
  if (current === OVERVIEW) {
    // Which flows pass through (a way into the per-flow diagrams), and what it is connected to.
    const { nodes, edges } = overview.parts;
    add(t('d_flows'), nodes.find(x => x.id === n.id)?.flows);
    add(t('d_from'), edges.filter(e => e.to === n.id).map(e => labelOf(e.from)));
    add(t('d_to'), edges.filter(e => e.from === n.id).map(e => labelOf(e.to)));
    box.appendChild(dl);
    return;
  }
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
  const ovOption = document.querySelector('#flow option[data-overview]');
  if (ovOption) ovOption.textContent = t('overview');
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
  // Inside VS Code the editor's display language comes before the config's; a choice made here wins over both.
  pickLang(host?.lang?.() || graph.lang);
  const select = document.getElementById('flow');
  fillFlows(select);
  // #flow=<name> opens that flow; #overview opens the overview (when it is offered). The overview has its own
  // word in the hash, so a flow that happens to be named "overview" still opens with #flow=overview.
  const fm = /flow=([^&]+)/.exec(location.hash);
  const want = fm && decodeURIComponent(fm[1]);
  current = /(^#|&)overview(&|$)/.test(location.hash) && overviewOffered() ? OVERVIEW
    : graph.flows.some(f => f.name === want) ? want : graph.flows[0]?.name;
  select.value = current;
  select.addEventListener('change', () => {
    current = select.value; selectedLoop = null; selectedNode = null; selectedFlow = null;
    render(); renderLoops(); renderDetail();
  });
  // #loop=<id> opens with that loop picked (only if it belongs to the flow on screen)
  const m = /loop=(\d+)/.exec(location.hash);
  if (m && graph.loops.some(l => l.id === Number(m[1]) && l.flow === current)) selectedLoop = Number(m[1]);
  document.getElementById('lang-toggle').addEventListener('click', () => { setLang(LANG === 'ja' ? 'en' : 'ja'); renderAll(); });
  host?.onGraph(replaceGraph);
  renderAll();
}

function fillFlows(select) {
  select.textContent = '';
  // The overview goes first in the list; the view on open is still the first flow.
  if (overviewOffered()) {
    const o = document.createElement('option');
    o.value = OVERVIEW; o.textContent = t('overview'); o.dataset.overview = '';
    select.appendChild(o);
  }
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
  overview = null;
  const select = document.getElementById('flow');
  fillFlows(select);
  if (current === OVERVIEW ? !overviewOffered() : !graph.flows.some(f => f.name === current)) current = graph.flows[0]?.name;
  select.value = current;
  if (!graph.flows.some(f => f.name === selectedFlow && f.kind !== 'hub')) selectedFlow = null;
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
