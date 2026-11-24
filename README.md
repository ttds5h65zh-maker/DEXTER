# Perlée en lumière: live virtual try-on (concept prototype)

A mobile web app that puts an original golden-bead ring and bangle on your hand in real time, using the phone camera.
It was built for the Meridian Digital Team's "Perlée en lumière" campaign proposal.
**This is not an official Van Cleef & Arpels experience.** The jewellery is an original 3D design inspired by golden beads.

- Static site: HTML, CSS and JS modules. No build step, no backend.
- Hand tracking: MediaPipe Tasks Vision `HandLandmarker` 1.2.3 (VIDEO mode, GPU with CPU fallback, one hand).
- Rendering: Three.js 0.187.0 with an orthographic camera aligned to the cover-fitted video, PBR gold lit by `RoomEnvironment`, and depth-only occluders that hide the back of each band.
- Privacy: everything runs on the phone. There are no analytics and no cookies, and the page makes no requests to other sites. All libraries, the model and the fonts are hosted in this repo. The camera stops when you leave the try-on or hide the tab.

## Run it locally (laptop webcam)

Browsers only allow the camera on `https://` or `http://localhost`, so use a local server (opening the file directly won't work):

```bash
cd DEXTER
python3 -m http.server 8000
```

Then open <http://localhost:8000> in Chrome or Safari and tap **Start try-on**.
Add `?debug` to the address (<http://localhost:8000/?debug>) to show an FPS counter.

## Tuning the fit

All placement and size factors sit at the top of [`js/overlay.js`](js/overlay.js) in `TUNING`:

| Constant | What it does |
|---|---|
| `RING_POSITION` | 0 = at the knuckle, 1 = at the first joint (default 0.40) |
| `FINGER_WIDTH` | finger diameter per finger, as a fraction of knuckle width |
| `RING_FIT` | ring inner radius ÷ finger radius |
| `BRACELET_POSITION`, `BRACELET_RADIUS` | where the bangle sits behind the wrist, and its size |
| `SMOOTH_MIN_CUTOFF`, `SMOOTH_BETA` | One Euro filter: steadiness vs. lag |

With `?debug`, you can also change them live from the browser console, e.g. `perlee.TUNING.RING_POSITION = 0.5`.

## Files

```
index.html             screens + import map
css/style.css          theme
js/app.js              screens, camera, controls, frame loop
js/tracker.js          MediaPipe HandLandmarker (GPU → CPU fallback)
js/overlay.js          video↔screen mapping, ring/bangle placement, occluders (TUNING constants)
js/jewellery.js        original ring + bangle models, metals
js/oneEuro.js          One Euro filter
js/browse.js           "Browse without camera" turntable
vendor/                three.js (MIT), MediaPipe tasks-vision + WASM (Apache-2.0)
models/                hand_landmarker.task (Apache-2.0, Google MediaPipe)
fonts/                 Cormorant Garamond, Jost (SIL Open Font License)
qr/                    qr.png (1200 px) and qr.svg for the slide
tools/make_qr.py       regenerates the QR code for a given URL
```

## Regenerate the QR code

```bash
python3 -m venv .venv && .venv/bin/pip install segno pillow
.venv/bin/python tools/make_qr.py https://YOUR-USER.github.io/YOUR-REPO/
```
