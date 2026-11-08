'use strict';
// VCD (IEEE 1364 value change dump) reading, shared by the worker and the tests.
// The header (declarations) is parsed as text. The body is scanned as bytes: once to build a block index
// (which blocks hold changes of which signal), then again, block by block, only for the signals you add.
// Nothing here keeps all value changes of a file in memory.

const CODE_CHARS = '01xzuwlh-';
// byte -> scalar value code (0..8), -1 when the byte does not start a scalar change
const SCALAR = new Int8Array(256).fill(-1);
for (let i = 0; i < CODE_CHARS.length; i++) {
  SCALAR[CODE_CHARS.charCodeAt(i)] = i;
  SCALAR[CODE_CHARS.toUpperCase().charCodeAt(i)] = i;
}

const UNIT_EXP = { s: 0, ms: -3, us: -6, ns: -9, ps: -12, fs: -15 };
const REAL_TYPES = new Set(['real', 'realtime', 'shortreal']);
const MAX_WARN_EXAMPLES = 3;

function parseTimescale(text) {
  const m = /^\s*(1|10|100)\s*(s|ms|us|ns|ps|fs)\s*$/i.exec(String(text || ''));
  if (!m) return null;
  const unit = m[2].toLowerCase();
  return { num: Number(m[1]), unit, exp: UNIT_EXP[unit] };
}

/**
 * Parses the declaration part of a VCD file (everything before the first value change).
 * @param {string} text  header text, up to and including "$enddefinitions $end"
 * @returns {{timescale, timescaleText, date, version, scopes, vars, ids, warnings}}
 *  scopes[0] is the unnamed root. Each var has a full dotted path that is unique in the file.
 *  ids holds one entry per identifier code (several vars may share one code).
 */
function parseHeader(text) {
  const toks = String(text).split(/\s+/);
  let i = 0;
  const scopes = [{ name: '', type: 'root', parent: -1, children: [], vars: [], path: '' }];
  const vars = [];
  const ids = [];
  const idMap = new Map();
  const warnings = [];
  const paths = new Map();
  let cur = 0;
  let timescale = null, timescaleText = '', date = '', version = '';
  let ended = false;
  const warn = (key, text) => {
    const w = warnings.find(x => x.key === key);
    if (w) { w.count++; if (w.examples.length < MAX_WARN_EXAMPLES) w.examples.push(text); } else warnings.push({ key, count: 1, examples: [text] });
  };
  const collect = () => {
    const out = [];
    while (i < toks.length) {
      const t = toks[i++];
      if (t === '$end') return out;
      if (t) out.push(t);
    }
    return out;
  };
  while (i < toks.length && !ended) {
    const t = toks[i++];
    if (!t) continue;
    switch (t) {
      case '$timescale': {
        const a = collect();
        timescaleText = a.join(' ');
        timescale = parseTimescale(a.join(''));
        if (!timescale) warn('timescale', `Unknown $timescale "${timescaleText}". Times are shown as 1 ns steps.`);
        break;
      }
      case '$scope': {
        const a = collect();
        const type = a[0] || 'module';
        const name = a.slice(1).join(' ') || '(unnamed)';
        const parent = scopes[cur];
        let si = parent.children.find(c => scopes[c].name === name);
        if (si === undefined) {
          si = scopes.length;
          scopes.push({ name, type, parent: cur, children: [], vars: [], path: parent.path ? parent.path + '.' + name : name });
          parent.children.push(si);
        }
        cur = si;
        break;
      }
      case '$upscope':
        collect();
        if (cur > 0) cur = scopes[cur].parent; else warn('upscope', 'An $upscope has no matching $scope.');
        break;
      case '$var': {
        const a = collect();
        if (a.length < 4) { warn('var', `A $var line has too few fields: "$var ${a.join(' ')} $end"`); break; }
        const type = a[0].toLowerCase();
        let size = parseInt(a[1], 10);
        const code = a[2];
        const name = a.slice(3).join('');
        if (!(size >= 1)) { warn('size', `Signal ${name} has an unknown size "${a[1]}". It is read as 1 bit.`); size = 1; }
        const kind = REAL_TYPES.has(type) ? 'real' : type === 'string' ? 'string' : (size === 1 || type === 'event') ? 'scalar' : 'vector';
        let id = idMap.get(code);
        if (id === undefined) {
          id = ids.length;
          idMap.set(code, id);
          ids.push({ code, kind, size });
        } else if (ids[id].size !== size || ids[id].kind !== kind) {
          warn('alias', `Identifier "${code}" is used for signals of different sizes. The first size (${ids[id].size}) is used.`);
        }
        const sc = scopes[cur];
        let path = sc.path ? sc.path + '.' + name : name;
        const seen = paths.get(path) || 0;
        if (seen) {
          warn('dup', `Signal ${path} is declared ${seen + 1} times. The copies are listed as ${path}#2 and so on.`);
          paths.set(path, seen + 1);
          path = `${path}#${seen + 1}`;
        } else paths.set(path, 1);
        const bm = /\[(-?\d+)(?::(-?\d+))?\]$/.exec(name);
        const v = { name, path, scope: cur, type, size: ids[id].size, kind: ids[id].kind, id };
        if (bm) { v.msb = Number(bm[1]); v.lsb = bm[2] === undefined ? Number(bm[1]) : Number(bm[2]); }
        sc.vars.push(vars.length);
        vars.push(v);
        break;
      }
      case '$date': date = collect().join(' '); break;
      case '$version': version = collect().join(' '); break;
      case '$enddefinitions': collect(); ended = true; break;
      default:
        if (t[0] === '$') collect(); // $comment, $attrbegin and other sections we do not need
        else warn('stray', `Unexpected text "${t.slice(0, 40)}" in the declarations.`);
    }
  }
  if (cur !== 0) warn('scope', 'A $scope is not closed with $upscope.');
  if (!vars.length) warn('novars', 'The file declares no signals ($var).');
  if (!timescale && !timescaleText) warn('timescale', 'The file has no $timescale. Times are shown as 1 ns steps.');
  return {
    timescale: timescale || { num: 1, unit: 'ns', exp: -9 }, timescaleText, date, version,
    scopes, vars, ids, warnings,
  };
}

