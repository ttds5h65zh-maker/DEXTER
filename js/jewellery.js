// Original jewellery models inspired by golden beads (not copies of any real product).
// Four designs, each available as a ring and as a bangle, so they can be stacked:
//  • Signature: a polished band edged on both sides with a row of tiny beads
//  • Beads:     a single row of round gold beads
//  • Twin:      two offset rows of beads
//  • Lumière:   gold beads alternating with small bezel-set white stones
//
// Everything is built in "unit" space: the axis runs along +Y and the inner radius
// is about 1, so the overlay just scales each piece to the finger or wrist radius.
// Each piece reports its `width` (along the axis) so pieces can be stacked.

import * as THREE from 'three';

export const METALS = {
  yellow: { label: 'Yellow gold', short: 'Yellow', color: '#F4CE7E' },
  rose:   { label: 'Rose gold',   short: 'Rose',   color: '#EDB49A' },
  white:  { label: 'White gold',  short: 'White',  color: '#E4E2DD' },
  mix:    { label: 'Mixed golds', short: 'Mix',    color: null },
};
const MIX_ORDER = ['yellow', 'rose', 'white'];

/** The actual metal of the i-th piece ("Mix" alternates yellow, rose, white). */
export function metalAt(choice, i) {
  return choice === 'mix' ? MIX_ORDER[i % MIX_ORDER.length] : choice;
}

export const STYLES = {
  signature: { label: 'Signature' },
  beads:     { label: 'Beads' },
  twin:      { label: 'Twin' },
  lumiere:   { label: 'Lumière' },
};

// ---------------------------------------------------------------------------
// Shared geometries (built once, reused by every piece)
// ---------------------------------------------------------------------------
const cache = new Map();
const cached = (key, make) => {
  if (!cache.has(key)) cache.set(key, make());
  return cache.get(key);
};

const sphereGeo = (r) => cached(`sphere:${r}`, () => new THREE.SphereGeometry(r, 20, 14));

/** A torus around the Y axis, stretched along Y so it reads as a flat band. */
const bandGeo = (radius, tube, stretch = 1) => cached(`band:${radius}:${tube}:${stretch}`, () => {
  const g = new THREE.TorusGeometry(radius, tube, 24, 160);
  g.rotateX(Math.PI / 2);
  g.scale(1, stretch, 1);
  return g;
});

/** A small round "brilliant" stone, table facing +Y. Faceted via flat shading. */
const stoneGeo = (r) => cached(`stone:${r}`, () => new THREE.LatheGeometry([
  new THREE.Vector2(0.001, -0.62 * r),  // culet
  new THREE.Vector2(r, -0.04 * r),      // girdle
  new THREE.Vector2(r, 0.04 * r),
  new THREE.Vector2(0.58 * r, 0.3 * r), // crown → table edge
  new THREE.Vector2(0.001, 0.3 * r),    // table centre
], 10));

/** A thin gold rim (bezel) around a stone, axis +Y. */
const bezelGeo = (r) => cached(`bezel:${r}`, () => {
  const g = new THREE.TorusGeometry(r * 1.06, r * 0.2, 8, 28);
  g.rotateX(Math.PI / 2);
  return g;
});

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------
function metalMaterial(metal, roughness) {
  return new THREE.MeshPhysicalMaterial({
    color: METALS[metal].color,
    metalness: 1,
    roughness,
    // Transparent only so pieces can fade in; depthWrite keeps occlusion correct.
    transparent: true,
    depthWrite: true,
  });
}

function stoneMaterial() {
  return new THREE.MeshPhysicalMaterial({
    color: '#C9D0D8',
    metalness: 0,
    roughness: 0,
    ior: 2.4,              // diamond-like reflectivity
    specularIntensity: 1,
    clearcoat: 1,
    clearcoatRoughness: 0,
    iridescence: 0.45,     // a touch of colour "fire" in the facets
    iridescenceIOR: 1.8,
    flatShading: true,     // crisp facets that catch the light
    envMapIntensity: 1.8,
    transparent: true,
    depthWrite: true,
  });
}

