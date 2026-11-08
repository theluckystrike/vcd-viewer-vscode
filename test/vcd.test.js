'use strict';
// The JS reader against the Python reference reader on every generated sample, plus block-size independence.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const X = require('../src/core/indexer');
const V = require('../src/core/vcd');
const { packedValues } = require('../src/core/packed');

const ROOT = path.join(__dirname, '..');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vcd-samples-'));
execFileSync('python3', ['-I', path.join(ROOT, 'scripts/make_samples.py'), DIR], { stdio: 'ignore' });
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));

function open(file, blockSize) {
  const buf = fs.readFileSync(file);
  const r = X.bufferReader(buf);
  const h = X.readHeader(r);
  const ix = X.buildIndex(r, h.header, h.bodyStart, null, blockSize ? { blockSize } : {});
  return { r, h, ix };
}
function valueAt(sig, t) {
  let lo = 0, hi = sig.times.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (sig.times[m] <= t) lo = m + 1; else hi = m; }
  const i = lo - 1;
  if (i < 0) return null;
  if (sig.codes) return V.CODE_CHARS[sig.codes[i]];
  if (sig.reals) return Number.isNaN(sig.reals[i]) ? 'nan' : sig.reals[i];
  return packedValues(sig).at(i);
}
const same = (a, b) => (typeof b === 'number' ? Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b)) : a === b);

for (const f of fs.readdirSync(DIR).filter(f => f !== 'hostile_not_a_vcd.vcd').sort()) {
  test(`${f}: values at 7 times match the Python reference, with large and tiny blocks`, () => {
    const file = path.join(DIR, f);
    for (const bs of [0, 4096]) {
      const { r, h, ix } = open(file, bs);
      const end = ix.endTime;
      const times = [0, 1, Math.floor(end / 5), Math.floor(end / 2), Math.floor(end * 0.77) + 3, end - 1, end];
      const ref = JSON.parse(execFileSync('python3', ['-I', path.join(ROOT, 'scripts/ref_vcd.py'), file, '--times', times.join(',')], { encoding: 'utf8', maxBuffer: 1 << 26 }));
      assert.strictEqual(ref.end, end, 'end time');
      assert.strictEqual(ref.vars, h.header.vars.length, 'var count');
      const ids = [...new Set(h.header.vars.map(v => v.id))];
      const sigs = X.loadSignals(r, h.header, ix, ids);
      const byId = new Map(sigs.map(s => [s.id, s]));
      let n = 0;
      for (const v of h.header.vars) {
        const exp = ref.paths[v.path];
        assert.ok(exp, 'reference has ' + v.path);
        times.forEach((t, k) => { const got = valueAt(byId.get(v.id), t); assert.ok(same(got, exp[k]), `${v.path} at ${t}: ${String(got).slice(0, 40)} vs ${String(exp[k]).slice(0, 40)} (block ${bs})`); n++; });
      }
      assert.ok(n > 0);
    }
  });
}

test('parallel parts merge to the same result as one pass', () => {
  const { r, h, ix } = open(path.join(DIR, 'soc_256_signals.vcd'), 4096);
  const ids = h.header.ids.map((_, i) => i);
  const one = X.loadSignals(r, h.header, ix, ids);
  const ranges = X.rangesFor(ix, ids, 4096);
  const parts = X.splitRanges(ranges, 3).map(p => X.scanRanges(r, h.header.ids, ids, p));
  assert.strictEqual(parts.length, 3);
  const merged = X.mergeResults(parts);
  for (let i = 0; i < one.length; i++) {
    assert.deepStrictEqual(Array.from(merged[i].times), Array.from(one[i].times));
    const vals = s => (s.codes ? Array.from(s.codes) : s.reals ? Array.from(s.reals) : packedValues(s).toArray());
    assert.deepStrictEqual(vals(merged[i]), vals(one[i]));
  }
});

test('a rare signal reads only the blocks that hold it', () => {
  const { h, ix } = open(path.join(DIR, 'soc_256_signals.vcd'), 4096);
  const irq = h.header.vars.find(v => v.path === 'tb.soc.irq[3:0]');
  const clk = h.header.vars.find(v => v.path === 'tb.soc.clk');
  const nb = ix.offsets.length - 1;
  assert.ok(nb > 8);
  assert.ok(ix.sink.blocksFor([irq.id], nb).length < nb / 2);
  assert.strictEqual(ix.sink.blocksFor([clk.id], nb).length, nb);
});

