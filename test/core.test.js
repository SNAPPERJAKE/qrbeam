// Run: node test/core.test.js
// Checks the codec end to end without a browser: base45, CRC, packing, and the
// fountain code under frame loss, plus how many frames a receive really takes.
const assert = require('assert');
const crypto = require('crypto');
const Beam = require('../beam.js');

let passed = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { passed++; console.log('ok   ' + name); },
    (e) => { console.log('FAIL ' + name + '\n     ' + (e.stack || e)); process.exitCode = 1; },
  );
}

// Push frames through a lossy "camera" until the decoder finishes.
function transfer(payload, B, { loss = 0, startSeed = 0, ge = true, dupes = 0 } = {}) {
  const tid = crypto.randomBytes(4).readUInt32BE(0);
  const encd = new Beam.Encoder(payload, B, tid);
  let dec = null, shown = 0;
  for (let seed = startSeed; ; seed++) {
    shown++;
    if (Math.random() < loss) continue;
    const text = encd.frameText(seed);
    for (let r = 0; r <= dupes; r++) {
      const f = Beam.parseText(text);
      if (!dec) { dec = new Beam.Decoder(f); if (!ge) dec._maybeSolve = () => {}; }
      dec.add(f);
    }
    if (dec.done) break;
    if (shown > encd.K * 20 + 200) throw new Error('never finished');
  }
  return { out: dec.payload(), received: dec.received, shown, K: encd.K, dec };
}

