'use strict';
// VCD Waveform Viewer webview: signal tree, signal rows (DOM, virtual) and the waveform (canvas).
// All data comes from the extension host by postMessage. No network.
const F = require('./format');
const { unpackSignals } = require('../core/pack');

const vscode = acquireVsCodeApi();
const T0 = performance.now();
const ROW_HEIGHTS = { compact: 20, normal: 24, large: 30 };
const TREE_ROW = 22;
const RADIXES = [['hex', 'Hex'], ['bin', 'Binary'], ['unsigned', 'Unsigned'], ['signed', 'Signed'], ['ascii', 'ASCII'], ['real', 'Real']];

// ---------- DOM helpers ----------
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'text') e.textContent = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids) if (c !== null && c !== undefined) e.append(c);
  return e;
}
const btn = (label, title, act, extra = {}) => h('button', { type: 'button', title, 'data-act': act, ...extra }, label);
const sep = () => h('span', { class: 'sep' });

// ---------- state ----------
const S = {
  name: '', size: 0, sizeText: '', settings: { defaultRadix: 'hex', initialSignals: 64, rowHeight: 'normal' },
  header: null, index: null, error: null, warnings: [],
  rows: [], // {uid, kind:'var'|'bus', v, bits, alias, radix}
  data: new Map(), // id code index -> loaded signal
  pending: new Set(),
  sel: new Set(), // row uids
  focus: null, // row uid
  view: { t0: 0, t1: 1 }, cursor: null, markers: { a: null, b: null },
  treeOpen: true, expanded: new Set(), treeSel: new Set(), treeFocus: -1, search: '',
  savedLayout: null, restoreView: null,
  progress: null, loadProgress: null,
  timing: { header: null, indexed: null, firstDraw: null, lastLoadMs: null },
  rendered: false, reqId: 0, uid: 1,
};
let pathIndex = null; // path -> var index
let fsPerTick = 1e6;
let ROW_H = 24;

// ---------- layout ----------
const app = document.getElementById('app');
app.textContent = '';
const ui = {};
ui.radix = h('select', { class: 'radix', 'aria-label': 'Radix', title: 'How the selected signals show their values' },
  ...RADIXES.map(([v, l]) => h('option', { value: v }, l)));
ui.times = h('span', { class: 'times', 'aria-live': 'polite' });
ui.toolbar = h('div', { class: 'toolbar', role: 'toolbar' },
  btn('Signals', 'Show or hide the signal tree (T)', 'tree', { 'aria-pressed': 'true' }), sep(),
  btn('−', 'Zoom out (-, or Ctrl/Cmd + wheel)', 'zoomOut', { class: 'icon' }), btn('+', 'Zoom in (+, or Ctrl/Cmd + wheel)', 'zoomIn', { class: 'icon' }),
  btn('Fit', 'Show the whole time range (F)', 'fit'), btn('Zoom A–B', 'Zoom to the range between marker A and marker B', 'zoomAB'), sep(),
  btn('◀ Edge', 'Move the cursor to the previous change of the selected signal (Left arrow)', 'prevEdge'),
  btn('Edge ▶', 'Move the cursor to the next change of the selected signal (Right arrow)', 'nextEdge'),
  btn('Set A', 'Put marker A at the cursor (A)', 'setA'), btn('Set B', 'Put marker B at the cursor (B)', 'setB'), sep(),
  ui.radix,
  btn('Bus', 'Group the selected bit signals into one bus, or split a selected bus (G)', 'bus'),
  btn('Rename', 'Give the selected signal a short name (F2)', 'rename'),
  btn('Remove', 'Remove the selected signals from the view (Delete)', 'remove'), sep(),
  btn('Export', 'Save the signal list, radixes and names as a JSON file', 'export'),
  btn('Import', 'Load a signal list from a JSON file', 'import'),
  h('span', { class: 'grow' }), ui.times);

ui.search = h('input', { class: 'search', type: 'search', placeholder: 'Search signals', 'aria-label': 'Search signals', spellcheck: 'false' });
ui.treeInfo = h('span', { class: 'tree-info' });
ui.addSel = btn('Add', 'Add the selected signals (Enter). Double-click a signal to add it.', 'addSel');
ui.addAll = btn('Add all', 'Add every signal in the list below', 'addAll');
ui.treeRows = h('div', { class: 'tree-rows', role: 'tree', 'aria-label': 'Signals in the file' });
ui.treeSpacer = h('div', { class: 'tree-spacer' });
ui.treeScroll = h('div', { class: 'tree-scroll', tabindex: '0' }, ui.treeSpacer, ui.treeRows);
ui.treePanel = h('div', { class: 'tree-panel' }, ui.search, h('div', { class: 'tree-actions' }, ui.addSel, ui.addAll, ui.treeInfo), ui.treeScroll);
ui.splitter = h('div', { class: 'splitter', title: 'Drag to resize' });

ui.ruler = h('canvas', { class: 'ruler', 'aria-label': 'Time ruler' });
ui.namesHead = h('div', { class: 'names-head' }, h('span', { class: 'n-name' }, 'Signal'), h('span', { class: 'n-val' }, 'Value'));
ui.head = h('div', { class: 'wave-head' }, ui.namesHead, ui.ruler);
ui.names = h('div', { class: 'names', role: 'listbox', 'aria-label': 'Shown signals', 'aria-multiselectable': 'true' });
ui.waves = h('canvas', { class: 'waves', tabindex: '0', 'aria-label': 'Waveforms. Click to place the cursor, drag to pan, Shift+drag to zoom to a range.' });
ui.namesSplit = h('div', { class: 'names-split', title: 'Drag to resize' });
ui.rowsView = h('div', { class: 'rows-view' }, ui.names, ui.namesSplit, ui.waves);
ui.rowsSpacer = h('div', { class: 'rows-spacer' });
ui.rowsScroll = h('div', { class: 'rows-scroll' }, ui.rowsView, ui.rowsSpacer);
ui.hthumb = h('div', { class: 'hthumb' });
ui.hbar = h('div', { class: 'hbar', title: 'Drag to move through time' }, ui.hthumb);
ui.empty = h('div', { class: 'empty', hidden: true });
ui.notice = h('div', { class: 'notice', hidden: true, role: 'alert' });
ui.progress = h('div', { class: 'progress', hidden: true }, h('div', { class: 'bar' }), h('span', { class: 'ptext' }));
ui.wavePanel = h('div', { class: 'wave-panel' }, ui.head, ui.rowsScroll, ui.hbar, ui.empty, ui.notice, ui.progress);
ui.warn = h('div', { class: 'warnbar', hidden: true });
ui.toast = h('div', { class: 'toast', hidden: true, role: 'status' });
ui.hint = h('span', { class: 'hint' });
ui.info = h('span', { class: 'info' });
ui.status = h('div', { class: 'status' }, ui.hint, h('span', { class: 'grow' }), ui.info);
app.append(ui.toolbar, ui.warn, h('div', { class: 'main' }, ui.treePanel, ui.splitter, ui.wavePanel), ui.status, ui.toast);
const supportLine = document.getElementById('zovo-support');
if (supportLine) { supportLine.classList.remove('zovo-support-fixed'); ui.status.append(supportLine); }
document.documentElement.style.setProperty('--tree-w', '260px');
document.documentElement.style.setProperty('--names-w', '300px');

// ---------- colours (from the VS Code theme) ----------
let C = {};
function readColors() {
  const cs = getComputedStyle(document.body);
  const v = (n, fb) => (cs.getPropertyValue(n).trim() || fb);
  const light = document.body.classList.contains('vscode-light') || document.body.classList.contains('vscode-high-contrast-light');
  C = {
    light,
    bg: v('--vscode-editor-background', light ? '#ffffff' : '#1e1e1e'),
    fg: v('--vscode-editor-foreground', light ? '#333333' : '#cccccc'),
    dim: v('--vscode-descriptionForeground', light ? '#717171' : '#9d9d9d'),
    wave: v('--vscode-charts-green', light ? '#388a34' : '#89d185'),
    bus: v('--vscode-charts-blue', light ? '#1a85ff' : '#3794ff'),
    x: v('--vscode-charts-red', light ? '#e51400' : '#f14c4c'),
    z: v('--vscode-charts-yellow', light ? '#bf8803' : '#cca700'),
    cursor: v('--vscode-editorCursor-foreground', light ? '#000000' : '#aeafad'),
    a: v('--vscode-charts-orange', '#d18616'),
    b: v('--vscode-charts-purple', '#b180d7'),
    grid: v('--vscode-editorIndentGuide-background1', v('--vscode-editorIndentGuide-background', light ? '#d3d3d3' : '#404040')),
    sel: v('--vscode-editor-lineHighlightBackground', light ? 'rgba(0,0,0,.05)' : 'rgba(255,255,255,.05)'),
    selBorder: v('--vscode-focusBorder', '#007fd4'),
    font: `${v('--vscode-editor-font-size', '12px')} ${v('--vscode-editor-font-family', 'monospace')}`,
  };
}
readColors();
new MutationObserver(() => { readColors(); draw(); }).observe(document.body, { attributes: true, attributeFilter: ['class'] });