/** Byte offset just after "$enddefinitions ... $end", or -1. buf is a Node Buffer. */
function findBodyStart(buf, len) {
  const at = buf.indexOf('$enddefinitions', 0, 'latin1');
  if (at < 0 || at >= len) return -1;
  let p = at + 15;
  for (;;) {
    const e = buf.indexOf('$end', p, 'latin1');
    if (e < 0 || e + 4 > len) return -1;
    const after = e + 4 < len ? buf[e + 4] : 32;
    if (after <= 32) return e + 4;
    p = e + 4;
  }
}

/** First non-space byte; a VCD file starts with a $ keyword. */
function firstByte(buf, len) {
  for (let i = 0; i < len; i++) if (buf[i] > 32) return buf[i];
  return -1;
}

// Identifier codes of 1 to 3 printable characters map through a flat table (base 95), longer ones through a Map.
const T3 = 95 * 95 * 95;
function buildLookup(ids) {
  const table = new Int32Array(T3);
  const map = new Map();
  for (let i = 0; i < ids.length; i++) {
    const c = ids[i].code;
    if (c.length <= 3) {
      let k = 0;
      for (let j = 0; j < c.length; j++) k = k * 95 + (c.charCodeAt(j) - 32);
      table[k] = i + 1;
    } else map.set(c, i);
  }
  return { table, map };
}

function lookupId(lk, buf, s, e) {
  const n = e - s;
  if (n <= 3) {
    let k = 0;
    for (let j = s; j < e; j++) {
      const d = buf[j] - 32;
      if (d < 1 || d > 94) return -1;
      k = k * 95 + d;
    }
    return lk.table[k] - 1;
  }
  if (!lk.map.size) return -1;
  const v = lk.map.get(latin1(buf, s, e));
  return v === undefined ? -1 : v;
}

function latin1(buf, s, e) {
  if (typeof buf.latin1Slice === 'function') return buf.latin1Slice(s, e);
  let out = '';
  for (let i = s; i < e; i += 8192) out += String.fromCharCode.apply(null, buf.subarray(i, Math.min(e, i + 8192)));
  return out;
}

function newScanState(lookup) {
  return {
    lookup, time: 0, timestamps: 0, firstTime: -1,
    backwards: 0, backwardsAt: [], bad: 0, badAt: [], unknown: 0, unknownAt: [], truncated: '',
  };
}

function note(arr, v) { if (arr.length < MAX_WARN_EXAMPLES) arr.push(v); }

function isComment(buf, s, e) {
  // "$comment"
  return e - s === 8 && buf[s + 1] === 99 && buf[s + 2] === 111 && buf[s + 3] === 109 && buf[s + 4] === 109 && buf[s + 5] === 101 && buf[s + 6] === 110 && buf[s + 7] === 116;
}
function isEnd(buf, s, e) { return e - s === 4 && buf[s] === 36 && buf[s + 1] === 101 && buf[s + 2] === 110 && buf[s + 3] === 100; }

