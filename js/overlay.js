// The 3D try-on layer: a transparent Three.js canvas laid exactly over the video.
//
// How alignment works: the <video> fills the screen with object-fit: cover, so it
// is scaled by s = max(W / videoW, H / videoH) and centred (the overflow is cropped).
// We apply the very same maths to every landmark, then use an orthographic camera
// whose units are CSS pixels. 1 world unit = 1 screen pixel, so the 3D jewellery
// lands exactly on the finger in portrait, landscape, and with either camera.

import * as THREE from 'three';
import { createRing, createBangle, makeEnvironment } from './jewellery.js';
import { LandmarkSmoother } from './oneEuro.js';

// ============================================================================
// TUNABLE CONSTANTS: adjust these to change how the jewellery sits on the hand.
// "Hand scale" = knuckle width (index knuckle to little-finger knuckle, in 3D),
// which is about 6.5 cm on an adult hand. Sizes below are fractions of it.
// ============================================================================
export const TUNING = {
  RING_POSITION: 0.40,      // 0 = at the knuckle (MCP), 1 = at the first joint (PIP)
  FINGER_WIDTH: {           // finger diameter as a fraction of hand scale
    index: 0.27,
    middle: 0.275,
    ring: 0.26,
    little: 0.22,
  },
  RING_FIT: 1.04,           // ring inner radius ÷ finger radius (a little room)
  FINGER_OCCLUDER_FIT: 0.97, // invisible finger cylinder radius ÷ finger radius
  FINGER_OCCLUDER_RANGE: [-0.5, 1.15], // cylinder extent along the finger, in MCP→PIP lengths
  OCCLUDE_ALL_FINGERS: true, // hide ring parts that pass behind neighbouring fingers too
  Z_SCALE: 1.0,             // how much MediaPipe depth (z) tilts the pieces towards the camera
  HAND_LENGTH_TO_SCALE: 0.68, // wrist→middle knuckle length × this ≈ knuckle width (used when the hand is edge-on)

  BRACELET_POSITION: 0.22,  // how far the bangle sits behind the wrist landmark, in hand lengths
  BRACELET_RADIUS: 0.49,    // bangle inner radius as a fraction of hand scale
  BRACELET_OVAL: 0.84,      // bangle depth ÷ width (slightly oval, like a real wrist)
  WRIST_HALF_WIDTH: 0.43,   // invisible wrist occluder, fractions of hand scale
  WRIST_HALF_DEPTH: 0.30,

  FADE_MS: 380,             // fade-in time when the hand (re)appears
  SMOOTH_MIN_CUTOFF: 1.6,   // One Euro filter: lower = steadier, more lag
  SMOOTH_BETA: 0.006,       // One Euro filter: higher = less lag on fast moves
};

// MediaPipe landmark indices: [knuckle (MCP), first joint (PIP)] for each finger.
export const FINGERS = {
  index: [5, 6],
  middle: [9, 10],
  ring: [13, 14],
  little: [17, 18],
};
const WRIST = 0;
const MIDDLE_MCP = 9;

// Scratch objects reused every frame (avoids garbage collection hiccups).
const v = () => new THREE.Vector3();
const tmpA = v(), tmpB = v(), tmpC = v(), tmpX = v(), tmpY = v(), tmpZ = v();
const tmpM = new THREE.Matrix4();

const toV = (p, out = new THREE.Vector3()) => out.set(p.x, p.y, p.z);

