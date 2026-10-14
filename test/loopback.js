// Browser loopback test. Serve the qrbeam folder over http, open the page, then
// in the console:  await import('./test/loopback.js'); await runLoop({ size: 40000 })
//
// It swaps the camera for a canvas that draws the QR stream the way a camera
// would see it (tilted, blurred, dimmed, with dropped frames), runs the real
// receive path, and checks the file that comes out is byte-for-byte the same.
// A hidden tab throttles video frame callbacks to ~1/s, so `realTiming` stands
// in a 30 fps camera clock.
export function realTiming() {
  HTMLVideoElement.prototype.requestVideoFrameCallback = function (cb) {
    return setTimeout(() => cb(performance.now(), {}), 33);
  };
}

window.runLoop = async function ({
  size = 40000, density = 'normal', fps = 12, loss = 0.2, angle = 3, qrPx = 560, blur = 0.6,
  kind = 'random', extraText = null, name = 'test.bin', type = 'application/octet-stream', bytes = null,
  lanes = 1, gap = 60,
} = {}) {
  const data = bytes || new Uint8Array(size);
  if (bytes) { /* caller's own file */ } else if (kind === 'random') {
    for (let i = 0; i < size; i += 65536) crypto.getRandomValues(data.subarray(i, Math.min(size, i + 65536)));
  } else {
    const t = new TextEncoder().encode('The quick brown fox jumps over the lazy dog. ');
    for (let i = 0; i < size; i++) data[i] = t[i % t.length];
  }
  const files = [{ name, type, data }];
  if (extraText) files.push({ name: 'Note.txt', type: 'text/plain', data: new TextEncoder().encode(extraText) });
  const payload = await Beam.pack({ files });
  const B = Beam.blockSizeFor(density, payload.length);
  const enc = new Beam.Encoder(payload, B, crypto.getRandomValues(new Uint32Array(1))[0]);

  const cam = document.createElement('canvas'); cam.width = 1280; cam.height = 720;
  const c = cam.getContext('2d');
  const tiny = document.createElement('canvas'); const tc = tiny.getContext('2d');
  let seed = 0, version = 0;
  const flags = lanes === 2 ? Beam.FLAG_LANES : 0;
  const paintCode = (s) => {
    const qr = qrcode(0, 'L'); qr.addData(enc.frameText(s, flags), 'Alphanumeric'); qr.make();
    const n = qr.getModuleCount(), N = n + 8; version = (n - 17) / 4;
    tiny.width = tiny.height = N;
    const img = tc.createImageData(N, N); img.data.fill(255);
    for (let r = 0; r < n; r++) {
      for (let q = 0; q < n; q++) {
        if (qr.isDark(r, q)) { const o = ((r + 4) * N + q + 4) * 4; img.data[o] = img.data[o + 1] = img.data[o + 2] = 0; }
      }
    }
    tc.putImageData(img, 0, 0);
  };
  const draw = () => {
    const first = seed + 1;
    seed += lanes;
    if (Math.random() < loss) return; // the camera misses this frame entirely
    c.filter = 'none'; c.fillStyle = '#556'; c.fillRect(0, 0, 1280, 720);
    c.save(); c.translate(640, 360); c.rotate((angle * Math.PI) / 180);
    c.filter = `blur(${blur}px) brightness(0.85) contrast(0.9)`; c.imageSmoothingEnabled = false;
    for (let i = 0; i < lanes; i++) {
      paintCode(first + i);
      const x = lanes === 2 ? (i ? gap / 2 : -gap / 2 - qrPx) : -qrPx / 2;
      c.drawImage(tiny, x, -qrPx / 2, qrPx, qrPx);
    }
    c.restore();
  };
  const stream = cam.captureStream(30);
  navigator.mediaDevices.getUserMedia = async () => stream;
  draw();
  const timer = setInterval(draw, 1000 / fps);
  const t0 = performance.now();
  QRBeam.startReceiving();
  const done = () => !document.querySelector('#view-received').hidden || !document.querySelector('#cam-error').hidden;
  while (!done() && performance.now() - t0 < 240000) await new Promise((r) => setTimeout(r, 200));
  clearInterval(timer);
  stream.getTracks().forEach((t) => t.stop());
  const secs = (performance.now() - t0) / 1000;
  const a = document.querySelector('#got a[download]');
  if (!a) {
    return { ok: false, secs, stats: document.querySelector('#recv-stats').innerText, error: document.querySelector('#cam-error').innerText };
  }
  const got = new Uint8Array(await (await fetch(a.href)).arrayBuffer());
  const same = got.length === data.length && got.every((v, i) => v === data[i]);
  return {
    ok: same, secs: +secs.toFixed(1), K: enc.K, B, payload: payload.length, version, framesDrawn: seed,
    scanner: QRBeam.scanner.kind + ' x' + QRBeam.scanner.slots,
    summary: document.querySelector('#got-summary').innerText,
  };
};