// ---------------------------------------------------------------------------
// Instancing helper: places copies of a geometry on circles around the Y axis.
// items: [{ angle, radius, y, orient }] (orient = point the copy's +Y outwards)
// ---------------------------------------------------------------------------
const UP = new THREE.Vector3(0, 1, 0);
function instanced(geometry, material, items) {
  const mesh = new THREE.InstancedMesh(geometry, material, items.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const one = new THREE.Vector3(1, 1, 1);
  const dir = new THREE.Vector3();
  items.forEach((it, i) => {
    const c = Math.cos(it.angle), s = Math.sin(it.angle);
    p.set(c * it.radius, it.y, s * it.radius);
    if (it.orient) q.setFromUnitVectors(UP, dir.set(c, 0, s));
    else q.identity();
    mesh.setMatrixAt(i, m.compose(p, q, one));
  });
  mesh.instanceMatrix.needsUpdate = true;
  return mesh;
}

/** `count` evenly spaced positions on a circle. */
function circle(count, radius, y = 0, phase = 0, orient = false) {
  return Array.from({ length: count }, (_, k) => ({
    angle: ((k + phase) / count) * Math.PI * 2, radius, y, orient,
  }));
}

/** How many beads of radius r fit around a circle of radius R, almost touching. */
const fit = (R, r, spacing = 1.05) => Math.floor((2 * Math.PI * R) / (2 * r * spacing));

// ---------------------------------------------------------------------------
// Design recipes. Sizes are in units of the inner radius.
// ---------------------------------------------------------------------------
const RECIPES = {
  ring: {
    signature: (mat) => {
      const R = 1.09, bead = 0.06, edge = 0.175;
      const n = fit(R, bead);
      return {
        width: 2 * (edge + bead),
        meshes: [
          new THREE.Mesh(bandGeo(R, 0.09, 1.6), mat.metal),
          instanced(sphereGeo(bead), mat.bead, [...circle(n, R, edge), ...circle(n, R, -edge, 0.5)]),
        ],
      };
    },
    beads: (mat) => {
      const bead = 0.1, R = 1 + bead;
      return { width: 2 * bead, meshes: [instanced(sphereGeo(bead), mat.bead, circle(fit(R, bead, 1.02), R))] };
    },
    twin: (mat) => {
      const bead = 0.07, R = 1 + bead, off = 0.065;
      const n = fit(R, bead, 1.02);
      return {
        width: 2 * (off + bead),
        meshes: [instanced(sphereGeo(bead), mat.bead, [...circle(n, R, off), ...circle(n, R, -off, 0.5)])],
      };
    },
    lumiere: (mat) => lumiere(mat, { bead: 0.085, stone: 0.075, R: 1.1, rail: 0.03 }),
  },
  bangle: {
    signature: (mat) => {
      const bead = 0.068, R = 1.085, rail = 0.075;
      return {
        width: 2 * (rail + 0.018),
        meshes: [
          railMesh(bandGeo(1.06, 0.018), mat.metal, rail),
          railMesh(bandGeo(1.06, 0.018), mat.metal, -rail),
          instanced(sphereGeo(bead), mat.bead, circle(fit(R, bead, 1.04), R)),
        ],
      };
    },
    beads: (mat) => {
      const bead = 0.08, R = 1 + bead;
      return { width: 2 * bead, meshes: [instanced(sphereGeo(bead), mat.bead, circle(fit(R, bead, 1.02), R))] };
    },
    twin: (mat) => {
      const bead = 0.05, R = 1 + bead, off = 0.046;
      const n = fit(R, bead, 1.02);
      return {
        width: 2 * (off + bead),
        meshes: [instanced(sphereGeo(bead), mat.bead, [...circle(n, R, off), ...circle(n, R, -off, 0.5)])],
      };
    },
    lumiere: (mat) => lumiere(mat, { bead: 0.062, stone: 0.054, R: 1.07, rail: 0.02 }),
  },
};

function railMesh(geometry, material, y) {
  const m = new THREE.Mesh(geometry, material);
  m.position.y = y;
  return m;
}

/** Gold beads alternating with bezel-set stones, on a slim inner rail. */
function lumiere(mat, { bead, stone, R, rail }) {
  const pairs = Math.floor(fit(R, (bead + stone * 1.25) / 2, 1.04) / 2);
  const beads = [], stones = [];
  for (let k = 0; k < pairs * 2; k++) {
    const angle = (k / (pairs * 2)) * Math.PI * 2;
    (k % 2 ? stones : beads).push({ angle, radius: R, y: 0, orient: true });
  }
  const stoneItems = stones.map((s) => ({ ...s, radius: R + stone * 0.15 }));
  return {
    width: 2 * Math.max(bead, stone * 1.3),
    meshes: [
      new THREE.Mesh(bandGeo(1 + rail, rail), mat.metal),
      instanced(sphereGeo(bead), mat.bead, beads),
      instanced(bezelGeo(stone), mat.metal, stoneItems),
      instanced(stoneGeo(stone), mat.stone, stoneItems),
    ],
  };
}

/**
 * Builds one piece.
 * @param {'ring'|'bangle'} kind
 * @param {keyof STYLES} style
 * @param {'yellow'|'rose'|'white'} metal
 */
export function createPiece(kind, style, metal = 'yellow') {
  const mat = {
    metal: metalMaterial(metal, 0.14),
    bead: metalMaterial(metal, 0.2),
    stone: stoneMaterial(),
  };
  const { width, meshes } = RECIPES[kind][style](mat);
  const group = new THREE.Group();
  meshes.forEach((m) => group.add(m));
  const all = Object.values(mat);

  return {
    group,
    width,
    kind,
    style,
    setMetal(key) {
      mat.metal.color.set(METALS[key].color);
      mat.bead.color.set(METALS[key].color);
    },
    setOpacity(a) {
      all.forEach((m) => { m.opacity = a; });
      group.visible = a > 0.001;
    },
    dispose() {
      all.forEach((m) => m.dispose());
      meshes.forEach((m) => m.isInstancedMesh && m.dispose());
    },
  };
}

/**
 * Lays pieces side by side along their Y axis, touching, centred on 0.
 * Returns the total width. `gap` is in the same units as the piece widths.
 */
export function stackOffsets(widths, gap) {
  const total = widths.reduce((a, w) => a + w, 0) + gap * Math.max(widths.length - 1, 0);
  let cursor = -total / 2;
  const offsets = widths.map((w) => {
    const o = cursor + w / 2;
    cursor += w + gap;
    return o;
  });
  return { offsets, total };
}

/**
 * Studio lighting for polished metal: Three.js RoomEnvironment through PMREM, plus
 * tall softbox strips and dark cards (as in jewellery photography) so the gold shows
 * crisp highlights and defined edges instead of looking flat.
 */
export async function makeEnvironment(renderer) {
  const { RoomEnvironment } = await import('../vendor/three/addons/RoomEnvironment.js');
  const studio = new RoomEnvironment();

  const card = (brightness, w, h, x, y, z) => {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ color: new THREE.Color().setScalar(brightness), side: THREE.DoubleSide }),
    );
    m.position.set(x, y, z);
    m.lookAt(0, 0, 0);
    studio.add(m);
  };
  card(9, 1.4, 12, -7, 2, 3);     // left softbox strip
  card(7, 1.4, 12, 7, 2, -1);     // right softbox strip
  card(12, 6, 1.2, 0, 9, 2);      // overhead strip
  card(0.02, 3, 8, -3.5, 0, 7);   // dark card front-left (defines edges)
  card(0.02, 3, 8, 4, -1, 6.5);   // dark card front-right

  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromScene(studio, 0.02).texture;
  pmrem.dispose();
  return env;
}
