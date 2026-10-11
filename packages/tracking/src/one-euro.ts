/**
 * One Euro filter (Casiez et al. 2012): low cutoff when the hand is still (removes jitter),
 * higher cutoff when it moves fast (removes lag).
 */
const alpha = (cutoffHz: number, dtS: number) => {
  const tau = 1 / (2 * Math.PI * cutoffHz);
  return 1 / (1 + tau / dtS);
};

export interface OneEuroParams {
  /** Hz. Lower = less jitter at rest. */
  minCutoff: number;
  /** Speed coefficient. Higher = less lag when moving. */
  beta: number;
  /** Hz, cutoff for the derivative. */
  dCutoff: number;
}

export class OneEuroFilter {
  private x: number | null = null;
  private dx = 0;
  private lastT: number | null = null;

  constructor(private readonly p: OneEuroParams) {}

  /** @param tMs timestamp in milliseconds */
  filter(value: number, tMs: number): number {
    if (this.x === null || this.lastT === null) {
      this.x = value;
      this.lastT = tMs;
      return value;
    }
    // Duplicate or out-of-order timestamp: keep the last output.
    if (tMs <= this.lastT) return this.x;
    const dt = (tMs - this.lastT) / 1000;
    const rawDx = (value - this.x) / dt;
    this.dx += alpha(this.p.dCutoff, dt) * (rawDx - this.dx);
    const cutoff = this.p.minCutoff + this.p.beta * Math.abs(this.dx);
    this.x += alpha(cutoff, dt) * (value - this.x);
    this.lastT = tMs;
    return this.x;
  }

  reset(): void {
    this.x = null;
    this.lastT = null;
    this.dx = 0;
  }
}

/** Filters all 21 landmarks (x, y, z) independently. */
export class LandmarkFilter {
  private filters: OneEuroFilter[] = [];

  constructor(private readonly p: OneEuroParams) {}

  filter<L extends { x: number; y: number; z: number }>(lms: readonly L[], tMs: number): { x: number; y: number; z: number }[] {
    if (this.filters.length !== lms.length * 3) this.filters = Array.from({ length: lms.length * 3 }, () => new OneEuroFilter(this.p));
    return lms.map((l, i) => ({
      x: this.filters[i * 3]!.filter(l.x, tMs),
      y: this.filters[i * 3 + 1]!.filter(l.y, tMs),
      z: this.filters[i * 3 + 2]!.filter(l.z, tMs),
    }));
  }

  reset(): void {
    this.filters.forEach((f) => f.reset());
  }
}
