// Writes a large VCD for the large-file gate: 20,000 signals in 400 units, about targetMB of value changes.
// usage: node scripts/make_large.mjs <out.vcd> [targetMB=1024]
// Activity is mixed like a real design: a clock and a cycle counter change every step, 2% of the signals are
// busy, 18% change now and then, 80% change only a few times in the whole file.
import fs from 'node:fs';

const out = process.argv[2];
const target = Number(process.argv[3] || 1024) * 1024 * 1024;
let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const ident = n => { let s = ''; n += 1; while (n > 0) { n -= 1; s += String.fromCharCode(33 + (n % 94)); n = Math.floor(n / 94); } return s; };

const sigs = [];
const head = ['$date Sun Nov  8 2026 $end', '$version make_large.mjs $end', '$timescale 1ps $end', '$scope module tb $end'];
let n = 0;
const add = (name, w) => { const c = ident(n++); sigs.push({ c, w }); head.push(`$var wire ${w} ${c} ${name}${w > 1 ? ` [${w - 1}:0]` : ''} $end`); return sigs.length - 1; };
const clk = add('clk', 1);
const cyc = add('cycle', 32);
head.push('$scope module soc $end');
for (let core = 0; core < 40; core++) {
  head.push(`$scope module core${core} $end`);
  for (let u = 0; u < 10; u++) {
    head.push(`$scope module unit${u} $end`);
    for (let k = 0; k < 50 - (core === 0 && u === 0 ? 2 : 0); k++) {
      const w = k % 10 === 0 ? 32 : k % 5 === 0 ? 8 : 1;
      add(`s${k}`, w);
    }
    head.push('$upscope $end');
  }
  head.push('$upscope $end');
}
head.push('$upscope $end', '$upscope $end', '$enddefinitions $end');
const N = sigs.length;
// classes: busy 2%, medium 18%, rare 80%
const busy = [], medium = [], rare = [];
for (let i = 2; i < N; i++) { const r = (i * 2654435761) % 100; (r < 2 ? busy : r < 20 ? medium : rare).push(i); }
const fd = fs.openSync(out, 'w');
let written = 0;
const chunks = [];
let pending = 0;
const emit = s => { chunks.push(s); pending += s.length; if (pending > 4 << 20) flush(); };
const flush = () => { const b = Buffer.from(chunks.join(''), 'latin1'); fs.writeSync(fd, b); written += b.length; chunks.length = 0; pending = 0; };
const val = w => { if (w === 1) return rnd() < 0.5 ? '0' : '1'; let s = ''; for (let i = 0; i < w; i++) s += rnd() < 0.5 ? '0' : '1'; return s.replace(/^0+(?=.)/, ''); };
const change = i => { const w = sigs[i].w; return w === 1 ? val(1) + sigs[i].c + '\n' : 'b' + val(w) + ' ' + sigs[i].c + '\n'; };
emit(head.join('\n') + '\n#0\n$dumpvars\n');
for (let i = 0; i < N; i++) emit(sigs[i].w === 1 ? '0' + sigs[i].c + '\n' : 'b0 ' + sigs[i].c + '\n');
emit('$end\n');
// estimate steps: about 430 changes of ~9 bytes per step
const steps = Math.floor(target / 4300);
const rareChanges = 20; // per rare signal over the file
const rareEvery = Math.max(1, Math.floor(steps / (rareChanges * rare.length / 1)));
let t = 0, cycle = 0;
for (let s = 1; s <= steps && written + pending < target; s++) {
  t += 500;
  emit(`#${t}\n${s % 2}${sigs[clk].c}\n`);
  if (s % 2) { cycle++; emit(`b${cycle.toString(2)} ${sigs[cyc].c}\n`); }
  for (let k = 0; k < 200; k++) emit(change(busy[Math.floor(rnd() * busy.length)]));
  for (let k = 0; k < 180; k++) emit(change(medium[Math.floor(rnd() * medium.length)]));
  if (s % rareEvery === 0) emit(change(rare[Math.floor(rnd() * rare.length)]));
}
flush();
fs.closeSync(fd);
console.log(JSON.stringify({ out, bytes: written, signals: N, endTime: t, busy: busy.length, medium: medium.length, rare: rare.length, exampleRare: rare[0], exampleMedium: medium[0], exampleBusy: busy[0] }));
