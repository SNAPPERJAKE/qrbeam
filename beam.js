// QR Beam core: everything that turns bytes into a stream of QR frames and back.
// No DOM in here, so the same file runs in the page and under Node for tests.
//
// Frame (before base45):
//   0      u8   protocol version (1)
//   1..4   u32  transfer id (random per send; a new id resets the receiver)
//   5..8   u32  payload length in bytes
//   9..10  u16  block size B (multiple of 4)
//   11..14 u32  seed (symbol id; sender counts up from 0 and loops forever)
//   15..18 u32  CRC32 of the whole payload
//   19..   B bytes: XOR of the source blocks this seed picks (LT fountain code)
//
// The payload is cut into K = ceil(len/B) blocks. Every frame carries a random
// mix of blocks chosen by its seed, so the receiver can start at any point and
// miss any frames; it finishes after roughly K + a few percent frames.
(function (root) {
  'use strict';

  const VERSION = 1;
  const HEADER = 19;
  const DENSE_K = 100;

  // ---------- base45 (RFC 9285): bytes <-> QR alphanumeric charset ----------
  // QR alphanumeric mode packs 2 chars in 11 bits, so base45 carries 16 bits in
  // 16.5 bits of QR: 97% efficient, versus 75% for base64 in byte mode. It also
  // round-trips cleanly through decoders that only hand back text.
  const B45 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
  const B45_REV = new Int16Array(128).fill(-1);
  for (let i = 0; i < 45; i++) B45_REV[B45.charCodeAt(i)] = i;

  function b45encode(bytes) {
    let out = '';
    let i = 0;
    for (; i + 1 < bytes.length; i += 2) {
      let n = bytes[i] * 256 + bytes[i + 1];
      const c = n % 45; n = (n - c) / 45;
      const d = n % 45; const e = (n - d) / 45;
      out += B45[c] + B45[d] + B45[e];
    }
    if (i < bytes.length) {
      const n = bytes[i];
      out += B45[n % 45] + B45[(n / 45) | 0];
    }
    return out;
  }

  function b45decode(str) {
    const len = str.length;
    const rem = len % 3;
    if (rem === 1) return null;
    const out = new Uint8Array(((len - rem) / 3) * 2 + (rem ? 1 : 0));
    let o = 0;
    for (let i = 0; i < len; i += 3) {
      const a = B45_REV[str.charCodeAt(i)];
      const b = B45_REV[str.charCodeAt(i + 1)];
      if (a < 0 || b < 0) return null;
      if (i + 2 < len) {
        const c = B45_REV[str.charCodeAt(i + 2)];
        if (c < 0) return null;
        const n = a + b * 45 + c * 2025;
        if (n > 0xffff) return null;
        out[o++] = n >> 8; out[o++] = n & 0xff;
      } else {
        const n = a + b * 45;
        if (n > 0xff) return null;
        out[o++] = n;
      }
    }
    return out;
  }

  // Chars needed for a frame of n bytes.
  function b45len(n) { return (n >> 1) * 3 + (n & 1) * 2; }

  // ---------- CRC32 ----------
  const CRC_TABLE = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    CRC_TABLE[n] = c >>> 0;
  }
  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  // ---------- seeded randomness ----------
  function fmix32(h) {
    h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return h >>> 0;
  }
  function mulberry32(a) {
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------- LT fountain code ----------
  // Robust soliton degree distribution, returned as a cumulative table.
  const cdfCache = new Map();
  function solitonCdf(K) {
    if (cdfCache.has(K)) return cdfCache.get(K);
    const c = 0.03, delta = 0.5;
    const mu = new Float64Array(K + 1);
    mu[1] = 1 / K;
    for (let i = 2; i <= K; i++) mu[i] = 1 / (i * (i - 1));
    const R = c * Math.log(K / delta) * Math.sqrt(K);
    if (R > 0) {
      const spike = Math.max(1, Math.min(K, Math.round(K / R)));
      for (let i = 1; i < spike; i++) mu[i] += R / (i * K);
      const tail = (R * Math.log(R / delta)) / K;
      if (tail > 0) mu[spike] += tail;
    }
    let sum = 0;
    for (let i = 1; i <= K; i++) sum += mu[i];
    const cdf = new Float64Array(K + 1);
    let acc = 0;
    for (let i = 1; i <= K; i++) { acc += mu[i] / sum; cdf[i] = acc; }
    cdf[K] = 1;
    cdfCache.set(K, cdf);
    return cdf;
  }

  // Which source blocks a given seed XORs together. Both ends run this.
  function symbolIndices(seed, K, tid) {
    if (K === 1) return [0];
    const rand = mulberry32(fmix32((seed ^ fmix32(tid + 0x9e3779b9)) >>> 0));
    if (K <= DENSE_K) {
      // Few blocks: coin-flip each one in. Peeling can't untangle these, but
      // elimination finishes after about K + 1.6 frames, better than soliton here.
      const out = [];
      while (!out.length) for (let i = 0; i < K; i++) if (rand() < 0.5) out.push(i);
      return out;
    }
    const cdf = solitonCdf(K);
    const r = rand();
    let lo = 1, hi = K;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cdf[mid] < r) lo = mid + 1; else hi = mid; }
    const d = lo;
    if (d * 2 > K) {
      const all = Array.from({ length: K }, (_, i) => i);
      for (let i = 0; i < d; i++) {
        const j = i + Math.floor(rand() * (K - i));
        const t = all[i]; all[i] = all[j]; all[j] = t;
      }
      return all.slice(0, d);
    }
    const picked = new Set();
    while (picked.size < d) picked.add(Math.floor(rand() * K));
    return Array.from(picked);
  }

  function xorInto(dst32, src32) {
    for (let i = 0; i < dst32.length; i++) dst32[i] ^= src32[i];
  }

  class Encoder {
    constructor(payload, blockSize, tid) {
      if (blockSize % 4) throw new Error('block size must be a multiple of 4');
      this.len = payload.length;
      this.B = blockSize;
      this.K = Math.max(1, Math.ceil(payload.length / blockSize));
      this.tid = tid >>> 0;
      this.crc = crc32(payload);
      this.src = new Uint8Array(this.K * blockSize);
      this.src.set(payload);
      this.src32 = new Uint32Array(this.src.buffer);
      this.W = blockSize / 4;
    }
    frame(seed) {
      const out = new Uint8Array(HEADER + this.B);
      const dv = new DataView(out.buffer);
      dv.setUint8(0, VERSION);
      dv.setUint32(1, this.tid);
      dv.setUint32(5, this.len);
      dv.setUint16(9, this.B);
      dv.setUint32(11, seed >>> 0);
      dv.setUint32(15, this.crc);
      const acc = new Uint32Array(this.W);
      for (const i of symbolIndices(seed >>> 0, this.K, this.tid)) {
        xorInto(acc, this.src32.subarray(i * this.W, (i + 1) * this.W));
      }
      out.set(new Uint8Array(acc.buffer), HEADER);
      return out;
    }
    frameText(seed) { return b45encode(this.frame(seed)); }
  }

  function parseFrame(bytes) {
    if (!bytes || bytes.length < HEADER + 4) return null;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (dv.getUint8(0) !== VERSION) return null;
    const B = dv.getUint16(9);
    if (B % 4 || bytes.length !== HEADER + B) return null;
    return {
      tid: dv.getUint32(1), len: dv.getUint32(5), B,
      seed: dv.getUint32(11), crc: dv.getUint32(15),
      data: bytes.subarray(HEADER),
    };
  }

  function parseText(text) {
    if (typeof text !== 'string') return null;
    return parseFrame(b45decode(text));
  }

  class Decoder {
    constructor(f) {
      this.tid = f.tid; this.len = f.len; this.B = f.B; this.crc = f.crc;
      this.K = Math.max(1, Math.ceil(f.len / f.B));
      this.W = f.B / 4;
      this.blocks = new Array(this.K).fill(null);
      this.known = 0;
      this.pending = new Map();
      this.byIndex = Array.from({ length: this.K }, () => new Set());
      this.nextId = 1;
      this.seen = new Set();
      this.received = 0;
      this.minSeed = Infinity; this.maxSeed = -Infinity;
      this.sinceSolve = 0;
    }
    matches(f) {
      return f.tid === this.tid && f.len === this.len && f.B === this.B && f.crc === this.crc;
    }
    get done() { return this.known === this.K; }
    // Fraction of the sender's frames we have caught, judged from seed gaps.
    get catchRate() {
      if (this.received < 2) return null;
      return this.received / (this.maxSeed - this.minSeed + 1);
    }
    // Returns true when the frame was new.
    add(f) {
      if (this.done || this.seen.has(f.seed)) return false;
      this.seen.add(f.seed);
      this.received++;
      if (f.seed < this.minSeed) this.minSeed = f.seed;
      if (f.seed > this.maxSeed) this.maxSeed = f.seed;
      const data = new Uint32Array(this.W);
      new Uint8Array(data.buffer).set(f.data);
      const unknown = [];
      for (const i of symbolIndices(f.seed, this.K, this.tid)) {
        if (this.blocks[i]) xorInto(data, this.blocks[i]);
        else unknown.push(i);
      }
      if (unknown.length === 1) this._resolve(unknown[0], data);
      else if (unknown.length > 1) {
        const id = this.nextId++;
        this.pending.set(id, { idx: new Set(unknown), data });
        for (const i of unknown) this.byIndex[i].add(id);
        this.sinceSolve++;
        this._maybeSolve();
      }
      return true;
    }
    _resolve(i0, d0) {
      const queue = [[i0, d0]];
      while (queue.length) {
        const [i, d] = queue.pop();
        if (this.blocks[i]) continue;
        this.blocks[i] = d;
        this.known++;
        for (const id of this.byIndex[i]) {
          const p = this.pending.get(id);
          if (!p) continue;
          xorInto(p.data, d);
          p.idx.delete(i);
          if (p.idx.size === 1) {
            const j = p.idx.values().next().value;
            this.pending.delete(id);
            this.byIndex[j].delete(id);
            queue.push([j, p.data]);
          } else if (p.idx.size === 0) {
            this.pending.delete(id);
          }
        }
        this.byIndex[i].clear();
      }
    }
    // Peeling stalls now and then near the end. When enough equations are
    // waiting to possibly pin down every missing block, try Gaussian
    // elimination over GF(2) on just the missing ones.
    _maybeSolve() {
      const u = this.K - this.known;
      if (u === 0 || this.pending.size < u) return;
      if (this.sinceSolve < Math.max(1, Math.ceil(u / 16))) return;
      this.sinceSolve = 0;
      const cols = new Map();
      this.blocks.forEach((b, i) => { if (!b) cols.set(i, cols.size); });
      const words = Math.ceil(u / 32);
      const rows = [];
      for (const p of this.pending.values()) {
        const bits = new Uint32Array(words);
        for (const i of p.idx) { const c = cols.get(i); bits[c >> 5] |= 1 << (c & 31); }
        rows.push({ bits, p });
      }
      // Rank check on coefficients only; cheap compared to touching data.
      const probe = rows.map((r) => r.bits.slice());
      let rank = 0;
      for (let c = 0; c < u && rank < probe.length; c++) {
        const w = c >> 5, m = 1 << (c & 31);
        let piv = -1;
        for (let r = rank; r < probe.length; r++) if (probe[r][w] & m) { piv = r; break; }
        if (piv < 0) return; // some missing block is not covered yet
        [probe[rank], probe[piv]] = [probe[piv], probe[rank]];
        for (let r = rank + 1; r < probe.length; r++) if (probe[r][w] & m) xorInto(probe[r], probe[rank]);
        rank++;
      }
      if (rank < u) return;
      // Full rank: Gauss-Jordan with the data, then hand results to peeling.
      const eq = rows.map((r) => ({ bits: r.bits, data: r.p.data.slice() }));
      let top = 0;
      const pivotRow = new Array(u);
      for (let c = 0; c < u; c++) {
        const w = c >> 5, m = 1 << (c & 31);
        let piv = -1;
        for (let r = top; r < eq.length; r++) if (eq[r].bits[w] & m) { piv = r; break; }
        [eq[top], eq[piv]] = [eq[piv], eq[top]];
        for (let r = 0; r < eq.length; r++) {
          if (r !== top && eq[r].bits[w] & m) {
            xorInto(eq[r].bits, eq[top].bits);
            xorInto(eq[r].data, eq[top].data);
          }
        }
        pivotRow[c] = top++;
      }
      const solved = [];
      for (const [i, c] of cols) solved.push([i, eq[pivotRow[c]].data]);
      this.pending.clear();
      for (const s of this.byIndex) s.clear();
      for (const [i, d] of solved) this._resolve(i, d);
    }
    // The reassembled payload, or throws if it fails its checksum.
    payload() {
      if (!this.done) throw new Error('not finished');
      const out = new Uint8Array(this.K * this.B);
      this.blocks.forEach((b, i) => out.set(new Uint8Array(b.buffer), i * this.B));
      const p = out.subarray(0, this.len);
      if (crc32(p) !== this.crc) throw new Error('checksum mismatch');
      return p;
    }
  }

  // ---------- payload packing ----------
  // outer: u8 flags (bit0 = deflate-raw) + body
  // body:  u8 kind 1 = text: UTF-8
  //                2 = files: u16 count, then per file u16 nameLen, name,
  //                    u8 typeLen, type, u32 size; then all file bytes in order
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  function packBody(item) {
    if (item.text != null) {
      const t = enc.encode(item.text);
      const out = new Uint8Array(1 + t.length);
      out[0] = 1; out.set(t, 1);
      return out;
    }
    const metas = item.files.map((f) => ({
      name: enc.encode(f.name).subarray(0, 65535),
      type: enc.encode(f.type || '').subarray(0, 255),
      data: f.data,
    }));
    let size = 3;
    for (const m of metas) size += 2 + m.name.length + 1 + m.type.length + 4 + m.data.length;
    const out = new Uint8Array(size);
    const dv = new DataView(out.buffer);
    out[0] = 2; dv.setUint16(1, metas.length);
    let o = 3;
    for (const m of metas) {
      dv.setUint16(o, m.name.length); o += 2; out.set(m.name, o); o += m.name.length;
      out[o++] = m.type.length; out.set(m.type, o); o += m.type.length;
      dv.setUint32(o, m.data.length); o += 4;
    }
    for (const m of metas) { out.set(m.data, o); o += m.data.length; }
    return out;
  }

  function unpackBody(body) {
    if (body[0] === 1) return { text: dec.decode(body.subarray(1)) };
    if (body[0] !== 2) throw new Error('unknown payload kind');
    const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
    const count = dv.getUint16(1);
    let o = 3;
    const metas = [];
    for (let i = 0; i < count; i++) {
      const nl = dv.getUint16(o); o += 2;
      const name = dec.decode(body.subarray(o, o + nl)); o += nl;
      const tl = body[o++];
      const type = dec.decode(body.subarray(o, o + tl)); o += tl;
      const size = dv.getUint32(o); o += 4;
      metas.push({ name, type, size });
    }
    const files = metas.map((m) => {
      const data = body.slice(o, o + m.size); o += m.size;
      return { name: m.name, type: m.type, data };
    });
    return { files };
  }

  async function streamBytes(bytes, stream) {
    const s = new Blob([bytes]).stream().pipeThrough(stream);
    return new Uint8Array(await new Response(s).arrayBuffer());
  }

  async function pack(item) {
    const body = packBody(item);
    let flags = 0, out = body;
    if (typeof CompressionStream !== 'undefined' && body.length > 64) {
      try {
        const z = await streamBytes(body, new CompressionStream('deflate-raw'));
        if (z.length < body.length * 0.97) { flags = 1; out = z; }
      } catch (e) { /* send uncompressed */ }
    }
    const res = new Uint8Array(1 + out.length);
    res[0] = flags; res.set(out, 1);
    return res;
  }

  async function unpack(payload) {
    let body = payload.subarray(1);
    if (payload[0] & 1) body = await streamBytes(body, new DecompressionStream('deflate-raw'));
    return unpackBody(body);
  }

  // ---------- frame sizes ----------
  // Block size per density, picked so a frame lands on a given QR version at
  // error-correction level L (alphanumeric capacity in brackets).
  const DENSITY = {
    easy:   { B: 336,  version: 12 }, // 65x65 modules  [535 chars]
    normal: { B: 676,  version: 18 }, // 89x89          [1046]
    dense:  { B: 1116, version: 24 }, // 113x113        [1704]
    max:    { B: 1660, version: 30 }, // 137x137        [2520]
  };
  function blockSizeFor(density, payloadLen) {
    const B = (DENSITY[density] || DENSITY.normal).B;
    // Small payloads get a smaller code; it scans faster and from further away.
    return Math.min(B, Math.max(16, Math.ceil(payloadLen / 4) * 4));
  }

  const api = {
    VERSION, HEADER, DENSITY,
    b45encode, b45decode, b45len, crc32,
    solitonCdf, symbolIndices,
    Encoder, Decoder, parseFrame, parseText,
    pack, unpack, packBody, unpackBody, blockSizeFor,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Beam = api;
})(typeof self !== 'undefined' ? self : this);
