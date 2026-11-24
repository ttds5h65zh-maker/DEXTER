// The 3D try-on layer: a transparent Three.js canvas laid exactly over the video.
//
// How alignment works: the <video> fills the screen with object-fit: cover, so it
// is scaled by s = max(W / videoW, H / videoH) and centred (the overflow is cropped).
// We apply the very same maths to every landmark, then use an orthographic camera
// whose units are CSS pixels. 1 world unit = 1 screen pixel, so the 3D jewellery
// lands exactly on the finger in portrait, landscape, and with either camera.

import * as THREE from 'three';
import { createPiece, makeEnvironment, metalAt, stackOffsets } from './jewellery.js';
import { LandmarkSmoother } from './oneEuro.js';

// ============================================================================
// TUNABLE CONSTANTS: adjust these to change how the jewellery sits on the hand.
// "Hand scale" = knuckle width (index knuckle to little-finger knuckle, in 3D),
// which is about 6.5 cm on an adult hand. Sizes below are fractions of it.
// ============================================================================
export const TUNING = {
  RING_POSITION: 0.40,      // centre of the ring stack: 0 = knuckle (MCP), 1 = first joint (PIP)
  FINGER_WIDTH: {           // finger diameter as a fraction of hand scale
    index: 0.27,
    middle: 0.275,
    ring: 0.26,
    little: 0.22,
  },
  RING_FIT: 1.04,           // ring inner radius ÷ finger radius (a little room)
  STACK_GAP: 0.03,          // space between stacked rings, in finger radii
  FINGER_OCCLUDER_FIT: 0.97, // invisible finger cylinder radius ÷ finger radius
  FINGER_OCCLUDER_RANGE: [-0.5, 1.15], // cylinder extent along the finger, in MCP→PIP lengths
  OCCLUDE_ALL_FINGERS: true, // hide ring parts that pass behind neighbouring fingers too
  CONTACT_SHADOW: 0.3,      // soft shadow where each ring meets the finger (0 = off)
  SHADOW_SPREAD: 1.9,       // shadow width ÷ ring width
  Z_SCALE: 1.0,             // how much MediaPipe depth (z) tilts the pieces towards the camera
  HAND_LENGTH_TO_SCALE: 0.68, // wrist→middle knuckle length × this ≈ knuckle width (used when the hand is edge-on)

  BRACELET_POSITION: 0.22,  // how far the first bangle sits behind the wrist landmark, in hand lengths
  BRACELET_RADIUS: 0.49,    // bangle inner radius as a fraction of hand scale
  BRACELET_OVAL: 0.84,      // bangle depth ÷ width (slightly oval, like a real wrist)
  BANGLE_GAP: 0.02,         // space between stacked bangles, in bangle radii
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
const easeOut = (t) => 1 - Math.pow(1 - t, 3);

// Contact shadow: a soft dark band on the finger surface, strongest under the ring
// and fading towards the band's ends and towards the finger's edges.
const SHADOW_VERTEX = /* glsl */`
  varying float vFacing;
  varying float vAlong;
  void main() {
    vec3 n = normalize(normalMatrix * normal);
    vFacing = max(n.z, 0.0);          // 1 = facing the camera, 0 = finger edge
    vAlong = uv.y;                    // 0..1 along the finger
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;
const SHADOW_FRAGMENT = /* glsl */`
  uniform float uOpacity;
  varying float vFacing;
  varying float vAlong;
  void main() {
    float d = (vAlong - 0.5) * 3.2;
    float along = exp(-d * d);
    float edge = smoothstep(0.1, 0.65, vFacing);
    gl_FragColor = vec4(0.08, 0.05, 0.02, uOpacity * along * edge);
  }`;

export class Overlay {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.1;

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 8000);
    this.camera.position.set(0, 0, 4000);

    this.smoother = new LandmarkSmoother(21, TUNING.SMOOTH_MIN_CUTOFF, TUNING.SMOOTH_BETA);
    this.layoutKey = '';
    this.handVisible = false;
    this.lastMs = performance.now();

    this.selection = { piece: 'ring', fingers: new Set(['ring']), styles: ['signature'], metal: 'yellow' };

    // --- Invisible "depth only" material: writes depth, draws no colour. -----
    // Anything of the jewellery behind these shapes (the back of a band, the far
    // side of a bangle) fails the depth test and disappears, so it looks worn.
    const occluderMat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: true });
    const cylinder = new THREE.CylinderGeometry(1, 1, 1, 28, 1, false);
    const makeOccluder = () => {
      const m = new THREE.Mesh(cylinder, occluderMat);
      m.renderOrder = -1; // render before everything else
      m.visible = false;
      this.scene.add(m);
      return m;
    };
    this.shadowGeo = new THREE.CylinderGeometry(1, 1, 1, 48, 1, true);

    // One ring stack + one finger occluder per finger; one bangle stack + wrist occluder.
    this.fingers = {};
    for (const name of Object.keys(FINGERS)) this.fingers[name] = { occluder: makeOccluder(), pieces: [] };
    this.bangles = [];
    this.wristOccluder = makeOccluder();
    this.rebuild();
  }

  async init() {
    this.scene.environment = await makeEnvironment(this.renderer);
    this.scene.environmentIntensity = 1.15;
  }

  /** (Re)creates all ring and bangle pieces for the selected designs and metal. */
  rebuild() {
    const { styles, metal } = this.selection;
    const drop = (p) => { this.scene.remove(p.group); p.dispose(); };

    Object.values(this.fingers).forEach((slot, fi) => {
      slot.pieces.forEach(drop);
      slot.pieces = styles.map((style, si) => {
        const p = createPiece('ring', style, metalAt(metal, fi + si));
        this.addContactShadow(p);
        return this.adopt(p);
      });
    });
    this.bangles.forEach(drop);
    this.bangles = styles.map((style, si) => this.adopt(createPiece('bangle', style, metalAt(metal, si))));
  }

  adopt(piece) {
    piece.alpha = 0;
    piece.setOpacity(0);
    this.scene.add(piece.group);
    return piece;
  }

  /** Adds a soft shadow band on the finger under a ring (child of the ring, so it follows it). */
  addContactShadow(piece) {
    if (!TUNING.CONTACT_SHADOW) return;
    const mat = new THREE.ShaderMaterial({
      uniforms: { uOpacity: { value: 0 } },
      vertexShader: SHADOW_VERTEX,
      fragmentShader: SHADOW_FRAGMENT,
      transparent: true,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(this.shadowGeo, mat);
    const r = 1 / TUNING.RING_FIT; // = finger surface, in ring units
    mesh.scale.set(r, piece.width * TUNING.SHADOW_SPREAD, r);
    piece.group.add(mesh);
    const setOpacity = piece.setOpacity;
    const dispose = piece.dispose;
    piece.setOpacity = (a) => { setOpacity(a); mat.uniforms.uOpacity.value = a * TUNING.CONTACT_SHADOW; };
    piece.dispose = () => { dispose(); mat.dispose(); };
  }

  setSelection({ piece, fingers, styles, metal }) {
    if (piece) this.selection.piece = piece;
    if (fingers) this.selection.fingers = new Set(fingers);
    const stylesChanged = styles && styles.join() !== this.selection.styles.join();
    const metalChanged = metal && metal !== this.selection.metal;
    if (stylesChanged) this.selection.styles = [...styles];
    if (metalChanged) {
      const wasMix = this.selection.metal === 'mix';
      this.selection.metal = metal;
      if (!stylesChanged && !wasMix && metal !== 'mix') {
        // Simple recolour: no need to rebuild (keeps pieces visible).
        Object.values(this.fingers).forEach((s) => s.pieces.forEach((p) => p.setMetal(metal)));
        this.bangles.forEach((p) => p.setMetal(metal));
        return;
      }
    }
    if (stylesChanged || metalChanged) this.rebuild();
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

  /** Fades a piece in while wanted; hides it at once when not. */
  fade(piece, wanted, step) {
    piece.alpha = wanted ? Math.min(1, piece.alpha + step) : 0;
    piece.setOpacity(easeOut(piece.alpha));
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
    const q = new THREE.Quaternion();
    const axis = v();

    // ---- Ring stacks ----------------------------------------------------------
    for (const [name, [mcp, pip]] of Object.entries(FINGERS)) {
      const { pieces, occluder } = this.fingers[name];
      const wanted = showRings && this.selection.fingers.has(name);

      const seg = tmpC.subVectors(P[pip], P[mcp]);
      const segLen = seg.length();
      axis.copy(seg).normalize();
      const fingerR = (scale * TUNING.FINGER_WIDTH[name]) / 2;
      const ringScale = fingerR * TUNING.RING_FIT;
      this.basis(seg, palmNormal, q);

      // Stack the rings along the finger, centred 40% of the way from knuckle to joint.
      const centre = v().copy(P[mcp]).addScaledVector(seg, TUNING.RING_POSITION);
      const { offsets } = stackOffsets(pieces.map((p) => p.width * ringScale), TUNING.STACK_GAP * fingerR);
      pieces.forEach((piece, i) => {
        piece.group.position.copy(centre).addScaledVector(axis, offsets[i]);
        piece.group.quaternion.copy(q);
        piece.group.scale.setScalar(ringScale);
        this.fade(piece, wanted, fadeStep);
      });

      // Finger occluder: a cylinder along the finger segment.
      const [a, b] = TUNING.FINGER_OCCLUDER_RANGE;
      occluder.visible = showRings && (wanted || TUNING.OCCLUDE_ALL_FINGERS);
      occluder.position.copy(P[mcp]).addScaledVector(seg, (a + b) / 2);
      occluder.quaternion.copy(q);
      const r = fingerR * TUNING.FINGER_OCCLUDER_FIT;
      occluder.scale.set(r, Math.max(segLen * (b - a), 1), r);
    }

    // ---- Bangle stack -----------------------------------------------------------
    const dir = tmpC.subVectors(P[MIDDLE_MCP], P[WRIST]).normalize();
    this.basis(dir, palmNormal, q);
    const br = scale * TUNING.BRACELET_RADIUS;
    // The first bangle sits at BRACELET_POSITION; the rest stack up the arm.
    const widths = this.bangles.map((p) => p.width * br);
    const { offsets, total } = stackOffsets(widths, TUNING.BANGLE_GAP * br);
    const first = v().copy(P[WRIST]).addScaledVector(dir, -handLen * TUNING.BRACELET_POSITION);
    this.bangles.forEach((piece, i) => {
      const along = offsets[i] - offsets[0]; // 0 for the first, growing up the arm
      piece.group.position.copy(first).addScaledVector(dir, -along);
      piece.group.quaternion.copy(q);
      piece.group.scale.set(br, br, br * TUNING.BRACELET_OVAL);
      this.fade(piece, showBangle, fadeStep);
    });

    this.wristOccluder.visible = showBangle;
    this.wristOccluder.quaternion.copy(q);
    const middle = (offsets[offsets.length - 1] - offsets[0]) / 2; // centre of the stack
    this.wristOccluder.position.copy(first).addScaledVector(dir, -middle);
    this.wristOccluder.scale.set(scale * TUNING.WRIST_HALF_WIDTH, handLen * 0.9 + total, scale * TUNING.WRIST_HALF_DEPTH);
  }

  hideAll() {
    for (const { pieces, occluder } of Object.values(this.fingers)) {
      pieces.forEach((p) => this.fade(p, false, 0));
      occluder.visible = false;
    }
    this.bangles.forEach((p) => this.fade(p, false, 0));
    this.wristOccluder.visible = false;
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}
