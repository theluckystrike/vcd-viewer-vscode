'use strict';
// Loaded signals travel from the extension host to the webview as a few buffers (times, scalar codes, reals,
// bus/string value bytes and their end offsets) plus offsets, instead of one typed array per signal. VS Code
// delivers a message with hundreds of separate typed arrays unreliably, and one buffer per kind is also
// cheaper to send. Bus and string values arrive in the webview as a PackedValues (core/packed.js).
const { PackedValues } = require('./packed');

function packSignals(signals) {
  let nt = 0, nc = 0, nr = 0, nb = 0, ne = 0;
  for (const s of signals) {
    nt += s.times.length; if (s.codes) nc += s.codes.length; if (s.reals) nr += s.reals.length;
    if (s.vbytes) { nb += s.vbytes.length; ne += s.vends.length; }
  }
  const times = new Float64Array(nt), codes = new Uint8Array(nc), reals = new Float64Array(nr);
  const vbytes = new Uint8Array(nb), vends = new Uint32Array(ne);
  let ot = 0, oc = 0, or = 0, ob = 0, oe = 0;
  const meta = signals.map(s => {
    const m = { id: s.id, kind: s.kind, size: s.size, t: [ot, s.times.length] };
    times.set(s.times, ot); ot += s.times.length;
    if (s.codes) { m.c = [oc, s.codes.length]; codes.set(s.codes, oc); oc += s.codes.length; }
    if (s.reals) { m.r = [or, s.reals.length]; reals.set(s.reals, or); or += s.reals.length; }
    if (s.vbytes) {
      // end offsets stay relative to the signal's own bytes
      m.v = [ob, s.vbytes.length, oe, s.vends.length];
      vbytes.set(s.vbytes, ob); ob += s.vbytes.length;
      vends.set(s.vends, oe); oe += s.vends.length;
    }
    return m;
  });
  return { meta, times, codes, reals, vbytes, vends };
}

function unpackSignals(p) {
  const times = p.times instanceof Float64Array ? p.times : new Float64Array(p.times);
  const codes = p.codes instanceof Uint8Array ? p.codes : new Uint8Array(p.codes);
  const reals = p.reals instanceof Float64Array ? p.reals : new Float64Array(p.reals);
  const vbytes = p.vbytes instanceof Uint8Array ? p.vbytes : new Uint8Array(p.vbytes || []);
  const vends = p.vends instanceof Uint32Array ? p.vends : new Uint32Array(p.vends || []);
  return p.meta.map(m => {
    const s = { id: m.id, kind: m.kind, size: m.size, times: times.subarray(m.t[0], m.t[0] + m.t[1]) };
    if (m.c) s.codes = codes.subarray(m.c[0], m.c[0] + m.c[1]);
    if (m.r) s.reals = reals.subarray(m.r[0], m.r[0] + m.r[1]);
    if (m.v) s.values = new PackedValues(vbytes.subarray(m.v[0], m.v[0] + m.v[1]), vends.subarray(m.v[2], m.v[2] + m.v[3]));
    return s;
  });
}

module.exports = { packSignals, unpackSignals };