/**
 * Scans value-change bytes buf[start, end). base is the file offset of buf[0] (for messages).
 * When final is false, scanning stops before a token or change that may continue past end, and the
 * return value is where it stopped. sink gets scalar(id, code, time), vector(id, buf, s, e, time),
 * real(id, buf, s, e, time) and str(id, buf, s, e, time).
 * Timestamps that go backwards are kept at the last time and counted in st.backwards.
 */
function scanBody(buf, start, end, final, st, sink, base) {
  const lk = st.lookup;
  let p = start;
  for (;;) {
    while (p < end && buf[p] <= 32) p++;
    if (p >= end) return end;
    const ts = p;
    while (p < end && buf[p] > 32) p++;
    const te = p;
    if (te === end && !final) return ts;
    const c = buf[ts];
    if (c === 35) { // #time
      let v = 0, ok = te > ts + 1;
      for (let k = ts + 1; k < te; k++) {
        const d = buf[k] - 48;
        if (d < 0 || d > 9) { ok = false; break; }
        v = v * 10 + d;
      }
      if (!ok) { st.bad++; note(st.badAt, base + ts); continue; }
      st.timestamps++;
      if (st.firstTime < 0) st.firstTime = v;
      if (v < st.time) { st.backwards++; note(st.backwardsAt, [base + ts, v, st.time]); } else st.time = v;
      continue;
    }
    const sc = SCALAR[c];
    if (sc >= 0) {
      if (te - ts < 2) { if (final && te === end) st.truncated = st.truncated || 'value'; else { st.bad++; note(st.badAt, base + ts); } continue; }
      const id = lookupId(lk, buf, ts + 1, te);
      if (id < 0) { st.unknown++; note(st.unknownAt, base + ts); continue; }
      sink.scalar(id, sc, st.time);
      continue;
    }
    if (c === 98 || c === 66 || c === 114 || c === 82 || c === 115 || c === 83) { // b B r R s S
      let q = te;
      while (q < end && buf[q] <= 32) q++;
      if (q >= end) {
        if (!final) return ts;
        st.truncated = st.truncated || 'change';
        return end;
      }
      const is = q;
      while (q < end && buf[q] > 32) q++;
      if (q === end && !final) return ts;
      p = q;
      if (te - ts < 2) { st.bad++; note(st.badAt, base + ts); continue; }
      const id = lookupId(lk, buf, is, q);
      if (id < 0) { st.unknown++; note(st.unknownAt, base + ts); continue; }
      if (c === 98 || c === 66) sink.vector(id, buf, ts + 1, te, st.time);
      else if (c === 114 || c === 82) sink.real(id, buf, ts + 1, te, st.time);
      else sink.str(id, buf, ts + 1, te, st.time);
      continue;
    }
    if (c === 36) { // $keyword: $dumpvars, $dumpall, $dumpon, $dumpoff and $end carry no data; skip $comment text
      if (isComment(buf, ts, te)) {
        let q = te, found = false;
        while (q < end) {
          while (q < end && buf[q] <= 32) q++;
          const s2 = q;
          while (q < end && buf[q] > 32) q++;
          if (q > s2 && isEnd(buf, s2, q) && (q < end || final)) { found = true; break; }
        }
        if (!found && !final) return ts;
        p = q;
      }
      continue;
    }
    st.bad++; note(st.badAt, base + ts);
  }
}

/** Index sink: counts changes per identifier and marks the blocks that hold them. */
class IndexSink {
  constructor(nIds, capBlocks) {
    this.n = nIds;
    this.counts = new Float64Array(nIds);
    this.last = new Int32Array(nIds).fill(-1);
    this.cap = Math.max(8, capBlocks);
    this.bpi = Math.ceil(this.cap / 8);
    this.bits = new Uint8Array(nIds * this.bpi);
    this.block = 0;
  }
  setBlock(b) {
    if (b >= this.cap) {
      const cap = Math.max(b + 1, this.cap * 2), bpi = Math.ceil(cap / 8);
      const nb = new Uint8Array(this.n * bpi);
      for (let i = 0; i < this.n; i++) nb.set(this.bits.subarray(i * this.bpi, (i + 1) * this.bpi), i * bpi);
      this.bits = nb; this.cap = cap; this.bpi = bpi;
    }
    this.block = b;
  }
  mark(id) {
    this.counts[id]++;
    const b = this.block;
    if (this.last[id] !== b) { this.last[id] = b; this.bits[id * this.bpi + (b >> 3)] |= 1 << (b & 7); }
  }
  scalar(id) { this.mark(id); }
  vector(id) { this.mark(id); }
  real(id) { this.mark(id); }
  str(id) { this.mark(id); }
  /** Sorted block numbers that hold changes of any of the given ids. */
  blocksFor(idList, nBlocks) {
    const any = new Uint8Array(this.bpi);
    for (const id of idList) {
      const o = id * this.bpi;
      for (let k = 0; k < this.bpi; k++) any[k] |= this.bits[o + k];
    }
    const out = [];
    for (let b = 0; b < nBlocks; b++) if (any[b >> 3] & (1 << (b & 7))) out.push(b);
    return out;
  }
}