// ---------- helpers ----------
const varOf = r => S.header.vars[r.v];
const isScalarRow = r => r.kind === 'var' && varOf(r).kind === 'scalar';
const rowWidth = r => (r.kind === 'bus' ? r.bits.reduce((a, v) => a + S.header.vars[v].size, 0) : varOf(r).size);
// Names shown more than once (the same leaf name in two scopes) get their parent scope in front.
let dupNames = new Set();
function updateDupNames() {
  const seen = new Set();
  dupNames = new Set();
  for (const r of S.rows) if (r.kind === 'var') { const n = varOf(r).name; if (seen.has(n)) dupNames.add(n); else seen.add(n); }
}
function rowLabel(r) {
  if (r.alias) return r.alias;
  if (r.kind === 'bus') return r.name;
  const x = varOf(r);
  if (dupNames.has(x.name)) { const sc = S.header.scopes[x.scope]; return sc && sc.name ? `${sc.name}.${x.name}` : x.name; }
  return x.name;
}
function rowPath(r) { return r.kind === 'bus' ? r.bits.map(v => S.header.vars[v].path).join(', ') : varOf(r).path; }
function rowById(uid) { return S.rows.find(r => r.uid === uid); }
function defaultRadix(v) {
  const x = S.header.vars[v];
  if (x.kind === 'real') return 'real';
  if (/^(integer|int|shortint|longint|byte)$/.test(x.type)) return 'signed';
  return S.settings.defaultRadix === 'real' ? 'hex' : S.settings.defaultRadix;
}

// Signal data of a row. For a bus the bit signals are merged into one change list (cached).
function rowData(r) {
  if (r.kind === 'var') return S.data.get(varOf(r).id) || null;
  const parts = r.bits.map(v => S.data.get(S.header.vars[v].id));
  if (parts.some(p => !p)) return null;
  if (r.cache && r.cache.parts.every((p, i) => p === parts[i])) return r.cache.data;
  const widths = r.bits.map(v => S.header.vars[v].size);
  const idx = parts.map(() => -1);
  const times = [], values = [];
  const valOf = (p, i, w) => {
    if (i < 0) return 'x'.repeat(w);
    if (p.codes) return F.CODE_CHARS[p.codes[i]];
    if (p.values) return F.extend(String(p.values[i]), w);
    return 'x'.repeat(w);
  };
  for (;;) {
    let t = Infinity;
    for (let k = 0; k < parts.length; k++) { const n = idx[k] + 1; if (n < parts[k].times.length && parts[k].times[n] < t) t = parts[k].times[n]; }
    if (t === Infinity) break;
    for (let k = 0; k < parts.length; k++) { while (idx[k] + 1 < parts[k].times.length && parts[k].times[idx[k] + 1] <= t) idx[k]++; }
    const val = parts.map((p, k) => valOf(p, idx[k], widths[k])).join('');
    if (times.length && times[times.length - 1] === t) values[values.length - 1] = val;
    else { times.push(t); values.push(val); }
    if (times.length > 5e6) break;
  }
  const data = { kind: 'vector', size: widths.reduce((a, b) => a + b, 0), times: Float64Array.from(times), values };
  r.cache = { parts, data };
  return data;
}

// Raw value of a row at time t: {i, raw} with raw a code char, bit string, number or string; null before the first change.
function rawAt(r, t) {
  const d = rowData(r);
  if (!d || t === null || t === undefined) return { i: -1, raw: null, loading: !d };
  const i = F.upperBound(d.times, t) - 1;
  if (i < 0) return { i, raw: null };
  if (d.codes) return { i, raw: F.CODE_CHARS[d.codes[i]] };
  if (d.reals) return { i, raw: d.reals[i] };
  return { i, raw: d.values[i] };
}

function fmtValue(r, d, i) {
  if (i < 0 || !d) return '';
  if (d.codes) return F.CODE_CHARS[d.codes[i]];
  if (d.reals) return F.formatReal(d.reals[i]);
  if (d.kind === 'string') return String(d.values[i]);
  const raw = String(d.values[i]);
  const key = i;
  if (!r.fcache || r.fcacheRadix !== r.radix || r.fcacheData !== d) { r.fcache = new Map(); r.fcacheRadix = r.radix; r.fcacheData = d; }
  let s = r.fcache.get(key);
  if (s === undefined) {
    s = r.radix === 'real' ? F.formatBits(raw, d.size, 'hex') : F.formatBits(raw, d.size, r.radix);
    if (r.fcache.size > 50000) r.fcache.clear();
    r.fcache.set(key, s);
  }
  return s;
}

function valueText(r, t) {
  const d = rowData(r);
  if (!d) return S.pending.size ? 'loading…' : '';
  if (t === null || t === undefined) return '';
  const i = F.upperBound(d.times, t) - 1;
  if (i < 0) return '—';
  return fmtValue(r, d, i);
}

// ---------- time / view ----------
function timeRange() {
  const ix = S.index;
  if (!ix) return [0, 1];
  const a = ix.startTime, b = Math.max(ix.endTime, a + 1);
  return [a, b];
}
function waveWidth() { return Math.max(10, ui.waves.clientWidth); }
function tAtX(x) { return S.view.t0 + (x / waveWidth()) * (S.view.t1 - S.view.t0); }
function xAtT(t) { return (t - S.view.t0) / (S.view.t1 - S.view.t0) * waveWidth(); }
function setView(t0, t1) {
  const [a, b] = timeRange();
  const full = b - a;
  let span = Math.max(t1 - t0, Math.min(4, full));
  span = Math.min(span, full * 4 + 10);
  let s = t0;
  const pad = span * 0.9;
  s = Math.max(a - pad, Math.min(s, b + pad - span));
  S.view = { t0: s, t1: s + span };
  draw();
  saveSoon();
}
function fit() {
  const [a, b] = timeRange();
  const pad = (b - a) * 0.02;
  S.view = { t0: a, t1: b + pad };
  draw();
  saveSoon();
}
function zoomAt(factor, x) {
  const t = tAtX(x);
  const span = (S.view.t1 - S.view.t0) * factor;
  const f = x / waveWidth();
  setView(t - f * span, t - f * span + span);
}
function panBy(px) {
  const dt = px / waveWidth() * (S.view.t1 - S.view.t0);
  setView(S.view.t0 + dt, S.view.t1 + dt);
}
function ensureVisible(t) {
  const span = S.view.t1 - S.view.t0;
  if (t < S.view.t0 || t > S.view.t1) setView(t - span / 2, t + span / 2);
}
let unitRef = null;
function timeText(t) {
  if (t === null || t === undefined) return '–';
  return F.fmtTimeAuto(t, fsPerTick, unitRef !== null ? unitRef : undefined);
}

// ---------- canvas sizing ----------
function fitCanvas(c) {
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth, hgt = c.clientHeight;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(hgt * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(hgt * dpr); }
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h: hgt };
}

// ---------- drawing ----------
let drawQueued = false;
function draw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => { drawQueued = false; drawNow(); });
}

function visibleRows() {
  const top = ui.rowsScroll.scrollTop;
  const hgt = ui.rowsScroll.clientHeight;
  const first = Math.max(0, Math.floor(top / ROW_H));
  const last = Math.min(S.rows.length, Math.ceil((top + hgt) / ROW_H) + 1);
  return { first, last, off: top - first * ROW_H };
}

function drawNow() {
  if (!S.header) return;
  updateDupNames();
  ui.rowsSpacer.style.height = Math.max(0, S.rows.length * ROW_H - ui.rowsScroll.clientHeight + 4) + 'px';
  renderNames();
  drawRuler();
  drawWaves();
  updateHbar();
  updateTimes();
  updateButtons();
}

