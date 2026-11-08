'use strict';
const vscode = require('vscode');
const path = require('path');
const { Worker } = require('worker_threads');
const { buildHtml } = require('./html');
const { validateWebviewMessage, sizePlan, fmtSize } = require('./core/protocol');
const { createRatingPrompt } = require('./rate');
const { packSignals } = require('./core/pack');
const { registerSupport, commandUris, showLinks } = require('./support');

const VIEW_TYPE = 'vcdViewer.waveform';
const EXT_ID = 'zovo.vcd-waveform-viewer';
const LAYOUTS_KEY = 'vcdViewer.layouts.v1';
const MAX_SAVED_FILES = 200;
const MAX_NON_FILE_MB = 512;
let rating = { success() {}, failure() {} };

function settings() {
  const c = vscode.workspace.getConfiguration('vcdViewer');
  return {
    maxFileMB: c.get('maxFileMB', 16384),
    defaultRadix: c.get('defaultRadix', 'hex'),
    initialSignals: c.get('initialSignals', 64),
    autoReload: c.get('autoReload', true),
    rowHeight: c.get('rowHeight', 'normal'),
  };
}

function savedLayout(ctx, key) {
  const all = ctx.globalState.get(LAYOUTS_KEY) || {};
  return all[key] ? all[key].layout : null;
}

async function saveLayout(ctx, key, layout) {
  const all = { ...(ctx.globalState.get(LAYOUTS_KEY) || {}) };
  all[key] = { at: Date.now(), layout };
  const keys = Object.keys(all);
  if (keys.length > MAX_SAVED_FILES) {
    keys.sort((a, b) => all[a].at - all[b].at);
    for (const k of keys.slice(0, keys.length - MAX_SAVED_FILES)) delete all[k];
  }
  await ctx.globalState.update(LAYOUTS_KEY, all);
}

class VcdEditorProvider {
  constructor(context) { this.context = context; }

  openCustomDocument(uri) { return { uri, dispose() {} }; }