test('hostile files: clear errors and notes', () => {
  assert.throws(() => open(path.join(DIR, 'hostile_not_a_vcd.vcd')), e => e.code === 'notvcd');
  const t = open(path.join(DIR, 'hostile_truncated.vcd'));
  assert.ok(t.ix.warnings.some(w => w.key === 'truncated'));
  const b = open(path.join(DIR, 'hostile_time_backwards.vcd'));
  assert.deepStrictEqual(b.ix.warnings.find(w => w.key === 'backwards').count, 2);
  const d = open(path.join(DIR, 'hostile_ids_100k_bits.vcd'));
  assert.ok(d.h.header.warnings.some(w => w.key === 'dup'));
  assert.ok(d.ix.warnings.some(w => w.key === 'unknown'));
  assert.ok(d.h.header.vars.some(v => v.path === 'tb.dup_name#2'));
  assert.strictEqual(d.h.header.vars.find(v => v.path === 'tb.huge_vector[99999:0]').size, 100000);
  // every printable character works as an identifier code
  assert.strictEqual(new Set(d.h.header.ids.map(i => i.code).filter(c => c.length === 1)).size, 94);
  const empty = X.bufferReader(Buffer.alloc(0));
  assert.throws(() => X.readHeader(empty), e => e.code === 'empty');
  const noEnd = X.bufferReader(Buffer.from('$timescale 1ns $end\n$scope module a $end\n$var wire 1 ! x $end\n'));
  assert.throws(() => X.readHeader(noEnd), e => e.code === 'noenddefs');
});

test('header: timescales, scopes reopened, bit ranges, real and string kinds', () => {
  for (const [t, num, unit] of [['1ns', 1, 'ns'], ['10 ps', 10, 'ps'], ['100fs', 100, 'fs'], ['1 s', 1, 's'], ['1us', 1, 'us']]) {
    const h = V.parseHeader(`$timescale ${t} $end $enddefinitions $end`);
    assert.deepStrictEqual([h.timescale.num, h.timescale.unit], [num, unit]);
  }
  const h = V.parseHeader('$scope module a $end $var wire 8 # d [7:0] $end $upscope $end $scope module a $end $var real 1 $ r $end $var string 1 % s $end $upscope $end $enddefinitions $end');
  assert.strictEqual(h.scopes.length, 2);
  assert.deepStrictEqual(h.vars.map(v => [v.path, v.kind, v.msb, v.lsb]), [['a.d[7:0]', 'vector', 7, 0], ['a.r', 'real', undefined, undefined], ['a.s', 'string', undefined, undefined]]);
});

test('a declared width over 2^20 bits is read as 2^20 bits, with a note', () => {
  const src = '$timescale 1ns $end\n$scope module t $end\n$var wire 2147483647 ! big $end\n$var wire 8 " ok $end\n$upscope $end\n$enddefinitions $end\n#0\nb1 !\nb101 "\n#5\nbx !\n';
  const r = X.bufferReader(Buffer.from(src, 'latin1'));
  const h = X.readHeader(r);
  const big = h.header.vars.find(v => v.path === 't.big');
  assert.strictEqual(big.size, 1 << 20);
  assert.strictEqual(h.header.vars.find(v => v.path === 't.ok').size, 8);
  assert.ok(JSON.stringify(h.header).includes('2147483647'), 'the note names the declared width');
});

test('bus values are packed into bytes and read back the same, also across parallel parts', () => {
  const lines = ['$timescale 1ns $end', '$scope module t $end', '$var wire 1 ! clk $end', '$var wire 32 " cnt $end', '$var string 1 # s $end', '$upscope $end', '$enddefinitions $end'];
  for (let t = 0; t < 3000; t++) lines.push(`#${t}`, `${t & 1}!`, `b${t.toString(2)} "`, t % 7 ? `b${t % 3 ? 'X1Z0' : '10'} "` : `sname_${t} #`);
  const src = lines.join('\n') + '\n';
  const r = X.bufferReader(Buffer.from(src, 'latin1'));
  const h = X.readHeader(r);
  const ix = X.buildIndex(r, h.header, h.bodyStart, null, { blockSize: 4096 });
  const ids = h.header.ids.map((_, i) => i);
  const one = X.loadSignals(r, h.header, ix, ids);
  const cnt = one.find(s => s.kind === 'vector'), str = one.find(s => s.kind === 'string');
  assert.ok(cnt.vbytes instanceof Uint8Array && cnt.vends instanceof Uint32Array && !('values' in cnt));
  const cv = packedValues(cnt);
  assert.strictEqual(cv.length, cnt.times.length);
  assert.strictEqual(cv.at(0), '0');
  assert.strictEqual(cv.at(-1), cv.at(cv.length - 1));
  assert.ok(cv.toArray().includes('x1z0'), 'vector values are lower-cased as before');
  assert.strictEqual(packedValues(str).at(0), 'name_0');
  const parts = X.splitRanges(X.rangesFor(ix, ids, 4096), 4).map(p => X.scanRanges(r, h.header.ids, ids, p));
  const merged = X.mergeResults(parts);
  assert.deepStrictEqual(packedValues(merged.find(s => s.kind === 'vector')).toArray(), cv.toArray());
  assert.deepStrictEqual(packedValues(merged.find(s => s.kind === 'string')).toArray(), packedValues(str).toArray());
});