function drawRuler() {
  const { ctx, w, h: hh } = fitCanvas(ui.ruler);
  ctx.fillStyle = C.bg; ctx.fillRect(0, 0, w, hh);
  if (!S.index) return;
  const span = S.view.t1 - S.view.t0;
  const step = F.niceStep(span, w);
  unitRef = Math.max(Math.abs(S.view.t1), Math.abs(S.view.t0)) * fsPerTick;
  const unit = F.pickUnit(unitRef || fsPerTick);
  const dec = F.decimalsFor(step, fsPerTick, unit);
  ctx.font = C.font; ctx.textBaseline = 'middle';
  ctx.strokeStyle = C.grid; ctx.fillStyle = C.dim; ctx.lineWidth = 1;
  const first = Math.ceil(S.view.t0 / step) * step;
  ctx.beginPath();
  for (let t = first, k = 0; t <= S.view.t1 && k < 500; t += step, k++) {
    const x = Math.round(xAtT(t)) + 0.5;
    ctx.moveTo(x, hh - 8); ctx.lineTo(x, hh);
    ctx.fillText(F.fmtTime(t, fsPerTick, unit, dec), x + 3, hh / 2 - 2);
  }
  for (let t = first - step / 2, k = 0; t <= S.view.t1 && k < 1000; t += step, k++) {
    const x = Math.round(xAtT(t)) + 0.5;
    ctx.moveTo(x, hh - 4); ctx.lineTo(x, hh);
  }
  ctx.stroke();
  drawMarks(ctx, hh, true);
  if (rangeSel) {
    ctx.fillStyle = C.selBorder; ctx.globalAlpha = 0.25;
    ctx.fillRect(Math.min(rangeSel.x0, rangeSel.x1), 0, Math.abs(rangeSel.x1 - rangeSel.x0), hh);
    ctx.globalAlpha = 1;
  }
}

function drawMarks(ctx, hh, labels) {
  const mark = (t, color, label) => {
    if (t === null || t === undefined) return;
    const x = Math.round(xAtT(t)) + 0.5;
    if (x < -1 || x > waveWidth() + 1) return;
    ctx.strokeStyle = color; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, hh); ctx.stroke();
    if (labels && label) {
      ctx.fillStyle = color; ctx.font = C.font;
      const tw = ctx.measureText(label).width + 6;
      ctx.fillRect(x - tw / 2, hh - 13, tw, 13);
      ctx.fillStyle = C.bg; ctx.textAlign = 'center'; ctx.fillText(label, x, hh - 6); ctx.textAlign = 'left';
    }
  };
  mark(S.markers.a, C.a, 'A');
  mark(S.markers.b, C.b, 'B');
  mark(S.cursor, C.cursor, null);
}

function drawWaves() {
  const { ctx, w, h: hh } = fitCanvas(ui.waves);
  ctx.fillStyle = C.bg; ctx.fillRect(0, 0, w, hh);
  if (!S.index) return;
  const { first, last, off } = visibleRows();
  // grid lines from the ruler
  const step = F.niceStep(S.view.t1 - S.view.t0, w);
  ctx.strokeStyle = C.grid; ctx.globalAlpha = 0.5; ctx.beginPath();
  for (let t = Math.ceil(S.view.t0 / step) * step, k = 0; t <= S.view.t1 && k < 500; t += step, k++) {
    const x = Math.round(xAtT(t)) + 0.5; ctx.moveTo(x, 0); ctx.lineTo(x, hh);
  }
  ctx.stroke(); ctx.globalAlpha = 1;
  ctx.font = C.font; ctx.textBaseline = 'middle';
  const charW = ctx.measureText('0').width || 7;
  for (let i = first; i < last; i++) {
    const r = S.rows[i];
    const y = i * ROW_H - ui.rowsScroll.scrollTop;
    if (S.sel.has(r.uid)) { ctx.fillStyle = C.sel; ctx.fillRect(0, y, w, ROW_H); }
    const d = rowData(r);
    if (!d) { drawLoading(ctx, y, w); continue; }
    if (d.codes) drawScalar(ctx, d, y, w);
    else drawBus(ctx, r, d, y, w, charW);
  }
  void off;
  drawMarks(ctx, hh, false);
  if (rangeSel) {
    ctx.fillStyle = C.selBorder; ctx.globalAlpha = 0.18;
    ctx.fillRect(Math.min(rangeSel.x0, rangeSel.x1), 0, Math.abs(rangeSel.x1 - rangeSel.x0), hh);
    ctx.globalAlpha = 1;
  }
}

function drawLoading(ctx, y, w) {
  ctx.fillStyle = C.dim; ctx.globalAlpha = 0.25;
  for (let x = (y % 16); x < w; x += 16) ctx.fillRect(x, y + ROW_H / 2 - 1, 8, 2);
  ctx.globalAlpha = 1;
}

// Calls seg(i, xs, xe) for each change wider than 2 px and dense(xs, xe) for runs of narrower changes.
function walk(times, w, seg, dense) {
  const n = times.length;
  const k = w / (S.view.t1 - S.view.t0);
  const X = t => (t - S.view.t0) * k;
  let i = F.upperBound(times, S.view.t0) - 1;
  let guard = 0;
  while (guard++ < 100000) {
    const xs = i < 0 ? 0 : Math.max(0, X(times[i]));
    if (xs >= w) break;
    if (i + 1 >= n) { seg(i, xs, w); break; }
    const xe = Math.min(w, X(times[i + 1]));
    if (xe - xs >= 2) { seg(i, xs, xe); i++; continue; }
    let j = F.upperBound(times, S.view.t0 + (xs + 2) / k) - 1;
    if (j <= i) j = i + 1;
    dense(xs, Math.min(w, X(times[j])), i, j);
    i = j;
  }
}

function drawScalar(ctx, d, y, w) {
  const top = y + 4, bot = y + ROW_H - 4, mid = (top + bot) / 2;
  const codes = d.codes;
  let prevY = null;
  ctx.lineWidth = 1.5;
  const levelY = c => (c === 1 || c === 7 ? top : c === 0 || c === 6 ? bot : c === 3 ? mid : null);
  walk(d.times, w, (i, xs, xe) => {
    if (i < 0) { ctx.strokeStyle = C.dim; ctx.globalAlpha = 0.4; ctx.beginPath(); ctx.moveTo(xs, mid); ctx.lineTo(xe, mid); ctx.stroke(); ctx.globalAlpha = 1; prevY = null; return; }
    const c = codes[i];
    const ly = levelY(c);
    if (ly === null) { // x, u, w, -
      ctx.fillStyle = C.x; ctx.globalAlpha = 0.28; ctx.fillRect(xs, top, xe - xs, bot - top); ctx.globalAlpha = 1;
      ctx.strokeStyle = C.x; ctx.beginPath(); ctx.moveTo(xs, top); ctx.lineTo(xe, top); ctx.moveTo(xs, bot); ctx.lineTo(xe, bot); ctx.stroke();
      prevY = null; return;
    }
    ctx.strokeStyle = c === 3 ? C.z : C.wave;
    if (c === 6 || c === 7) ctx.setLineDash([3, 2]);
    ctx.beginPath();
    if (prevY !== null && prevY !== ly) { ctx.moveTo(xs, prevY); ctx.lineTo(xs, ly); } else ctx.moveTo(xs, ly);
    ctx.lineTo(xe, ly); ctx.stroke();
    ctx.setLineDash([]);
    prevY = ly;
  }, (xs, xe) => {
    ctx.fillStyle = C.wave; ctx.globalAlpha = 0.55; ctx.fillRect(xs, top, Math.max(1, xe - xs), bot - top); ctx.globalAlpha = 1;
    prevY = null;
  });
}

function drawBus(ctx, r, d, y, w, charW) {
  const top = y + 4, bot = y + ROW_H - 4, mid = (top + bot) / 2;
  ctx.lineWidth = 1.2;
  walk(d.times, w, (i, xs, xe) => {
    if (i < 0) { ctx.strokeStyle = C.dim; ctx.globalAlpha = 0.4; ctx.beginPath(); ctx.moveTo(xs, mid); ctx.lineTo(xe, mid); ctx.stroke(); ctx.globalAlpha = 1; return; }
    let cls = 0;
    if (d.values) { const raw = String(d.values[i]); cls = d.kind === 'string' ? 0 : F.valueClass(raw); }
    else if (d.reals && Number.isNaN(d.reals[i])) cls = 1;
    const color = cls === 1 ? C.x : cls === 2 ? C.z : C.bus;
    const s = Math.min(3, (xe - xs) / 2);
    const l = xs <= 0 ? xs : xs + s;
    ctx.beginPath();
    ctx.moveTo(xs, xs <= 0 ? top : mid); if (xs > 0) ctx.lineTo(l, top);
    ctx.lineTo(xe - s, top); ctx.lineTo(xe, mid); ctx.lineTo(xe - s, bot); ctx.lineTo(l, bot);
    if (xs > 0) ctx.lineTo(xs, mid); else ctx.lineTo(xs, top);
    if (cls === 1) { ctx.fillStyle = C.x; ctx.globalAlpha = 0.22; ctx.fill(); ctx.globalAlpha = 1; }
    ctx.strokeStyle = color; ctx.stroke();
    const tx = (xs <= 0 ? 0 : xs + s) + 1;
    const room = Math.floor((xe - s - 1 - tx) / charW);
    if (room >= 1) {
      let text = fmtValue(r, d, i);
      if (text.length > room) text = room >= 2 ? text.slice(0, room - 1) + '…' : '';
      if (text) { ctx.fillStyle = cls === 2 ? C.z : C.fg; ctx.fillText(text, tx, mid + 0.5); }
    }
  }, (xs, xe) => {
    ctx.fillStyle = C.bus; ctx.globalAlpha = 0.45; ctx.fillRect(xs, top, Math.max(1, xe - xs), bot - top); ctx.globalAlpha = 1;
  });
}

