// "Browse without camera": a product-shot style turntable on ivory.
// Shows the selected designs as a ring stack and a bangle stack, each with a soft
// floor shadow. Drag to spin them.

import * as THREE from 'three';
import { createPiece, makeEnvironment, metalAt, stackOffsets } from './jewellery.js';

const RING_SCALE = 0.62;   // rings shown a little larger than life next to the bangles
const RING_TILT = 1.0;     // radians: tilt so we see the bead rows and the opening
const BANGLE_TILT = 1.12;

/** A soft round shadow texture (drawn once on a small canvas). */
function shadowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(58, 48, 30, 0.55)');
  grad.addColorStop(0.45, 'rgba(58, 48, 30, 0.22)');
  grad.addColorStop(1, 'rgba(58, 48, 30, 0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class BrowseViewer {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);

    // Each stack: pivot (turntable spin) → holder (tilt) → pieces. Shadow stays on the floor.
    const tex = shadowTexture();
    const makeStack = (tilt) => {
      const pivot = new THREE.Group();
      const holder = new THREE.Group();
      holder.rotation.x = tilt;
      pivot.add(holder);
      const shadow = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false }),
      );
      shadow.rotation.x = -Math.PI / 2;
      const stack = new THREE.Group();
      stack.add(pivot, shadow);
      this.scene.add(stack);
      return { stack, pivot, holder, shadow, pieces: [] };
    };
    this.rings = makeStack(RING_TILT);
    this.bangles = makeStack(BANGLE_TILT);
    this.rings.holder.scale.setScalar(RING_SCALE);

    this.look = { styles: [], metal: '' };
    this.spin = 0;
    this.running = false;
    this.ready = makeEnvironment(this.renderer).then((env) => {
      this.scene.environment = env;
      this.scene.environmentIntensity = 1.1;
    });
    this.bindDrag();
    this.setLook({ styles: ['signature'], metal: 'yellow' });
  }

  bindDrag() {
    let lastX = null;
    this.canvas.addEventListener('pointerdown', (e) => { lastX = e.clientX; this.canvas.setPointerCapture(e.pointerId); });
    this.canvas.addEventListener('pointermove', (e) => {
      if (lastX === null) return;
      this.spin += (e.clientX - lastX) * 0.01;
      lastX = e.clientX;
    });
    const end = () => { lastX = null; };
    this.canvas.addEventListener('pointerup', end);
    this.canvas.addEventListener('pointercancel', end);
  }

  /** Shows the given designs (up to 3) in the given metal ('mix' alternates golds). */
  setLook({ styles, metal }) {
    if (styles.join() === this.look.styles.join() && metal === this.look.metal) return;
    this.look = { styles: [...styles], metal };
    this.fill(this.rings, 'ring', 0.03);
    this.fill(this.bangles, 'bangle', 0.02);
    this.w = 0; // force a re-layout
  }

  fill(s, kind, gap) {
    s.pieces.forEach((p) => { s.holder.remove(p.group); p.dispose(); });
    s.pieces = this.look.styles.map((style, i) => createPiece(kind, style, metalAt(this.look.metal, i)));
    const { offsets } = stackOffsets(s.pieces.map((p) => p.width), gap);
    s.pieces.forEach((p, i) => {
      p.group.position.y = offsets[i];
      s.holder.add(p.group);
    });
    // Put the soft shadow just under the lowest point of the tilted stack.
    s.pivot.rotation.y = 0;
    s.stack.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(s.pivot);
    const size = box.getSize(new THREE.Vector3());
    s.shadow.position.y = box.min.y - s.stack.position.y - 0.02;
    s.shadow.scale.set(Math.max(size.x, size.z) * 1.35, Math.max(size.x, size.z) * 0.85, 1);
  }

  layout() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (w === this.w && h === this.h) return;
    this.w = w; this.h = h;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // Portrait: bangles above, rings in front below. Landscape: side by side.
    if (w < h) {
      this.bangles.stack.position.set(0, 0.55, -0.3);
      this.rings.stack.position.set(0, -1.4, 0.9);
      this.camera.fov = 30;
      const short = h < 740 ? 1.12 : 1; // small phones: step back so the stack clears the buttons
      this.camera.position.set(0, 1.6, 12.5 * short * Math.max(1, 0.6 / (w / h)));
    } else {
      this.bangles.stack.position.set(-1.3, 0.1, 0);
      this.rings.stack.position.set(1.5, -0.35, 0.6);
      this.camera.fov = 28;
      this.camera.position.set(0, 1.8, 10);
    }
    this.camera.lookAt(0, -0.25, 0);
    this.camera.updateProjectionMatrix();
  }

  async start() {
    await this.ready;
    if (this.running) return;
    this.running = true;
    let last = performance.now();
    const tick = (now) => {
      if (!this.running) return;
      requestAnimationFrame(tick);
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      this.layout();
      this.spin += dt * 0.35; // slow, calm rotation
      this.bangles.pivot.rotation.y = this.spin;
      this.rings.pivot.rotation.y = -this.spin * 1.2 + 0.6;
      this.renderer.render(this.scene, this.camera);
    };
    requestAnimationFrame(tick);
  }

  stop() {
    this.running = false;
  }
}
