'use strict';
// Value and time formatting for the waveform view. Pure functions, also used by the tests.

const CODE_CHARS = '01xzuwlh-';
const UNITS = [['s', 1e15], ['ms', 1e12], ['µs', 1e9], ['ns', 1e6], ['ps', 1e3], ['fs', 1]];

/** Index of the first element greater than t (times is sorted ascending). */
function upperBound(times, t) {
  let lo = 0, hi = times.length;
  while (lo < hi) {
    const m = (lo + hi) >>> 1;
    if (times[m] <= t) lo = m + 1; else hi = m;
  }
  return lo;
}

/** Index of the first element not less than t. */
function lowerBound(times, t) {
  let lo = 0, hi = times.length;
  while (lo < hi) {
    const m = (lo + hi) >>> 1;
    if (times[m] < t) lo = m + 1; else hi = m;
  }
  return lo;
}

/** VCD left-extension: a value shorter than the width is padded with 0, or with x or z when it starts with x or z. */
function extend(raw, w) {
  if (raw.length === w) return raw;
  if (raw.length > w) return raw.slice(raw.length - w);
  const c = raw[0];
  const pad = c === '1' || c === '0' || c === undefined ? '0' : c;
  return pad.repeat(w - raw.length) + raw;
}

const isBin = s => /^[01]*$/.test(s);

function nibble(g) {
  if (isBin(g)) return parseInt(g, 2).toString(16);
  if (/^z+$/.test(g)) return 'z';
  if (/^[xuw-]+$/.test(g)) return 'x';
  if (/^[01zlh]+$/.test(g)) return 'Z';
  return 'X';
}

function toHex(bits) {
  const n = bits.length;
  if (isBin(bits) && n <= 52) return parseInt(bits || '0', 2).toString(16);
  const r = n % 4;
  const parts = [];
  if (r) parts.push(nibble(bits.slice(0, r)));
  for (let i = r; i < n; i += 4) parts.push(nibble(bits.slice(i, i + 4)));
  let s = parts.join('');
  if (isBin(bits)) s = s.replace(/^0+(?=.)/, '');
  return s;
}

function undefText(bits) {
  if (/^z+$/.test(bits)) return 'z';
  return 'x';
}

function toUnsigned(bits) {
  if (!isBin(bits)) return undefText(bits);
  if (bits.length <= 52) return String(parseInt(bits || '0', 2));
  return BigInt('0b' + bits).toString();
}

function toSigned(bits) {
  if (!isBin(bits)) return undefText(bits);
  const n = bits.length;
  if (n === 0) return '0';
  if (bits[0] === '0') return toUnsigned(bits);
  if (n <= 52) return String(parseInt(bits, 2) - 2 ** n);
  return (BigInt('0b' + bits) - (1n << BigInt(n))).toString();
}

function toAscii(bits) {
  const r = bits.length % 8;
  const b = r ? '0'.repeat(8 - r) + bits : bits;
  let out = '';
  for (let i = 0; i < b.length; i += 8) {
    const g = b.slice(i, i + 8);
    if (!isBin(g)) { out += '?'; continue; }
    const c = parseInt(g, 2);
    if (c === 0) continue;
    out += c >= 32 && c < 127 ? String.fromCharCode(c) : '.';
  }
  return out;
}

/**
 * Text of a vector value in a radix. raw is the bit string as stored ("0101", "x", "z1"), width the declared size.
 * Very wide values in decimal radixes are shown in hex (BigInt to decimal is slow above a few thousand bits).
 */
function formatBits(raw, width, radix) {
  const bits = extend(raw, Math.max(width, 1));
  switch (radix) {
    case 'bin': return bits;
    case 'unsigned': return width > 4096 ? toHex(bits) : toUnsigned(bits);
    case 'signed': return width > 4096 ? toHex(bits) : toSigned(bits);
    case 'ascii': return toAscii(bits);
    default: return toHex(bits);
  }
}

function formatReal(v) {
  if (typeof v !== 'number' || Number.isNaN(v)) return 'nan';
  if (!Number.isFinite(v)) return v > 0 ? 'inf' : '-inf';
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a >= 1e6 || a < 1e-4) return v.toExponential(4);
  return String(Number(v.toPrecision(7)));
}

/** "Problem" class of a raw value for colouring: 0 ok, 1 has x (or u, w, -), 2 all z, 3 some z. */
function valueClass(raw) {
  if (/[xuw-]/.test(raw)) return 1;
  if (/^z+$/.test(raw)) return 2;
  if (raw.includes('z')) return 3;
  return 0;
}

/** Time units for a timescale: fs per tick, and helpers to print times. */
function timeUnits(ts) {
  const fsPerTick = ts.num * Math.pow(10, ts.exp + 15);
  return { fsPerTick };
}

function pickUnit(fs) {
  const a = Math.abs(fs);
  for (const [name, f] of UNITS) if (a >= f) return [name, f];
  return UNITS[UNITS.length - 1];
}

/** Ruler tick step (in ticks) for a span shown across px pixels, about every target pixels. */
function niceStep(span, px, target = 90) {
  const raw = span * target / Math.max(px, 1);
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 5, 10]) if (p * m >= raw) return Math.max(p * m, 1e-12);
  return p * 10;
}

/** Formats a time in ticks as "12.5 ns". unitFs/decimals fixed by the caller so labels line up. */
function fmtTime(t, fsPerTick, unit, decimals) {
  const v = t * fsPerTick / unit[1];
  let s = v.toFixed(Math.max(0, Math.min(decimals, 9)));
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return `${s} ${unit[0]}`;
}

/** Decimals needed so that one step (in ticks) is visible in the unit. */
function decimalsFor(stepTicks, fsPerTick, unit) {
  const stepInUnit = stepTicks * fsPerTick / unit[1];
  if (stepInUnit >= 1) return 0;
  return Math.min(9, Math.ceil(-Math.log10(stepInUnit) - 1e-9));
}

/** Formats a time with the unit picked from its size and the precision of one tick. */
function fmtTimeAuto(t, fsPerTick, refFs) {
  const unit = pickUnit(refFs !== undefined && refFs !== null && refFs > 0 ? refFs : Math.abs(t * fsPerTick) || fsPerTick);
  return fmtTime(t, fsPerTick, unit, decimalsFor(1, fsPerTick, unit));
}

module.exports = {
  CODE_CHARS, upperBound, lowerBound, extend, toHex, toUnsigned, toSigned, toAscii, formatBits, formatReal, valueClass,
  timeUnits, pickUnit, niceStep, fmtTime, decimalsFor, fmtTimeAuto,
};