// ---------- names column (DOM, only the visible rows) ----------
const nameEls = new Map(); // row uid -> {el, nameEl, valEl, key}
function renderNames() {
  const { first, last } = visibleRows();
  const top = ui.rowsScroll.scrollTop;
  const keep = new Set();
  for (let i = first; i < last; i++) {
    const r = S.rows[i];
    keep.add(r.uid);
    let o = nameEls.get(r.uid);
    if (!o) {
      const nameEl = h('span', { class: 'n-name' });
      const valEl = h('span', { class: 'val' });
      const rm = h('button', { type: 'button', class: 'rm', title: 'Remove', 'data-uid': r.uid }, '×');
      const el = h('div', { class: 'nrow', role: 'option', draggable: 'true', 'data-uid': r.uid }, nameEl, valEl, rm);
      o = { el, nameEl, valEl, rm, key: '', vkey: '' };
      nameEls.set(r.uid, o);
      ui.names.append(el);
    }
    const val = valueText(r, S.cursor);
    const raw = rawAt(r, S.cursor);
    let cls = 'val';
    if (raw.raw !== null && typeof raw.raw === 'string' && (r.kind === 'bus' || varOf(r).kind !== 'string')) {
      const vc = F.valueClass(raw.raw);
      if (vc === 1) cls += ' vx'; else if (vc === 2) cls += ' vz';
    }
    const width = rowWidth(r);
    const key = `${rowLabel(r)}|${r.kind}|${width}|${r.alias}`;
    if (o.key !== key) {
      o.key = key;
      o.nameEl.replaceChildren(...(r.kind === 'bus' ? [h('span', { class: 'badge' }, 'bus')] : []), rowLabel(r));
      o.nameEl.title = `${rowPath(r)}${width > 1 ? ` (${width} bits)` : ''}${r.alias ? `\nshown as ${r.alias}` : ''}\nDouble-click to rename, drag to move`;
      o.rm.setAttribute('aria-label', 'Remove ' + rowLabel(r));
    }
    const vkey = cls + '|' + val;
    if (o.vkey !== vkey) {
      o.vkey = vkey;
      o.valEl.className = cls;
      o.valEl.textContent = val.length > 200 ? val.slice(0, 200) + '…' : val;
      o.valEl.title = (val.length > 24 ? (val.length > 2000 ? val.slice(0, 2000) + '…' : val) + '\n' : '') + 'Double-click to copy';
    }
    const c = 'nrow' + (S.sel.has(r.uid) ? ' sel' : '') + (S.focus === r.uid ? ' focus' : '');
    if (o.el.className !== c) o.el.className = c;
    o.el.setAttribute('aria-selected', S.sel.has(r.uid) ? 'true' : 'false');
    o.el.dataset.i = i;
    o.el.style.top = (i * ROW_H - top) + 'px';
    o.el.style.height = ROW_H + 'px';
  }
  for (const [uid, o] of nameEls) if (!keep.has(uid)) { o.el.remove(); nameEls.delete(uid); }
  ui.empty.hidden = !!(S.rows.length || !S.index || S.error);
  ui.namesHead.querySelector('.n-name').textContent = `Signal (${S.rows.length})`;
}

ui.names.addEventListener('mousedown', e => {
  const rowEl = e.target.closest('.nrow');
  if (!rowEl || e.target.closest('.rm') || e.target.closest('input')) return;
  const uid = Number(rowEl.dataset.uid);
  if (e.metaKey || e.ctrlKey) { if (S.sel.has(uid)) S.sel.delete(uid); else S.sel.add(uid); }
  else if (e.shiftKey && S.focus !== null) {
    const a = S.rows.findIndex(r => r.uid === S.focus), b = S.rows.findIndex(r => r.uid === uid);
    S.sel = new Set(S.rows.slice(Math.min(a, b), Math.max(a, b) + 1).map(r => r.uid));
  } else if (!S.sel.has(uid) || S.sel.size === 1) S.sel = new Set([uid]);
  S.focus = uid;
  syncRadix();
  draw();
});
ui.names.addEventListener('click', e => {
  const rm = e.target.closest('.rm');
  if (rm) { removeRows([Number(rm.dataset.uid)]); return; }
  const rowEl = e.target.closest('.nrow');
  if (rowEl && !(e.metaKey || e.ctrlKey || e.shiftKey)) { S.sel = new Set([Number(rowEl.dataset.uid)]); syncRadix(); draw(); }
});
ui.names.addEventListener('dblclick', e => {
  const rowEl = e.target.closest('.nrow');
  if (!rowEl) return;
  const r = rowById(Number(rowEl.dataset.uid));
  if (e.target.closest('.val')) { const v = valueText(r, S.cursor); if (v) vscode.postMessage({ type: 'copy', text: v }); return; }
  startRename(r);
});
// drag to reorder
let dragUids = null;
ui.names.addEventListener('dragstart', e => {
  const rowEl = e.target.closest('.nrow');
  if (!rowEl) return;
  const uid = Number(rowEl.dataset.uid);
  if (!S.sel.has(uid)) S.sel = new Set([uid]);
  dragUids = S.rows.filter(r => S.sel.has(r.uid)).map(r => r.uid);
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', 'rows');
});
ui.names.addEventListener('dragover', e => { if (dragUids) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; showDropLine(e); } });
ui.names.addEventListener('dragleave', () => { ui.names.style.removeProperty('--drop-y'); ui.names.classList.remove('dropping'); });
ui.names.addEventListener('drop', e => {
  if (!dragUids) return;
  e.preventDefault();
  moveRowsTo(dragUids, dropIndex(e));
  dragUids = null;
  ui.names.classList.remove('dropping');
});
ui.names.addEventListener('dragend', () => { dragUids = null; ui.names.classList.remove('dropping'); });
function dropIndex(e) {
  const b = ui.names.getBoundingClientRect();
  return Math.max(0, Math.min(S.rows.length, Math.round((e.clientY - b.top + ui.rowsScroll.scrollTop) / ROW_H)));
}
function showDropLine(e) {
  const i = dropIndex(e);
  ui.names.classList.add('dropping');
  ui.names.style.setProperty('--drop-y', (i * ROW_H - ui.rowsScroll.scrollTop) + 'px');
}
function moveRowsTo(uids, at) {
  const set = new Set(uids);
  const before = S.rows.slice(0, at).filter(r => !set.has(r.uid));
  const moving = S.rows.filter(r => set.has(r.uid));
  const after = S.rows.slice(at).filter(r => !set.has(r.uid));
  S.rows = [...before, ...moving, ...after];
  draw(); renderTree(); saveList();
}
function moveSelected(dir) {
  if (!S.sel.size) return;
  const idx = S.rows.map((r, i) => (S.sel.has(r.uid) ? i : -1)).filter(i => i >= 0);
  if (dir < 0 && idx[0] === 0) return;
  if (dir > 0 && idx[idx.length - 1] === S.rows.length - 1) return;
  const rows = S.rows.slice();
  const order = dir < 0 ? idx : idx.slice().reverse();
  for (const i of order) { const j = i + dir; [rows[i], rows[j]] = [rows[j], rows[i]]; }
  S.rows = rows;
  scrollRowIntoView(S.rows.findIndex(r => r.uid === S.focus));
  draw(); saveList();
}
function scrollRowIntoView(i) {
  if (i < 0) return;
  const top = i * ROW_H, bot = top + ROW_H;
  const st = ui.rowsScroll.scrollTop, hgt = ui.rowsScroll.clientHeight;
  if (top < st) ui.rowsScroll.scrollTop = top;
  else if (bot > st + hgt) ui.rowsScroll.scrollTop = bot - hgt;
}

function startRename(r) {
  if (!r) return;
  scrollRowIntoView(S.rows.indexOf(r));
  renderNames();
  const o = nameEls.get(r.uid);
  if (!o) return;
  const input = h('input', { class: 'rename', value: rowLabel(r), 'aria-label': 'New name' });
  o.nameEl.replaceWith(input);
  input.focus(); input.select();
  let done = false;
  const finish = ok => {
    if (done) return; done = true;
    if (ok) { const v = input.value.trim(); r.alias = v && v !== (r.kind === 'bus' ? r.name : varOf(r).name) ? v.slice(0, 200) : ''; saveList(); }
    input.replaceWith(o.nameEl);
    o.key = '';
    draw();
    ui.waves.focus();
  };
  input.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); });
  input.addEventListener('blur', () => finish(true));
}

