'use strict';
// Values of bus (vector) and string signals as one byte buffer plus end offsets, instead of one JS string
// per change. A 400 MB VCD with a busy 32-bit bus has about 11 million changes: as strings they took about
// 4 GB in the extension host and slowed the window. Packed they need about 30 bytes per change and travel
// between threads and to the webview as transferable buffers.

const MAX_BYTES = 2 ** 31; // per load request

class PackedValues {
  constructor(bytes, ends) { this.bytes = bytes; this.ends = ends; this.length = ends.length; }
  /** The value at change i as a string (negative i counts from the end, like Array.prototype.at). */
  at(i) {
    i = Math.trunc(i);
    if (i < 0) i += this.length;
    if (!(i >= 0 && i < this.length)) return undefined;
    const a = i ? this.ends[i - 1] : 0, b = this.ends[i];
    let out = '';
    for (let k = a; k < b; k += 8192) out += String.fromCharCode.apply(null, this.bytes.subarray(k, Math.min(b, k + 8192)));
    return out;
  }
  toArray() { const r = new Array(this.length); for (let i = 0; i < this.length; i++) r[i] = this.at(i); return r; }
}

class ValuesBuilder {
  constructor() { this.bytes = new Uint8Array(4096); this.ends = new Uint32Array(1024); this.nb = 0; this.n = 0; }
  room(nb) {
    if (this.nb + nb > this.bytes.length) {
      let c = this.bytes.length * 2;
      while (c < this.nb + nb) c *= 2;
      if (this.nb + nb > MAX_BYTES) {
        const e = new Error('These signals have more than 2 GB of bus values. Remove some busy buses and add them one at a time.');
        e.code = 'memory';
        throw e;
      }
      const x = new Uint8Array(Math.min(c, MAX_BYTES)); x.set(this.bytes.subarray(0, this.nb)); this.bytes = x;
    }
    if (this.n >= this.ends.length) { const x = new Uint32Array(this.ends.length * 2); x.set(this.ends); this.ends = x; }
  }
  /** Copies buf[a..b) as latin1; lower = lower-case like String.prototype.toLowerCase on latin1 text. */
  pushBytes(buf, a, b, lower) {
    this.room(b - a);
    const B = this.bytes;
    let o = this.nb;
    for (let k = a; k < b; k++) {
      let c = buf[k];
      if (lower && ((c >= 65 && c <= 90) || (c >= 0xc0 && c <= 0xde && c !== 0xd7))) c += 32;
      B[o++] = c;
    }
    this.nb = o; this.ends[this.n++] = o;
  }
  pushString(s) {
    this.room(s.length);
    const B = this.bytes;
    let o = this.nb;
    for (let k = 0; k < s.length; k++) B[o++] = s.charCodeAt(k) & 255;
    this.nb = o; this.ends[this.n++] = o;
  }
  /** Raw buffers, trimmed: {vbytes, vends}. */
  finish() { return { vbytes: this.bytes.slice(0, this.nb), vends: this.ends.slice(0, this.n) }; }
}

/** Builds raw {vbytes, vends} from an array of strings (tests, bus rows). */
function packStrings(list) { const b = new ValuesBuilder(); for (const s of list) b.pushString(String(s)); return b.finish(); }

/** PackedValues view of a raw signal result ({vbytes, vends}); plain arrays (after JSON) are accepted. */
function packedValues(s) {
  const bytes = s.vbytes instanceof Uint8Array ? s.vbytes : Uint8Array.from(s.vbytes);
  const ends = s.vends instanceof Uint32Array ? s.vends : Uint32Array.from(s.vends);
  return new PackedValues(bytes, ends);
}

module.exports = { PackedValues, ValuesBuilder, packStrings, packedValues, MAX_BYTES };
