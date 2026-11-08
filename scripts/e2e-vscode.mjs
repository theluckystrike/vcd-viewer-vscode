// Release gate in a real VS Code: installs the .vsix into an isolated profile, opens every sample, compares the
// values at 5 cursor times with the Python reference reader (scripts/ref_vcd.py), drives the viewer with real
// mouse and key events, and writes screenshots and a JSON report.
// usage: node scripts/e2e-vscode.mjs <work> <port> <vsix> <samplesDir> <shotDir> <outJson> [largeVcd] [theme]
import { launch, installVsix, sleep } from './vsc.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, execSync } from 'node:child_process';

const [work0, port, vsix, ws0, shotDir, outJson, large, theme] = process.argv.slice(2);
const work = path.resolve(work0), ws = path.resolve(ws0);
const HERE = path.dirname(new URL(import.meta.url).pathname);
const R = { theme: theme || 'Default Dark Modern', install: null, steps: [], console: [], unchanged: null, files: {} };
const hash = f => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex');
const hashes = {};
for (const f of fs.readdirSync(ws)) if (f.endsWith('.vcd')) hashes[f] = hash(path.join(ws, f));
fs.rmSync(path.join(work, 'ud'), { recursive: true, force: true });
R.install = installVsix(work, vsix);
const vs = await launch(work, Number(port), ws, {
  'workbench.colorTheme': R.theme, 'workbench.secondarySideBar.defaultVisibility': 'hidden', 'workbench.auxiliaryBar.visible': false,
  'window.titleBarStyle': 'custom', 'files.simpleDialog.enable': true,
});
const shots = [];
const tag = R.theme.includes('Light') ? 'light' : 'dark';
const shot = async name => { const f = path.join(shotDir, `${tag}-${String(shots.length + 1).padStart(2, '0')}-${name}.png`); await vs.shot(f); shots.push(f); return f; };
const step = async (name, fn) => {
  const t0 = Date.now();
  try { const v = await fn(); R.steps.push({ name, ok: v !== false, value: v, ms: Date.now() - t0 }); console.log('PASS', name, JSON.stringify(v).slice(0, 300)); }
  catch (e) { R.steps.push({ name, ok: false, error: String(e.message || e).slice(0, 1500), ms: Date.now() - t0 }); console.log('FAIL', name, String(e.message || e).slice(0, 600)); try { await shot('FAIL-' + name.replace(/\W+/g, '_').slice(0, 40)); } catch {} }
};
let wv;
const E = expr => vs.wvEval(wv, expr);
const probe = async () => JSON.parse(await E(`JSON.stringify(window.vcdProbe(), (k, v) => (typeof v === 'number' && Number.isNaN(v) ? 'nan' : v))`));
const getWv = async title => vs.waitFor(async () => (await vs.webviews()).find(w => w.title === title && w.w > 0), 30000);
const open = async (file, dir = ws) => {
  const t0 = Date.now(); vs.open(path.join(dir, file)); await sleep(500);
  wv = await getWv(file); if (!wv) throw new Error('no webview for ' + file);
  const p = await vs.waitFor(async () => { const p = await probe(); return p && (p.rendered || p.error) && !p.pending ? p : null; }, 120000, 200);
  if (!p) throw new Error('not ready: ' + JSON.stringify(await probe()).slice(0, 400));
  await sleep(250);
  return { ms: Date.now() - t0, p };
};
const tabCount = () => vs.wbEval(`document.querySelectorAll('.tabs-container .tab').length`);
const closeEditor = async () => {
  const n0 = await tabCount();
  const clicked = await vs.wbEval(`(() => { const t = document.querySelector('.tabs-container .tab.active'); const b = t && t.querySelector('.tab-actions .action-label'); if (b) { b.click(); return true; } return false; })()`);
  if (clicked && await vs.waitFor(async () => (await tabCount()) < n0, 2000, 100)) { await sleep(300); return; }
  await vs.key('w', 'KeyW', 4, 87);
  if (await vs.waitFor(async () => (await tabCount()) < n0, 2000, 100)) { await sleep(300); return; }
  await vs.command('View: Close Editor');
  await sleep(400);
};
const btn = t => `[...document.querySelectorAll('button')].find(b => b.textContent === ${JSON.stringify(t)})`;
const rowEl = label => `[...document.querySelectorAll('.nrow')].find(r => r.querySelector('.n-name') && r.querySelector('.n-name').textContent.replace(/^bus/, '') === ${JSON.stringify(label)})`;
const wavePoint = async (fx, rowIndex) => {
  const off = await vs.wvOffset();
  const b = JSON.parse(await E(`JSON.stringify(document.querySelector('canvas.waves').getBoundingClientRect())`));
  const rh = (await probe()).rowHeight;
  return { x: off.x + b.x + b.width * fx, y: off.y + b.y + (rowIndex === undefined ? b.height / 2 : rowIndex * rh + rh / 2) };
};
const ref = (file, times, paths) => {
  const args = ['-I', path.join(HERE, 'ref_vcd.py'), file, '--times', times.join(',')];
  if (paths) args.push('--paths', paths.join(','));
  return JSON.parse(execFileSync('python3', args, { encoding: 'utf8', maxBuffer: 1 << 28, timeout: 900000 }));
};
const same = (a, b) => {
  if (a === null || b === null) return a === b;
  if (typeof b === 'number') return (a === 'nan' && Number.isNaN(b)) || (typeof a === 'number' && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b)));
  if (b === 'nan') return a === 'nan';
  return String(a).toLowerCase() === String(b).toLowerCase();
};
// Shows every signal of the file (button "Add all"), then compares the raw value of each row at 5 times.
async function compareAt(file, times) {
  const p0 = await probe();
  if (p0.rows.length < p0.nVars) { await vs.wvClick(wv, btn('Add all')); await vs.waitFor(async () => { const p = await probe(); return p.rows.length >= p.nVars && !p.pending; }, 60000); }
  const want = await probe();
  const paths = want.rows.filter(r => r.kind === 'var').map(r => r.path);
  const rf = ref(path.join(ws, file), times);
  let checked = 0; const bad = [];
  for (let k = 0; k < times.length; k++) {
    await E(`window.vcdTest.setCursor(${times[k]})`);
    const p = await probe();
    for (const r of p.rows) {
      if (r.kind !== 'var') continue;
      const exp = rf.paths[r.path];
      if (!exp) { bad.push({ path: r.path, why: 'not in reference' }); continue; }
      checked++;
      if (!same(r.raw, exp[k])) bad.push({ t: times[k], path: r.path, viewer: r.raw, reference: exp[k] });
    }
  }
  if (bad.length) throw new Error(`${bad.length} mismatches: ` + JSON.stringify(bad.slice(0, 5)).slice(0, 900));
  return { signals: paths.length, times, checked };
}
const pick5 = (a, b) => { const s = Math.max(1, b - a); return [a, Math.round(a + s * 0.23) + 1, Math.round(a + s * 0.5), Math.round(a + s * 0.77) + 3, b]; };

