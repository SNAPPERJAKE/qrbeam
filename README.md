# QR Beam

Send files and text between a phone and a computer with nothing connecting them:
one screen flashes a stream of QR codes and the other device reads them with its camera.
No Wi-Fi, Bluetooth, pairing, account or server is involved in the transfer.

**Open it: https://snapperjake.github.io/qrbeam/**

## Use it

1. Open QR Beam on both devices.
2. On the sending device: **Send**, pick files and/or type text, **Start beaming**.
3. On the receiving device: **Receive** and fill the on-screen box with the flashing code.
   Missed frames don't matter. It finishes on its own and shows Save / Share / Copy.

On the receiver, a grid shows one square per piece of the file, lit as each piece arrives;
it chimes (and buzzes, where the phone allows) when the file is complete. The home screen's
animated code is the link to the site itself: it keeps changing pattern, but any phone camera
pointed at it opens QR Beam.
Color, light/dark theme and the chime are under **Look and sound** on the home screen.

**Lock-on:** the receiver no longer needs the code centred or filling a box. It searches the whole
camera view, and once it reads a code it scans only a tight box around it at full resolution
(enlarged up to 2x for small or distant codes, which need about 5.5 camera pixels per QR module).
Orange corner brackets snap onto each code and tilt and stretch with it.

**Photos** are shrunk before sending (Large = 2048 px, Small = 1280 px, or Original): a 3 MB phone
photo becomes a few hundred KB, which is the difference between minutes and seconds.

**Two codes at once:** on a wide screen the sender shows two codes side by side and the receiver
reads both every frame (about 1.75x faster in testing). Toggle with the 1 code / 2 codes button.

**Two-way:** with the screens facing each other, each device uses its front camera. The receiver
shows a small status code; the sender reads it to show the receiver's progress, speeds itself up
or down from the receiver's catch rate, and stops with "Delivered" once everything has arrived.
- PC sends to iPhone: on the iPhone tap Receive, then **Use front camera (two-way)**, and hold the
  phone with its screen toward the monitor.
- iPhone sends to PC: Send with Two-way on and hold the phone's screen toward the webcam. The PC's
  receive screen shows its status code automatically.

Tips
- Laptop webcam reading a phone screen: use **Easy** density and turn the phone brightness up.
- Phone camera reading a monitor: **Dense** or **Max**, and raise the speed until the receiver
  says it is missing frames.
- The receiver shows how many frames it is catching and tells you when the sender can go faster.

Rough speeds (simulated camera, 10-20% dropped frames): Normal at 12 fps is about 6 KB/s,
Dense at 15 fps about 13 KB/s, Max at 20 fps about 28 KB/s. Text and links usually fit in a
single frame. Good for notes, links, documents and photos; not for videos.

## Where the page has to live

Browsers only allow camera access on `https://` pages (or local files on a computer). So:
- **Phone (iPhone Safari):** open https://snapperjake.github.io/qrbeam/ once, then Share > Add to Home Screen.
  The service worker caches everything, so after that it opens and works in airplane mode.
- **Computer:** open the hosted link, or double-click `index.html` (Chrome/Edge) to run it from disk.

## How it works

- `beam.js`: the codec, with no DOM so it also runs under Node.
  - Payload: files/text packed together, then deflate-compressed when that helps.
  - Cut into fixed-size blocks. Even frames carry one block as-is, walking through the file;
    odd frames carry the XOR of a seeded random set of blocks (a fountain code: coin-flip rows for
    up to 100 blocks, otherwise a robust-soliton degree spread 3x, tuned for the half that
    arrives plain). The receiver can join at any time and miss any frames, sees pieces land from
    the first frame, and needs about 3-7% more frames than there are blocks.
  - Decoder: peeling plus Gaussian elimination over GF(2) when peeling stalls.
  - Each frame is base45 text (RFC 9285) in QR alphanumeric mode: 97% efficient, versus 75% for
    base64, and it survives readers that only return text. A CRC32 checks the reassembled payload.
- `app.js`: page logic. The sender paints each QR with every module the same whole-pixel size.
  The receiver uses the native `BarcodeDetector` where it exists (Android/macOS Chrome); otherwise
  it runs jsQR in up to 3 Web Workers (iPhone, Windows), or on the main thread when opened from disk.
- `scan-worker.js`, `sw.js` (offline cache), `manifest.webmanifest` + icons (home-screen app).
- `vendor/`: qrcode-generator 1.4.4 (MIT) and jsQR 1.4.0 (Apache-2.0), unmodified.

## Tests

- `test/duo.html`: two copies of the app side by side, each one's camera fed by the other's
  screen, for the full two-way loop: `await duo.run({ size: 60000, lanes: 2 })`.
- `node test/core.test.js`: base45/CRC/packing, exact recovery under 40% loss, and a table
  of frames needed per block count.
- `test/loopback.js`: in-browser end-to-end run. Serve the folder over http, open the page,
  then in the console: `(await import('./test/loopback.js')).realTiming(); await runLoop({ size: 40000 })`.
  It fakes the camera with a tilted, blurred, lossy QR stream and checks the received bytes.
