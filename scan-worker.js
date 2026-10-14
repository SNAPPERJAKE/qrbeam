// Decodes camera frames off the main thread. app.js keeps a few of these busy.
// Sends back the text and the code's four corners, which the receiver uses to
// lock on to where the code is.
importScripts('vendor/jsQR.js');
onmessage = (e) => {
  const { id, w, h, buf } = e.data;
  const r = jsQR(new Uint8ClampedArray(buf), w, h, { inversionAttempts: 'dontInvert' });
  const l = r && r.location;
  postMessage({
    id,
    text: r ? r.data : null,
    ver: r ? r.version : 0,
    quad: l ? [l.topLeftCorner.x, l.topLeftCorner.y, l.topRightCorner.x, l.topRightCorner.y,
      l.bottomRightCorner.x, l.bottomRightCorner.y, l.bottomLeftCorner.x, l.bottomLeftCorner.y] : null,
  });
};
postMessage({ ready: true });
