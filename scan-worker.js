// Decodes camera frames off the main thread. app.js keeps a few of these busy.
importScripts('vendor/jsQR.js');
onmessage = (e) => {
  const { id, w, h, buf } = e.data;
  const r = jsQR(new Uint8ClampedArray(buf), w, h, { inversionAttempts: 'dontInvert' });
  postMessage({ id, text: r ? r.data : null });
};
postMessage({ ready: true });
