/**
 * Pinch with hysteresis: separate thresholds to start and to release, both relative to hand
 * size. A ratio hovering near one threshold cannot flicker between pinched and released.
 */
export interface PinchThresholds {
  /** Pinch starts when thumb-index distance / hand size drops below this. */
  start: number;
  /** Pinch releases when it rises above this. Must be > start. */
  release: number;
}

export const DEFAULT_PINCH: PinchThresholds = { start: 0.3, release: 0.45 };

export class PinchDetector {
  private pinched = false;

  constructor(private thresholds: PinchThresholds = DEFAULT_PINCH) {
    if (thresholds.release <= thresholds.start) throw new Error("pinch release threshold must be above start threshold");
  }

  setThresholds(t: PinchThresholds): void {
    if (t.release <= t.start) throw new Error("pinch release threshold must be above start threshold");
    this.thresholds = t;
  }

  update(ratio: number): boolean {
    if (this.pinched ? ratio > this.thresholds.release : ratio < this.thresholds.start) this.pinched = !this.pinched;
    return this.pinched;
  }

  reset(): void {
    this.pinched = false;
  }
}