// ---------- rows ----------
function addVars(vlist, at) {
  const shown = new Set(S.rows.filter(r => r.kind === 'var').map(r => r.v));
  const add = [];
  for (const v of vlist) if (!shown.has(v)) { shown.add(v); add.push({ uid: S.uid++, kind: 'var', v, alias: '', radix: defaultRadix(v) }); }
  if (!add.length) return 0;
  if (at === undefined) S.rows.push(...add); else S.rows.splice(at, 0, ...add);
  requestLoad();
  draw(); renderTree(); saveList();
  return add.length;
}
function removeRows(uids) {
  const set = new Set(uids);
  S.rows = S.rows.filter(r => !set.has(r.uid));
  for (const u of uids) S.sel.delete(u);
  if (set.has(S.focus)) S.focus = null;
  draw(); renderTree(); saveList();
}
function groupBus() {
  const sel = S.rows.filter(r => S.sel.has(r.uid));
  if (sel.length === 1 && sel[0].kind === 'bus') { // split
    const r = sel[0], at = S.rows.indexOf(r);
    const bits = r.bits.map(v => ({ uid: S.uid++, kind: 'var', v, alias: '', radix: defaultRadix(v) }));
    S.rows.splice(at, 1, ...bits);
    S.sel = new Set(bits.map(b => b.uid)); S.focus = bits[0].uid;
    toast(`Split the bus into ${bits.length} signals.`);
    draw(); saveList(); return;
  }
  const vars = sel.filter(r => r.kind === 'var' && (varOf(r).kind === 'scalar' || varOf(r).kind === 'vector'));
  if (vars.length < 2) { toast('Select two or more bit signals (Ctrl/Cmd+click or Shift+click), then press Bus.'); return; }
  const at = S.rows.indexOf(vars[0]);
  const bits = vars.map(r => r.v);
  const names = bits.map(v => S.header.vars[v].name);
  const m = names.map(n => /^(.*)\[(\d+)\]$/.exec(n));
  let name;
  if (m.every(x => x && x[1] === m[0][1])) name = `${m[0][1]}[${m[0][2]}:${m[m.length - 1][2]}]`;
  else name = `{${names.length > 3 ? names[0] + ', …, ' + names[names.length - 1] : names.join(', ')}}`;
  const bus = { uid: S.uid++, kind: 'bus', bits, name, alias: '', radix: 'hex' };
  const set = new Set(vars.map(r => r.uid));
  S.rows = S.rows.filter(r => !set.has(r.uid));
  S.rows.splice(Math.min(at, S.rows.length), 0, bus);
  S.sel = new Set([bus.uid]); S.focus = bus.uid;
  toast(`Grouped ${bits.length} signals into the bus ${name}. The top signal is the most significant bit.`);
  requestLoad(); draw(); renderTree(); saveList();
}

// ---------- loading ----------
let loadTimer = null;
let loadQueued = false;
function requestLoad() {
  clearTimeout(loadTimer);
  loadQueued = true;
  loadTimer = setTimeout(() => {
    loadQueued = false;
    if (!S.index) return;
    const need = new Set();
    for (const r of S.rows) for (const v of (r.kind === 'bus' ? r.bits : [r.v])) {
      const id = S.header.vars[v].id;
      if (!S.data.has(id) && !S.pending.has(id)) need.add(id);
    }
    if (!need.size) return;
    const ids = [...need];
    for (const id of ids) S.pending.add(id);
    const reqId = ++S.reqId;
    loads.set(reqId, { ids, t0: performance.now() });
    vscode.postMessage({ type: 'load', ids, reqId });
    draw();
  }, 20);
}
const loads = new Map();

// ---------- tree ----------
let treeItems = [];
function buildTreeItems() {
  const H = S.header;
  const out = [];
  if (!H) return out;
  const q = S.search.trim().toLowerCase();
  if (q) {
    const terms = q.split(/\s+/);
    for (let v = 0; v < H.vars.length; v++) {
      const p = H.vars[v].path.toLowerCase();
      if (terms.every(t => p.includes(t))) out.push({ t: 'var', v, depth: 0, full: true });
    }
    return out;
  }
  const walkScope = (s, depth) => {
    const sc = H.scopes[s];
    for (const c of sc.children) {
      out.push({ t: 'scope', s: c, depth });
      if (S.expanded.has(c)) walkScope(c, depth + 1);
    }
    for (const v of sc.vars) out.push({ t: 'var', v, depth });
  };
  walkScope(0, 0);
  return out;
}
function scopeVarsDeep(s, out = []) {
  const sc = S.header.scopes[s];
  for (const v of sc.vars) out.push(v);
  for (const c of sc.children) scopeVarsDeep(c, out);
  return out;
}
function renderTree() {
  if (!S.header) return;
  treeItems = buildTreeItems();
  const shown = new Set(S.rows.filter(r => r.kind === 'var').map(r => r.v));
  ui.treeSpacer.style.height = treeItems.length * TREE_ROW + 'px';
  const top = ui.treeScroll.scrollTop, hgt = ui.treeScroll.clientHeight || 400;
  const first = Math.max(0, Math.floor(top / TREE_ROW) - 2), last = Math.min(treeItems.length, Math.ceil((top + hgt) / TREE_ROW) + 2);
  const frag = document.createDocumentFragment();
  for (let i = first; i < last; i++) {
    const it = treeItems[i];
    let el;
    if (it.t === 'scope') {
      const sc = S.header.scopes[it.s];
      const open = S.expanded.has(it.s);
      el = h('div', { class: 'titem scope', role: 'treeitem', 'aria-expanded': open ? 'true' : 'false', 'data-i': i, title: `${sc.path} (${sc.type})` },
        h('span', { class: 'twist' }, open ? '▾' : '▸'), h('span', { class: 'tname' }, sc.name),
        h('span', { class: 'tmeta' }, sc.type),
        h('button', { type: 'button', class: 'tadd', title: `Add every signal in ${sc.name} and below`, 'data-scope': it.s }, '+'));
    } else {
      const x = S.header.vars[it.v];
      const count = S.index && S.index.counts ? S.index.counts[x.id] : null;
      el = h('div', {
        class: 'titem var' + (shown.has(it.v) ? ' shown' : '') + (S.treeSel.has(it.v) ? ' tsel' : ''), role: 'treeitem', 'aria-selected': S.treeSel.has(it.v) ? 'true' : 'false', 'data-i': i,
        title: `${x.path}\n${x.type}, ${x.size} bit${x.size > 1 ? 's' : ''}${count !== null && count !== undefined ? `, ${count.toLocaleString()} changes` : ''}\nDouble-click to add`,
      },
      h('span', { class: 'kicon k-' + x.kind }, x.kind === 'scalar' ? '⎍' : x.kind === 'real' ? '∿' : x.kind === 'string' ? 'S' : '≡'),
      h('span', { class: 'tname' }, it.full ? x.path : x.name),
      x.size > 1 && x.kind !== 'real' && x.kind !== 'string' ? h('span', { class: 'tmeta' }, `${x.size}`) : null,
      h('button', { type: 'button', class: 'tadd', title: 'Add to the view', 'data-var': it.v }, '+'));
    }
    el.style.top = i * TREE_ROW + 'px';
    el.style.paddingLeft = (6 + it.depth * 12) + 'px';
    frag.append(el);
  }
  ui.treeRows.replaceChildren(frag);
  const nv = S.header.vars.length;
  ui.treeInfo.textContent = S.search ? `${treeItems.length.toLocaleString()} of ${nv.toLocaleString()}` : `${nv.toLocaleString()} signals`;
  ui.addAll.textContent = S.search ? `Add ${treeItems.length.toLocaleString()}` : 'Add all';
}
ui.treeScroll.addEventListener('scroll', () => renderTree());
ui.search.addEventListener('input', () => { S.search = ui.search.value; S.treeSel.clear(); ui.treeScroll.scrollTop = 0; renderTree(); });
ui.search.addEventListener('keydown', e => {
  if (e.key === 'Enter') { const vs = treeItems.filter(t => t.t === 'var').map(t => t.v); if (vs.length) addVars(S.treeSel.size ? [...S.treeSel] : vs.slice(0, 1)); }
  if (e.key === 'Escape') { ui.search.value = ''; S.search = ''; renderTree(); }
  e.stopPropagation();
});
ui.treeRows.addEventListener('click', e => {
  const add = e.target.closest('.tadd');
  if (add) {
    if (add.dataset.scope) addScope(Number(add.dataset.scope));
    else addVars([Number(add.dataset.var)]);
    return;
  }
  const el = e.target.closest('.titem');
  if (!el) return;
  const it = treeItems[Number(el.dataset.i)];
  if (it.t === 'scope') { if (S.expanded.has(it.s)) S.expanded.delete(it.s); else S.expanded.add(it.s); renderTree(); return; }
  if (e.metaKey || e.ctrlKey) { if (S.treeSel.has(it.v)) S.treeSel.delete(it.v); else S.treeSel.add(it.v); }
  else if (e.shiftKey && S.treeFocus >= 0) {
    const a = Math.min(S.treeFocus, Number(el.dataset.i)), b = Math.max(S.treeFocus, Number(el.dataset.i));
    for (let i = a; i <= b; i++) if (treeItems[i].t === 'var') S.treeSel.add(treeItems[i].v);
  } else S.treeSel = new Set([it.v]);
  S.treeFocus = Number(el.dataset.i);
  for (const c of ui.treeRows.children) {
    const t = treeItems[Number(c.dataset.i)];
    if (t && t.t === 'var') { const on = S.treeSel.has(t.v); c.classList.toggle('tsel', on); c.setAttribute('aria-selected', on ? 'true' : 'false'); }
  }
});
ui.treeRows.addEventListener('dblclick', e => {
  const el = e.target.closest('.titem.var');
  if (el && !e.target.closest('.tadd')) addVars([treeItems[Number(el.dataset.i)].v]);
});
function addScope(s) {
  const vs = scopeVarsDeep(s);
  const n = addVars(vs);
  toast(n ? `Added ${n} signals from ${S.header.scopes[s].path}.` : 'All signals of this scope are already shown.');
}

