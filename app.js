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
  if (!['original', 'large', 'small'].includes(prefs.photoSize)) prefs.photoSize = 'large';
  if (typeof prefs.twoWay !== 'boolean') prefs.twoWay = true;
  // How many codes a send starts with, picked on the Send screen. (Replaces the
  // old "lanes" setting, which also remembered mid-transfer switches.)
  delete prefs.lanes;
  if (![1, 2].includes(prefs.startCodes)) prefs.startCodes = 1;
  if (!['environment', 'user'].includes(prefs.rxFacing)) prefs.rxFacing = 'environment';
  function savePrefs() {
    try { localStorage.setItem('qrbeam', JSON.stringify(prefs)); } catch (e) { /* private mode */ }
  }

  let view = 'home';
  function show(name) {
    VIEWS.forEach((v) => { $('#view-' + v).hidden = v !== name; });
    view = name;
    window.scrollTo(0, 0);
    if (name === 'home') heroStart(); else heroStop();
    // the badge stays out of the way of the codes and the camera
    $('#credit').hidden = name === 'sending' || name === 'receiving';
    $('#credit-pop').hidden = true;
    $('#home-bar').hidden = name !== 'home';
    $('#look-pop').hidden = true;
    $('#look-btn').setAttribute('aria-expanded', 'false');
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
  // A still code for a person to scan, about cssSize px across and crisp at
  // any pixel ratio.
  function paintQR(canvas, text, cssSize, quiet) {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const tiny = document.createElement('canvas');
    const N = qrBitmap(qr, tiny, quiet) + 2 * quiet;
    const dpr = window.devicePixelRatio || 1;
    const px = N * Math.max(1, Math.floor((cssSize * dpr) / N));
    canvas.width = canvas.height = px;
    canvas.style.width = canvas.style.height = px / dpr + 'px';
    const c = canvas.getContext('2d');
    c.imageSmoothingEnabled = false;
    c.drawImage(tiny, 0, 0, px, px);
  }

  // ===================== home: the beam animation =====================
  // A monitor flashing the link to this very page, light flying across, and
  // a phone whose grid fills block by block. The code keeps changing (it
  // steps through the eight QR mask patterns) but every frame reads the same
  // link, so any phone camera pointed at it opens QR Beam.
  const hero = $('#hero'), heroCtx = hero.getContext('2d');
  const heroQR = document.createElement('canvas');
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const HOME_URL = 'https://snapperjake.github.io/qrbeam/';
  const HERO_COLS = 4, HERO_ROWS = 7;
  const hs = {
    mask: 0, raf: 0, nextFlip: 0, W: 0, H: 0, L: null,
    parts: [], lit: new Float64Array(HERO_COLS * HERO_ROWS), litCount: 0, fullAt: 0,
  };
  heroFlipQR();

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
    const qr = qrcode(0, 'M');
    qr.addData(HOME_URL);
    qr.make(hs.mask);
    hs.mask = (hs.mask + 1) % 8;
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
    grid.K = 0; grid.wantK = 0; grid.done = false;
    gridCanvas.style.height = '0px';
  }
  function gridInit(K) {
    grid.wantK = K;
    const W = gridCanvas.clientWidth;
    if (!W) return; // laid out later; the resize watcher below picks it up
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
  // The receive screen changes width (the two-way status code comes and goes,
  // phones rotate), so re-lay the grid whenever its width does.
  if (window.ResizeObserver) {
    new ResizeObserver(() => {
      const K = grid.K || grid.wantK;
      if (K && gridCanvas.clientWidth && Math.abs(gridCanvas.clientWidth - (grid.W || 0)) > 1) gridInit(K);
    }).observe(gridCanvas);
  } else {
    window.addEventListener('resize', () => { if (grid.K) gridInit(grid.K); });
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
  // Frames a receiver needs, from the decoder tests (about 3-7% over the block count).
  function framesNeeded(K) { return K === 1 ? 1 : Math.ceil(K * 1.06) + 1; }

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
    if (rxCam.running && rxCam.ended()) rxCam.reopen();
    if (txCam.running && txCam.ended()) txCam.reopen();
  });

  // ===================== QR scanning =====================
  let scanner = null;
  async function getScanner() {
    if (!scanner) scanner = await makeScanner();
    return scanner;
  }
  // Pick the fastest QR reader this browser has.
  async function makeScanner() {
    if ('BarcodeDetector' in window) {
      try {
        const formats = await BarcodeDetector.getSupportedFormats();
        if (formats.includes('qr_code')) {
          const det = new BarcodeDetector({ formats: ['qr_code'] });
          return {
            kind: 'native', slots: 2,
            scan: async (src) => (await det.detect(src)).map((r) => ({
              text: r.rawValue,
              quad: r.cornerPoints && r.cornerPoints.length === 4 ? r.cornerPoints.flatMap((pt) => [pt.x, pt.y]) : null,
            })),
          };
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
        if (!r) return [];
        const l = r.location;
        return [{
          text: r.data,
          ver: r.version,
          quad: [l.topLeftCorner.x, l.topLeftCorner.y, l.topRightCorner.x, l.topRightCorner.y,
            l.bottomRightCorner.x, l.bottomRightCorner.y, l.bottomLeftCorner.x, l.bottomLeftCorner.y],
        }];
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
          if (res) res(m.text ? [{ text: m.text, quad: m.quad, ver: m.ver }] : []);
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

  // ===================== cameras =====================
  function sq(cx, cy, side) {
    return { x: Math.round(cx - side / 2), y: Math.round(cy - side / 2), w: Math.round(side), h: Math.round(side) };
  }
  function cameraMessage(e) {
    if (e.name === 'NotAllowedError') return 'Camera access is blocked. Allow the camera for this page in your browser settings, then tap Try again.';
    if (e.name === 'NotFoundError' || e.name === 'OverconstrainedError') return 'No suitable camera found on this device.';
    return 'The camera would not start (' + e.name + '). Close other apps that use it, then tap Try again.';
  }
  const FRONT = /front|user|face|selfie/i, BACK = /back|rear|environment|world/i;
  function facingOf(stream) {
    const t = stream.getVideoTracks()[0];
    const st = t && t.getSettings ? t.getSettings() : {};
    return st.facingMode || '';
  }
  // Phones treat a plain facingMode as a hint, and iPhone Safari will hand back
  // the camera it just had when you switch. So ask for the direction outright,
  // then by the camera's name ("Front Camera"), and only then as a hint, which
  // is what laptop webcams that don't report a direction need.
  async function openStream(get, deviceId, facing) {
    if (deviceId) return get({ deviceId: { exact: deviceId } });
    let stream = null, firstErr = null;
    try {
      stream = await get({ facingMode: { exact: facing } });
    } catch (e) {
      if (e.name === 'NotAllowedError') throw e;
      firstErr = e;
    }
    if (stream && (facingOf(stream) || facing) === facing) return stream;
    let named = [];
    try {
      const want = facing === 'user' ? FRONT : BACK;
      named = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput' && want.test(d.label));
    } catch (e) { /* no list */ }
    if (named.length) {
      // the plain wide camera, rather than an ultra-wide or telephoto one
      const pick = named.find((d) => !/ultra|tele|dual|triple/i.test(d.label)) || named[0];
      if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
      try { return await get({ deviceId: { exact: pick.deviceId } }); } catch (e) {
        if (e.name === 'NotAllowedError') throw e;
      }
    }
    if (stream) return stream;
    try {
      return await get({ facingMode: facing });
    } catch (e) {
      throw firstErr && e.name === 'OverconstrainedError' ? firstErr : e;
    }
  }

  // Runs one camera into a <video> and keeps the QR scanner fed with crops of
  // its frames. The receiver reads the data stream with one; in two-way mode
  // the sender reads the receiver's status code with another.
  function makeCamera(video, { onText, crops, scanMax }) {
    const cam = { running: false, gen: 0, stream: null, inFlight: 0, turn: 0, facing: 'environment', userFacing: false, deviceId: null, opts: {} };
    const grab = document.createElement('canvas');
    const gctx = grab.getContext('2d', { willReadFrequently: true });

    function stopTracks() {
      if (cam.stream) cam.stream.getTracks().forEach((t) => t.stop());
      cam.stream = null;
      video.srcObject = null;
    }
    // Resolves to null when running, or to a message saying why not.
    cam.open = async (opts = {}) => {
      cam.running = true;
      cam.opts = opts;
      const gen = ++cam.gen;
      stopTracks();
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        return window.isSecureContext
          ? 'This browser does not allow camera access.'
          : 'The camera only works when QR Beam is opened from its https:// link (or as a file on a computer).';
      }
      if (opts.facing) cam.facing = opts.facing;
      const size = { width: { ideal: opts.width || 1920 }, height: { ideal: opts.height || 1080 } };
      const get = (v) => navigator.mediaDevices.getUserMedia({ video: Object.assign(v, size), audio: false });
      let stream;
      try {
        stream = await openStream(get, opts.deviceId, cam.facing);
      } catch (e) {
        return gen === cam.gen ? cameraMessage(e) : 'stopped';
      }
      if (!cam.running || gen !== cam.gen) { stream.getTracks().forEach((t) => t.stop()); return 'stopped'; }
      cam.stream = stream;
      video.srcObject = stream;
      try { await video.play(); } catch (e) { /* muted video may autoplay */ }
      if (!video.videoWidth) await new Promise((r) => video.addEventListener('loadedmetadata', r, { once: true }));
      const track = stream.getVideoTracks()[0];
      const st = track.getSettings ? track.getSettings() : {};
      cam.deviceId = st.deviceId;
      cam.userFacing = st.facingMode === 'user' || (!st.facingMode && !isMobile);
      await getScanner();
      if (!cam.running || gen !== cam.gen) return 'stopped';
      loop(gen);
      return null;
    };
    cam.reopen = () => cam.open(cam.opts);
    cam.stop = () => { cam.running = false; cam.gen++; stopTracks(); };
    cam.ended = () => !cam.stream || cam.stream.getVideoTracks().every((t) => t.readyState === 'ended');

    // A crop may carry its own size limit (c.max): a locked-on code is read at
    // full resolution, unscaled, since resampling costs sharpness right where
    // the module edges need it.
    function grabCrop(c) {
      const big = Math.max(c.w, c.h);
      const k = c.scale ? Math.min(c.scale, 1600 / big) : Math.min(1, (c.max || scanMax) / big);
      const w = Math.max(16, Math.round(c.w * k)), h = Math.max(16, Math.round(c.h * k));
      if (grab.width !== w || grab.height !== h) { grab.width = w; grab.height = h; }
      gctx.drawImage(video, c.x, c.y, c.w, c.h, 0, 0, w, h);
      return gctx.getImageData(0, 0, w, h);
    }
    // crop is where src came from in the video (null when src is the video).
    function dispatch(src, gen, crop) {
      cam.inFlight++;
      const k = crop ? src.width / crop.w : 1; // read before the pixels move to a worker
      const done = (hits) => {
        cam.inFlight--;
        if (!cam.running || cam.gen !== gen) return;
        for (const h of hits) {
          const q = h.quad && crop ? h.quad.map((v, i) => v / k + (i % 2 ? crop.y : crop.x)) : h.quad;
          onText(h.text, q, h.ver);
        }
      };
      try { Promise.resolve(scanner.scan(src)).then(done, () => done([])); } catch (e) { done([]); }
    }
    function loop(gen) {
      const live = () => cam.running && cam.gen === gen;
      const next = () => {
        if (!live()) return;
        if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(onFrame);
        else requestAnimationFrame(onFrame);
      };
      function onFrame() {
        if (!live()) return;
        next();
        if (video.readyState < 2 || cam.inFlight >= scanner.slots) return;
        if (scanner.kind === 'native') { dispatch(video, gen); return; }
        for (const c of crops(video.videoWidth, video.videoHeight, cam.turn++)) {
          if (cam.inFlight >= scanner.slots) break;
          dispatch(grabCrop(c), gen, c);
        }
      }
      next();
    }
    return cam;
  }

  // ===================== send: choosing =====================
  const items = []; // { file, key, job, prepared }
  const fileInput = $('#file-input'), drop = $('#drop'), textBox = $('#send-text');
  const startBtn = $('#send-start'), estimate = $('#estimate');

  // Phone photos are 2-4 MB; a 2048 px JPEG looks the same on a screen at a
  // fraction of the size, which is the difference between minutes and seconds.
  const PHOTO = { large: { side: 2048, q: 0.85 }, small: { side: 1280, q: 0.8 } };
  function isPhoto(f) {
    return /^image\/(jpeg|png|webp|heic|heif|avif|bmp)$/i.test(f.type) || /\.(heic|heif|jpe?g|png|webp|avif)$/i.test(f.name);
  }
  async function shrinkImage(file, { side, q }) {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode(); // <img> honours EXIF rotation; also decodes HEIC on iPhone
      const w = img.naturalWidth, h = img.naturalHeight;
      const k = Math.min(1, side / Math.max(w, h));
      const cw = Math.max(1, Math.round(w * k)), ch = Math.max(1, Math.round(h * k));
      const c = document.createElement('canvas');
      c.width = cw; c.height = ch;
      c.getContext('2d').drawImage(img, 0, 0, cw, ch);
      let alpha = false;
      if (!/jpe?g|heic|heif/i.test(file.type + ' ' + file.name)) {
        const t = document.createElement('canvas');
        t.width = t.height = 48;
        const tc = t.getContext('2d', { willReadFrequently: true });
        tc.drawImage(c, 0, 0, 48, 48);
        const d = tc.getImageData(0, 0, 48, 48).data;
        for (let i = 3; i < d.length; i += 4) if (d[i] < 250) { alpha = true; break; }
      }
      const type = alpha ? 'image/png' : 'image/jpeg';
      const blob = await new Promise((res) => c.toBlob(res, type, q));
      if (!blob || blob.size >= file.size * 0.9) return null; // not worth it
      const base = file.name.replace(/\.[^.]+$/, '') || 'photo';
      return { name: base + (alpha ? '.png' : '.jpg'), type, data: new Uint8Array(await blob.arrayBuffer()) };
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  function prepareItem(item) {
    const mode = isPhoto(item.file) ? prefs.photoSize : 'original';
    if (item.key === mode) return;
    item.key = mode;
    item.prepared = null;
    item.job = null;
    if (mode === 'original') return;
    const job = shrinkImage(item.file, PHOTO[mode]).catch(() => null).then((out) => {
      if (item.job !== job) return;
      item.prepared = out;
      item.job = null;
      renderFiles();
    });
    item.job = job;
  }
  function itemSize(item) { return item.prepared ? item.prepared.data.length : item.file.size; }

  function addFiles(list) {
    for (const f of list) items.push({ file: f, key: null, job: null, prepared: null });
    renderFiles();
  }
  function renderFiles() {
    const ul = $('#file-list');
    ul.textContent = '';
    items.forEach((it, i) => {
      prepareItem(it);
      const li = document.createElement('li');
      const name = document.createElement('span'); name.className = 'name'; name.textContent = it.file.name;
      const size = document.createElement('span'); size.className = 'size';
      size.textContent = fmtBytes(it.file.size);
      if (it.job || it.prepared) {
        const to = document.createElement('span'); to.className = 'to';
        to.textContent = it.job ? ' → …' : ' → ' + fmtBytes(it.prepared.data.length);
        size.append(to);
      }
      const x = document.createElement('button'); x.className = 'x'; x.type = 'button'; x.textContent = '×';
      x.setAttribute('aria-label', 'Remove ' + it.file.name);
      x.onclick = () => { items.splice(i, 1); renderFiles(); };
      li.append(name, size, x);
      ul.append(li);
    });
    $('#photo-opts').hidden = !items.some((it) => isPhoto(it.file));
    updateEstimate();
  }
  function clearSendSetup() {
    items.length = 0;
    textBox.value = '';
    renderFiles();
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
  for (const r of document.querySelectorAll('input[name="codes"]')) {
    r.checked = +r.value === prefs.startCodes;
    r.addEventListener('change', () => { prefs.startCodes = +r.value; savePrefs(); updateEstimate(); });
  }
  for (const r of document.querySelectorAll('input[name="photo"]')) {
    r.checked = r.value === prefs.photoSize;
    r.addEventListener('change', () => { prefs.photoSize = r.value; savePrefs(); renderFiles(); });
  }
  const twoWayBox = $('#two-way');
  twoWayBox.checked = prefs.twoWay;
  twoWayBox.addEventListener('change', () => { prefs.twoWay = twoWayBox.checked; savePrefs(); });
  const fpsRange = $('#fps');
  fpsRange.value = prefs.fpsIdx;
  fpsRange.addEventListener('input', () => { prefs.fpsIdx = +fpsRange.value; savePrefs(); updateSpeed(); updateEstimate(); });

  function rawSize() {
    let n = new TextEncoder().encode(textBox.value).length + 8;
    for (const it of items) n += itemSize(it) + it.file.name.length + 32;
    return n;
  }
  function updateEstimate() {
    const has = items.length > 0 || textBox.value.length > 0;
    startBtn.disabled = !has;
    if (!has) { estimate.textContent = 'Nothing selected yet.'; return; }
    const size = rawSize();
    const B = Beam.blockSizeFor(prefs.density, size);
    const need = framesNeeded(Math.ceil(size / B));
    const fps = FPS_STEPS[prefs.fpsIdx], two = prefs.startCodes === 2;
    // two codes measured about 1.75x one code's speed (not 2x: the receiver misses a few more)
    const secs = need / (fps * (two ? 1.75 : 1) * 0.8);
    let html = `<b>${fmtBytes(size)}</b> is about <b>${need}</b> code${need === 1 ? '' : 's'}. ` +
      `At ${fps}/s${two ? ' with 2 codes' : ''} that takes roughly <b>${fmtTime(secs)}</b>, or less if it compresses.`;
    if (items.some((it) => it.job)) html += ' <br>Shrinking photos…';
    if (size > MAX_SEND) html += ' <br><b>Too big.</b> The limit is 64 MB, and even that would take hours.';
    else if (secs > 600) html += ' <br>That is a long time to hold a camera still. QR Beam suits text, links, photos and files up to a few MB.';
    estimate.innerHTML = html;
    if (size > MAX_SEND) startBtn.disabled = true;
  }

  startBtn.addEventListener('click', async () => {
    unlockAudio(); // for the "delivered" chime later
    startBtn.disabled = true;
    startBtn.textContent = 'Preparing…';
    try {
      await Promise.all(items.map((it) => it.job));
      const t = textBox.value;
      let item;
      if (!items.length) item = { text: t };
      else {
        const list = await Promise.all(items.map(async (it) => (it.prepared
          ? { name: it.prepared.name, type: it.prepared.type, data: it.prepared.data }
          : { name: it.file.name, type: it.file.type, data: new Uint8Array(await it.file.arrayBuffer()) })));
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
  const tinyA = document.createElement('canvas'), tinyB = document.createElement('canvas');
  const qrWrap = $('#qr-wrap');
  const LANE_GAP = 6; // extra modules between two codes, on top of their quiet zones
  let sender = null, linkTimer = 0;

  // In two-way mode the sender watches the receiver's status code with its
  // own front camera (the whole frame, since the code can be anywhere in it).
  const txCam = makeCamera($('#tx-video'), {
    scanMax: 960,
    crops: (vw, vh) => [{ x: 0, y: 0, w: vw, h: vh }],
    onText: onStatusText,
  });

  // One code or two side by side: starts from the Send screen's choice, and the
  // button under the code flips it for this transfer only.
  function lanesFor() {
    return sender ? sender.codes : prefs.startCodes;
  }
  function buildFrame() {
    const lanes = lanesFor();
    const flags = (lanes === 2 ? Beam.FLAG_LANES : 0) | (sender.listening ? Beam.FLAG_LISTEN : 0);
    const qrs = [];
    for (let i = 0; i < lanes; i++) {
      const qr = qrcode(0, 'L');
      qr.addData(sender.enc.frameText((sender.seed + i) >>> 0, flags), 'Alphanumeric');
      qr.make();
      qrs.push(qr);
    }
    sender.seed = (sender.seed + lanes) >>> 0;
    return qrs;
  }
  // Paint at 1 px per module, then scale up by a whole number so every module
  // is the same size on screen.
  function paintFrame(qrs) {
    const n = qrBitmap(qrs[0], tinyA, 4), N = n + 8, two = qrs.length === 2;
    if (two) qrBitmap(qrs[1], tinyB, 4);
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(64, qrWrap.clientWidth - 32) * dpr, H = Math.max(64, qrWrap.clientHeight - 16) * dpr;
    const across = two ? 2 * N + LANE_GAP : N;
    const s = Math.max(1, Math.floor(Math.min(W / across, H / N)));
    const pw = across * s, ph = N * s;
    if (qrCanvas.width !== pw || qrCanvas.height !== ph) {
      qrCanvas.width = pw; qrCanvas.height = ph;
      qrCanvas.style.width = pw / dpr + 'px';
      qrCanvas.style.height = ph / dpr + 'px';
    }
    qrCtx.imageSmoothingEnabled = false;
    qrCtx.fillStyle = '#ffffff';
    qrCtx.fillRect(0, 0, pw, ph);
    qrCtx.drawImage(tinyA, 0, 0, N * s, N * s);
    if (two) qrCtx.drawImage(tinyB, (N + LANE_GAP) * s, 0, N * s, N * s);
    return n;
  }

  function beginBeam(payload) {
    stopSending();
    const B = Beam.blockSizeFor(prefs.density, payload.length);
    const tid = crypto.getRandomValues(new Uint32Array(1))[0];
    sender = {
      enc: new Beam.Encoder(payload, B, tid),
      seed: 0, shown: 0, paused: false, nextAt: 0, modules: 0, raf: 0, lanes: 1, codes: prefs.startCodes,
      twoWay: prefs.twoWay, listening: false, auto: false, delivered: false, started: performance.now(),
      link: { state: 'off', last: 0, st: null, lastAdjust: 0, error: '' },
    };
    $('#view-sending').classList.remove('done');
    $('#delivered').hidden = true;
    show('sending');
    keepAwake(true);
    $('#pause').textContent = 'Pause';
    sender.next = buildFrame();
    updateSpeed();
    updateLanesBtn();
    $('#link').hidden = !sender.twoWay;
    $('#tx-meter i').style.width = '0%';
    if (sender.twoWay) startLink(sender);
    clearInterval(linkTimer);
    linkTimer = setInterval(renderLink, 300);
    sender.raf = requestAnimationFrame(tick);
  }
  function tick(now) {
    if (!sender) return;
    sender.raf = requestAnimationFrame(tick);
    if (sender.paused || now < sender.nextAt) return;
    const interval = 1000 / FPS_STEPS[prefs.fpsIdx];
    sender.nextAt = now - sender.nextAt > interval ? now + interval : sender.nextAt + interval;
    sender.modules = paintFrame(sender.next);
    sender.lanes = sender.next.length;
    sender.shown++;
    sender.next = buildFrame();
    if (sender.shown % 4 === 1) renderSendStats();
  }
  function renderSendStats() {
    if (!sender) return;
    const { enc, modules, lanes } = sender;
    const need = framesNeeded(enc.K);
    const perSec = FPS_STEPS[prefs.fpsIdx] * lanes;
    $('#send-stats').innerHTML =
      `<span>frame <b>${sender.shown}</b></span>` +
      `<span><b>${fmtBytes(enc.len)}</b> in ${enc.K} block${enc.K === 1 ? '' : 's'} of ${enc.B} B</span>` +
      `<span>QR version ${(modules - 17) / 4} · ${modules}×${modules}${lanes === 2 ? ' · 2 codes per frame' : ''}</span>` +
      (enc.K === 1
        ? '<span>fits in one frame, so it reads instantly</span>'
        : `<span>receiver needs ~${need} codes · ${fmtTime(need / perSec)} at best</span>`);
  }
  function updateSpeed() {
    const fps = FPS_STEPS[prefs.fpsIdx];
    const sv = $('#speed-val');
    const auto = !!(sender && sender.auto);
    sv.textContent = fps + '/s' + (auto ? ' auto' : '');
    sv.classList.toggle('auto', auto);
    $('#fps-label').textContent = fps + ' frames/s';
    fpsRange.value = prefs.fpsIdx;
    $('#slower').disabled = prefs.fpsIdx === 0;
    $('#faster').disabled = prefs.fpsIdx === FPS_STEPS.length - 1;
    renderSendStats();
  }
  function manualSpeed(step) {
    prefs.fpsIdx = Math.max(0, Math.min(FPS_STEPS.length - 1, prefs.fpsIdx + step));
    if (sender) sender.auto = false;
    savePrefs();
    updateSpeed();
  }
  $('#slower').onclick = () => manualSpeed(-1);
  $('#faster').onclick = () => manualSpeed(1);
  $('#speed-val').onclick = () => {
    if (!sender || !sender.listening) return;
    sender.auto = !sender.auto;
    updateSpeed();
  };
  function updateLanesBtn() {
    const n = lanesFor();
    $('#lanes').textContent = n === 2 ? '2 codes' : '1 code';
  }
  $('#lanes').onclick = () => {
    if (!sender) return;
    sender.codes = sender.codes === 2 ? 1 : 2;
    updateLanesBtn();
  };
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
    if (sender) updateLanesBtn();
  });

  // ----- two-way: the receiver's status code, seen through this camera -----
  async function startLink(s) {
    s.link.state = 'starting';
    renderLink();
    const err = await txCam.open({ facing: 'user', width: 1280, height: 720 });
    if (sender !== s || s.delivered) return;
    if (err) {
      s.link.state = 'error';
      s.link.error = err === 'stopped' ? 'the camera stopped.' : err;
      renderLink();
      return;
    }
    s.listening = true;
    s.auto = true;
    s.link.state = 'looking';
    updateSpeed();
    renderLink();
  }
  function onStatusText(text) {
    const s = sender;
    if (!s || s.delivered) return;
    const st = Beam.parseStatus(text);
    if (!st) return;
    const now = performance.now(), L = s.link;
    L.last = now;
    L.st = st;
    if (st.tid !== s.enc.tid) return; // receiver idle, or still on an earlier transfer
    if (st.done) { delivered(); return; }
    // Auto speed: the receiver's catch rate covers its last 3 s, so give each
    // change a little longer than that to show up before judging again.
    if (s.auto && st.caught != null && st.rate > 0 && now - L.lastAdjust > 3500) {
      let step = 0;
      if (st.caught >= 0.93 && prefs.fpsIdx < FPS_STEPS.length - 1) step = 1;
      else if (st.caught < 0.6 && prefs.fpsIdx > 0) step = -1;
      if (step) {
        prefs.fpsIdx += step;
        L.lastAdjust = now;
        savePrefs();
        updateSpeed();
      }
    }
  }
  function renderLink() {
    const s = sender;
    if (!s || !s.twoWay || s.delivered) return;
    const L = s.link, now = performance.now();
    let msg, pct = 0;
    if (L.state === 'starting') msg = 'Two-way: starting the camera…';
    else if (L.state === 'error') msg = 'One-way only. ' + L.error;
    else if (!L.st || now - L.last > 3000) {
      msg = L.st ? 'Lost sight of the receiver’s status code. Keep the screens facing each other.'
        : 'Two-way: looking for the receiver’s status code. Face the screens toward each other.';
    } else if (L.st.tid !== s.enc.tid) {
      msg = L.st.tid ? 'The receiver is still on an earlier transfer.'
        : 'The receiver is ready but can’t read this code yet. Aim the screens at each other.';
    } else {
      pct = L.st.K ? L.st.known / L.st.K : 0;
      msg = `Receiver has <b>${Math.floor(pct * 100)}%</b>` +
        (L.st.caught != null ? ` · catching ${Math.round(L.st.caught * 100)}% of codes` : '') +
        (L.st.rate ? ` · ${((L.st.rate * s.enc.B) / 1024).toFixed(1)} KB/s` : '');
    }
    $('#link-line').innerHTML = msg;
    $('#tx-meter i').style.width = (pct * 100).toFixed(1) + '%';
  }
  function delivered() {
    const s = sender;
    if (!s || s.delivered) return;
    s.delivered = true;
    const secs = (performance.now() - s.started) / 1000;
    cancelAnimationFrame(s.raf);
    s.raf = 0;
    txCam.stop();
    clearInterval(linkTimer);
    keepAwake(false);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    $('#view-sending').classList.add('done');
    $('#delivered').hidden = false;
    $('#delivered-sum').textContent = `The receiver confirmed all ${fmtBytes(s.enc.len)} after ${fmtTime(secs)}.`;
    chime();
    buzz();
  }
  function stopSending() {
    clearInterval(linkTimer);
    txCam.stop();
    if (!sender) return;
    cancelAnimationFrame(sender.raf);
    sender = null;
    keepAwake(false);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }
  $('#send-stop').onclick = () => { stopSending(); show('send-setup'); updateEstimate(); };
  $('#sent-home').onclick = () => { stopSending(); clearSendSetup(); goHome(); };
  $('#sent-more').onclick = () => { stopSending(); clearSendSetup(); show('send-setup'); };

  // ===================== receive =====================
  const video = $('#video'), cam = $('#cam');
  const statusCanvas = $('#status-qr'), statusTiny = document.createElement('canvas');
  let rx = null, statsTimer = 0;

  // ----- lock-on: remember where each code sits and follow it -----
  const tracks = []; // { q: latest corners, s: drawn corners, last, hit } in video pixels
  const TRACK_MS = 900; // a lock this long without a read is dropped
  const LOCK_MAX = 1100; // locked-on crops up to this size are read unscaled
  function quadCenter(q) { return [(q[0] + q[2] + q[4] + q[6]) / 4, (q[1] + q[3] + q[5] + q[7]) / 4]; }
  function quadDiag(q) { return Math.max(Math.hypot(q[4] - q[0], q[5] - q[1]), Math.hypot(q[6] - q[2], q[7] - q[3])); }
  function trackHit(q, ver) {
    if (!q || q.length !== 8 || !q.every(Number.isFinite)) return;
    const mods = ver ? 17 + 4 * ver : 0;
    const now = performance.now(), [cx, cy] = quadCenter(q);
    let best = null, bd = Infinity;
    for (const t of tracks) {
      const [tx, ty] = quadCenter(t.q), dist = Math.hypot(tx - cx, ty - cy);
      if (dist < bd) { bd = dist; best = t; }
    }
    // Two codes side by side sit about 0.8 diagonals apart, so 0.6 tells them apart.
    if (best && bd < quadDiag(q) * 0.6) {
      best.q = q; best.last = now; best.hit = now;
      if (mods) best.mods = mods;
      return;
    }
    if (tracks.length >= 2) { tracks.sort((a, b) => a.last - b.last); tracks.shift(); }
    tracks.push({ q, s: q.slice(), last: now, hit: now, mods });
  }
  function liveTracks(now) {
    for (let i = tracks.length - 1; i >= 0; i--) if (now - tracks[i].last > TRACK_MS) tracks.splice(i, 1);
    return tracks;
  }
  function quadBox(q) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < 8; i += 2) {
      x0 = Math.min(x0, q[i]); x1 = Math.max(x1, q[i]);
      y0 = Math.min(y0, q[i + 1]); y1 = Math.max(y1, q[i + 1]);
    }
    return { x0, y0, x1, y1 };
  }
  // A box around a locked code with room for a hand-held camera to drift.
  // Being tight is the point: the code keeps its full sharpness instead of
  // being shrunk along with the whole frame, and small crops decode faster.
  // With two codes side by side, each box stops halfway across the gap, or
  // the scanner sees pieces of both and reads neither.
  function cropAround(q, vw, vh, others, mods) {
    const b = quadBox(q);
    const side = Math.max(b.x1 - b.x0, b.y1 - b.y0) * 1.6;
    const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
    let x0 = Math.max(0, cx - side / 2), x1 = Math.min(vw, cx + side / 2);
    let y0 = Math.max(0, cy - side / 2), y1 = Math.min(vh, cy + side / 2);
    for (const o of others) {
      // split at the midpoint between the two centres, along whichever axis
      // separates them more (works for tilted codes whose outlines overlap)
      const [ox, oy] = quadCenter(o);
      if (Math.abs(ox - cx) >= Math.abs(oy - cy)) {
        if (ox > cx) x1 = Math.min(x1, (cx + ox) / 2); else x0 = Math.max(x0, (cx + ox) / 2);
      } else if (oy > cy) y1 = Math.min(y1, (cy + oy) / 2); else y0 = Math.max(y0, (cy + oy) / 2);
    }
    const w = x1 - x0, h = y1 - y0;
    // Keep big crops affordable, but blow small codes up: the scanner wants
    // about 5.5 px per module, and a far-off or small code can have under 4.
    let scale = Math.min(1, LOCK_MAX / Math.max(w, h));
    if (mods) {
      const ppm = Math.hypot(q[2] - q[0], q[3] - q[1]) / mods;
      if (ppm * scale < 5.5) scale = Math.min(2, 5.5 / ppm);
    }
    return { x: Math.round(x0), y: Math.round(y0), w: Math.round(w), h: Math.round(h), scale };
  }
  // The boxes to search in when nothing is locked yet.
  function searchBoxes(vw, vh) {
    const half = Math.min(vw / 2, vh) * 0.96;
    return rx && rx.lanes === 2
      ? [sq(vw / 4, vh / 2, half), sq((3 * vw) / 4, vh / 2, half)]
      : [sq(vw / 2, vh / 2, Math.min(vw, vh) * CROP)];
  }
  // Which parts of the camera frame to decode. Locked on: a tight box around
  // each code, plus a look at the whole view now and then. Not locked: take
  // turns between the middle, the halves and the whole view.
  function rxCrops(vw, vh, turn) {
    const full = { x: 0, y: 0, w: vw, h: vh };
    const half = Math.min(vw / 2, vh) * 0.96;
    const left = sq(vw / 4, vh / 2, half), right = sq((3 * vw) / 4, vh / 2, half);
    const live = liveTracks(performance.now());
    if (live.length) {
      const list = live.map((t) => cropAround(t.q, vw, vh, live.filter((o) => o !== t).map((o) => o.q), t.mods));
      if (turn % 2) list.reverse();
      const want = rx && rx.lanes === 2 ? 2 : 1;
      if (live.length < want) list.push([left, right, full][turn % 3]); // find the other code
      else if (turn % 10 === 9) list.push(full); // and notice if the layout changes
      return list;
    }
    const mid = sq(vw / 2, vh / 2, Math.min(vw, vh) * CROP);
    const order = rx && rx.lanes === 2 ? [left, right, full, mid] : [mid, full, mid, left, mid, right];
    const k = turn % order.length;
    return order.slice(k).concat(order.slice(0, k));
  }

  // The camera overlay: while searching, the box to aim at with a slow scan
  // line; once locked, corner brackets that sit on each code and tilt and
  // stretch with it.
  const overlay = $('#overlay'), octx = overlay.getContext('2d');
  let overlayRaf = 0;
  function overlayLoop() {
    cancelAnimationFrame(overlayRaf);
    const step = (now) => {
      if (!rx || !rx.running) { overlayRaf = 0; return; }
      overlayRaf = requestAnimationFrame(step);
      drawOverlay(now);
    };
    overlayRaf = requestAnimationFrame(step);
  }
  function drawOverlay(now) {
    const vw = video.videoWidth, vh = video.videoHeight, W = overlay.clientWidth, H = overlay.clientHeight;
    if (!vw || !vh || !W || !H) return;
    const dpr = window.devicePixelRatio || 1;
    if (overlay.width !== Math.round(W * dpr) || overlay.height !== Math.round(H * dpr)) {
      overlay.width = Math.round(W * dpr);
      overlay.height = Math.round(H * dpr);
    }
    const ctx = octx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const kx = W / vw, ky = H / vh, mirror = cam.classList.contains('mirror');
    const X = (x) => (mirror ? vw - x : x) * kx, Y = (y) => y * ky;
    const live = liveTracks(now);

    if (!live.length) {
      const boxes = searchBoxes(vw, vh).map((b) => ({ x: Math.min(X(b.x), X(b.x + b.w)), y: Y(b.y), w: b.w * kx, h: b.h * ky }));
      ctx.fillStyle = 'rgba(0, 0, 0, 0.28)';
      ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'destination-out';
      for (const b of boxes) { roundRect(ctx, b.x, b.y, b.w, b.h, 10); ctx.fill(); }
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
      ctx.lineWidth = 2;
      for (const b of boxes) { roundRect(ctx, b.x, b.y, b.w, b.h, 10); ctx.stroke(); }
      if (!reduceMotion.matches) {
        const p = 0.5 - 0.5 * Math.cos(((now % 2200) / 2200) * 2 * Math.PI);
        ctx.strokeStyle = colors.accent;
        ctx.globalAlpha = 0.55;
        ctx.lineWidth = 2;
        for (const b of boxes) {
          const y = b.y + 8 + (b.h - 16) * p;
          ctx.beginPath(); ctx.moveTo(b.x + 10, y); ctx.lineTo(b.x + b.w - 10, y); ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }
      return;
    }

    for (const t of live) {
      for (let i = 0; i < 8; i++) t.s[i] += (t.q[i] - t.s[i]) * 0.35; // glide, don't jump
      const [cx, cy] = quadCenter(t.s);
      const P = [];
      for (let i = 0; i < 8; i += 2) P.push([X(cx + (t.s[i] - cx) * 1.14), Y(cy + (t.s[i + 1] - cy) * 1.14)]);
      const fade = Math.max(0, Math.min(1, (TRACK_MS - (now - t.last)) / 300));
      const flash = Math.max(0, 1 - (now - t.hit) / 160);
      ctx.globalAlpha = 0.13 * fade;
      ctx.fillStyle = colors.accent;
      ctx.beginPath();
      P.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = fade;
      ctx.strokeStyle = colors.accent;
      ctx.lineWidth = 3.5 + flash * 1.5;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.shadowColor = colors.accent;
      ctx.shadowBlur = 6 + flash * 10;
      ctx.beginPath();
      for (let i = 0; i < 4; i++) {
        const a = P[i], prev = P[(i + 3) % 4], next = P[(i + 1) % 4];
        ctx.moveTo(a[0] + (prev[0] - a[0]) * 0.24, a[1] + (prev[1] - a[1]) * 0.24);
        ctx.lineTo(a[0], a[1]);
        ctx.lineTo(a[0] + (next[0] - a[0]) * 0.24, a[1] + (next[1] - a[1]) * 0.24);
      }
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
    }
  }
  const rxCam = makeCamera(video, { scanMax: SCAN_MAX, crops: rxCrops, onText: handleText });

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

  async function startReceiving() {
    unlockAudio(); // still inside the tap that got us here
    stopSending();
    stopReceiving();
    show('receiving');
    gridReset();
    $('#cam-error').hidden = true;
    $('#recv-retry').hidden = true;
    $('#meter').className = 'meter';
    $('#meter i').style.width = '0%';
    $('#recv-stats').innerHTML = '<span>waiting for the first frame</span>';
    $('#status-cap').textContent = 'Two-way: the sender reads this code to follow your progress and tune its speed.';
    $('#cam-tip').textContent = 'Point at the flashing code';
    tracks.length = 0;
    setHint('');
    rx = {
      running: true, decoder: null, recent: [], other: 0, started: 0, lastHit: 0,
      lanes: 1, listening: false, progress: 0, caught: null, rate: 0, lastStatus: '', devices: [],
    };
    renderStatus();
    keepAwake(true);
    clearInterval(statsTimer);
    statsTimer = setInterval(renderRecvStats, 250);
    overlayLoop();
    await openRxCamera();
  }
  async function openRxCamera(opts = {}) {
    if (!rx || !rx.running) return;
    $('#cam-error').hidden = true;
    $('#recv-retry').hidden = true;
    const err = await rxCam.open({ facing: opts.facing || prefs.rxFacing, deviceId: opts.deviceId });
    if (!rx || !rx.running) return;
    if (err) { if (err !== 'stopped') showCamError(err); return; }
    cam.classList.toggle('mirror', rxCam.userFacing);
    try {
      rx.devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    } catch (e) { rx.devices = []; }
    const flip = $('#flip-cam');
    flip.hidden = !isMobile || rx.devices.length < 2;
    flip.textContent = rxCam.userFacing ? 'Use back camera' : 'Use front camera (two-way)';
    $('#switch-cam').hidden = isMobile || rx.devices.length < 2;
    layoutGuide();
    renderStatus(true);
  }
  video.addEventListener('resize', layoutGuide);

  // Size the camera box to the video's shape; the overlay draws to match.
  function layoutGuide() {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return;
    cam.style.setProperty('--ar', vw + ' / ' + vh);
    cam.style.setProperty('--arn', String(vw / vh));
  }
  function camTip(now) {
    const n = liveTracks(now).length, two = !!rx && rx.lanes === 2;
    if (n) return two && n < 2 ? 'Locked on 1 of 2 codes' : 'Locked on';
    return two ? 'Fit both codes in view (turn the phone sideways)' : 'Point at the flashing code';
  }

  $('#flip-cam').onclick = () => {
    prefs.rxFacing = rxCam.userFacing ? 'environment' : 'user';
    savePrefs();
    openRxCamera({ facing: prefs.rxFacing });
  };
  $('#switch-cam').onclick = () => {
    const list = rx ? rx.devices : [];
    if (list.length < 2) return;
    const i = list.findIndex((d) => d.deviceId === rxCam.deviceId);
    openRxCamera({ deviceId: list[(i + 1) % list.length].deviceId });
  };

  function handleText(text, quad, ver) {
    if (!rx || !rx.running) return;
    const f = Beam.parseText(text);
    if (!f) {
      if (Beam.parseStatus(text)) return; // a receiver's status code, not for us
      rx.other++;
      const v = Beam.peekVersion(text);
      if (v && v !== Beam.VERSION) setHint('The other device has a different version of QR Beam. Reload the page on both devices.', 'warn');
      else if (!rx.decoder && rx.other >= 3) setHint('That is an ordinary QR code, not a QR Beam stream.', 'warn');
      return;
    }
    rx.lastHit = performance.now();
    trackHit(quad, ver);
    rx.listening = f.listening;
    rx.lanes = f.lanes;
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
    $('#cam-tip').textContent = camTip(now);
    const d = rx.decoder;
    if (d) {
      rx.recent = rx.recent.filter((r) => now - r.t < 3000);
      const win = rx.recent;
      let rate = 0, caught = null;
      if (win.length >= 3) {
        rate = win.length / Math.max(0.5, (now - win[0].t) / 1000);
        let lo = Infinity, hi = -Infinity;
        for (const r of win) { if (r.seed < lo) lo = r.seed; if (r.seed > hi) hi = r.seed; }
        caught = Math.min(1, win.length / (hi - lo + 1));
      }
      const need = framesNeeded(d.K);
      const p = Math.max(d.known / d.K, Math.min(0.99, d.received / need));
      rx.progress = p; rx.caught = caught; rx.rate = rate;
      $('#meter i').style.width = (p * 100).toFixed(1) + '%';
      const parts = [
        `<span><b>${Math.floor(p * 100)}%</b> of ${fmtBytes(d.len)}</span>`,
        `<span>${d.known} of ${d.K} piece${d.K === 1 ? '' : 's'}</span>`,
      ];
      if (rate) {
        parts.push(`<span>${((rate * d.B) / 1024).toFixed(1)} KB/s</span>`);
        parts.push(`<span>~${fmtTime(Math.max(0, need - d.received) / rate)} left</span>`);
      }
      if (caught != null) parts.push(`<span>catching ${Math.round(caught * 100)}% of codes</span>`);
      $('#recv-stats').innerHTML = parts.join('');
      if (now - rx.lastHit > 1500) setHint('Lost the code. Point the camera at the other screen.', 'warn');
      else if (caught != null && caught < 0.5) setHint('Missing many codes. Hold steady, move closer, or slow the sender down.', 'warn');
      else if (caught != null && caught > 0.95 && win.length > 12 && !rx.listening) setHint('Catching almost every code. The sender can go faster.', 'good');
      else if (caught != null) setHint('');
    }
    renderStatus();
  }

  // ----- two-way: our status code, for the sender's front camera -----
  // Shown while this camera faces the user (a laptop webcam, or a phone's
  // front camera), so this screen faces the sender too; hidden again if the
  // frames say the sender isn't watching.
  function statusWanted() {
    return !!rx && rxCam.userFacing && (!rx.decoder || rx.listening);
  }
  function renderStatus(force) {
    const want = statusWanted();
    $('#status').hidden = !want;
    $('#view-receiving').classList.toggle('twoway', want);
    if (!want) return;
    const d = rx.decoder;
    const text = Beam.statusText(d
      ? { done: d.done, tid: d.tid, known: d.done ? d.K : Math.floor(rx.progress * d.K), K: d.K, caught: rx.caught, rate: rx.rate }
      : { tid: 0, known: 0, K: 0, caught: null, rate: 0 });
    if (text === rx.lastStatus && !force) return;
    rx.lastStatus = text;
    const qr = qrcode(0, 'L');
    qr.addData(text, 'Alphanumeric');
    qr.make();
    const n = qrBitmap(qr, statusTiny, 4), N = n + 8;
    const dpr = window.devicePixelRatio || 1;
    const room = Math.min(isMobile ? 360 : 300, ($('#status').clientWidth || 300) - 28);
    const px = N * Math.max(1, Math.floor((room * dpr) / N));
    if (statusCanvas.width !== px) {
      statusCanvas.width = statusCanvas.height = px;
      statusCanvas.style.width = statusCanvas.style.height = px / dpr + 'px';
    }
    const c = statusCanvas.getContext('2d');
    c.imageSmoothingEnabled = false;
    c.drawImage(statusTiny, 0, 0, px, px);
  }

  function stopReceiving() {
    if (!rx) return;
    rx.running = false;
    cancelAnimationFrame(overlayRaf);
    overlayRaf = 0;
    rxCam.stop();
    clearInterval(statsTimer);
    keepAwake(false);
  }

  async function finishReceive() {
    const d = rx.decoder;
    const secs = (performance.now() - rx.started) / 1000;
    const twoWay = statusWanted();
    stopReceiving();
    rx.progress = 1;
    if (twoWay) {
      renderStatus(true); // now says "done", so the sender can stop
      $('#status-cap').textContent = 'Done! Letting the sender know…';
    }
    $('#meter').className = 'meter done';
    $('#meter i').style.width = '100%';
    let item;
    try {
      item = await Beam.unpack(d.payload());
    } catch (e) {
      showCamError('Everything arrived but it failed its integrity check (' + e.message + '). Tap Try again to receive it again.');
      return;
    }
    // Let the grid turn green (and the sender see "done") before switching screens.
    grid.done = true;
    grid.dirty = true;
    gridKick();
    chime();
    buzz();
    renderReceived(item, d, secs);
    setTimeout(() => { if (view === 'receiving') show('received'); }, twoWay ? 2500 : 800);
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

  // ===================== "Made by" badge =====================
  const CREDIT_URL = 'https://github.com/SNAPPERJAKE';
  const creditPop = $('#credit-pop'), creditBtn = $('#credit-btn');
  $('#credit-link').href = CREDIT_URL;
  function setCredit(open) {
    creditPop.hidden = !open;
    creditBtn.setAttribute('aria-expanded', String(open));
    if (!open || creditPop.dataset.drawn) return;
    paintQR($('#credit-qr'), CREDIT_URL, 180, 3);
    creditPop.dataset.drawn = '1';
  }
  creditBtn.onclick = () => setCredit(creditPop.hidden);
  $('#credit-x').onclick = () => setCredit(false);
  document.addEventListener('click', (e) => { if (!creditPop.hidden && !$('#credit').contains(e.target)) setCredit(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !creditPop.hidden) setCredit(false); });

  // ===================== home: "?" help and look and sound =====================
  // The card sits under the home animation. Everything dims except the
  // monitor, and an arrow runs from the card's Scan part to it: that moving
  // code is the one to scan. With no room under the animation (a phone on its
  // side) the card centres and the whole page dims instead.
  const help = $('#help'), helpCard = $('#help-card'), helpHole = $('#help-hole');
  const lookPop = $('#look-pop'), lookBtn = $('#look-btn');
  const pt = (p) => Math.round(p[0]) + ',' + Math.round(p[1]);
  function layoutHelp() {
    if (!help.open) return;
    const vw = window.innerWidth, vh = window.innerHeight;
    let M = null; // the monitor, bezel and stand, with a margin
    if (heroLayout()) {
      const r = hero.getBoundingClientRect(), S = hs.L.screen;
      M = { x: r.left + S.x - 8, y: r.top + S.y - 8, w: S.w + 16, h: S.h + 19 + 16 };
    }
    // Arrow out of the card's left side when there's room for its loop, else straight up.
    const side = (vw - helpCard.offsetWidth) / 2 >= 150;
    const top = M ? M.y + M.h + (side ? 24 : 48) : 0;
    const room = vh - top - 12;
    const spot = M && M.y >= 0 && room >= 240;
    help.classList.toggle('no-spot', !spot);
    if (!spot) { helpCard.style.top = helpCard.style.maxHeight = ''; return; }
    helpCard.style.top = top + 'px';
    helpCard.style.maxHeight = room + 'px';
    Object.assign(helpHole.style, { left: M.x + 'px', top: M.y + 'px', width: M.w + 'px', height: M.h + 'px' });

    const card = helpCard.getBoundingClientRect(), scan = $('#help-scan').getBoundingClientRect();
    let a, b, c1, c2;
    if (side) {
      a = [card.left - 8, scan.top + scan.height * 0.4];
      b = [M.x - 8, M.y + M.h * 0.42];
      c1 = [a[0] - 120, a[1]]; c2 = [b[0] - 120, b[1]];
    } else {
      a = [scan.left + scan.width / 2, card.top - 8];
      b = [M.x + M.w / 2, M.y + M.h + 6];
      const k = (a[1] - b[1]) * 0.5;
      c1 = [a[0], a[1] - k]; c2 = [b[0], b[1] + k];
    }
    $('#help-line').setAttribute('d', `M${pt(a)} C${pt(c1)} ${pt(c2)} ${pt(b)}`);
    const t = Math.atan2(b[1] - c2[1], b[0] - c2[0]), L = 13;
    const wing = (d) => [b[0] + Math.cos(t + d) * L, b[1] + Math.sin(t + d) * L];
    $('#help-head').setAttribute('d', `M${pt(wing(2.6))} L${pt(b)} L${pt(wing(-2.6))}`);
  }
  $('#help-btn').onclick = () => {
    setLook(false);
    window.scrollTo(0, 0); // the monitor has to be on screen to point at it
    document.documentElement.style.overflow = 'hidden';
    if (help.showModal) help.showModal(); else help.setAttribute('open', '');
    layoutHelp();
  };
  function closeHelp() { if (help.close) help.close(); else help.removeAttribute('open'); }
  help.addEventListener('close', () => { document.documentElement.style.overflow = ''; });
  $('#help-x').onclick = closeHelp;
  // the dialog itself is the dimmed layer, so a click that lands on it is outside the card
  help.addEventListener('click', (e) => { if (e.target === help) closeHelp(); });
  window.addEventListener('resize', layoutHelp);
  window.addEventListener('scroll', layoutHelp, { passive: true });

  function setLook(open) {
    lookPop.hidden = !open;
    lookBtn.setAttribute('aria-expanded', String(open));
  }
  lookBtn.onclick = () => setLook(lookPop.hidden);
  $('#look-x').onclick = () => setLook(false);
  document.addEventListener('click', (e) => { if (!lookPop.hidden && !$('#home-bar').contains(e.target)) setLook(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !lookPop.hidden) setLook(false); });

  // ===================== navigation =====================
  function goHome() {
    stopSending();
    stopReceiving();
    show('home');
  }
  $('#home-link').onclick = goHome;
  $('#go-send').onclick = () => { show('send-setup'); updateSpeed(); updateEstimate(); };
  $('#go-receive').onclick = () => startReceiving();
  $('#send-back').onclick = goHome;
  $('#recv-stop').onclick = goHome;
  $('#recv-retry').onclick = () => startReceiving();
  $('#got-home').onclick = goHome;
  $('#got-again').onclick = () => startReceiving();

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
    rxCam, txCam, beginBeam, startReceiving, goHome,
  };
})();
