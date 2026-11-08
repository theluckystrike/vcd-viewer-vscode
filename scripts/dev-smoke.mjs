// Quick look in a real VS Code: open files, wait for the waves, save a screenshot, print the probe.
// usage: node scripts/dev-smoke.mjs <work> <port> <vsix> <folder> <shotDir> file1 [file2 ...]
import { launch, installVsix, sleep } from './vsc.mjs';
import path from 'node:path';
import fs from 'node:fs';
const [work, port, vsix, folder, shotDir, ...files] = process.argv.slice(2);
fs.rmSync(path.join(work, 'ud'), { recursive: true, force: true });
console.log(installVsix(work, vsix).code);
const vs = await launch(work, Number(port), folder, { 'workbench.colorTheme': process.env.THEME || 'Default Dark Modern' });
try {
  await sleep(2500);
  await vs.command('View: Close Primary Side Bar').catch(() => {});
  for (const f of files) {
    vs.open(path.join(folder, f));
    const wv = await vs.waitFor(async () => (await vs.webviews()).find(w => w.title === f && w.w > 0), 30000);
    if (!wv) { console.log(f, 'NO WEBVIEW'); continue; }
    const t0 = Date.now();
    const p = await vs.waitFor(async () => { const p = JSON.parse(await vs.wvEval(wv, 'JSON.stringify(window.vcdProbe && window.vcdProbe())')); return p && (p.rendered || p.error) ? p : null; }, 60000, 250);
    await sleep(600);
    await vs.shot(path.join(shotDir, f.replace(/\W+/g, '_') + '.png'));
    console.log(f, Date.now() - t0, 'ms', JSON.stringify(p && { ...p, rows: p.rows.slice(0, 4), nrows: p.rows.length }).slice(0, 1500));
  }
  console.log('console:', JSON.stringify(vs.console.filter(c => !/Extension Host|punycode|ExperimentalWarning/.test(c.text)).slice(0, 12), null, 1));
} finally { await vs.close(); }
