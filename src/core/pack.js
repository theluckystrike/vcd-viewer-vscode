'use strict';
// Loaded signals travel from the extension host to the webview as three buffers (times, scalar codes, reals)
// plus offsets, instead of one typed array per signal. VS Code delivers a message with hundreds of separate
// typed arrays unreliably, and one buffer per kind is also cheaper to send.

function packSignals(signals) {
  let nt = 0, nc = 0, nr = 0;
  for (const s of signals) { nt += s.times.length; if (s.codes) nc += s.codes.length; if (s.reals) nr += s.reals.length; }
  const times = new Float64Array(nt), codes = new Uint8Array(nc), reals = new Float64Array(nr);
  let ot = 0, oc = 0, or = 0;
  const meta = signals.map(s => {
    const m = { id: s.id, kind: s.kind, size: s.size, t: [ot, s.times.length] };
    times.set(s.times, ot); ot += s.times.length;
    if (s.codes) { m.c = [oc, s.codes.length]; codes.set(s.codes, oc); oc += s.codes.length; }
    if (s.reals) { m.r = [or, s.reals.length]; reals.set(s.reals, or); or += s.reals.length; }
    if (s.values) m.values = s.values;
    return m;
  });
  return { meta, times, codes, reals };
}

function unpackSignals(p) {
  const times = p.times instanceof Float64Array ? p.times : new Float64Array(p.times);
  const codes = p.codes instanceof Uint8Array ? p.codes : new Uint8Array(p.codes);
  const reals = p.reals instanceof Float64Array ? p.reals : new Float64Array(p.reals);
  return p.meta.map(m => {
    const s = { id: m.id, kind: m.kind, size: m.size, times: times.subarray(m.t[0], m.t[0] + m.t[1]) };
    if (m.c) s.codes = codes.subarray(m.c[0], m.c[0] + m.c[1]);
    if (m.r) s.reals = reals.subarray(m.r[0], m.r[0] + m.r[1]);
    if (m.values) s.values = m.values;
    return s;
  });
}

module.exports = { packSignals, unpackSignals };
