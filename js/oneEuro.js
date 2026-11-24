// One Euro filter (Casiez et al., 2012): smooths jitter when the hand is still,
// but stays responsive when it moves fast. One filter per scalar value.

function smoothingFactor(dt, cutoff) {
  const r = 2 * Math.PI * cutoff * dt;
  return r / (r + 1);
}

export class OneEuroFilter {
  /**
   * @param {number} minCutoff  lower = smoother when still (Hz)
   * @param {number} beta       higher = less lag when moving fast
   * @param {number} dCutoff    cutoff for the speed estimate (Hz)
   */
  constructor(minCutoff = 1.2, beta = 0.02, dCutoff = 1.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.reset();
  }

  reset() {
    this.x = null;   // last filtered value
    this.dx = 0;     // last filtered speed
    this.t = null;   // last timestamp (seconds)
  }

  filter(value, tSeconds) {
    if (this.x === null) {
      this.x = value;
      this.t = tSeconds;
      return value;
    }
    const dt = Math.max(tSeconds - this.t, 1e-3);
    this.t = tSeconds;

    const rawDx = (value - this.x) / dt;
    const aD = smoothingFactor(dt, this.dCutoff);
    this.dx = aD * rawDx + (1 - aD) * this.dx;

    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    const a = smoothingFactor(dt, cutoff);
    this.x = a * value + (1 - a) * this.x;
    return this.x;
  }
}

/** Filters all 21 hand landmarks (x, y, z each) in one go. */
export class LandmarkSmoother {
  constructor(count = 21, minCutoff, beta) {
    this.filters = Array.from({ length: count * 3 }, () => new OneEuroFilter(minCutoff, beta));
  }

  reset() {
    this.filters.forEach((f) => f.reset());
  }

  /** points: array of {x, y, z} in pixels; returns a new array of smoothed points. */
  apply(points, tSeconds) {
    return points.map((p, i) => ({
      x: this.filters[i * 3].filter(p.x, tSeconds),
      y: this.filters[i * 3 + 1].filter(p.y, tSeconds),
      z: this.filters[i * 3 + 2].filter(p.z, tSeconds),
    }));
  }
}
