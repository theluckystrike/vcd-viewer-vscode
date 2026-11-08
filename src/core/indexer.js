'use strict';
// Builds the block index of a VCD file and loads chosen signals from it. Works on a "reader"
// ({size, read(buf, bufOffset, length, filePosition) -> bytesRead}), so the same code runs on a file
// descriptor in the worker and on a Buffer in the tests.
const V = require('./vcd');

const MIN_BLOCK = 64 * 1024;
const MAX_BLOCK = 1024 * 1024;
const MAX_HEADER = 512 * 1024 * 1024;

function blockSizeFor(size) {
  return Math.max(MIN_BLOCK, Math.min(MAX_BLOCK, Math.ceil(size / 2048 / 4096) * 4096));
}

class VcdError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function fileReader(fs, fd, size) {
  return { size, read: (buf, o, n, pos) => fs.readSync(fd, buf, o, n, pos) };
}
function bufferReader(data) {
  const b = Buffer.isBuffer(data) ? data : Buffer.from(data.buffer || data, data.byteOffset || 0, data.byteLength);
  return { size: b.length, read: (buf, o, n, pos) => { const m = Math.max(0, Math.min(n, b.length - pos)); b.copy(buf, o, pos, pos + m); return m; } };
}

function readFully(reader, buf, o, n, pos) {
  let got = 0;
  while (got < n) {
    const r = reader.read(buf, o + got, n - got, pos + got);
    if (!r) break;
    got += r;
  }
  return got;
}

/**
 * Reads the declarations. Returns {header, bodyStart}. Throws VcdError for files that are not VCD.
 */
function readHeader(reader) {
  const size = reader.size;
  if (size === 0) throw new VcdError('empty', 'The file is empty.');
  let cap = Math.min(size, 1024 * 1024);
  let buf = Buffer.allocUnsafe(cap);
  let len = readFully(reader, buf, 0, cap, 0);
  const fb = V.firstByte(buf, Math.min(len, 4096));
  if (fb !== 36) {
    throw new VcdError('notvcd', 'This file does not look like a VCD waveform. A VCD file starts with a $ keyword such as $date, $timescale or $scope.');
  }
  for (;;) {
    const bs = V.findBodyStart(buf, len);
    if (bs >= 0) {
      const header = V.parseHeader(buf.toString('latin1', 0, bs));
      return { header, bodyStart: bs };
    }
    if (len >= size) throw new VcdError('noenddefs', 'The file has no "$enddefinitions $end" line, so the signal list is incomplete. Was the file cut off while the simulation started?');
    if (len >= MAX_HEADER) throw new VcdError('header', 'The declarations are longer than 512 MB. This viewer stops here.');
    const ncap = Math.min(size, cap * 2);
    const nb = Buffer.allocUnsafe(ncap);
    buf.copy(nb, 0, 0, len);
    buf = nb; cap = ncap;
    len += readFully(reader, buf, len, cap - len, len);
  }
}

/**
 * Scans the body once. Returns the index: block offsets and start times, change counts per id code,
 * the time range and warnings. progress(done, total) is called now and then.
 */
function buildIndex(reader, header, bodyStart, progress, opts = {}) {
  const size = reader.size;
  const BLOCK = opts.blockSize || blockSizeFor(size);
  const lookup = V.buildLookup(header.ids);
  const st = V.newScanState(lookup);
  const sink = new V.IndexSink(header.ids.length, Math.ceil((size - bodyStart) / BLOCK) + 16);
  const offsets = [], times = [];
  let want = BLOCK;
  let buf = Buffer.allocUnsafe(BLOCK * 2);
  let pos = bodyStart;
  let lastReport = 0;
  while (pos < size) {
    if (buf.length < want) buf = Buffer.allocUnsafe(want);
    const n = readFully(reader, buf, 0, Math.min(want, size - pos), pos);
    if (n <= 0) break;
    const final = pos + n >= size;
    const b = offsets.length;
    sink.setBlock(b);
    offsets.push(pos); times.push(st.time);
    const used = V.scanBody(buf, 0, n, final, st, sink, pos);
    if (used === 0 && !final) { offsets.pop(); times.pop(); want *= 2; continue; }
    want = BLOCK;
    pos += used;
    if (progress) {
      const now = Date.now();
      if (now - lastReport > 100) { lastReport = now; progress(pos, size); }
    }
  }
  offsets.push(pos);
  const warnings = V.scanWarnings(st);
  if (!st.truncated && size > bodyStart) {
    const last = Buffer.alloc(1);
    readFully(reader, last, 0, 1, size - 1);
    if (last[0] > 32) warnings.push({ key: 'noeol', count: 1, examples: ['The file does not end with a line break, so the last line may be cut off. Was the simulation stopped early?'] });
  }
  return {
    blockSize: BLOCK,
    offsets: Float64Array.from(offsets),
    times: Float64Array.from(times),
    sink,
    counts: sink.counts,
    startTime: st.firstTime < 0 ? 0 : Math.min(st.firstTime, st.time),
    endTime: st.time,
    timestamps: st.timestamps,
    warnings,
  };
}