// ---------- toolbar ----------
ui.toolbar.addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  act(b.dataset.act);
});
ui.treePanel.addEventListener('click', e => {
  const b = e.target.closest('button[data-act]');
  if (b) act(b.dataset.act);
});
ui.radix.addEventListener('change', () => {
  for (const r of S.rows) if (S.sel.has(r.uid) && !(r.kind === 'var' && (varOf(r).kind === 'scalar' || varOf(r).kind === 'string'))) {
    if (ui.radix.value === 'real' && !(r.kind === 'var' && varOf(r).kind === 'real')) continue;
    r.radix = ui.radix.value;
  }
  draw(); saveList();
});
function syncRadix() {
  const r = rowById(S.focus);
  if (r) ui.radix.value = r.radix || 'hex';
}

function act(a) {
  if (!S.index && !['tree', 'import'].includes(a)) return;
  const center = waveWidth() / 2;
  switch (a) {
    case 'tree': S.treeOpen = !S.treeOpen; ui.treePanel.hidden = !S.treeOpen; ui.splitter.hidden = !S.treeOpen; ui.toolbar.querySelector('[data-act=tree]').setAttribute('aria-pressed', String(S.treeOpen)); requestAnimationFrame(() => { renderTree(); draw(); }); break;
    case 'zoomIn': zoomAt(0.5, S.cursor !== null && xAtT(S.cursor) >= 0 && xAtT(S.cursor) <= waveWidth() ? xAtT(S.cursor) : center); break;
    case 'zoomOut': zoomAt(2, S.cursor !== null && xAtT(S.cursor) >= 0 && xAtT(S.cursor) <= waveWidth() ? xAtT(S.cursor) : center); break;
    case 'fit': fit(); break;
    case 'zoomAB': {
      const { a: ma, b: mb } = S.markers;
      if (ma === null || mb === null || ma === mb) { toast('Set marker A and marker B first (keys A and B put them at the cursor).'); break; }
      const lo = Math.min(ma, mb), hi = Math.max(ma, mb), pad = (hi - lo) * 0.05;
      setView(lo - pad, hi + pad); break;
    }
    case 'prevEdge': edge(-1); break;
    case 'nextEdge': edge(1); break;
    case 'setA': S.markers.a = S.cursor !== null ? S.cursor : tAtX(center); draw(); saveSoon(); break;
    case 'setB': S.markers.b = S.cursor !== null ? S.cursor : tAtX(center); draw(); saveSoon(); break;
    case 'bus': groupBus(); break;
    case 'rename': startRename(rowById(S.focus) || S.rows.find(r => S.sel.has(r.uid))); break;
    case 'remove': if (S.sel.size) removeRows([...S.sel]); break;
    case 'export': vscode.postMessage({ type: 'exportLayout', layout: layoutNow() }); break;
    case 'import': vscode.postMessage({ type: 'importLayout' }); break;
    case 'addSel': if (S.treeSel.size) addVars([...S.treeSel]); else toast('Click signals in the tree to select them, or double-click one to add it.'); break;
    case 'addAll': {
      const vs = S.search ? treeItems.filter(t => t.t === 'var').map(t => t.v) : S.header.vars.map((_, i) => i);
      const n = addVars(vs);
      toast(n ? `Added ${n.toLocaleString()} signals.` : 'These signals are already shown.');
      break;
    }
  }
}

function edge(dir) {
  const r = rowById(S.focus) || S.rows.find(x => S.sel.has(x.uid));
  if (!r) { toast('Click a signal name first. Then the arrow keys jump to its next or previous change.'); return; }
  const d = rowData(r);
  if (!d) return;
  const times = d.times;
  const t = S.cursor !== null ? S.cursor : S.view.t0;
  const valAt = i => (i < 0 ? null : d.codes ? d.codes[i] : d.reals ? d.reals[i] : d.values[i]);
  const n = times.length;
  let target = null;
  if (dir > 0) {
    let j = F.upperBound(times, t);
    while (j < n && j > 0 && valAt(j) === valAt(j - 1)) j++;
    if (j < n) target = times[j];
  } else {
    let k = F.lowerBound(times, t) - 1;
    while (k > 0 && valAt(k) === valAt(k - 1)) k--;
    if (k >= 0) target = times[k];
  }
  if (target === null) { toast(dir > 0 ? 'No later change of this signal.' : 'No earlier change of this signal.'); return; }
  S.cursor = target;
  ensureVisible(target);
  draw(); saveSoon();
}

// ---------- mouse on waves and ruler ----------
let drag = null, rangeSel = null;
function localX(e, el) { return e.clientX - el.getBoundingClientRect().left; }
ui.waves.addEventListener('mousedown', e => {
  if (!S.index) return;
  ui.waves.focus();
  const x = localX(e, ui.waves);
  drag = { x0: x, last: x, moved: false, mode: e.button === 1 ? 'pan' : e.shiftKey ? 'range' : 'pan', button: e.button, y: e.clientY };
  if (e.button === 1) e.preventDefault();
});
ui.ruler.addEventListener('mousedown', e => {
  if (!S.index) return;
  const x = localX(e, ui.ruler);
  drag = { x0: x, last: x, moved: false, mode: 'range', button: e.button, ruler: true };
});
window.addEventListener('mousemove', e => {
  if (!drag) return;
  const el = drag.ruler ? ui.ruler : ui.waves;
  const x = localX(e, el);
  if (!drag.moved && Math.abs(x - drag.x0) < 4) return;
  drag.moved = true;
  if (drag.mode === 'pan') { panBy(drag.last - x); drag.last = x; }
  else { rangeSel = { x0: drag.x0, x1: x }; draw(); }
});
window.addEventListener('mouseup', e => {
  if (!drag) return;
  const d = drag; drag = null;
  const el = d.ruler ? ui.ruler : ui.waves;
  const x = localX(e, el);
  if (!d.moved && d.button === 0) {
    S.cursor = Math.round(tAtX(Math.max(0, Math.min(waveWidth(), x))));
    if (!d.ruler) {
      const b = ui.waves.getBoundingClientRect();
      const i = Math.floor((e.clientY - b.top + ui.rowsScroll.scrollTop) / ROW_H);
      if (i >= 0 && i < S.rows.length && !(e.metaKey || e.ctrlKey)) { S.sel = new Set([S.rows[i].uid]); S.focus = S.rows[i].uid; syncRadix(); }
    }
    draw(); saveSoon();
    return;
  }
  if (d.mode === 'range' && rangeSel) {
    const a = tAtX(Math.min(rangeSel.x0, rangeSel.x1)), b = tAtX(Math.max(rangeSel.x0, rangeSel.x1));
    rangeSel = null;
    if (b - a > 0) setView(a, b); else draw();
  }
});
ui.rowsScroll.addEventListener('wheel', e => {
  if (!S.index) return;
  const x = localX(e, ui.waves);
  const overWaves = x >= 0;
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault();
    zoomAt(Math.exp(Math.max(-1, Math.min(1, e.deltaY * 0.004))), overWaves ? x : waveWidth() / 2);
  } else if (overWaves && (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY))) {
    e.preventDefault();
    panBy(e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX);
  }
}, { passive: false });
ui.ruler.addEventListener('wheel', e => {
  if (!S.index) return;
  e.preventDefault();
  if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) panBy(e.deltaX);
  else zoomAt(Math.exp(Math.max(-1, Math.min(1, e.deltaY * 0.004))), localX(e, ui.ruler));
}, { passive: false });
ui.rowsScroll.addEventListener('scroll', () => draw());