  async resolveCustomEditor(document, panel) {
    const ctx = this.context;
    const uri = document.uri;
    const dist = vscode.Uri.joinPath(ctx.extensionUri, 'dist');
    const media = vscode.Uri.joinPath(ctx.extensionUri, 'media');
    panel.webview.options = { enableScripts: true, localResourceRoots: [dist, media], enableCommandUris: commandUris('vcdViewer') };
    const name = path.posix.basename(uri.path);
    panel.webview.html = buildHtml({
      cspSource: panel.webview.cspSource,
      scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.js')).toString(),
      styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'webview.css')).toString(),
      title: name,
      showSupportLinks: showLinks(vscode, 'vcdViewer'),
    });
    const layoutKey = uri.toString();
    let disposed = false;
    let counted = false;
    let failed = false;
    let worker = null;
    let generation = 0;
    const post = m => (disposed ? Promise.resolve(false) : panel.webview.postMessage(m));
    const onFail = () => { if (!failed && !counted) { failed = true; rating.failure(); } };

    const stopWorker = () => {
      if (worker) { const w = worker; worker = null; w.postMessage({ type: 'close' }); setTimeout(() => w.terminate().catch(() => {}), 2000); }
    };

    const startWorker = async (reload) => {
      stopWorker();
      const gen = ++generation;
      const stat = await vscode.workspace.fs.stat(uri);
      const s = settings();
      const plan = sizePlan(stat.size, s.maxFileMB);
      await post({
        type: 'init', name, size: stat.size, sizeText: fmtSize(stat.size), plan, reload: !!reload,
        settings: { defaultRadix: s.defaultRadix, initialSignals: s.initialSignals, rowHeight: s.rowHeight },
        layout: reload ? null : savedLayout(ctx, layoutKey),
      });
      if (!plan.load) return;
      let data;
      if (uri.scheme === 'file') data = { path: uri.fsPath };
      else {
        if (stat.size > MAX_NON_FILE_MB * 1024 * 1024) {
          await post({ type: 'error', code: 'remote', message: `Files that are not on a local disk are read into memory, up to ${MAX_NON_FILE_MB} MB. This one is ${fmtSize(stat.size)}.` });
          return;
        }
        const bytes = await vscode.workspace.fs.readFile(uri);
        data = { buffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
      }
      if (gen !== generation || disposed) return;
      const w = new Worker(path.join(__dirname, 'worker.js'), {
        workerData: data, transferList: data.buffer ? [data.buffer] : [],
        resourceLimits: { maxOldGenerationSizeMb: 4096 },
      });
      worker = w;
      w.on('message', m => {
        if (w !== worker) return;
        if (m.type === 'error' && !m.reqId) onFail();
        if (m.type === 'loaded') {
          const { signals, ...rest } = m;
          post({ ...rest, packed: packSignals(signals) });
          return;
        }
        post(m);
      });
      w.on('error', e => {
        if (w !== worker) return;
        const oom = /memory/i.test(String(e && (e.code || e.message)));
        post({ type: 'error', code: oom ? 'memory' : 'worker', message: oom
          ? 'The reader ran out of memory. Remove some signals with many changes and open the file again.'
          : `The file could not be read: ${e && e.message ? e.message : e}` });
        onFail();
        worker = null;
      });
    };

    // Reload when the simulator writes the file again (setting vcdViewer.autoReload).
    let reloadTimer = null;
    let watcher = null;
    if (uri.scheme === 'file') {
      try {
        watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(path.dirname(uri.fsPath)), path.basename(uri.fsPath)));
        const changed = () => {
          if (!settings().autoReload) return;
          clearTimeout(reloadTimer);
          reloadTimer = setTimeout(() => { if (!disposed) startWorker(true).catch(e => post({ type: 'error', message: String(e.message || e) })); }, 800);
        };
        watcher.onDidChange(changed);
        watcher.onDidCreate(changed);
      } catch { watcher = null; }
    }

    panel.webview.onDidReceiveMessage(async raw => {
      const v = validateWebviewMessage(raw);
      if (!v.ok) return;
      const msg = v.msg;
      try {
        switch (msg.type) {
          case 'ready': await startWorker(false); return;
          case 'load':
            if (worker) worker.postMessage({ type: 'load', ids: msg.ids, reqId: msg.reqId });
            return;
          case 'rendered': if (!counted && !failed) { counted = true; rating.success(); } return;
          case 'failed': onFail(); return;
          case 'saveLayout': await saveLayout(ctx, layoutKey, msg.layout); return;
          case 'exportLayout': {
            const base = name.replace(/\.[^.]+$/, '');
            const target = await vscode.window.showSaveDialog({
              defaultUri: vscode.Uri.joinPath(uri.with({ path: path.posix.dirname(uri.path) }), `${base}.signals.json`),
              filters: { 'Signal list': ['json'] }, saveLabel: 'Export Signal List',
            });
            if (!target) return;
            if (target.toString() === uri.toString() || !/\.json$/i.test(target.path)) {
              await post({ type: 'notice', message: 'Choose a file name that ends in .json. The VCD file is never changed.' });
              return;
            }
            await vscode.workspace.fs.writeFile(target, Buffer.from(JSON.stringify({ ...msg.layout, file: name }, null, 1) + '\n'));
            await post({ type: 'notice', message: `Saved ${msg.layout.signals.length} signals to ${path.posix.basename(target.path)}.` });
            return;
          }
          case 'importLayout': {
            const pick = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'Signal list': ['json'] }, openLabel: 'Import Signal List' });
            if (!pick || !pick[0]) return;
            const st = await vscode.workspace.fs.stat(pick[0]);
            if (st.size > 20 * 1024 * 1024) { await post({ type: 'notice', message: 'That file is larger than 20 MB, so it is not a signal list.' }); return; }
            let json;
            try { json = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(pick[0])).toString('utf8')); } catch { json = null; }
            const { cleanLayout } = require('./core/protocol');
            const layout = cleanLayout(json);
            if (!layout) { await post({ type: 'notice', message: 'That file is not a signal list. Export one with the Export button first.' }); return; }
            await post({ type: 'layout', layout });
            return;
          }
          case 'copy': await vscode.env.clipboard.writeText(msg.text); await post({ type: 'notice', message: 'Copied.' }); return;
          case 'openSettings': await vscode.commands.executeCommand('workbench.action.openSettings', 'vcdViewer'); return;
        }
      } catch (e) {
        await post({ type: 'error', message: e && e.message ? e.message : String(e) });
      }
    });
    panel.onDidDispose(() => {
      disposed = true;
      clearTimeout(reloadTimer);
      if (watcher) watcher.dispose();
      stopWorker();
    });
  }
}

function activate(context) {
  rating = createRatingPrompt({ vscode, context, extensionId: EXT_ID, section: 'vcdViewer', name: 'VCD Waveform Viewer' });
  registerSupport({ vscode, context, prefix: 'vcdViewer', selfId: EXT_ID });
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, new VcdEditorProvider(context), {
      supportsMultipleEditorsPerDocument: true,
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('vcdViewer.openWalkthrough', () =>
      vscode.commands.executeCommand('workbench.action.openWalkthrough', `${EXT_ID}#vcdViewer.start`, false)),
    vscode.commands.registerCommand('vcdViewer.openWith', async uri => {
      const target = uri || (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri);
      if (target) await vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE);
    }),
    vscode.commands.registerCommand('vcdViewer.forgetSignalLists', async () => {
      await context.globalState.update(LAYOUTS_KEY, undefined);
      vscode.window.showInformationMessage('VCD Waveform Viewer forgot the saved signal lists.');
    }),
  );
}

function deactivate() {}

module.exports = { activate, deactivate, VcdEditorProvider, VIEW_TYPE, EXT_ID };
