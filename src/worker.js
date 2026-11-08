'use strict';
// Worker thread: owns one open VCD file. It reads the declarations, builds the block index and loads
// signals on request, so the extension host never holds the file or its value changes.
// For loads that touch many blocks it starts a few helper threads (the same file in "scan" mode) and
// gives each one part of the file.
const { Worker, parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const os = require('os');
const X = require('./core/indexer');

const PARALLEL_MIN_BYTES = 48 * 1024 * 1024;

function openReader() {
  if (workerData.path) {
    const fd = fs.openSync(workerData.path, 'r');
    return { fd, reader: X.fileReader(fs, fd, fs.fstatSync(fd).size) };
  }
  return { fd: null, reader: X.bufferReader(Buffer.from(workerData.buffer)) };
}

if (workerData && workerData.scan) {
  // ---- helper thread: scans the ranges it is given ----
  const { reader } = openReader();
  parentPort.on('message', m => {
    try {
      const signals = X.scanRanges(reader, workerData.ids, m.want, m.ranges);
      const transfer = [];
      for (const s of signals) { transfer.push(s.times.buffer); if (s.codes) transfer.push(s.codes.buffer); if (s.reals) transfer.push(s.reals.buffer); }
      parentPort.postMessage({ job: m.job, signals }, transfer);
    } catch (e) {
      parentPort.postMessage({ job: m.job, error: e.message || String(e) });
    }
  });
} else {
  main();
}

function main() {
  let reader = null, fd = null, header = null, index = null;
  let pool = null;
  let jobSeq = 0;
  let idleTimer = null;
  const jobs = new Map();

  const close = () => {
    clearTimeout(idleTimer);
    if (fd !== null) { try { fs.closeSync(fd); } catch {} fd = null; }
    if (pool) for (const w of pool) w.terminate();
    pool = null;
  };
  const fail = (e, reqId) => parentPort.postMessage({ type: 'error', reqId, code: e.code || 'error', message: e.message || String(e) });

  const helpers = () => {
    if (pool || !workerData.path) return pool;
    const n = Math.max(0, Math.min(6, (os.availableParallelism ? os.availableParallelism() : os.cpus().length) - 1));
    if (n < 2) return null;
    pool = [];
    for (let i = 0; i < n; i++) {
      const w = new Worker(__filename, { workerData: { scan: true, path: workerData.path, ids: header.ids }, resourceLimits: { maxOldGenerationSizeMb: 2048 } });
      w.on('message', m => { const j = jobs.get(m.job); if (j) { jobs.delete(m.job); j(m); } });
      w.on('error', () => {});
      pool.push(w);
    }
    return pool;
  };

  const runPart = (w, want, ranges) => new Promise((resolve, reject) => {
    const job = ++jobSeq;
    jobs.set(job, m => (m.error ? reject(new Error(m.error)) : resolve(m.signals)));
    w.postMessage({ job, want, ranges });
  });

  async function load(m) {
    const ids = (Array.isArray(m.ids) ? m.ids : []).filter(i => Number.isInteger(i) && i >= 0 && i < header.ids.length);
    const t0 = Date.now();
    const ranges = X.rangesFor(index, ids);
    const bytes = ranges.reduce((a, r) => a + (r[1] - r[0]), 0);
    let signals;
    const p = bytes >= PARALLEL_MIN_BYTES ? helpers() : null;
    if (p) {
      parentPort.postMessage({ type: 'loadProgress', reqId: m.reqId, done: 0, total: 1 });
      const parts = X.splitRanges(ranges, p.length);
      signals = X.mergeResults(await Promise.all(parts.map((part, i) => runPart(p[i], ids, part))));
    } else {
      signals = X.scanRanges(reader, header.ids, ids, ranges, (done, total) => parentPort.postMessage({ type: 'loadProgress', reqId: m.reqId, done, total }));
    }
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (pool) { for (const w of pool) w.terminate(); pool = null; } }, 60000);
    const transfer = [];
    for (const s of signals) { transfer.push(s.times.buffer); if (s.codes) transfer.push(s.codes.buffer); if (s.reals) transfer.push(s.reals.buffer); }
    parentPort.postMessage({ type: 'loaded', reqId: m.reqId, signals, ms: Date.now() - t0, bytes, threads: p ? p.length : 1 }, transfer);
  }

  // Loads run one after another, in the order they were asked for.
  let queue = Promise.resolve();
  parentPort.on('message', m => {
    if (!m || typeof m !== 'object') return;
    if (m.type === 'load') {
      queue = queue.then(() => (index ? load(m) : fail(new Error('The file is still being read.'), m.reqId))).catch(e => fail(e, m.reqId));
      return;
    }
    if (m.type === 'close') { close(); process.exit(0); }
  });

  const t0 = Date.now();
  try {
    ({ fd, reader } = openReader());
    const h = X.readHeader(reader);
    header = h.header;
    parentPort.postMessage({ type: 'header', header, size: reader.size, ms: Date.now() - t0 });
    index = X.buildIndex(reader, header, h.bodyStart, (done, total) => parentPort.postMessage({ type: 'progress', done, total }));
    parentPort.postMessage({
      type: 'indexed', ms: Date.now() - t0, size: reader.size,
      startTime: index.startTime, endTime: index.endTime, timestamps: index.timestamps,
      blocks: index.offsets.length - 1, counts: Float64Array.from(index.counts), warnings: index.warnings,
    });
  } catch (e) {
    close();
    fail(e);
  }
}
