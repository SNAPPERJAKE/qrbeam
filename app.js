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
  if (!['ember', 'signal', 'mint', 'violet', 'rose'].includes(prefs.accent)) prefs.accent = 'ember';
  if (!['auto', 'light', 'dark'].includes(prefs.theme)) prefs.theme = 'auto';
  if (typeof prefs.sound !== 'boolean') prefs.sound = true;
  function savePrefs() {
    try { localStorage.setItem('qrbeam', JSON.stringify(prefs)); } catch (e) { /* private mode */ }
  }

  let view = 'home';
  function show(name) {
    VIEWS.forEach((v) => { $('#view-' + v).hidden = v !== name; });
    view = name;
    window.scrollTo(0, 0);
    if (name === 'home') heroStart(); else heroStop();
  }

  // Theme colours, read back from the CSS tokens for canvas drawing.
  let colors = {};
  function readColors() {
    const cs = getComputedStyle(document.documentElement);
    for (const k of ['accent', 'line', 'ink', 'muted', 'surface', 'bg', 'good']) colors[k] = cs.getPropertyValue('--' + k).trim();
  }

  // ===================== look and sound =====================
  function applyLook() {
    const root = document.documentElement;
    if (prefs.accent === 'ember') delete root.dataset.accent; else root.dataset.accent = prefs.accent;
    if (prefs.theme === 'auto') delete root.dataset.theme; else root.dataset.theme = prefs.theme;
    readColors();
    if (grid.K) { grid.dirty = true; gridKick(); }
    heroDrawStill();
  }
  for (const r of document.querySelectorAll('input[name="accent"]')) {
    r.checked = r.value === prefs.accent;
    r.addEventListener('change', () => { prefs.accent = r.value; savePrefs(); applyLook(); });
  }
  for (const r of document.querySelectorAll('input[name="theme"]')) {
    r.checked = r.value === prefs.theme;
    r.addEventListener('change', () => { prefs.theme = r.value; savePrefs(); applyLook(); });
  }
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyLook);
  const soundBox = $('#sound-on');
  soundBox.checked = prefs.sound;
  soundBox.addEventListener('change', () => {
    prefs.sound = soundBox.checked;
    savePrefs();
    if (prefs.sound) { unlockAudio(); chime(); buzz(); }
  });

  // Audio has to be switched on from a tap, so every button that leads to a
  // receive calls this; the chime then plays when the file lands.
  let audioCtx = null;
  function unlockAudio() {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
    } catch (e) { audioCtx = null; }
  }
  function chime() {
    if (!prefs.sound || !audioCtx) return;
    const t0 = audioCtx.currentTime + 0.03;
    const master = audioCtx.createGain();
    master.gain.value = 0.22;
    master.connect(audioCtx.destination);
    // A major arpeggio, rising.
    [880, 1108.73, 1318.51, 1760].forEach((f, i) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = i === 3 ? 'triangle' : 'sine';
      o.frequency.value = f;
      const t = t0 + i * 0.08;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(1, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + (i === 3 ? 0.9 : 0.45));
      o.connect(g).connect(master);
      o.start(t);
      o.stop(t + 1);
    });
  }
  function buzz() {
    if (!prefs.sound) return;
    if (navigator.vibrate) { navigator.vibrate([35, 60, 80]); return; }
    // iPhone has no vibrate API; iOS 18 taps when a switch-style checkbox flips.
    if (isIOS) {
      const h = $('#haptic');
      h.click();
      setTimeout(() => h.click(), 140);
    }
  }

  // ===================== QR drawing =====================
  // A QR at 1 px per module with a white quiet zone, for scaling up crisply.
  function qrBitmap(qr, canvas, quiet) {
    const n = qr.getModuleCount(), N = n + 2 * quiet;
    if (canvas.width !== N) { canvas.width = canvas.height = N; }
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(N, N), d = img.data;
    d.fill(255);
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (qr.isDark(r, c)) { const o = ((r + quiet) * N + c + quiet) * 4; d[o] = d[o + 1] = d[o + 2] = 0; }
      }
    }
    ctx.putImageData(img, 0, 0);
    return n;
  }

  // ===================== home: the beam animation =====================
  // A monitor flashing a real QR Beam stream (a short hello), light flying
  // across, and a phone whose grid fills block by block. Point a second
  // device's Receive at it and the message really arrives.
  const hero = $('#hero'), heroCtx = hero.getContext('2d');
  const heroQR = document.createElement('canvas');
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const HERO_MSG = 'Hello from the QR Beam home screen. This message came across by light alone.';
  const HERO_COLS = 4, HERO_ROWS = 7;
  const hs = {
    enc: null, seed: 0, raf: 0, nextFlip: 0, W: 0, H: 0, L: null,
    parts: [], lit: new Float64Array(HERO_COLS * HERO_ROWS), litCount: 0, fullAt: 0,
  };
  Beam.pack({ text: HERO_MSG }).then((p) => {
    hs.enc = new Beam.Encoder(p, Beam.blockSizeFor('easy', p.length), 0x51b3a3);
    heroFlipQR();
    heroDrawStill();
  });

  function heroLayout() {
    const W = hero.clientWidth, H = hero.clientHeight;
    if (!W || !H) return false;
    const dpr = window.devicePixelRatio || 1;
    if (hs.W !== W || hs.H !== H) {
      hero.width = Math.round(W * dpr); hero.height = Math.round(H * dpr);
      hs.W = W; hs.H = H;
    }
    heroCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const sw = Math.min(190, W * 0.4), sh = Math.min(H - 40, sw * 0.8);
    const screen = { x: 2, y: 4, w: sw, h: sh };
    const pw = Math.min(82, W * 0.21), ph = Math.min(H - 6, pw * 1.95);
    const phone = { x: W - pw - 2, y: (H - ph) / 2, w: pw, h: ph };
    const view = { x: phone.x + 6, y: phone.y + 16, w: pw - 12, h: ph - 32 };
    hs.L = { screen, phone, view, dpr };
    return true;
  }
  function heroFlipQR() {
    if (!hs.enc) return;
    const qr = qrcode(0, 'L');
    qr.addData(hs.enc.frameText(hs.seed++), 'Alphanumeric');
    qr.make();
    qrBitmap(qr, heroQR, 2);
  }
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function heroDraw(now) {
    const ctx = heroCtx, L = hs.L;
    if (!L) return;
    const { screen: S, phone: P, view: V } = L;
    ctx.clearRect(0, 0, hs.W, hs.H);

    // the beam of light between the two
    const x0 = S.x + S.w, x1 = V.x, cy0 = S.y + S.h / 2, cy1 = V.y + V.h / 2;
    const g = ctx.createLinearGradient(x0, 0, x1, 0);
    g.addColorStop(0, colors.accent + '40');
    g.addColorStop(1, colors.accent + '10');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(x0, S.y + S.h * 0.18); ctx.lineTo(x1, cy1 - V.h * 0.18);
    ctx.lineTo(x1, cy1 + V.h * 0.18); ctx.lineTo(x0, S.y + S.h * 0.82);
    ctx.closePath(); ctx.fill();

    // monitor: bezel, white screen with the live code, stand
    ctx.fillStyle = colors.ink;
    roundRect(ctx, S.x, S.y, S.w, S.h, 8); ctx.fill();
    ctx.fillStyle = '#ffffff';
    roundRect(ctx, S.x + 5, S.y + 5, S.w - 10, S.h - 10, 4); ctx.fill();
    ctx.fillStyle = colors.ink;
    ctx.fillRect(S.x + S.w / 2 - 6, S.y + S.h, 12, 14);
    roundRect(ctx, S.x + S.w / 2 - 34, S.y + S.h + 13, 68, 6, 3); ctx.fill();
    if (heroQR.width > 1) {
      const N = heroQR.width, room = (S.h - 16) * L.dpr;
      const px = Math.max(N, Math.floor(room / N) * N) / L.dpr;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(heroQR, Math.round((S.x + S.w / 2 - px / 2) * L.dpr) / L.dpr, Math.round((S.y + S.h / 2 - px / 2) * L.dpr) / L.dpr, px, px);
    }

    // light in flight
    for (const p of hs.parts) {
      const t = Math.min(1, (now - p.t0) / p.dur), e = t * t * (3 - 2 * t);
      const x = x0 + (x1 - x0) * e, y = p.y0 + (p.y1 - p.y0) * e;
      ctx.globalAlpha = 0.35 + 0.65 * Math.sin(Math.PI * Math.min(1, t * 1.15));
      ctx.fillStyle = colors.accent;
      ctx.fillRect(x - p.s / 2, y - p.s / 2, p.s, p.s);
    }
    ctx.globalAlpha = 1;

    // phone: body, dark viewfinder, corner brackets, block grid
    ctx.fillStyle = colors.surface;
    ctx.strokeStyle = colors.ink;
    ctx.lineWidth = 2;
    roundRect(ctx, P.x, P.y, P.w, P.h, 14); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#141a21';
    roundRect(ctx, V.x, V.y, V.w, V.h, 6); ctx.fill();
    ctx.strokeStyle = colors.accent;
    ctx.lineWidth = 2;
    const b = 8, bx0 = V.x + 5, by0 = V.y + 5, bx1 = V.x + V.w - 5, by1 = V.y + V.h - 5;
    ctx.beginPath();
    ctx.moveTo(bx0, by0 + b); ctx.lineTo(bx0, by0); ctx.lineTo(bx0 + b, by0);
    ctx.moveTo(bx1 - b, by0); ctx.lineTo(bx1, by0); ctx.lineTo(bx1, by0 + b);
    ctx.moveTo(bx1, by1 - b); ctx.lineTo(bx1, by1); ctx.lineTo(bx1 - b, by1);
    ctx.moveTo(bx0 + b, by1); ctx.lineTo(bx0, by1); ctx.lineTo(bx0, by1 - b);
    ctx.stroke();
    const gap = 3, cell = Math.min((V.w - 22 - gap * (HERO_COLS - 1)) / HERO_COLS, (V.h - 22 - gap * (HERO_ROWS - 1)) / HERO_ROWS);
    const gw = HERO_COLS * cell + (HERO_COLS - 1) * gap, gh = HERO_ROWS * cell + (HERO_ROWS - 1) * gap;
    const gx = V.x + (V.w - gw) / 2, gy = V.y + (V.h - gh) / 2;
    const full = hs.litCount === hs.lit.length;
    for (let i = 0; i < hs.lit.length; i++) {
      const x = gx + (i % HERO_COLS) * (cell + gap), y = gy + Math.floor(i / HERO_COLS) * (cell + gap);
      ctx.fillStyle = hs.lit[i] ? (full ? colors.good : colors.accent) : '#2b3540';
      ctx.fillRect(x, y, cell, cell);
      const age = now - hs.lit[i];
      if (hs.lit[i] && age < 500) {
        const k = 1 - age / 500, grow = k * 2;
        ctx.globalAlpha = k * 0.8; ctx.fillStyle = '#ffffff';
        ctx.fillRect(x - grow, y - grow, cell + grow * 2, cell + grow * 2);
        ctx.globalAlpha = 1;
      }
    }
  }
  function heroTick(now) {
    hs.raf = requestAnimationFrame(heroTick);
    const L = hs.L;
    if (!L) return;
    if (now >= hs.nextFlip) {
      hs.nextFlip = now + 170;
      heroFlipQR();
      const x0 = L.screen.x + L.screen.w, cy1 = L.view.y + L.view.h / 2;
      for (let i = 0; i < 3; i++) {
        hs.parts.push({
          t0: now + i * 45, dur: 650 + Math.random() * 250, s: 3 + Math.random() * 3,
          y0: L.screen.y + L.screen.h * (0.25 + Math.random() * 0.5),
          y1: cy1 + (Math.random() - 0.5) * L.view.h * 0.3, x0,
        });
      }
    }
    // each arriving spark lights one more block; when full, hold, then restart
    hs.parts = hs.parts.filter((p) => {
      if (now - p.t0 < p.dur) return true;
      if (hs.litCount < hs.lit.length && Math.random() < 0.55) {
        let i;
        do { i = Math.floor(Math.random() * hs.lit.length); } while (hs.lit[i]);
        hs.lit[i] = now;
        if (++hs.litCount === hs.lit.length) hs.fullAt = now;
      }
      return false;
    });
    if (hs.fullAt && now - hs.fullAt > 1600) { hs.lit.fill(0); hs.litCount = 0; hs.fullAt = 0; }
    heroDraw(now);
  }
  function heroStart() {
    if (hs.raf || view !== 'home' || document.visibilityState !== 'visible') return;
    if (!heroLayout()) return;
    if (reduceMotion.matches) { heroDrawStill(); return; }
    hs.raf = requestAnimationFrame(heroTick);
  }
  function heroStop() {
    cancelAnimationFrame(hs.raf);
    hs.raf = 0;
  }
  // One still frame: used for reduced motion and while nothing animates.
  function heroDrawStill() {
    if (view !== 'home' || !heroLayout()) return;
    if (hs.raf) return; // the running loop redraws on its own
    if (!hs.litCount) {
      for (let i = 0; i < hs.lit.length; i += 2) hs.lit[(i * 7) % hs.lit.length] = 1;
      hs.litCount = hs.lit.reduce((a, v) => a + (v ? 1 : 0), 0);
    }
    heroDraw(1e9);
  }
  window.addEventListener('resize', () => { hs.W = 0; if (view === 'home') { heroLayout(); heroDrawStill(); } });
  reduceMotion.addEventListener('change', () => { heroStop(); heroStart(); });

  // ===================== receive: the block grid =====================
  // One square per block of the file, lit the moment that block is recovered.
  // Huge files share a square between several blocks and fill it gradually.
  const gridCanvas = $('#grid'), gridCtx = gridCanvas.getContext('2d');
  const grid = { K: 0, raf: 0, dirty: false, done: false };
  const FLASH_MS = 700;

  function gridReset() {
    grid.K = 0; grid.done = false;
    gridCanvas.style.height = '0px';
  }
  function gridInit(K) {
    const W = gridCanvas.clientWidth;
    if (!W) return;
    const maxH = Math.round(Math.min(150, Math.max(64, window.innerHeight * 0.16)));
    let L = null;
    for (let c = 18; c >= 3 && !L; c--) {
      const gap = c >= 7 ? 2 : 1;
      const cols = Math.floor((W + gap) / (c + gap));
      const rows = Math.ceil(K / cols);
      if (rows * (c + gap) - gap <= maxH) L = { c, gap, cols, per: 1 };
    }
    if (!L) {
      const c = 3, gap = 1, cols = Math.floor((W + gap) / (c + gap)), rows = Math.floor((maxH + gap) / (c + gap));
      L = { c, gap, cols, per: Math.ceil(K / (cols * rows)) };
    }
    const prevLit = grid.K === K ? grid.lit : null;
    Object.assign(grid, L);
    grid.K = K;
    grid.cells = Math.ceil(K / grid.per);
    grid.cols = Math.min(grid.cols, grid.cells);
    grid.rows = Math.ceil(grid.cells / grid.cols);
    grid.lit = prevLit || new Uint8Array(K);
    grid.cellLit = new Uint32Array(grid.cells);
    grid.cellAt = new Float64Array(grid.cells);
    if (prevLit) prevLit.forEach((v, i) => { if (v) grid.cellLit[Math.floor(i / grid.per)]++; });
    const H = grid.rows * (grid.c + grid.gap) - grid.gap;
    grid.ox = Math.floor((W - (grid.cols * (grid.c + grid.gap) - grid.gap)) / 2);
    const dpr = window.devicePixelRatio || 1;
    gridCanvas.style.height = H + 'px';
    gridCanvas.width = Math.round(W * dpr);
    gridCanvas.height = Math.round(H * dpr);
    grid.W = W; grid.H = H; grid.dpr = dpr;
    readColors();
    grid.dirty = true;
    gridKick();
  }
  function gridSolved(i) {
    if (!grid.K || grid.lit[i]) return;
    grid.lit[i] = 1;
    const cell = Math.floor(i / grid.per);
    grid.cellLit[cell]++;
    grid.cellAt[cell] = performance.now();
    grid.dirty = true;
    gridKick();
  }
  function gridKick() { if (!grid.raf) grid.raf = requestAnimationFrame(gridDraw); }
  function gridDraw(now) {
    grid.raf = 0;
    if (!grid.K) return;
    const ctx = gridCtx, { c, gap, cols, per, cells, ox } = grid;
    ctx.setTransform(grid.dpr, 0, 0, grid.dpr, 0, 0);
    ctx.clearRect(0, 0, grid.W, grid.H);
    let flashing = false;
    for (let k = 0; k < cells; k++) {
      const x = ox + (k % cols) * (c + gap), y = Math.floor(k / cols) * (c + gap);
      const n = grid.cellLit[k];
      ctx.fillStyle = colors.line;
      ctx.fillRect(x, y, c, c);
      if (!n) continue;
      const total = Math.min(per, grid.K - k * per);
      ctx.globalAlpha = n >= total ? 1 : 0.3 + (0.55 * n) / total;
      ctx.fillStyle = grid.done ? colors.good : colors.accent;
      ctx.fillRect(x, y, c, c);
      const age = now - grid.cellAt[k];
      if (age < FLASH_MS) {
        flashing = true;
        const f = 1 - age / FLASH_MS, grow = f * Math.min(2, c / 4);
        ctx.globalAlpha = f * 0.85;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(x - grow, y - grow, c + grow * 2, c + grow * 2);
      }
      ctx.globalAlpha = 1;
    }
    grid.dirty = false;
    if (flashing) gridKick();
  }
  window.addEventListener('resize', () => { if (grid.K && rx && rx.running) gridInit(grid.K); });

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
    if (document.visibilityState !== 'visible') { heroStop(); return; }
    if (wantWake) keepAwake(true);
    heroStart();
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
  const tiny = document.createElement('canvas');
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
    const n = qrBitmap(qr, tiny, 4), N = n + 8;
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
    unlockAudio(); // still inside the tap that got us here
    stopSending();
    show('receiving');
    gridReset();
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
      const v = Beam.peekVersion(text);
      if (v && v !== Beam.VERSION) setHint('The other device has a different version of QR Beam. Reload the page on both devices.', 'warn');
      else if (!rx.decoder && rx.other >= 3) setHint('That is an ordinary QR code, not a QR Beam stream.', 'warn');
      return;
    }
    rx.lastHit = performance.now();
    guide.classList.add('hit');
    if (!rx.decoder || !rx.decoder.matches(f)) {
      if (rx.decoder) setHint('The sender started a new transfer, so this one started over.', 'warn');
      rx.decoder = new Beam.Decoder(f);
      rx.decoder.onSolved = gridSolved;
      rx.started = performance.now();
      rx.recent = [];
      gridReset();
      gridInit(rx.decoder.K);
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
      `<span>${d.known} of ${d.K} piece${d.K === 1 ? '' : 's'}</span>`,
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
    // Let the grid turn green and the chime play before switching screens.
    grid.done = true;
    grid.dirty = true;
    gridKick();
    chime();
    buzz();
    renderReceived(item, d, secs);
    setTimeout(() => { if (view === 'receiving') show('received'); }, 800);
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
  applyLook();
  heroStart();

  // For poking at it from the console or a test harness.
  window.QRBeam = {
    get sender() { return sender; }, get rx() { return rx; }, get scanner() { return scanner; },
    beginBeam, startReceiving, goHome,
  };
})();