// horizontal scroll bar
function updateHbar() {
  const [a, b] = timeRange();
  const full = Math.max(b, S.view.t1) - Math.min(a, S.view.t0);
  const W = ui.hbar.clientWidth;
  const left = (S.view.t0 - Math.min(a, S.view.t0)) / full * W;
  const width = Math.max(16, (S.view.t1 - S.view.t0) / full * W);
  ui.hthumb.style.left = Math.min(W - width, left) + 'px';
  ui.hthumb.style.width = width + 'px';
}
let hdrag = null;
ui.hbar.addEventListener('mousedown', e => {
  if (!S.index) return;
  e.preventDefault();
  const [a, b] = timeRange();
  const full = Math.max(b, S.view.t1) - Math.min(a, S.view.t0);
  if (e.target === ui.hthumb) hdrag = { x: e.clientX, t0: S.view.t0, k: full / ui.hbar.clientWidth };
  else {
    const t = Math.min(a, S.view.t0) + localX(e, ui.hbar) / ui.hbar.clientWidth * full;
    const span = S.view.t1 - S.view.t0;
    setView(t - span / 2, t + span / 2);
  }
});
window.addEventListener('mousemove', e => {
  if (!hdrag) return;
  const span = S.view.t1 - S.view.t0;
  const t0 = hdrag.t0 + (e.clientX - hdrag.x) * hdrag.k;
  setView(t0, t0 + span);
});
window.addEventListener('mouseup', () => { hdrag = null; });

// splitters
function splitDrag(el, prop, min, getBase) {
  el.addEventListener('mousedown', e => {
    e.preventDefault();
    const start = e.clientX, base = getBase();
    const mv = ev => { document.documentElement.style.setProperty(prop, Math.max(min, base + ev.clientX - start) + 'px'); draw(); renderTree(); };
    const up = () => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up);
  });
}
splitDrag(ui.splitter, '--tree-w', 140, () => ui.treePanel.getBoundingClientRect().width);
splitDrag(ui.namesSplit, '--names-w', 140, () => ui.names.getBoundingClientRect().width);
new ResizeObserver(() => { draw(); renderTree(); }).observe(ui.wavePanel);

// ---------- keys ----------
document.addEventListener('keydown', e => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  if (!S.index) return;
  const mod = e.metaKey || e.ctrlKey;
  const k = e.key;
  let handled = true;
  if (k === '+' || k === '=') act('zoomIn');
  else if (k === '-' || k === '_') act('zoomOut');
  else if (k === 'f' || k === 'F') { if (!mod) act('fit'); else handled = false; }
  else if ((k === 'a' || k === 'A') && mod) { S.sel = new Set(S.rows.map(r => r.uid)); draw(); }
  else if (k === 'a' || k === 'A') act('setA');
  else if (k === 'b' || k === 'B') act('setB');
  else if (k === 'g' || k === 'G') act('bus');
  else if (k === 't' || k === 'T') act('tree');
  else if (k === 'F2') act('rename');
  else if (k === 'Delete' || k === 'Backspace') act('remove');
  else if (k === 'ArrowRight' || k === 'n' || k === 'N') { if (S.focus !== null) edge(1); else panBy(waveWidth() / 10); }
  else if (k === 'ArrowLeft' || k === 'p' || k === 'P') { if (S.focus !== null) edge(-1); else panBy(-waveWidth() / 10); }
  else if ((k === 'ArrowUp' || k === 'ArrowDown') && e.altKey) moveSelected(k === 'ArrowUp' ? -1 : 1);
  else if (k === 'ArrowUp' || k === 'ArrowDown') {
    let i = S.rows.findIndex(r => r.uid === S.focus);
    i = Math.max(0, Math.min(S.rows.length - 1, i + (k === 'ArrowUp' ? -1 : 1)));
    if (S.rows[i]) { S.focus = S.rows[i].uid; S.sel = new Set([S.focus]); scrollRowIntoView(i); syncRadix(); draw(); }
  } else if (k === 'Home') { S.cursor = timeRange()[0]; ensureVisible(S.cursor); draw(); }
  else if (k === 'End') { S.cursor = timeRange()[1]; ensureVisible(S.cursor); draw(); }
  else if (k === 'Escape') { S.sel.clear(); S.focus = null; rangeSel = null; draw(); }
  else handled = false;
  if (handled) e.preventDefault();
});

// ---------- status ----------
function updateTimes() {
  const parts = [`Cursor ${timeText(S.cursor)}`];
  if (S.markers.a !== null) parts.push(`A ${timeText(S.markers.a)}`);
  if (S.markers.b !== null) parts.push(`B ${timeText(S.markers.b)}`);
  if (S.markers.a !== null && S.markers.b !== null) parts.push(`B−A ${timeText(S.markers.b - S.markers.a)}`);
  else if (S.markers.a !== null && S.cursor !== null) parts.push(`Cursor−A ${timeText(S.cursor - S.markers.a)}`);
  ui.times.textContent = parts.join('   ');
}
function updateButtons() {
  const has = !!S.index;
  for (const b of ui.toolbar.querySelectorAll('button')) if (b.dataset.act !== 'tree' && b.dataset.act !== 'import') b.disabled = !has;
  const sel = S.rows.filter(r => S.sel.has(r.uid));
  ui.toolbar.querySelector('[data-act=bus]').textContent = sel.length === 1 && sel[0].kind === 'bus' ? 'Split bus' : 'Bus';
  ui.radix.disabled = !sel.length;
}
function updateInfo() {
  if (!S.header) { ui.info.textContent = S.sizeText ? `${S.name} · ${S.sizeText}` : ''; return; }
  const ts = S.header.timescaleText || `${S.header.timescale.num} ${S.header.timescale.unit}`;
  const bits = [`${S.header.vars.length.toLocaleString()} signals`, `timescale ${ts}`];
  if (S.index) bits.push(`${F.fmtTimeAuto(S.index.startTime, fsPerTick, S.index.endTime * fsPerTick)} to ${F.fmtTimeAuto(S.index.endTime, fsPerTick)}`);
  bits.push(S.sizeText);
  ui.info.textContent = bits.join(' · ');
}
let toastTimer = null;
function toast(text) {
  ui.toast.textContent = text; ui.toast.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { ui.toast.hidden = true; }, 4000);
}
function showWarnings() {
  const ws = S.warnings;
  if (!ws.length) { ui.warn.hidden = true; return; }
  ui.warn.replaceChildren(
    h('strong', {}, ws.length === 1 ? 'Note about this file: ' : `${ws.length} notes about this file: `),
    ...ws.map(w => h('span', { class: 'w', 'data-key': w.key }, w.examples[0] + (w.count > 1 ? ` (${w.count.toLocaleString()} times)` : ''))),
    h('button', { type: 'button', class: 'close', title: 'Hide', 'aria-label': 'Hide the notes', onclick: () => { ui.warn.hidden = true; } }, '×'));
  ui.warn.hidden = false;
}
function showError(message) {
  S.error = message;
  ui.notice.replaceChildren(h('strong', {}, 'This file cannot be shown'), h('p', {}, message),
    h('p', { class: 'dim' }, 'To see the text, right-click the editor tab and choose Reopen Editor With, then Text Editor.'));
  ui.notice.classList.add('error');
  ui.notice.hidden = false;
  ui.progress.hidden = true;
}
function setProgress(label, done, total) {
  if (label === null) { ui.progress.hidden = true; return; }
  ui.progress.hidden = false;
  const f = total ? done / total : 0;
  ui.progress.querySelector('.bar').style.width = (f * 100).toFixed(1) + '%';
  ui.progress.querySelector('.ptext').textContent = label;
}