export class Overlay {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.15;

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 8000);
    this.camera.position.set(0, 0, 4000);

    this.smoother = new LandmarkSmoother(21, TUNING.SMOOTH_MIN_CUTOFF, TUNING.SMOOTH_BETA);
    this.layoutKey = '';
    this.handVisible = false;
    this.lastMs = performance.now();

    this.selection = { piece: 'ring', fingers: new Set(['ring']), metal: 'yellow' };

    // --- Invisible "depth only" material: writes depth, draws no colour. -----
    // Anything of the jewellery behind these shapes (the back of a band, the far
    // side of the bangle) fails the depth test and disappears, so it looks worn.
    const occluderMat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: true });
    const cylinder = new THREE.CylinderGeometry(1, 1, 1, 28, 1, false);
    const makeOccluder = () => {
      const m = new THREE.Mesh(cylinder, occluderMat);
      m.renderOrder = -1; // render before everything else
      m.visible = false;
      this.scene.add(m);
      return m;
    };

    // One ring + one finger occluder per finger.
    this.rings = {};
    for (const name of Object.keys(FINGERS)) {
      const piece = createRing('yellow');
      piece.alpha = 0;
      piece.setOpacity(0);
      this.scene.add(piece.group);
      this.rings[name] = { piece, occluder: makeOccluder() };
    }
    this.bangle = createBangle('yellow');
    this.bangle.alpha = 0;
    this.bangle.setOpacity(0);
    this.scene.add(this.bangle.group);
    this.wristOccluder = makeOccluder();
  }

  async init() {
    this.scene.environment = await makeEnvironment(this.renderer);
    this.scene.environmentIntensity = 1.25;
  }

  setSelection({ piece, fingers, metal }) {
    if (piece) this.selection.piece = piece;
    if (fingers) this.selection.fingers = new Set(fingers);
    if (metal && metal !== this.selection.metal) {
      this.selection.metal = metal;
      Object.values(this.rings).forEach((r) => r.piece.setMetal(metal));
      this.bangle.setMetal(metal);
    }
  }

  /** Recomputes the video→screen mapping. Cheap; called every frame. */
  layout(video, mirror) {
    const W = this.canvas.clientWidth || window.innerWidth;
    const H = this.canvas.clientHeight || window.innerHeight;
    const vw = video.videoWidth || W;
    const vh = video.videoHeight || H;
    const key = `${W}x${H}:${vw}x${vh}:${mirror}`;
    if (key !== this.layoutKey) {
      // Screen rotated, window resized or camera switched: rebuild the mapping
      // and forget smoothed positions (they were in the old coordinates).
      this.layoutKey = key;
      this.renderer.setSize(W, H, false);
      Object.assign(this.camera, { left: -W / 2, right: W / 2, top: H / 2, bottom: -H / 2 });
      this.camera.updateProjectionMatrix();
      this.smoother.reset();
    }
    const s = Math.max(W / vw, H / vh); // object-fit: cover
    const dw = vw * s;
    const dh = vh * s;
    this.map = { W, H, dw, dh, ox: (W - dw) / 2, oy: (H - dh) / 2, mirror };
  }

  /** Normalized MediaPipe landmark → world point (pixels, origin at screen centre, y up). */
  toWorld(lm) {
    const { W, H, dw, dh, ox, oy, mirror } = this.map;
    let x = ox + lm.x * dw;
    if (mirror) x = W - x; // the front camera video is mirrored with CSS
    const y = oy + lm.y * dh;
    return { x: x - W / 2, y: H / 2 - y, z: -lm.z * dw * TUNING.Z_SCALE };
  }

  /**
   * Builds a rotation whose Y axis follows `axis` and whose Z axis leans towards
   * `normalHint` (the palm normal), so pieces turn naturally with the hand.
   */
  basis(axis, normalHint, outQuat) {
    tmpY.copy(axis).normalize();
    tmpZ.copy(normalHint).addScaledVector(tmpY, -normalHint.dot(tmpY));
    if (tmpZ.lengthSq() < 1e-6) tmpZ.set(0, 0, 1).addScaledVector(tmpY, -tmpY.z);
    tmpZ.normalize();
    tmpX.crossVectors(tmpY, tmpZ).normalize();
    tmpM.makeBasis(tmpX, tmpY, tmpZ);
    return outQuat.setFromRotationMatrix(tmpM);
  }

  /**
   * Called once per video frame with MediaPipe landmarks (or null when no hand).
   */
  update(landmarks, video, mirror, nowMs) {
    const dt = Math.min(nowMs - this.lastMs, 100);
    this.lastMs = nowMs;
    this.layout(video, mirror);

    if (!landmarks) {
      // Tracking lost: hide everything instantly.
      if (this.handVisible) this.smoother.reset();
      this.handVisible = false;
      this.hideAll();
      return;
    }
    this.handVisible = true;

    const pts = this.smoother.apply(landmarks.map((lm) => this.toWorld(lm)), nowMs / 1000);
    const P = pts.map((p) => toV(p));

    // Hand scale = knuckle width, but never less than what the hand length implies
    // (when the hand is turned edge-on the knuckle width shrinks on screen).
    const handLen = P[WRIST].distanceTo(P[MIDDLE_MCP]);
    const scale = Math.max(P[5].distanceTo(P[17]), handLen * TUNING.HAND_LENGTH_TO_SCALE);

    // Palm normal (direction the back/front of the hand faces).
    const palmNormal = v().crossVectors(tmpA.subVectors(P[5], P[WRIST]), tmpB.subVectors(P[17], P[WRIST]));

    const showRings = this.selection.piece !== 'bracelet';
    const showBangle = this.selection.piece !== 'ring';
    const fadeStep = dt / TUNING.FADE_MS;

    // ---- Rings ------------------------------------------------------------
    for (const [name, [mcp, pip]] of Object.entries(FINGERS)) {
      const { piece, occluder } = this.rings[name];
      const wanted = showRings && this.selection.fingers.has(name);

      const seg = tmpC.subVectors(P[pip], P[mcp]);
      const segLen = seg.length();
      const fingerR = (scale * TUNING.FINGER_WIDTH[name]) / 2;
      const q = piece.group.quaternion;
      this.basis(seg, palmNormal, q);

      // Ring: 40% of the way from knuckle to first joint, sized to the finger.
      piece.group.position.copy(P[mcp]).addScaledVector(seg, TUNING.RING_POSITION);
      piece.group.scale.setScalar(fingerR * TUNING.RING_FIT);

      // Finger occluder: a cylinder along the finger segment.
      const [a, b] = TUNING.FINGER_OCCLUDER_RANGE;
      occluder.visible = wanted || (showRings && TUNING.OCCLUDE_ALL_FINGERS && this.selection.fingers.size > 0);
      occluder.position.copy(P[mcp]).addScaledVector(seg, (a + b) / 2);
      occluder.quaternion.copy(q);
      const r = fingerR * TUNING.FINGER_OCCLUDER_FIT;
      occluder.scale.set(r, Math.max(segLen * (b - a), 1), r);

      piece.alpha = wanted ? Math.min(1, piece.alpha + fadeStep) : 0;
      piece.setOpacity(easeOut(piece.alpha));
    }

    // ---- Bangle -------------------------------------------------------------
    const dir = tmpC.subVectors(P[MIDDLE_MCP], P[WRIST]).normalize();
    const bq = this.bangle.group.quaternion;
    this.basis(dir, palmNormal, bq);
    this.bangle.group.position.copy(P[WRIST]).addScaledVector(dir, -handLen * TUNING.BRACELET_POSITION);
    const br = scale * TUNING.BRACELET_RADIUS;
    this.bangle.group.scale.set(br, br, br * TUNING.BRACELET_OVAL);

    this.wristOccluder.visible = showBangle;
    this.wristOccluder.quaternion.copy(bq);
    this.wristOccluder.position.copy(this.bangle.group.position);
    this.wristOccluder.scale.set(scale * TUNING.WRIST_HALF_WIDTH, handLen * 0.9, scale * TUNING.WRIST_HALF_DEPTH);

    this.bangle.alpha = showBangle ? Math.min(1, this.bangle.alpha + fadeStep) : 0;
    this.bangle.setOpacity(easeOut(this.bangle.alpha));
  }

  hideAll() {
    for (const { piece, occluder } of Object.values(this.rings)) {
      piece.alpha = 0;
      piece.setOpacity(0);
      occluder.visible = false;
    }
    this.bangle.alpha = 0;
    this.bangle.setOpacity(0);
    this.wristOccluder.visible = false;
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}

const easeOut = (t) => 1 - Math.pow(1 - t, 3);
