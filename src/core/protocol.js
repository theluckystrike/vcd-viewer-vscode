'use strict';
// Message checks and small helpers shared by the extension host and the tests. No vscode import here.

const MAX_LAYOUT_SIGNALS = 20000;

function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Whether a file of this size is opened, and the text shown when it is not. */
function sizePlan(size, maxFileMB) {
  const limit = Math.max(1, Number(maxFileMB) || 16384) * 1024 * 1024;
  if (size > limit) {
    return { load: false, message: `This file is ${fmtSize(size)}. The limit in the setting vcdViewer.maxFileMB is ${fmtSize(limit)}. Raise the setting to open it.` };
  }
  return { load: true, message: '' };
}

const isStr = (v, max = 4096) => typeof v === 'string' && v.length <= max;

/** Keeps only the fields a saved signal list may have. Returns null when it is not a layout. */
function cleanLayout(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.signals)) return null;
  const radixes = new Set(['bin', 'hex', 'unsigned', 'signed', 'ascii', 'real']);
  const signals = [];
  for (const s of raw.signals.slice(0, MAX_LAYOUT_SIGNALS)) {
    if (!s || typeof s !== 'object') continue;
    const o = {};
    if (isStr(s.path, 4096) && s.path) o.path = s.path;
    else if (Array.isArray(s.bus) && s.bus.length && s.bus.length <= 4096 && s.bus.every(p => isStr(p, 4096))) o.bus = s.bus.slice();
    else continue;
    if (isStr(s.alias, 200) && s.alias) o.alias = s.alias;
    if (isStr(s.radix, 20) && radixes.has(s.radix)) o.radix = s.radix;
    signals.push(o);
  }
  const out = { version: 1, signals };
  const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  if (raw.view && typeof raw.view === 'object' && num(raw.view.start) !== null && num(raw.view.end) !== null && raw.view.end > raw.view.start) out.view = { start: raw.view.start, end: raw.view.end };
  if (num(raw.cursor) !== null) out.cursor = raw.cursor;
  if (raw.markers && typeof raw.markers === 'object') {
    out.markers = { a: num(raw.markers.a), b: num(raw.markers.b) };
  }
  if (isStr(raw.file, 1024)) out.file = raw.file;
  return out;
}

/** Validates a message from the webview. Returns {ok, msg}. */
function validateWebviewMessage(m) {
  if (!m || typeof m !== 'object' || typeof m.type !== 'string') return { ok: false };
  switch (m.type) {
    case 'ready': case 'rendered': case 'importLayout': case 'openSettings':
      return { ok: true, msg: { type: m.type } };
    case 'load': {
      if (!Array.isArray(m.ids) || m.ids.length > 100000 || !m.ids.every(i => Number.isInteger(i) && i >= 0)) return { ok: false };
      if (!Number.isInteger(m.reqId)) return { ok: false };
      return { ok: true, msg: { type: 'load', ids: m.ids, reqId: m.reqId } };
    }
    case 'saveLayout': case 'exportLayout': {
      const layout = cleanLayout(m.layout);
      return layout ? { ok: true, msg: { type: m.type, layout } } : { ok: false };
    }
    case 'copy':
      return isStr(m.text, 1e6) ? { ok: true, msg: { type: 'copy', text: m.text } } : { ok: false };
    case 'failed':
      return { ok: true, msg: { type: 'failed' } };
    default:
      return { ok: false };
  }
}

module.exports = { fmtSize, sizePlan, cleanLayout, validateWebviewMessage, MAX_LAYOUT_SIGNALS };