// ---------- layout save / restore ----------
function layoutNow() {
  return {
    version: 1, file: S.name,
    signals: S.rows.map(r => {
      const o = r.kind === 'bus' ? { bus: r.bits.map(v => S.header.vars[v].path), name: r.name } : { path: varOf(r).path };
      if (r.alias) o.alias = r.alias;
      if (r.radix) o.radix = r.radix;
      return o;
    }),
    view: { start: S.view.t0, end: S.view.t1 }, cursor: S.cursor, markers: { ...S.markers },
  };
}
// Changes to the signal list are saved at once; zoom and cursor moves are saved 0.4 s after the last one.
let saveTimer = null;
function saveSoon(now) {
  if (!S.index || !S.header) return;
  clearTimeout(saveTimer);
  if (now) { vscode.postMessage({ type: 'saveLayout', layout: layoutNow() }); return; }
  saveTimer = setTimeout(() => vscode.postMessage({ type: 'saveLayout', layout: layoutNow() }), 400);
}
const saveList = () => saveSoon(true);
function applyLayout(layout, keepView) {
  const rows = [];
  let missing = 0;
  for (const s of layout.signals || []) {
    if (s.path !== undefined) {
      const v = pathIndex.get(s.path);
      if (v === undefined) { missing++; continue; }
      rows.push({ uid: S.uid++, kind: 'var', v, alias: s.alias || '', radix: s.radix || defaultRadix(v) });
    } else if (s.bus) {
      const bits = s.bus.map(p => pathIndex.get(p));
      if (bits.some(b => b === undefined)) { missing++; continue; }
      const name = s.name || `{${s.bus.length} signals}`;
      rows.push({ uid: S.uid++, kind: 'bus', bits, name, alias: s.alias || '', radix: s.radix || 'hex' });
    }
  }
  S.rows = rows;
  S.sel.clear(); S.focus = null;
  if (!keepView) {
    if (layout.view && layout.view.end > layout.view.start) S.view = { t0: layout.view.start, t1: layout.view.end };
    S.cursor = typeof layout.cursor === 'number' ? layout.cursor : null;
    S.markers = { a: layout.markers ? layout.markers.a : null, b: layout.markers ? layout.markers.b : null };
  }
  if (missing) toast(`${missing} signal${missing > 1 ? 's' : ''} of the saved list ${missing > 1 ? 'are' : 'is'} not in this file.`);
  requestLoad(); renderTree(); draw();
}
function defaultRows() {
  const H = S.header;
  const order = scopeVarsDeep(0);
  let n = Math.max(0, Number(S.settings.initialSignals) || 0);
  if (S.size > 200 * 1024 * 1024) n = Math.min(n, 16);
  const seen = new Set();
  const pick = [];
  for (const v of order) {
    if (pick.length >= n) break;
    if (H.vars[v].type === 'parameter') continue;
    if (seen.has(H.vars[v].id)) continue; // the same net seen through another scope
    seen.add(H.vars[v].id);
    pick.push(v);
  }
  S.rows = pick.map(v => ({ uid: S.uid++, kind: 'var', v, alias: '', radix: defaultRadix(v) }));
}

// ---------- messages from the extension ----------
let keepOnReload = null;
window.addEventListener('message', ev => {
  const m = ev.data;
  if (!m || typeof m !== 'object') return;
  switch (m.type) {
    case 'init': {
      if (m.reload && S.header && S.index) keepOnReload = { layout: layoutNow(), view: { ...S.view }, cursor: S.cursor, markers: { ...S.markers } };
      S.rows = []; S.sel.clear(); S.focus = null;
      Object.assign(S, { name: m.name, size: m.size, sizeText: m.sizeText, settings: { ...S.settings, ...m.settings }, savedLayout: m.layout || null });
      ROW_H = ROW_HEIGHTS[S.settings.rowHeight] || 24;
      document.documentElement.style.setProperty('--row-h', ROW_H + 'px');
      S.index = null; S.data = new Map(); S.pending = new Set(); S.error = null;
      ui.notice.hidden = true;
      updateInfo();
      if (!m.plan.load) { showError(m.plan.message); vscode.postMessage({ type: 'failed' }); return; }
      setProgress(m.reload ? 'The file changed on disk. Reading it again…' : 'Reading the signal list…', 0, 1);
      break;
    }
    case 'header': {
      S.header = m.header;
      S.rows = [];
      S.timing.header = Math.round(performance.now() - T0);
      pathIndex = new Map(S.header.vars.map((v, i) => [v.path, i]));
      fsPerTick = F.timeUnits(S.header.timescale).fsPerTick;
      S.warnings = S.header.warnings.slice();
      // open scopes level by level while the tree stays short (about 40 lines)
      S.expanded = new Set();
      {
        let level = [0], lines = S.header.scopes[0].children.length + S.header.scopes[0].vars.length;
        while (level.length) {
          const next = [];
          for (const sc of level) for (const c of S.header.scopes[sc].children) next.push(c);
          const add = next.reduce((a, c) => a + S.header.scopes[c].children.length + S.header.scopes[c].vars.length, 0);
          if (!next.length || (lines + add > 40 && S.expanded.size)) break;
          for (const c of next) S.expanded.add(c);
          lines += add;
          level = next;
        }
      }
      renderTree(); updateInfo();
      break;
    }
    case 'progress':
      setProgress(`Reading ${fmtMB(m.done)} of ${fmtMB(m.total)} (${Math.floor(m.done / m.total * 100)}%)…`, m.done, m.total);
      break;
    case 'indexed': {
      S.index = m;
      S.timing.indexed = Math.round(performance.now() - T0);
      S.warnings = S.header.warnings.concat(m.warnings || []);
      showWarnings();
      setProgress(null);
      const [a, b] = timeRange();
      S.view = { t0: a, t1: b + (b - a) * 0.02 };
      if (keepOnReload) {
        const k = keepOnReload; keepOnReload = null;
        applyLayout(k.layout, true);
        S.view = k.view; S.cursor = k.cursor; S.markers = k.markers;
        toast('The file changed on disk and was read again. Your signals are kept.');
      } else if (S.savedLayout && S.savedLayout.signals && S.savedLayout.signals.length) {
        applyLayout(S.savedLayout, false);
      } else {
        defaultRows();
        S.cursor = a;
      }
      ui.empty.replaceChildren(h('p', {}, 'No signals shown yet.'), h('p', { class: 'dim' }, 'Double-click a signal in the tree on the left, or press + next to a scope to add all of its signals. There is no limit on how many you show.'));
      updateInfo(); renderTree(); requestLoad(); draw();
      break;
    }
    case 'loadProgress':
      setProgress(`Loading signals… ${Math.floor(m.done / m.total * 100)}%`, m.done, m.total);
      break;
    case 'loaded': {
      const req = loads.get(m.reqId);
      loads.delete(m.reqId);
      for (const s of unpackSignals(m.packed)) { S.data.set(s.id, s); S.pending.delete(s.id); }
      if (req) S.timing.lastLoadMs = Math.round(performance.now() - req.t0);
      if (!loads.size) setProgress(null);
      for (const r of S.rows) if (r.kind === 'bus') r.cache = null;
      drawNow();
      if (!S.rendered && !loads.size) {
        S.rendered = true;
        S.timing.firstDraw = Math.round(performance.now() - T0);
        vscode.postMessage({ type: 'rendered' });
      }
      break;
    }
    case 'layout': applyLayout(m.layout, false); saveList(); toast(`Loaded ${S.rows.length} signals from the list.`); break;
    case 'notice': toast(m.message); break;
    case 'error':
      if (m.reqId) { const req = loads.get(m.reqId); loads.delete(m.reqId); if (req) for (const id of req.ids) S.pending.delete(id); setProgress(null); toast(m.message); draw(); break; }
      showError(m.message);
      break;
  }
});
function fmtMB(n) { return n >= 1024 * 1024 * 1024 ? (n / 1024 / 1024 / 1024).toFixed(2) + ' GB' : (n / 1024 / 1024).toFixed(1) + ' MB'; }

// ---------- test probe (read-only state for the real VS Code gate) ----------
window.vcdProbe = () => ({
  ready: !!S.index, error: S.error, name: S.name,
  nVars: S.header ? S.header.vars.length : 0,
  pending: S.pending.size + (loadQueued ? 1 : 0), rendered: S.rendered,
  rows: S.rows.map(r => ({ uid: r.uid, label: rowLabel(r), path: rowPath(r), kind: r.kind, radix: r.radix, id: r.kind === 'var' ? varOf(r).id : null, n: rowData(r) ? rowData(r).times.length : -1, raw: S.cursor === null ? null : rawAt(r, S.cursor).raw, text: valueText(r, S.cursor) })),
  selected: [...S.sel], focus: S.focus,
  cursor: S.cursor, view: { ...S.view }, markers: { ...S.markers }, times: ui.times.textContent,
  warnings: S.warnings.map(w => w.key), timing: { ...S.timing },
  theme: C.light ? 'light' : 'dark', treeItems: treeItems.length,
  domRows: ui.names.children.length, rowHeight: ROW_H,
});
window.vcdTest = {
  setCursor(t) { S.cursor = t; ensureVisible(t); drawNow(); return S.cursor; },
  setView(t0, t1) { S.view = { t0, t1 }; drawNow(); saveSoon(); return S.view; },
  addPaths(paths) { return addVars(paths.map(p => pathIndex.get(p)).filter(v => v !== undefined)); },
  rowIndex(path) { return S.rows.findIndex(r => rowPath(r) === path); },
};

vscode.postMessage({ type: 'ready' });
