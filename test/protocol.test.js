'use strict';
const test = require('node:test');
const assert = require('node:assert');
const P = require('../src/core/protocol');
const { buildHtml } = require('../src/html');

test('messages from the webview are checked', () => {
  assert.ok(P.validateWebviewMessage({ type: 'ready' }).ok);
  assert.ok(P.validateWebviewMessage({ type: 'load', ids: [1, 2], reqId: 3 }).ok);
  assert.ok(!P.validateWebviewMessage({ type: 'load', ids: ['x'], reqId: 3 }).ok);
  assert.ok(!P.validateWebviewMessage({ type: 'load', ids: [-1], reqId: 3 }).ok);
  assert.ok(!P.validateWebviewMessage({ type: 'run', cmd: 'rm' }).ok);
  assert.ok(!P.validateWebviewMessage(null).ok);
  assert.ok(!P.validateWebviewMessage({ type: 'saveLayout', layout: { signals: 'x' } }).ok);
});
test('layouts keep only known fields', () => {
  const l = P.cleanLayout({ signals: [{ path: 'a.b', radix: 'hex', alias: 'x', evil: 1 }, { bus: ['a', 'b'], radix: 'nope' }, { foo: 1 }], view: { start: 0, end: 10 }, cursor: 5, markers: { a: 1, b: 'x' } });
  assert.deepStrictEqual(l, { version: 1, signals: [{ path: 'a.b', alias: 'x', radix: 'hex' }, { bus: ['a', 'b'] }], view: { start: 0, end: 10 }, cursor: 5, markers: { a: 1, b: null } });
  assert.strictEqual(P.cleanLayout({}), null);
});
test('size plan', () => {
  assert.ok(P.sizePlan(1e9, 16384).load);
  assert.ok(!P.sizePlan(2 * 1024 * 1024, 1).load);
});
test('webview HTML: no network, scripts by nonce', () => {
  const html = buildHtml({ cspSource: 'vscode-resource:', scriptUri: 's.js', styleUri: 's.css', title: '<x>', nonce: 'abc' });
  const csp = /content="([^"]+)"/.exec(html)[1];
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'nonce-abc'/);
  assert.doesNotMatch(csp, /https?:/);
  assert.doesNotMatch(csp, /connect-src/);
  assert.match(html, /&lt;x&gt;/);
});
test('pack and unpack keep every signal', () => {
  const { packSignals, unpackSignals } = require('../src/core/pack');
  const { packStrings, packedValues } = require('../src/core/packed');
  const sigs = [];
  for (let i = 0; i < 300; i++) {
    const n = i % 7;
    const s = { id: i, kind: ['scalar', 'vector', 'real'][i % 3], size: i % 3 === 1 ? 8 : 1, times: Float64Array.from({ length: n }, (_, k) => k * 10 + i) };
    if (s.kind === 'scalar') s.codes = Uint8Array.from({ length: n }, (_, k) => k % 4);
    else if (s.kind === 'real') s.reals = Float64Array.from({ length: n }, (_, k) => k / 3);
    else Object.assign(s, packStrings(Array.from({ length: n }, (_, k) => (k * 1000003 + i).toString(2))));
    sigs.push(s);
  }
  const back = unpackSignals(JSON.parse(JSON.stringify(packSignals(sigs), (k, v) => (ArrayBuffer.isView(v) ? Array.from(v) : v))));
  assert.strictEqual(back.length, 300);
  for (let i = 0; i < 300; i++) {
    assert.deepStrictEqual(Array.from(back[i].times), Array.from(sigs[i].times));
    if (sigs[i].codes) assert.deepStrictEqual(Array.from(back[i].codes), Array.from(sigs[i].codes));
    if (sigs[i].reals) assert.deepStrictEqual(Array.from(back[i].reals), Array.from(sigs[i].reals));
    if (sigs[i].vbytes) assert.deepStrictEqual(back[i].values.toArray(), packedValues(sigs[i]).toArray());
  }
});
