// Original jewellery models inspired by golden beads (not copies of any real product):
//  • Ring:   a polished gold band edged on both sides with a row of tiny round beads.
//  • Bangle: a slim double-rail bangle holding a row of larger round beads.
//
// Both are built in "unit" space: the axis runs along +Y and the inner radius is
// about 1, so the overlay just scales them to the finger / wrist radius.

import * as THREE from 'three';

export const METALS = {
  yellow: { label: 'Yellow gold', color: '#F4CE7E' },
  rose:   { label: 'Rose gold',   color: '#EDB49A' },
  white:  { label: 'White gold',  color: '#E4E2DD' },
};

// ---- Ring geometry (shared by every ring) --------------------------------
const RING = {
  bandRadius: 1.09,   // centre of the band's tube
  bandTube: 0.09,     // tube thickness (radial)
  bandStretch: 1.6,   // stretch along the finger so the band reads as a flat band
  beadRadius: 0.06,
  beadOffset: 0.175,  // distance of each bead row from the band centre, along the axis
};

// ---- Bangle geometry --------------------------------------------------------
const BANGLE = {
  railRadius: 1.06,
  railTube: 0.018,
  railOffset: 0.075,
  beadRadius: 0.068,
  beadRing: 1.085,    // distance of bead centres from the axis
};

let shared = null;
function geometries() {
  if (shared) return shared;

  // Torus lies in the XY plane around Z; rotate so its axis is Y.
  const band = new THREE.TorusGeometry(RING.bandRadius, RING.bandTube, 20, 96);
  band.rotateX(Math.PI / 2);
  band.scale(1, RING.bandStretch, 1);

  const rail = new THREE.TorusGeometry(BANGLE.railRadius, BANGLE.railTube, 10, 128);
  rail.rotateX(Math.PI / 2);

  shared = {
    band,
    rail,
    smallBead: new THREE.SphereGeometry(RING.beadRadius, 14, 10),
    largeBead: new THREE.SphereGeometry(BANGLE.beadRadius, 16, 12),
  };
  return shared;
}

function goldMaterial(metalKey, roughness) {
  return new THREE.MeshPhysicalMaterial({
    color: METALS[metalKey].color,
    metalness: 1,
    roughness,
    // Transparent only so we can fade pieces in; depthWrite keeps occlusion correct.
    transparent: true,
    opacity: 1,
    depthWrite: true,
  });
}

/** Places `count` beads evenly on a circle of radius r at height y (axis = Y). */
function beadCircle(geometry, material, rows) {
  const total = rows.reduce((n, row) => n + row.count, 0);
  const mesh = new THREE.InstancedMesh(geometry, material, total);
  const m = new THREE.Matrix4();
  let i = 0;
  for (const row of rows) {
    for (let k = 0; k < row.count; k++) {
      const a = ((k + (row.phase || 0)) / row.count) * Math.PI * 2;
      m.makeTranslation(Math.cos(a) * row.radius, row.y, Math.sin(a) * row.radius);
      mesh.setMatrixAt(i++, m);
    }
  }
  mesh.instanceMatrix.needsUpdate = true;
  return mesh;
}

/** Common wrapper: one Group, its materials, and helpers to recolour and fade. */
function makePiece(group, materials) {
  return {
    group,
    setMetal(key) {
      materials.forEach((mat) => mat.color.set(METALS[key].color));
    },
    setOpacity(a) {
      materials.forEach((mat) => { mat.opacity = a; });
      group.visible = a > 0.001;
    },
  };
}

export function createRing(metalKey = 'yellow') {
  const g = geometries();
  const bandMat = goldMaterial(metalKey, 0.16);
  const beadMat = goldMaterial(metalKey, 0.22);

  const group = new THREE.Group();
  group.add(new THREE.Mesh(g.band, bandMat));

  // How many tiny beads fit around the band, almost touching.
  const count = Math.floor((2 * Math.PI * RING.bandRadius) / (RING.beadRadius * 2 * 1.06));
  group.add(beadCircle(g.smallBead, beadMat, [
    { count, radius: RING.bandRadius, y: RING.beadOffset },
    { count, radius: RING.bandRadius, y: -RING.beadOffset, phase: 0.5 },
  ]));
  return makePiece(group, [bandMat, beadMat]);
}

export function createBangle(metalKey = 'yellow') {
  const g = geometries();
  const railMat = goldMaterial(metalKey, 0.18);
  const beadMat = goldMaterial(metalKey, 0.2);

  const group = new THREE.Group();
  for (const y of [BANGLE.railOffset, -BANGLE.railOffset]) {
    const rail = new THREE.Mesh(g.rail, railMat);
    rail.position.y = y;
    group.add(rail);
  }
  const count = Math.floor((2 * Math.PI * BANGLE.beadRing) / (BANGLE.beadRadius * 2 * 1.04));
  group.add(beadCircle(g.largeBead, beadMat, [{ count, radius: BANGLE.beadRing, y: 0 }]));
  return makePiece(group, [railMat, beadMat]);
}

/** Bright, soft studio lighting for metal: RoomEnvironment through PMREM. */
export async function makeEnvironment(renderer) {
  const { RoomEnvironment } = await import('../vendor/three/addons/RoomEnvironment.js');
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromScene(new RoomEnvironment(), 0.03).texture;
  pmrem.dispose();
  return env;
}