/** Load sink: keeps the changes of the wanted ids only. */
class LoadSink {
  constructor(ids, want) {
    this.want = new Int32Array(ids.length).fill(-1);
    this.slots = want.map((id, k) => {
      this.want[id] = k;
      return { id, kind: ids[id].kind, size: ids[id].size, times: [], vals: [] };
    });
  }
  scalar(id, code, t) {
    const k = this.want[id];
    if (k < 0) return;
    const s = this.slots[k];
    s.times.push(t);
    if (s.kind === 'scalar') s.vals.push(code);
    else if (s.kind === 'vector') s.vals.push(CODE_CHARS[code]);
    else if (s.kind === 'real') s.vals.push(NaN);
    else s.vals.push(CODE_CHARS[code]);
  }
  vector(id, buf, a, b, t) {
    const k = this.want[id];
    if (k < 0) return;
    const s = this.slots[k];
    s.times.push(t);
    if (s.kind === 'scalar') { const c = SCALAR[buf[b - 1]]; s.vals.push(c < 0 ? 2 : c); }
    else if (s.kind === 'real') s.vals.push(parseInt(latin1(buf, a, b), 2));
    else s.vals.push(latin1(buf, a, b).toLowerCase());
  }
  real(id, buf, a, b, t) {
    const k = this.want[id];
    if (k < 0) return;
    const s = this.slots[k];
    s.times.push(t);
    const v = parseFloat(latin1(buf, a, b));
    if (s.kind === 'real') s.vals.push(v);
    else if (s.kind === 'scalar') s.vals.push(2);
    else s.vals.push(String(v));
  }
  str(id, buf, a, b, t) {
    const k = this.want[id];
    if (k < 0) return;
    const s = this.slots[k];
    s.times.push(t);
    if (s.kind === 'scalar') s.vals.push(2);
    else if (s.kind === 'real') s.vals.push(NaN);
    else s.vals.push(latin1(buf, a, b));
  }
  /** Packs the result for postMessage: times as Float64Array, scalar codes as Uint8Array, reals as Float64Array. */
  result() {
    return this.slots.map(s => {
      const times = Float64Array.from(s.times);
      if (s.kind === 'scalar') return { id: s.id, kind: s.kind, size: s.size, times, codes: Uint8Array.from(s.vals) };
      if (s.kind === 'real') return { id: s.id, kind: s.kind, size: s.size, times, reals: Float64Array.from(s.vals) };
      return { id: s.id, kind: s.kind, size: s.size, times, values: s.vals };
    });
  }
}

/** Human-readable warnings from a finished body scan. */
function scanWarnings(st) {
  const out = [];
  if (st.backwards) {
    const [off, t, kept] = st.backwardsAt[0];
    out.push({ key: 'backwards', count: st.backwards, examples: [`Timestamp #${t} at byte ${off} is earlier than #${kept}. Changes after it are drawn at the later time.`] });
  }
  if (st.truncated) out.push({ key: 'truncated', count: 1, examples: ['The file ends in the middle of a value change. The last change is left out. Was the simulation stopped early?'] });
  if (st.unknown) out.push({ key: 'unknown', count: st.unknown, examples: st.unknownAt.map(o => `A value change at byte ${o} uses an identifier code that no $var declares. It is skipped.`) });
  if (st.bad) out.push({ key: 'bad', count: st.bad, examples: st.badAt.map(o => `Unreadable text at byte ${o} is skipped.`) });
  return out;
}

module.exports = {
  CODE_CHARS, SCALAR, UNIT_EXP, parseTimescale, parseHeader, findBodyStart, firstByte,
  buildLookup, lookupId, newScanState, scanBody, IndexSink, LoadSink, scanWarnings, latin1,
};
