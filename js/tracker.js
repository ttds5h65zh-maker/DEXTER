// Hand tracking with MediaPipe Tasks Vision HandLandmarker.
// Everything (WASM runtime + model) is self-hosted in this repo, so no
// third-party CDN is contacted. Runs fully on the device.

import { FilesetResolver, HandLandmarker } from '../vendor/mediapipe/vision_bundle.mjs';

const WASM_PATH = new URL('../vendor/mediapipe/wasm', import.meta.url).href;
const MODEL_PATH = new URL('../models/hand_landmarker.task', import.meta.url).href;

const OPTIONS = {
  runningMode: 'VIDEO',
  numHands: 1,
  minHandDetectionConfidence: 0.5,
  minHandPresenceConfidence: 0.5,
  minTrackingConfidence: 0.5,
};

let landmarker = null;
let loading = null;
export let delegateUsed = null;

/** Starts loading once; later calls return the same promise. */
export function loadTracker() {
  if (loading) return loading;
  loading = (async () => {
    const fileset = await FilesetResolver.forVisionTasks(WASM_PATH);
    // Fetch the model once ourselves so a GPU failure doesn't download it twice.
    const modelBuffer = new Uint8Array(await (await fetch(MODEL_PATH)).arrayBuffer());

    // Try the GPU first (fast on phones), fall back to CPU if WebGL isn't usable.
    for (const delegate of ['GPU', 'CPU']) {
      try {
        landmarker = await HandLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetBuffer: modelBuffer, delegate },
          ...OPTIONS,
        });
        delegateUsed = delegate;
        console.info(`[Perlée] hand tracking ready (${delegate})`);
        return landmarker;
      } catch (err) {
        console.warn(`[Perlée] ${delegate} delegate failed`, err);
      }
    }
    throw new Error('Hand tracking could not start on this device.');
  })();
  // Allow a retry if loading failed (e.g. flaky network on first visit).
  loading.catch(() => { loading = null; });
  return loading;
}

let lastTimestamp = -1;

/**
 * Runs detection on the current video frame.
 * Returns the 21 normalized landmarks of one hand, or null if no hand is found.
 */
export function detect(video, nowMs) {
  if (!landmarker) return null;
  // VIDEO mode requires strictly increasing timestamps.
  const ts = Math.max(nowMs, lastTimestamp + 1);
  lastTimestamp = ts;
  const result = landmarker.detectForVideo(video, ts);
  return result.landmarks && result.landmarks.length ? result.landmarks[0] : null;
}
