'use strict';
const test = require('node:test');
const assert = require('node:assert');
const F = require('../src/webview/format');

test('left extension follows the VCD rules', () => {
  assert.strictEqual(F.extend('1', 4), '0001');
  assert.strictEqual(F.extend('01', 4), '0001');
  assert.strictEqual(F.extend('x1', 4), 'xxx1');
  assert.strictEqual(F.extend('z', 4), 'zzzz');
  assert.strictEqual(F.extend('10101', 4), '0101');
});
test('radix: hex with x and z nibbles, unsigned, signed, ascii', () => {
  assert.strictEqual(F.formatBits('11111111', 8, 'hex'), 'ff');
  assert.strictEqual(F.formatBits('1', 12, 'hex'), '1');
  assert.strictEqual(F.formatBits('xxxx0001', 8, 'hex'), 'x1');
  assert.strictEqual(F.formatBits('zzzz0x01', 8, 'hex'), 'zX');
  assert.strictEqual(F.formatBits('z', 8, 'hex'), 'zz');
  assert.strictEqual(F.formatBits('11111111', 8, 'unsigned'), '255');
  assert.strictEqual(F.formatBits('11111111', 8, 'signed'), '-1');
  assert.strictEqual(F.formatBits('0111', 4, 'signed'), '7');
  assert.strictEqual(F.formatBits('1x', 4, 'unsigned'), 'x');
  assert.strictEqual(F.formatBits('z', 4, 'unsigned'), 'z');
  assert.strictEqual(F.formatBits('1' + '0'.repeat(63), 64, 'unsigned'), '9223372036854775808');
  assert.strictEqual(F.formatBits('1'.repeat(64), 64, 'signed'), '-1');
  const hi = Buffer.from('HI').reduce((s, b) => s + b.toString(2).padStart(8, '0'), '');
  assert.strictEqual(F.formatBits(hi, 24, 'ascii'), 'HI');
  assert.strictEqual(F.formatBits('1'.repeat(100000), 100000, 'unsigned').length, 25000);
});
test('time units and ruler steps', () => {
  const fs = F.timeUnits({ num: 1, unit: 'ps', exp: -12 }).fsPerTick;
  assert.strictEqual(fs, 1000);
  assert.strictEqual(F.fmtTimeAuto(1500, fs, 640000 * 1000), '1.5 ns');
  assert.strictEqual(F.fmtTimeAuto(0, F.timeUnits({ num: 1, unit: 'ns', exp: -9 }).fsPerTick), '0 ns');
  assert.strictEqual(F.fmtTimeAuto(10, F.timeUnits({ num: 10, unit: 'ns', exp: -9 }).fsPerTick), '100 ns');
  assert.strictEqual(F.niceStep(1000, 1000, 100), 100);
  assert.strictEqual(F.niceStep(1000, 1000, 90), 100);
  assert.strictEqual(F.upperBound([1, 2, 2, 3], 2), 3);
  assert.strictEqual(F.lowerBound([1, 2, 2, 3], 2), 1);
});