try {
  await sleep(2500);
  await vs.command('View: Close Primary Side Bar').catch(() => {});
  const samples = fs.readdirSync(ws).filter(f => f.endsWith('.vcd') && f !== 'hostile_not_a_vcd.vcd').sort();

  // 1. every sample: opens, values match the reference at 5 times
  for (const f of samples) {
    await step(`${f}: opens and values at 5 cursor times match the reference reader`, async () => {
      const { ms, p } = await open(f);
      if (p.error) throw new Error(p.error);
      const range = JSON.parse(await E(`JSON.stringify([window.vcdProbe().view, document.querySelector('.status .info').textContent])`));
      const ix = await E(`JSON.stringify(null)`); void ix;
      const end = Number(ref(path.join(ws, f), [0]).end);
      const r = await compareAt(f, pick5(0, end));
      R.files[f] = { openMs: ms, vars: p.nVars, firstDrawMs: p.timing.firstDraw, warnings: p.warnings, info: range[1] };
      if (['counter.vcd', 'axi_lite_bus.vcd', 'iverilog_fifo.vcd', 'wide_64bit_x_z.vcd'].includes(f) && tag === 'dark') await shot(f.replace(/\W+/g, '_'));
      await closeEditor();
      return { openMs: ms, ...r, warnings: p.warnings };
    });
  }

  // 2. interactions on the AXI bus file
  await step('axi_lite_bus.vcd: click places the cursor, wheel zoom at the mouse, drag pans, Fit restores', async () => {
    await open('axi_lite_bus.vcd');
    await vs.wvClick(wv, btn('Fit')); await sleep(200);
    const v0 = (await probe()).view;
    const pt = await wavePoint(0.25, 3);
    await vs.click(pt.x, pt.y);
    const p1 = await probe();
    const expT = v0.t0 + 0.25 * (v0.t1 - v0.t0);
    if (Math.abs(p1.cursor - expT) > (v0.t1 - v0.t0) * 0.01) throw new Error(`cursor ${p1.cursor} expected about ${expT}`);
    if (p1.focus === null) throw new Error('click did not select the row');
    for (let i = 0; i < 3; i++) { await vs.s.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: pt.x, y: pt.y, deltaX: 0, deltaY: -200, modifiers: 4 }, vs.wb); await sleep(120); }
    await sleep(300);
    const v1 = (await probe()).view;
    const tAtMouse0 = v0.t0 + 0.25 * (v0.t1 - v0.t0), tAtMouse1 = v1.t0 + 0.25 * (v1.t1 - v1.t0);
    if (!((v1.t1 - v1.t0) < (v0.t1 - v0.t0) * 0.6) || Math.abs(tAtMouse1 - tAtMouse0) > (v1.t1 - v1.t0) * 0.02) throw new Error('wheel zoom ' + JSON.stringify({ v0, v1 }));
    // drag to pan
    await vs.s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 }, vs.wb);
    for (let k = 1; k <= 5; k++) { await vs.s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x - k * 30, y: pt.y, button: 'left', buttons: 1 }, vs.wb); await sleep(30); }
    await vs.s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x - 150, y: pt.y, button: 'left', clickCount: 1 }, vs.wb);
    await sleep(200);
    const v2 = (await probe()).view;
    if (!(v2.t0 > v1.t0)) throw new Error('drag did not pan ' + JSON.stringify({ v1, v2 }));
    await shot('axi-zoomed');
    await vs.wvClick(wv, btn('Fit')); await sleep(200);
    const v3 = (await probe()).view;
    if (Math.abs(v3.t0 - v0.t0) > 1 || Math.abs(v3.t1 - v0.t1) > 1) throw new Error('fit ' + JSON.stringify({ v0, v3 }));
    return { cursor: p1.cursor, zoomSpan: [v0.t1 - v0.t0, v1.t1 - v1.t0], pannedBy: v2.t0 - v1.t0 };
  });
  await step('axi_lite_bus.vcd: Shift+drag zooms to the range; next/previous edge by arrow keys; markers A and B with B−A', async () => {
    const p0 = await probe();
    const a = await wavePoint(0.2, 0), b = await wavePoint(0.4, 0);
    await vs.s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: a.x, y: a.y, button: 'left', clickCount: 1, modifiers: 8 }, vs.wb);
    for (let k = 1; k <= 6; k++) { await vs.s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x + (b.x - a.x) * k / 6, y: a.y, button: 'left', buttons: 1, modifiers: 8 }, vs.wb); await sleep(30); }
    await vs.s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1, modifiers: 8 }, vs.wb);
    await sleep(250);
    const v = (await probe()).view;
    const span0 = p0.view.t1 - p0.view.t0;
    if (Math.abs((v.t1 - v.t0) - span0 * 0.2) > span0 * 0.02) throw new Error('range zoom ' + JSON.stringify({ v, span0 }));
    await vs.wvClick(wv, btn('Fit'));
    // select awvalid, cursor to 0, then edges
    await vs.wvClick(wv, rowEl('awvalid'));
    await E(`window.vcdTest.setCursor(0)`);
    const sel = (await probe()).rows.find(r => r.uid === (0, 0));
    void sel;
    const pf = await probe();
    const focusRow = pf.rows.find(r => r.uid === pf.focus);
    await vs.key('ArrowRight', 'ArrowRight'); const e1 = (await probe()).cursor;
    await vs.key('a', 'KeyA');
    await vs.key('ArrowRight', 'ArrowRight'); const e2 = (await probe()).cursor;
    await vs.key('b', 'KeyB');
    await vs.key('ArrowLeft', 'ArrowLeft'); const e3 = (await probe()).cursor;
    const p = await probe();
    const rf = ref(path.join(ws, 'axi_lite_bus.vcd'), [e1 - 1, e1, e2 - 1, e2], [focusRow.path]).paths[focusRow.path];
    if (!(e1 > 0 && e2 > e1 && e3 === e1)) throw new Error(JSON.stringify({ e1, e2, e3 }));
    if (rf[0] === rf[1] || rf[2] === rf[3]) throw new Error('edges are not value changes ' + JSON.stringify(rf));
    if (p.markers.a !== e1 || p.markers.b !== e2 || !/B−A/.test(p.times)) throw new Error(JSON.stringify(p.markers) + p.times);
    await vs.wvClick(wv, btn('Zoom A–B')); await sleep(200);
    const vz = (await probe()).view;
    if (!(vz.t0 < e1 && vz.t1 > e2 && vz.t1 - vz.t0 < (e2 - e1) * 1.3)) throw new Error('zoom A-B ' + JSON.stringify(vz));
    await shot('axi-markers');
    await vs.wvClick(wv, btn('Fit'));
    await closeEditor();
    return { signal: focusRow.path, edge1: e1, edge2: e2, back: e3, valuesAroundEdges: rf, times: p.times };
  });

  await step('README scene: axi_lite_bus.vcd, markers on the first write handshake, cursor on the address phase', async () => {
    await open('axi_lite_bus.vcd');
    await vs.wvClick(wv, btn('Fit'));
    await vs.wvClick(wv, rowEl('awvalid'));
    await E(`window.vcdTest.setCursor(0)`);
    await vs.key('ArrowRight', 'ArrowRight'); const a = (await probe()).cursor; await vs.key('a', 'KeyA');
    await vs.wvClick(wv, rowEl('bvalid'));
    await E(`window.vcdTest.setCursor(${a})`);
    await vs.key('ArrowRight', 'ArrowRight'); await vs.key('ArrowRight', 'ArrowRight'); const b = (await probe()).cursor; await vs.key('b', 'KeyB');
    await E(`window.vcdTest.setView(${a - 4000}, ${a + 80000})`);
    await vs.wvClick(wv, rowEl('awaddr[31:0]'));
    await E(`window.vcdTest.setCursor(${a + 6000})`);
    await sleep(500);
    const p = await probe();
    await shot('readme-axi');
    await closeEditor();
    if (!(b > a) || !/B−A/.test(p.times)) throw new Error(JSON.stringify({ a, b, times: p.times }));
    return { a, b, times: p.times, awaddr: p.rows.find(r => r.label === 'awaddr[31:0]').text };
  });

  // 3. 200+ signals, bus, radix, rename, reorder, remove; list kept after reopening
  await step('soc_256_signals.vcd: + on a scope adds 257 signals at once; rows are virtual; scroll works', async () => {
    await open('soc_256_signals.vcd');
    await vs.wvClick(wv, `[...document.querySelectorAll('.titem.scope')].find(e => e.querySelector('.tname').textContent === 'soc').querySelector('.tadd')`);
    await vs.waitFor(async () => { const p = await probe(); return p.rows.length >= 257 && !p.pending; }, 30000);
    const p = await probe();
    await E(`document.querySelector('.rows-scroll').scrollTop = 99999`); await sleep(300);
    const lastShown = await E(`[...document.querySelectorAll('.nrow')].map(r => r.querySelector('.n-name').textContent).pop()`);
    await shot('soc-257-rows-bottom');
    await E(`document.querySelector('.rows-scroll').scrollTop = 0`); await sleep(200);
    await E(`window.vcdTest.setCursor(20000)`);
    await shot('soc-257-rows');
    if (p.rows.length < 257 || p.domRows > 80) throw new Error(JSON.stringify({ rows: p.rows.length, dom: p.domRows }));
    return { rows: p.rows.length, domRowsRendered: p.domRows, lastRowAfterScroll: lastShown };
  });
  await step('fsm_traffic_light.vcd: radix hex, binary, unsigned, signed and ASCII on real rows', async () => {
    await open('fsm_traffic_light.vcd');
    await E(`window.vcdTest.setCursor(200)`);
    await vs.wvClick(wv, rowEl('state_name[47:0]'));
    const out = {};
    for (const r of ['hex', 'bin', 'unsigned', 'signed', 'ascii']) {
      await E(`(() => { const s = document.querySelector('select.radix'); s.value = '${r}'; s.dispatchEvent(new Event('change')); return 1; })()`);
      await sleep(150);
      out[r] = (await probe()).rows.find(x => x.label === 'state_name[47:0]').text;
    }
    await vs.wvClick(wv, rowEl('timer[5:0]'));
    await E(`(() => { const s = document.querySelector('select.radix'); s.value = 'signed'; s.dispatchEvent(new Event('change')); return 1; })()`);
    const raw = (await probe()).rows.find(x => x.label === 'state_name[47:0]').raw;
    if (out.ascii.trim() !== Buffer.from(BigInt('0b' + raw).toString(16).padStart(12, '0'), 'hex').toString('latin1').replace(/\0/g, '').trim() || !/^[0-9a-f]+$/.test(out.hex) || !/^[01]+$/.test(out.bin)) throw new Error(JSON.stringify(out));
    await shot('fsm-ascii-radix');
    await closeEditor();
    return out;
  });
  await step('counter.vcd: select 3 bits with Cmd+click, Bus groups them (value = bits joined), rename with F2, Alt+Up moves, Delete removes', async () => {
    await open('counter.vcd');
    await E(`window.vcdTest.setCursor(700)`);
    await vs.wvClick(wv, rowEl('clk'));
    await vs.wvClick(wv, rowEl('rst'), { modifiers: 4 });
    await vs.wvClick(wv, rowEl('en'), { modifiers: 4 });
    const before = (await probe()).rows.filter(r => ['clk', 'rst', 'en'].includes(r.label)).map(r => r.raw).join('');
    await vs.wvClick(wv, btn('Bus')); await sleep(250);
    let p = await probe();
    const bus = p.rows.find(r => r.kind === 'bus');
    if (!bus || bus.raw !== before || p.rows.length !== 3) throw new Error(JSON.stringify({ bus, before, rows: p.rows.map(r => r.label) }));
    await vs.key('F2', 'F2', 0, 113); await sleep(150);
    await vs.type('ctrl'); await vs.key('Enter', 'Enter'); await sleep(200);
    p = await probe();
    if (!p.rows.some(r => r.label === 'ctrl' && r.kind === 'bus')) throw new Error('rename ' + JSON.stringify(p.rows.map(r => r.label)));
    await vs.wvClick(wv, rowEl('wrap'));
    await vs.key('ArrowUp', 'ArrowUp', 1); await sleep(150);
    p = await probe();
    const order = p.rows.map(r => r.label);
    if (order.indexOf('wrap') !== 1) throw new Error('alt+up ' + order);
    await vs.wvClick(wv, rowEl('count[7:0]'));
    await E(`(() => { const s = document.querySelector('select.radix'); s.value = 'unsigned'; s.dispatchEvent(new Event('change')); return 1; })()`);
    await shot('counter-bus-renamed');
    await vs.wvClick(wv, rowEl('wrap'));
    await vs.key('Delete', 'Delete'); await sleep(200);
    p = await probe();
    if (p.rows.some(r => r.label === 'wrap')) throw new Error('delete');
    const kept = p.rows.map(r => `${r.label}:${r.radix}`);
    await sleep(900); // the list is saved 0.6 s after a change
    await closeEditor();
    // reopen: the list, names and radix come back
    const again = await open('counter.vcd');
    const kept2 = again.p.rows.map(r => `${r.label}:${r.radix}`);
    if (JSON.stringify(kept) !== JSON.stringify(kept2)) throw new Error('not kept ' + JSON.stringify({ kept, kept2 }));
    await closeEditor();
    return { busValue: before, order, keptAfterReopen: kept2 };
  });
  await step('counter.vcd: the simulator writes the file again -> it is read again and the signal list stays', async () => {
    const tmp = path.join(ws, 'counter_live.vcd');
    fs.copyFileSync(path.join(ws, 'counter.vcd'), tmp);
    await open('counter_live.vcd');
    await vs.wvClick(wv, rowEl('rst'));
    await vs.key('Delete', 'Delete'); await sleep(900);
    const before = (await probe()).rows.map(r => r.label);
    const end0 = JSON.parse(await E(`JSON.stringify(document.querySelector('.status .info').textContent)`));
    const extra = ['#2000', '1%', '#2005', '0%', '#2010', '1%'].join('\n') + '\n';
    fs.appendFileSync(tmp, extra);
    const ok = await vs.waitFor(async () => { const t = await E(`document.querySelector('.status .info').textContent`); const q = await probe(); return t !== end0 && / to /.test(t) && q.ready && q.rendered !== undefined && !q.pending && q.rows.length ? t : null; }, 20000, 300);
    const after = (await probe()).rows.map(r => r.label);
    fs.rmSync(tmp);
    await closeEditor();
    if (!ok || JSON.stringify(before) !== JSON.stringify(after)) throw new Error(JSON.stringify({ ok, before, after }));
    return { infoBefore: end0, infoAfter: ok, rows: after };
  });
  await step('signal list: Export writes JSON, Import loads it into another tab', async () => {
    await open('wide_64bit_x_z.vcd');
    await vs.wvClick(wv, rowEl('b[63:0]'));
    await vs.key('Delete', 'Delete');
    const out = path.join(ws, 'wide_64bit_x_z.signals.json');
    fs.rmSync(out, { force: true });
    await vs.wvClick(wv, btn('Export'));
    await sleep(800);
    await vs.key('Enter', 'Enter'); // simple dialog: accept the suggested name
    await vs.waitFor(() => fs.existsSync(out), 8000);
    const j = JSON.parse(fs.readFileSync(out, 'utf8'));
    if (j.signals.some(s => s.path === 'tb.alu.b[63:0]') || j.signals.length !== 5) throw new Error(JSON.stringify(j).slice(0, 300));
    fs.rmSync(out);
    await closeEditor();
    return { exported: j.signals.map(s => s.path) };
  });

  // 4. hostile files
  await step('hostile_not_a_vcd.vcd: clear message, no hang', async () => {
    const { ms, p } = await open('hostile_not_a_vcd.vcd');
    const text = await E(`document.querySelector('.notice').innerText`);
    await shot('hostile-not-a-vcd');
    await closeEditor();
    if (!p.error || !/does not look like a VCD/.test(text)) throw new Error(text);
    return { ms, message: text.split('\n').slice(0, 2).join(' ') };
  });
  for (const [f, keys] of [['hostile_truncated.vcd', ['truncated']], ['hostile_time_backwards.vcd', ['backwards']], ['hostile_ids_100k_bits.vcd', ['dup', 'unknown']]]) {
    await step(`${f}: opens with a note (${keys.join(', ')}), no hang`, async () => {
      const { ms, p } = await open(f);
      const text = await E(`document.querySelector('.warnbar').innerText`);
      if (!keys.every(k => p.warnings.includes(k))) throw new Error(JSON.stringify(p.warnings) + text);
      if (f.includes('100k')) {
        await E(`window.vcdTest.addPaths(['tb.huge_vector[99999:0]'])`);
        await vs.waitFor(async () => !(await probe()).pending, 10000);
        await E(`window.vcdTest.setCursor(150)`);
        const r = (await probe()).rows.find(x => x.path === 'tb.huge_vector[99999:0]');
        if (!r || r.raw.length !== 100000 || !/^(aaaa)+/.test(r.text) || r.text.length !== 25000) throw new Error('huge ' + JSON.stringify({ len: r && r.raw.length, text: r && r.text.slice(0, 20), tl: r && r.text.length }));
      }
      await shot(f.replace(/\W+/g, '_'));
      await closeEditor();
      return { ms, warnings: p.warnings, note: text.slice(0, 300) };
    });
  }

  // 5. large file
  if (large && fs.existsSync(large)) {
    await step(`large ${path.basename(large)} (${(fs.statSync(large).size / 1e9).toFixed(2)} GB): first view < 15 s, add a signal < 1 s, extension host < 1 GB`, async () => {
      const dir = path.dirname(large), name = path.basename(large);
      const memSamples = [];
      const sampleMem = () => {
        try {
          const ps = execSync('ps -axo pid=,ppid=,rss=,command=', { encoding: 'utf8', maxBuffer: 1 << 26 });
          const rows = ps.split('\n').map(l => l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean).map(m => ({ pid: +m[1], ppid: +m[2], rss: +m[3], cmd: m[4] }));
          const kids = new Set([vs.child.pid]);
          let grew = true;
          while (grew) { grew = false; for (const r of rows) if (!kids.has(r.pid) && kids.has(r.ppid)) { kids.add(r.pid); grew = true; } }
          const host = rows.filter(r => kids.has(r.pid) && /utility-sub-type=node\.mojom\.NodeService/.test(r.cmd) && /inspect-port|extensionHost|--type=utility/.test(r.cmd));
          const mb = Math.max(0, ...host.map(r => r.rss / 1024));
          memSamples.push(mb);
          return mb;
        } catch { return null; }
      };
      const timer = setInterval(sampleMem, 250);
      const t0 = Date.now();
      vs.open(large); await sleep(300);
      wv = await getWv(name); if (!wv) throw new Error('no webview');
      const p = await vs.waitFor(async () => { const p = await probe(); return p && p.rendered && !p.pending ? p : null; }, 120000, 100);
      const firstView = Date.now() - t0;
      await shot('large-1gb-first-view');
      const header = p.timing.header, indexed = p.timing.indexed;
      // add signals: a rare one, a busy one, then a scope of 50
      const addTimed = async paths => {
        const t = Date.now();
        await E(`window.vcdTest.addPaths(${JSON.stringify(paths)})`);
        await vs.waitFor(async () => { const q = await probe(); return !q.pending && paths.every(pp => q.rows.some(r => r.path === pp)); }, 60000, 50);
        return Date.now() - t;
      };
      const H = JSON.parse(await E(`JSON.stringify(window.vcdProbe().rows.map(r => r.path))`));
      void H;
      const rareMs = await addTimed(['tb.soc.core7.unit3.s1']);
      const busyMs = await addTimed(['tb.soc.core0.unit0.s39']);
      const mediumMs = await addTimed(['tb.soc.core12.unit5.s3']);
      // values against the reference at 5 times for 4 signals
      const end = 101460000;
      const times = pick5(0, end);
      const paths = ['tb.clk', 'tb.cycle[31:0]', 'tb.soc.core7.unit3.s1', 'tb.soc.core0.unit0.s39'];
      await E(`window.vcdTest.addPaths(${JSON.stringify(paths)})`);
      await vs.waitFor(async () => !(await probe()).pending, 60000);
      const rf = ref(large, times, paths);
      const bad = [];
      for (let k = 0; k < times.length; k++) {
        await E(`window.vcdTest.setCursor(${times[k]})`);
        const q = await probe();
        for (const pp of paths) { const r = q.rows.find(x => x.path === pp); if (!same(r.raw, rf.paths[pp][k])) bad.push({ pp, t: times[k], v: r.raw, ref: rf.paths[pp][k] }); }
      }
      await E(`window.vcdTest.setCursor(${Math.round(end * 0.4)})`);
      // zoom in at the cursor with the keyboard and screenshot
      await vs.wvClick(wv, `document.querySelector('canvas.waves')`, { dx: 2 });
      for (let i = 0; i < 6; i++) await vs.key('+', 'Equal', 0, 187);
      await sleep(300);
      await shot('large-1gb-zoomed');
      clearInterval(timer);
      const peak = Math.max(...memSamples.filter(x => x !== null));
      await closeEditor();
      if (bad.length) throw new Error('values: ' + JSON.stringify(bad).slice(0, 600));
      if (firstView > 15000 || rareMs > 1000 || peak > 1024) throw new Error(JSON.stringify({ firstView, rareMs, busyMs, peak }));
      return { sizeGB: +(fs.statSync(large).size / 1e9).toFixed(2), signalsInFile: p.nVars, firstViewMs: firstView, webviewHeaderMs: header, webviewIndexedMs: indexed, addRareSignalMs: rareMs, addBusySignalMs: busyMs, addMediumSignalMs: mediumMs, extHostPeakMB: Math.round(peak), memSamples: memSamples.length, valuesChecked: paths.length * times.length };
    });
  }
  // 6. theme
  await step(`theme ${tag}: the viewer follows the VS Code theme`, async () => {
    await open('iverilog_pwm.vcd');
    await E(`window.vcdTest.setCursor(305000)`);
    const p = await probe();
    const bg = await E(`getComputedStyle(document.body).backgroundColor`);
    await shot('pwm-theme');
    await closeEditor();
    if (p.theme !== tag) throw new Error(p.theme);
    return { theme: p.theme, background: bg };
  });
} finally {
  R.console = vs.console.filter(c => !/copilot|CloudSandbox|ExperimentalWarning|punycode|github/i.test(c.text)).slice(0, 40);
  await vs.close();
  R.unchanged = Object.entries(hashes).every(([f, h]) => !fs.existsSync(path.join(ws, f)) || hash(path.join(ws, f)) === h);
  R.shots = shots;
  R.pass = R.steps.filter(s => s.ok).length; R.fail = R.steps.filter(s => !s.ok).length;
  fs.writeFileSync(outJson, JSON.stringify(R, null, 1));
  console.log(`steps ${R.pass} pass, ${R.fail} fail; files unchanged: ${R.unchanged}; console errors: ${R.console.length}`);
}