(async () => {
  await test('base45 round-trips every length 0..300 and rejects junk', () => {
    for (let n = 0; n <= 300; n++) {
      const b = crypto.randomBytes(n);
      const s = Beam.b45encode(b);
      assert.strictEqual(s.length, Beam.b45len(n));
      assert.ok(/^[0-9A-Z $%*+\-./:]*$/.test(s));
      assert.deepStrictEqual(Buffer.from(Beam.b45decode(s)), b);
    }
    assert.strictEqual(Beam.b45decode('ABCD'), null); // length % 3 == 1
    assert.strictEqual(Beam.b45decode('abc'), null); // lowercase is not in the set
    assert.strictEqual(Beam.b45decode(':::'), null); // > 0xffff
    assert.strictEqual(Beam.b45decode('GGW'), null); // RFC 9285 invalid example
    assert.strictEqual(Beam.b45encode(Buffer.from('ietf!')), 'QED8WEX0'); // RFC 9285 example
  });

  await test('crc32 matches the standard check value', () => {
    assert.strictEqual(Beam.crc32(Buffer.from('123456789')), 0xcbf43926);
  });

  await test('text and multi-file payloads pack and unpack', async () => {
    const t = await Beam.unpack(await Beam.pack({ text: 'héllo 👋 ' + 'x'.repeat(500) }));
    assert.strictEqual(t.text, 'héllo 👋 ' + 'x'.repeat(500));
    const files = [
      { name: 'photo.jpg', type: 'image/jpeg', data: crypto.randomBytes(5000) },
      { name: 'notes – ünïcode.txt', type: 'text/plain', data: Buffer.from('a\n'.repeat(3000)) },
      { name: 'empty', type: '', data: new Uint8Array(0) },
    ];
    const packed = await Beam.pack({ files });
    assert.strictEqual(packed[0] & 1, 1, 'compressible set should be deflated');
    const u = await Beam.unpack(packed);
    assert.strictEqual(u.files.length, 3);
    u.files.forEach((f, i) => {
      assert.strictEqual(f.name, files[i].name);
      assert.strictEqual(f.type, files[i].type);
      assert.deepStrictEqual(Buffer.from(f.data), Buffer.from(files[i].data));
    });
    const rnd = await Beam.pack({ files: [{ name: 'r', type: '', data: crypto.randomBytes(4000) }] });
    assert.strictEqual(rnd[0] & 1, 0, 'random data should go uncompressed');
  });

  await test('frame header survives the trip and is checked', () => {
    const enc = new Beam.Encoder(crypto.randomBytes(1000), 336, 0xdeadbeef);
    const f = Beam.parseText(enc.frameText(42));
    assert.strictEqual(f.tid, 0xdeadbeef); assert.strictEqual(f.seed, 42);
    assert.strictEqual(f.len, 1000); assert.strictEqual(f.B, 336);
    assert.strictEqual(Beam.parseText('HELLO WORLD'), null);
    assert.strictEqual(Beam.parseText('https://example.com'), null);
  });

  await test('frames fit the QR version each density aims for', () => {
    // Alphanumeric capacity at EC level L for the target versions.
    const cap = { 12: 535, 18: 1046, 24: 1704, 30: 2520 };
    for (const [name, d] of Object.entries(Beam.DENSITY)) {
      const chars = Beam.b45len(Beam.HEADER + d.B);
      assert.ok(chars <= cap[d.version], `${name}: ${chars} > ${cap[d.version]}`);
      assert.ok(chars > cap[d.version] * 0.95, `${name} wastes space`);
    }
  });

  await test('one-block payload decodes from any single frame', () => {
    const p = crypto.randomBytes(20);
    const r = transfer(p, Beam.blockSizeFor('normal', p.length), { startSeed: 77 });
    assert.strictEqual(r.K, 1); assert.strictEqual(r.received, 1);
    assert.deepStrictEqual(Buffer.from(r.out), p);
  });

  await test('decodes exactly under 40% loss, late start and duplicate scans', () => {
    for (const len of [1, 100, 677, 5000, 33333, 120000]) {
      const p = crypto.randomBytes(len);
      const r = transfer(p, 676, { loss: 0.4, startSeed: 1000 + len, dupes: 2 });
      assert.deepStrictEqual(Buffer.from(r.out), p, 'len ' + len);
    }
  });

  await test('a corrupted block is caught by the checksum', () => {
    const p = crypto.randomBytes(3000);
    const enc = new Beam.Encoder(p, 336, 7);
    const dec = new Beam.Decoder(Beam.parseText(enc.frameText(0)));
    for (let s = 0; !dec.done; s++) {
      const f = Beam.parseText(enc.frameText(s));
      if (s === 3) f.data[5] ^= 1; // what a bad scan would look like
      dec.add(f);
    }
    // The flipped bit only matters if that frame got used; either way the
    // result is right or rejected, never silently wrong.
    let ok = true;
    try { assert.deepStrictEqual(Buffer.from(dec.payload()), p); } catch (e) { ok = /checksum/.test(e.message); }
    assert.ok(ok);
  });

  // How many unique frames a receive needs, as a multiple of K.
  console.log('\nframes needed / K  (200 runs each, 30% loss, random start)');
  console.log('   K   peel-only avg  p95 | +elimination avg  p95');
  for (const K of [2, 10, 30, 60, 100, 101, 300, 1000]) {
    const row = [];
    for (const ge of [false, true]) {
      if (!ge && K <= 100) { row.push('-'.padStart(10), '-'.padStart(5)); continue; } // dense rows need elimination
      const runs = K >= 1000 ? 40 : 200;
      const ratios = [];
      for (let i = 0; i < runs; i++) {
        const p = crypto.randomBytes(K * 16);
        const r = transfer(p, 16, { loss: 0.3, startSeed: (Math.random() * 1e6) | 0, ge });
        ratios.push(r.received / K);
      }
      ratios.sort((a, b) => a - b);
      const avg = ratios.reduce((a, b) => a + b, 0) / ratios.length;
      row.push(avg.toFixed(2).padStart(10), ratios[Math.floor(ratios.length * 0.95)].toFixed(2).padStart(5));
    }
    console.log(String(K).padStart(4) + ' ' + row[0] + row[1] + ' | ' + row[2] + row[3]);
  }

  console.log(`\n${passed} passed` + (process.exitCode ? ', SOME FAILED' : ''));
})();