/**
 * File ranges [start, end, timeAtStart] that hold changes of the given id codes. Consecutive blocks are
 * merged into one range of up to 8 MB.
 */
function rangesFor(index, ids, maxRange = 8 * 1024 * 1024) {
  const nBlocks = index.offsets.length - 1;
  const blocks = index.sink.blocksFor(ids, nBlocks);
  const out = [];
  for (let i = 0; i < blocks.length;) {
    let j = i;
    const start = index.offsets[blocks[i]];
    while (j + 1 < blocks.length && blocks[j + 1] === blocks[j] + 1 && index.offsets[blocks[j + 1] + 1] - start <= maxRange) j++;
    out.push([start, index.offsets[blocks[j] + 1], index.times[blocks[i]]]);
    i = j + 1;
  }
  return out;
}

/** Scans the ranges and returns the changes of the wanted ids: [{id, kind, size, times, codes|reals|vbytes+vends}]. */
function scanRanges(reader, headerIds, want, ranges, progress) {
  const sink = new V.LoadSink(headerIds, want);
  const lookup = V.buildLookup(headerIds);
  let buf = Buffer.allocUnsafe(1024 * 1024);
  let lastReport = Date.now();
  for (let k = 0; k < ranges.length; k++) {
    const [start, end, time] = ranges[k];
    const len = end - start;
    if (buf.length < len) buf = Buffer.allocUnsafe(len);
    const n = readFully(reader, buf, 0, len, start);
    const st = V.newScanState(lookup);
    st.time = time;
    st.firstTime = 0;
    V.scanBody(buf, 0, n, true, st, sink, start);
    if (progress && Date.now() - lastReport > 150) { lastReport = Date.now(); progress(k + 1, ranges.length); }
  }
  return sink.result();
}

/** Splits ranges into at most k contiguous parts of about the same byte size. */
function splitRanges(ranges, k) {
  const total = ranges.reduce((a, r) => a + (r[1] - r[0]), 0);
  const parts = [];
  let cur = [], acc = 0;
  for (const r of ranges) {
    cur.push(r); acc += r[1] - r[0];
    if (acc >= total / k && parts.length < k - 1) { parts.push(cur); cur = []; acc = 0; }
  }
  if (cur.length) parts.push(cur);
  return parts;
}

/** Joins the results of contiguous parts, in file order. */
function mergeResults(parts) {
  if (parts.length === 1) return parts[0];
  return parts[0].map((first, i) => {
    const list = parts.map(p => p[i]);
    const cat = (key, Ctor) => {
      const n = list.reduce((a, s) => a + s[key].length, 0);
      const out = new Ctor(n);
      let o = 0;
      for (const s of list) { out.set(s[key], o); o += s[key].length; }
      return out;
    };
    const r = { id: first.id, kind: first.kind, size: first.size, times: cat('times', Float64Array) };
    if (first.codes) r.codes = cat('codes', Uint8Array);
    else if (first.reals) r.reals = cat('reals', Float64Array);
    else {
      // bus and string values: join the byte buffers and shift the end offsets of each later part
      r.vbytes = cat('vbytes', Uint8Array);
      const ends = new Uint32Array(list.reduce((a, s) => a + s.vends.length, 0));
      let o = 0, base = 0;
      for (const s of list) { for (let k = 0; k < s.vends.length; k++) ends[o++] = s.vends[k] + base; base += s.vbytes.length; }
      r.vends = ends;
    }
    return r;
  });
}

/**
 * Loads all changes of the given id codes. Reads only the blocks that hold them.
 * Returns [{id, kind, size, times, codes|reals|vbytes+vends}] in the order of ids.
 */
function loadSignals(reader, header, index, ids, progress) {
  return scanRanges(reader, header.ids, ids, rangesFor(index, ids), progress);
}

module.exports = { readHeader, buildIndex, loadSignals, rangesFor, scanRanges, splitRanges, mergeResults, fileReader, bufferReader, blockSizeFor, VcdError };
