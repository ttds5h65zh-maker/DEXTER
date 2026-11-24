// "Browse without camera": the ring and bangle turning slowly on ivory.
// Drag to spin them yourself.

import * as THREE from 'three';
import { createRing, createBangle, makeEnvironment } from './jewellery.js';

export class BrowseViewer {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.1;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
    this.camera.position.set(0, 0.6, 9);
    this.camera.lookAt(0, 0, 0);

    this.ring = createRing();
    this.bangle = createBangle();
    // The ring is shown a little larger than life relative to the bangle so the beads read.
    this.ring.group.scale.setScalar(0.62);
    this.ringPivot = new THREE.Group();
    this.banglePivot = new THREE.Group();
    this.ringPivot.add(this.ring.group);
    this.banglePivot.add(this.bangle.group);
    // Tilt both so we see the bead rows and the opening.
    this.ring.group.rotation.x = 1.05;
    this.bangle.group.rotation.x = 1.15;
    this.scene.add(this.ringPivot, this.banglePivot);

    this.spin = 0;
    this.running = false;
    this.ready = makeEnvironment(this.renderer).then((env) => {
      this.scene.environment = env;
      this.scene.environmentIntensity = 1.1;
    });
    this.bindDrag();
  }

  bindDrag() {
    let lastX = null;
    this.canvas.addEventListener('pointerdown', (e) => { lastX = e.clientX; this.canvas.setPointerCapture(e.pointerId); });
    this.canvas.addEventListener('pointermove', (e) => {
      if (lastX === null) return;
      const dx = e.clientX - lastX;
      lastX = e.clientX;
      this.spin += dx * 0.01;
    });
    const end = () => { lastX = null; };
    this.canvas.addEventListener('pointerup', end);
    this.canvas.addEventListener('pointercancel', end);
  }

  setMetal(key) {
    this.ring.setMetal(key);
    this.bangle.setMetal(key);
  }

  layout() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (w === this.w && h === this.h) return;
    this.w = w; this.h = h;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    // Portrait: bangle above, ring below. Landscape: side by side.
    if (w < h) {
      this.banglePivot.position.set(0, 0.75, 0);
      this.ringPivot.position.set(0, -1.05, 0.8);
      this.camera.position.set(0, 0.2, 10.5 * Math.max(1, 0.62 / (w / h)));
    } else {
      this.banglePivot.position.set(-1.25, 0.15, 0);
      this.ringPivot.position.set(1.45, -0.05, 0.6);
      this.camera.position.set(0, 0.4, 9);
    }
    this.camera.lookAt(0, -0.05, 0);
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
      this.banglePivot.rotation.y = this.spin;
      this.ringPivot.rotation.y = -this.spin * 1.2 + 0.6;
      this.renderer.render(this.scene, this.camera);
    };
    requestAnimationFrame(tick);
  }

  stop() {
    this.running = false;
  }
}
