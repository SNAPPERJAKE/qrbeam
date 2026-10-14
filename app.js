// QR Beam page logic: picking what to send, painting the QR stream, and the
// camera loop that reads it back. The byte-level work lives in beam.js.
(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const VIEWS = ['home', 'send-setup', 'sending', 'receiving', 'received'];
  const FPS_STEPS = [4, 6, 8, 10, 12, 15, 20, 24, 30];
  const MAX_SEND = 64 * 1024 * 1024;
  const CROP = 0.9;        // scan the middle 90% square of the camera frame
  const SCAN_MAX = 800;    // ...downscaled to at most this many pixels a side
  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isMobile = isIOS || /Android|Mobi/i.test(navigator.userAgent);

  const prefs = (() => {
    try { return JSON.parse(localStorage.getItem('qrbeam') || '{}') || {}; } catch (e) { return {}; }
  })();
  if (!Beam.DENSITY[prefs.density]) prefs.density = 'normal';
  if (!(prefs.fpsIdx >= 0 && prefs.fpsIdx < FPS_STEPS.length)) prefs.fpsIdx = 3;
  function savePrefs() {
    try { localStorage.setItem('qrbeam', JSON.stringify(prefs)); } catch (e) { /* private mode */ }
  }

  let view = 'home';
  function show(name) {
    VIEWS.forEach((v) => { $('#view-' + v).hidden = v !== name; });
    view = name;
    window.scrollTo(0, 0);
  }

  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
    return (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB';
  }
  function fmtTime(s) {
    if (!isFinite(s)) return '…';
    s = Math.max(0, Math.round(s));
    if (s < 60) return s + ' s';
    if (s < 3600) return Math.floor(s / 60) + 'm ' + String(s % 60).padStart(2, '0') + 's';
    return Math.floor(s / 3600) + 'h ' + String(Math.floor(s / 60) % 60).padStart(2, '0') + 'm';
  }
  // Frames a receiver needs, from the decoder tests (about 6-8% over the block count).
  function framesNeeded(K) { return K === 1 ? 1 : Math.ceil(K * (K > 100 ? 1.08 : 1.06)) + 1; }

  // Keep the screen on while beaming or scanning.
  let wakeLock = null, wantWake = false;
  async function keepAwake(on) {
    wantWake = on;
    if (on) {
      try { wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { wakeLock = null; }
    } else {
      try { if (wakeLock) await wakeLock.release(); } catch (e) { /* already gone */ }
      wakeLock = null;
    }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (wantWake) keepAwake(true);
    // iOS ends the camera when the app goes to the background.
    if (rx && rx.running && rx.stream && rx.stream.getVideoTracks().every((t) => t.readyState === 'ended')) openCamera();
  });

  // ===================== send: choosing =====================
  const files = [];
  const fileInput = $('#file-input'), drop = $('#drop'), textBox = $('#send-text');
  const startBtn = $('#send-start'), estimate = $('#estimate');

  function addFiles(list) {
    for (const f of list) files.push(f);
    renderFiles();
  }
  function renderFiles() {
    const ul = $('#file-list');
    ul.textContent = '';
    files.forEach((f, i) => {
      const li = document.createElement('li');
      const name = document.createElement('span'); name.className = 'name'; name.textContent = f.name;
      const size = document.createElement('span'); size.className = 'size'; size.textContent = fmtBytes(f.size);
      const x = document.createElement('button'); x.className = 'x'; x.type = 'button'; x.textContent = '×';
      x.setAttribute('aria-label', 'Remove ' + f.name);
      x.onclick = () => { files.splice(i, 1); renderFiles(); };
      li.append(name, size, x);
      ul.append(li);
    });
    updateEstimate();
  }
  fileInput.addEventListener('change', () => { addFiles(fileInput.files); fileInput.value = ''; });
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault(); drop.classList.remove('over');
    if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  });
  document.addEventListener('paste', (e) => {
    if (view !== 'send-setup' || !e.clipboardData || !e.clipboardData.files.length) return;
    e.preventDefault();
    addFiles(e.clipboardData.files);
  });
  textBox.addEventListener('input', updateEstimate);

  for (const r of document.querySelectorAll('input[name="density"]')) {
    r.checked = r.value === prefs.density;
    r.addEventListener('change', () => { prefs.density = r.value; savePrefs(); updateEstimate(); });
  }
  const fpsRange = $('#fps');
  fpsRange.value = prefs.fpsIdx;
  fpsRange.addEventListener('input', () => { prefs.fpsIdx = +fpsRange.value; savePrefs(); updateSpeed(); updateEstimate(); });

  function rawSize() {
    let n = new TextEncoder().encode(textBox.value).length + 8;
    for (const f of files) n += f.size + f.name.length + 32;
    return n;
  }
  function updateEstimate() {
    const has = files.length > 0 || textBox.value.length > 0;
    startBtn.disabled = !has;
    if (!has) { estimate.textContent = 'Nothing selected yet.'; return; }
    const size = rawSize();
    const B = Beam.blockSizeFor(prefs.density, size);
    const need = framesNeeded(Math.ceil(size / B));
    const fps = FPS_STEPS[prefs.fpsIdx];
    const secs = need / (fps * 0.8);
    let html = `<b>${fmtBytes(size)}</b> is about <b>${need}</b> frame${need === 1 ? '' : 's'}. ` +
      `At ${fps}/s that takes roughly <b>${fmtTime(secs)}</b>, or less if it compresses.`;
    if (size > MAX_SEND) html += ' <br><b>Too big.</b> The limit is 64 MB, and even that would take hours.';
    else if (secs > 600) html += ' <br>That is a long time to hold a camera still. QR Beam suits text, links and files up to a few MB.';
    estimate.innerHTML = html;
    if (size > MAX_SEND) startBtn.disabled = true;
  }

  startBtn.addEventListener('click', async () => {
    startBtn.disabled = true;
    startBtn.textContent = 'Preparing…';
    try {
      const t = textBox.value;
      let item;
      if (!files.length) item = { text: t };
      else {
        const list = await Promise.all(files.map(async (f) => ({
          name: f.name, type: f.type, data: new Uint8Array(await f.arrayBuffer()),
        })));
        if (t.trim()) list.push({ name: 'Note.txt', type: 'text/plain', data: new TextEncoder().encode(t) });
        item = { files: list };
      }
      beginBeam(await Beam.pack(item));
    } catch (e) {
      estimate.textContent = 'Could not read that: ' + e.message;
    } finally {
      startBtn.textContent = 'Start beaming';
      updateEstimate();
    }
  });

  // ===================== send: beaming =====================
  const qrCanvas = $('#qr'), qrCtx = qrCanvas.getContext('2d');
  const tiny = document.createElement('canvas'), tinyCtx = tiny.getContext('2d');
  const qrWrap = $('#qr-wrap');
  let sender = null;

  function buildQR(seed) {
    const qr = qrcode(0, 'L');
    qr.addData(sender.enc.frameText(seed), 'Alphanumeric');
    qr.make();
    return qr;
  }
  // Paint at 1 px per module, then scale up by a whole number so every module
  // is the same size on screen.
  function paintQR(qr) {
    const n = qr.getModuleCount(), Q = 4, N = n + 2 * Q;
    if (tiny.width !== N) { tiny.width = tiny.height = N; }
    const img = tinyCtx.createImageData(N, N), d = img.data;
    d.fill(255);
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (qr.isDark(r, c)) { const o = ((r + Q) * N + c + Q) * 4; d[o] = d[o + 1] = d[o + 2] = 0; }
      }
    }
    tinyCtx.putImageData(img, 0, 0);
    const dpr = window.devicePixelRatio || 1;
    const avail = Math.max(64, Math.min(qrWrap.clientWidth - 32, qrWrap.clientHeight - 16)) * dpr;
    const px = N * Math.max(1, Math.floor(avail / N));
    if (qrCanvas.width !== px) {
      qrCanvas.width = qrCanvas.height = px;
      qrCanvas.style.width = qrCanvas.style.height = px / dpr + 'px';
    }
    qrCtx.imageSmoothingEnabled = false;
    qrCtx.drawImage(tiny, 0, 0, px, px);
    return n;
  }

  function beginBeam(payload) {
    const B = Beam.blockSizeFor(prefs.density, payload.length);
    const tid = crypto.getRandomValues(new Uint32Array(1))[0];
    sender = {
      enc: new Beam.Encoder(payload, B, tid),
      seed: 0, shown: 0, paused: false, nextAt: 0, modules: 0, raf: 0,
    };
    sender.next = buildQR(0);
    show('sending');
    keepAwake(true);
    $('#pause').textContent = 'Pause';
    updateSpeed();
    sender.raf = requestAnimationFrame(tick);
  }
  function tick(now) {
    if (!sender) return;
    sender.raf = requestAnimationFrame(tick);
    if (sender.paused || now < sender.nextAt) return;
    const interval = 1000 / FPS_STEPS[prefs.fpsIdx];
    sender.nextAt = now - sender.nextAt > interval ? now + interval : sender.nextAt + interval;
    sender.modules = paintQR(sender.next);
    sender.shown++;
    sender.seed = (sender.seed + 1) >>> 0;
    sender.next = buildQR(sender.seed);
    if (sender.shown % 4 === 1) renderSendStats();
  }
  function renderSendStats() {
    if (!sender) return;
    const { enc, modules } = sender;
    const need = framesNeeded(enc.K);
    const fps = FPS_STEPS[prefs.fpsIdx];
    $('#send-stats').innerHTML =
      `<span>frame <b>${sender.shown}</b></span>` +
      `<span><b>${fmtBytes(enc.len)}</b> in ${enc.K} block${enc.K === 1 ? '' : 's'} of ${enc.B} B</span>` +
      `<span>QR version ${(modules - 17) / 4} · ${modules}×${modules}</span>` +
      (enc.K === 1
        ? '<span>fits in one frame, so it reads instantly</span>'
        : `<span>receiver needs ~${need} frames · ${fmtTime(need / fps)} at best</span>`);
  }
  function updateSpeed() {
    const fps = FPS_STEPS[prefs.fpsIdx];
    $('#speed-val').textContent = fps + '/s';
    $('#fps-label').textContent = fps + ' frames/s';
    fpsRange.value = prefs.fpsIdx;
    $('#slower').disabled = prefs.fpsIdx === 0;
    $('#faster').disabled = prefs.fpsIdx === FPS_STEPS.length - 1;
    renderSendStats();
  }
  $('#slower').onclick = () => { prefs.fpsIdx = Math.max(0, prefs.fpsIdx - 1); savePrefs(); updateSpeed(); };
  $('#faster').onclick = () => { prefs.fpsIdx = Math.min(FPS_STEPS.length - 1, prefs.fpsIdx + 1); savePrefs(); updateSpeed(); };
  $('#pause').onclick = () => {
    if (!sender) return;
    sender.paused = !sender.paused;
    $('#pause').textContent = sender.paused ? 'Resume' : 'Pause';
  };
  const fsBtn = $('#fullscreen');
  fsBtn.hidden = !document.fullscreenEnabled;
  fsBtn.onclick = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else $('#view-sending').requestFullscreen().catch(() => {});
  };
  document.addEventListener('fullscreenchange', () => {
    fsBtn.textContent = document.fullscreenElement ? 'Exit full screen' : 'Full screen';
  });
  function stopSending() {
    if (!sender) return;
    cancelAnimationFrame(sender.raf);
    sender = null;
    keepAwake(false);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }
  $('#send-stop').onclick = () => { stopSending(); show('send-setup'); updateEstimate(); };

  // ===================== receive =====================
  const video = $('#video'), cam = $('#cam'), guide = $('#guide');
  const grab = document.createElement('canvas');
  const grabCtx = grab.getContext('2d', { willReadFrequently: true });
  let rx = null, scanner = null, statsTimer = 0, devices = [];

  function setHint(text, kind) {
    const h = $('#recv-hint');
    h.textContent = text || '';
    h.className = 'hint' + (kind ? ' ' + kind : '');
  }
  function showCamError(msg) {
    const el = $('#cam-error');
    el.textContent = msg;
    el.hidden = false;
    $('#recv-retry').hidden = false;
  }
  function stopStream() {
    if (rx && rx.stream) rx.stream.getTracks().forEach((t) => t.stop());
    if (rx) rx.stream = null;
    video.srcObject = null;
  }

  async function startReceiving() {
    stopSending();
    show('receiving');
    $('#cam-error').hidden = true;
    $('#recv-retry').hidden = true;
    $('#meter').className = 'meter';
    $('#meter i').style.width = '0%';
    $('#recv-stats').innerHTML = '<span>waiting for the first frame</span>';
    setHint('');
    rx = { running: true, gen: 0, decoder: null, recent: [], other: 0, started: 0, lastHit: 0, stream: null, inFlight: 0 };
    keepAwake(true);
    clearInterval(statsTimer);
    statsTimer = setInterval(renderRecvStats, 250);
    await openCamera();
  }

  async function openCamera(deviceId) {
    if (!rx || !rx.running) return;
    $('#cam-error').hidden = true;
    $('#recv-retry').hidden = true;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showCamError(window.isSecureContext
        ? 'This browser does not allow camera access.'
        : 'The camera only works when QR Beam is opened from its https:// link (or as a file on a computer).');
      return;
    }
    stopStream();
    const gen = ++rx.gen;
    const v = deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: 'environment' } };
    v.width = { ideal: 1920 };
    v.height = { ideal: 1080 };
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: v, audio: false });
    } catch (e) {
      showCamError(
        e.name === 'NotAllowedError' ? 'Camera access is blocked. Allow the camera for this page in your browser settings, then tap Try again.'
          : e.name === 'NotFoundError' ? 'No camera found on this device.'
            : 'The camera would not start (' + e.name + '). Close other apps that use it, then tap Try again.');
      return;
    }
    if (!rx || !rx.running || gen !== rx.gen) { stream.getTracks().forEach((t) => t.stop()); return; }
    rx.stream = stream;
    video.srcObject = stream;
    try { await video.play(); } catch (e) { /* autoplay is allowed for muted video */ }
    if (!video.videoWidth) await new Promise((r) => video.addEventListener('loadedmetadata', r, { once: true }));
    const settings = stream.getVideoTracks()[0].getSettings ? stream.getVideoTracks()[0].getSettings() : {};
    cam.classList.toggle('mirror', settings.facingMode === 'user' || (!settings.facingMode && !isMobile));
    try {
      devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    } catch (e) { devices = []; }
    rx.deviceId = settings.deviceId;
    $('#switch-cam').hidden = devices.length < 2;
    layoutGuide();
    if (!scanner) scanner = await makeScanner();
    if (gen === rx.gen) scanLoop(gen);
  }
  video.addEventListener('resize', layoutGuide);

  function layoutGuide() {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return;
    cam.style.setProperty('--ar', vw + ' / ' + vh);
    cam.style.setProperty('--arn', String(vw / vh));
    const side = Math.min(vw, vh) * CROP;
    guide.style.width = (side / vw) * 100 + '%';
    guide.style.height = (side / vh) * 100 + '%';
  }

  $('#switch-cam').onclick = () => {
    if (devices.length < 2) return;
    const i = devices.findIndex((d) => d.deviceId === rx.deviceId);
    openCamera(devices[(i + 1) % devices.length].deviceId);
  };

  // Pick the fastest QR reader this browser has.
  async function makeScanner() {
    if ('BarcodeDetector' in window) {
      try {
        const formats = await BarcodeDetector.getSupportedFormats();
        if (formats.includes('qr_code')) {
          const det = new BarcodeDetector({ formats: ['qr_code'] });
          return { kind: 'native', slots: 2, scan: async (src) => (await det.detect(src)).map((r) => r.rawValue) };
        }
      } catch (e) { /* fall through to jsQR */ }
    }
    if (location.protocol !== 'file:' && typeof Worker !== 'undefined') {
      try {
        return await makePool(Math.min(3, Math.max(1, (navigator.hardwareConcurrency || 2) - 1)));
      } catch (e) { /* fall through to the main thread */ }
    }
    return {
      kind: 'main', slots: 1,
      scan: (img) => {
        const r = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
        return r ? [r.data] : [];
      },
    };
  }

  // jsQR in background threads so several camera frames decode at once.
  function makePool(n) {
    return new Promise((resolve, reject) => {
      const idle = [], waiting = new Map();
      let ready = 0, nextId = 0, settled = false;
      const fail = (why) => {
        workers.forEach((w) => w.terminate());
        waiting.forEach((res) => res([]));
        waiting.clear();
        if (!settled) { settled = true; reject(new Error(why)); }
      };
      const timer = setTimeout(() => fail('workers did not start'), 5000);
      const workers = Array.from({ length: n }, () => {
        const w = new Worker('scan-worker.js');
        w.onerror = () => fail('worker error');
        w.onmessage = (e) => {
          const m = e.data;
          idle.push(w);
          if (m.ready) {
            if (++ready === n && !settled) { settled = true; clearTimeout(timer); resolve(pool); }
            return;
          }
          const res = waiting.get(m.id);
          waiting.delete(m.id);
          if (res) res(m.text ? [m.text] : []);
        };
        return w;
      });
      const pool = {
        kind: 'workers', slots: n,
        scan(img) {
          const w = idle.pop();
          if (!w) return [];
          const id = ++nextId;
          return new Promise((res) => {
            waiting.set(id, res);
            w.postMessage({ id, w: img.width, h: img.height, buf: img.data.buffer }, [img.data.buffer]);
          });
        },
      };
    });
  }

  function grabFrame() {
    const vw = video.videoWidth, vh = video.videoHeight;
    const side = Math.floor(Math.min(vw, vh) * CROP);
    const S = Math.min(side, SCAN_MAX);
    if (grab.width !== S) { grab.width = grab.height = S; }
    grabCtx.drawImage(video, (vw - side) >> 1, (vh - side) >> 1, side, side, 0, 0, S, S);
    return grabCtx.getImageData(0, 0, S, S);
  }

  function scanLoop(gen) {
    const live = () => rx && rx.running && rx.gen === gen;
    const next = () => {
      if (!live()) return;
      if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(onFrame);
      else requestAnimationFrame(onFrame);
    };
    function onFrame() {
      if (!live()) return;
      next();
      if (rx.inFlight >= scanner.slots || video.readyState < 2) return;
      rx.inFlight++;
      const done = (texts) => { if (rx) rx.inFlight--; if (live()) texts.forEach(handleText); };
      try {
        Promise.resolve(scanner.scan(scanner.kind === 'native' ? video : grabFrame())).then(done, () => done([]));
      } catch (e) { done([]); }
    }
    next();
  }

  function handleText(text) {
    const f = Beam.parseText(text);
    if (!f) {
      rx.other++;
      if (!rx.decoder && rx.other >= 3) setHint('That is an ordinary QR code, not a QR Beam stream.', 'warn');
      return;
    }
    rx.lastHit = performance.now();
    guide.classList.add('hit');
    if (!rx.decoder || !rx.decoder.matches(f)) {
      if (rx.decoder) setHint('The sender started a new transfer, so this one started over.', 'warn');
      rx.decoder = new Beam.Decoder(f);
      rx.started = performance.now();
      rx.recent = [];
    }
    if (rx.decoder.add(f)) rx.recent.push({ t: rx.lastHit, seed: f.seed });
    if (rx.decoder.done) finishReceive();
  }

  function renderRecvStats() {
    if (!rx || !rx.running) return;
    const now = performance.now();
    if (now - rx.lastHit > 400) guide.classList.remove('hit');
    const d = rx.decoder;
    if (!d) return;
    rx.recent = rx.recent.filter((r) => now - r.t < 3000);
    const win = rx.recent;
    let rate = 0, caught = null;
    if (win.length >= 3) {
      rate = win.length / Math.max(0.5, (now - win[0].t) / 1000);
      let lo = Infinity, hi = -Infinity;
      for (const r of win) { if (r.seed < lo) lo = r.seed; if (r.seed > hi) hi = r.seed; }
      caught = win.length / (hi - lo + 1);
    }
    const need = framesNeeded(d.K);
    const p = Math.max(d.known / d.K, Math.min(0.99, d.received / need));
    $('#meter i').style.width = (p * 100).toFixed(1) + '%';
    const parts = [
      `<span><b>${Math.floor(p * 100)}%</b> of ${fmtBytes(d.len)}</span>`,
      `<span>${d.received} of ~${need} frames</span>`,
    ];
    if (rate) {
      parts.push(`<span>${((rate * d.B) / 1024).toFixed(1)} KB/s</span>`);
      parts.push(`<span>~${fmtTime(Math.max(0, need - d.received) / rate)} left</span>`);
    }
    if (caught != null) parts.push(`<span>catching ${Math.round(Math.min(1, caught) * 100)}% of frames</span>`);
    $('#recv-stats').innerHTML = parts.join('');
    if (now - rx.lastHit > 1500) setHint('Lost the code. Point at the screen and fill the box.', 'warn');
    else if (caught != null && caught < 0.5) setHint('Missing many frames. Hold steady, move closer, or slow the sender down.', 'warn');
    else if (caught != null && caught > 0.95 && win.length > 12) setHint('Catching almost every frame. The sender can go faster.', 'good');
    else if (caught != null) setHint('');
  }

  function stopReceiving() {
    if (!rx) return;
    rx.running = false;
    stopStream();
    clearInterval(statsTimer);
    keepAwake(false);
  }

  async function finishReceive() {
    const d = rx.decoder;
    const secs = (performance.now() - rx.started) / 1000;
    stopReceiving();
    $('#meter').className = 'meter done';
    $('#meter i').style.width = '100%';
    let item;
    try {
      item = await Beam.unpack(d.payload());
    } catch (e) {
      showCamError('Everything arrived but it failed its integrity check (' + e.message + '). Tap Try again to receive it again.');
      return;
    }
    if (navigator.vibrate) navigator.vibrate(60);
    renderReceived(item, d, secs);
    show('received');
  }

  // ===================== received =====================
  let urls = [];
  function button(label, cls) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'btn small-btn' + (cls ? ' ' + cls : ''); b.textContent = label;
    return b;
  }
  function copyButton(text, pre) {
    const b = button('Copy');
    b.onclick = () => {
      const ok = () => { b.textContent = 'Copied'; setTimeout(() => { b.textContent = 'Copy'; }, 1500); };
      const fallback = () => {
        const range = document.createRange(); range.selectNodeContents(pre);
        const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
        b.textContent = 'Selected, press copy';
      };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(ok, fallback);
      else fallback();
    };
    return b;
  }
  function textCard(title, text) {
    const card = document.createElement('div'); card.className = 'card';
    const head = document.createElement('div'); head.className = 'head';
    const name = document.createElement('span'); name.className = 'name'; name.textContent = title;
    const pre = document.createElement('pre'); pre.textContent = text;
    head.append(name, copyButton(text, pre));
    card.append(head, pre);
    const t = text.trim();
    if (/^https?:\/\/\S+$/i.test(t)) {
      const a = document.createElement('a'); a.href = t; a.target = '_blank'; a.rel = 'noopener noreferrer';
      a.textContent = 'Open link';
      card.append(a);
    }
    return card;
  }
  function renderReceived(item, d, secs) {
    urls.forEach((u) => URL.revokeObjectURL(u));
    urls = [];
    const got = $('#got');
    got.textContent = '';
    let total = 0;
    if (item.text != null) {
      total = new TextEncoder().encode(item.text).length;
      got.append(textCard('Text', item.text));
    } else {
      for (const f of item.files) {
        total += f.data.length;
        const type = f.type || 'application/octet-stream';
        const file = new File([f.data], f.name || 'file', { type });
        const url = URL.createObjectURL(file);
        urls.push(url);
        let card;
        if (/^text\//.test(type) && f.data.length < 200000) {
          card = textCard(f.name, new TextDecoder().decode(f.data));
        } else {
          card = document.createElement('div'); card.className = 'card';
          const head = document.createElement('div'); head.className = 'head';
          const name = document.createElement('span'); name.className = 'name'; name.textContent = f.name;
          head.append(name);
          card.append(head);
          if (/^image\//.test(type)) {
            const img = document.createElement('img'); img.src = url; img.alt = f.name;
            card.append(img);
          }
        }
        const meta = document.createElement('span'); meta.className = 'small mono';
        meta.textContent = fmtBytes(f.data.length) + (f.type ? ' · ' + f.type : '');
        const row = document.createElement('div'); row.className = 'row';
        const save = document.createElement('a');
        save.className = 'btn small-btn primary'; save.href = url; save.download = f.name || 'file'; save.textContent = 'Save';
        row.append(save);
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          const share = button('Share');
          share.onclick = () => navigator.share({ files: [file] }).catch(() => {});
          row.append(share);
        }
        row.append(meta);
        card.append(row);
        got.append(card);
      }
    }
    $('#got-summary').textContent = d.K === 1 || secs < 1
      ? `${fmtBytes(total)} in ${d.K === 1 ? 'one frame' : 'under a second'}`
      : `${fmtBytes(total)} in ${fmtTime(secs)} (${(d.len / 1024 / secs).toFixed(1)} KB/s)`;
    $('#ios-save-tip').hidden = !(isIOS && item.files);
  }

  // ===================== navigation =====================
  function goHome() {
    stopSending();
    stopReceiving();
    show('home');
  }
  $('#home-link').onclick = goHome;
  $('#go-send').onclick = () => { show('send-setup'); updateSpeed(); updateEstimate(); };
  $('#go-receive').onclick = startReceiving;
  $('#send-back').onclick = goHome;
  $('#recv-stop').onclick = goHome;
  $('#recv-retry').onclick = startReceiving;
  $('#got-home').onclick = goHome;
  $('#got-again').onclick = startReceiving;

  $('#install-tip').hidden = !(isIOS && !navigator.standalone && location.protocol === 'https:');
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  updateSpeed();
  updateEstimate();

  // For poking at it from the console or a test harness.
  window.QRBeam = {
    get sender() { return sender; }, get rx() { return rx; }, get scanner() { return scanner; },
    beginBeam, startReceiving, goHome,
  };
})();
