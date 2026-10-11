/**
 * Case clock: elapsed case time excluding pauses (checkpoint questions, instructor pause).
 * Serializable so an attempt survives a browser refresh.
 */
export interface ClockState {
  /** Case ms accumulated before the current running segment. */
  accumulatedMs: number;
  /** Wall-clock ms when the current segment started, or null while paused. */
  runningSince: number | null;
}

export class CaseClock {
  private state: ClockState;

  constructor(
    private readonly now: () => number = () => Date.now(),
    state?: ClockState,
  ) {
    this.state = state ? { ...state } : { accumulatedMs: 0, runningSince: null };
  }

  get running(): boolean {
    return this.state.runningSince !== null;
  }

  elapsedMs(): number {
    const { accumulatedMs, runningSince } = this.state;
    return Math.floor(accumulatedMs + (runningSince === null ? 0 : Math.max(0, this.now() - runningSince)));
  }

  start(): void {
    if (this.state.runningSince === null) this.state.runningSince = this.now();
  }

  pause(): void {
    if (this.state.runningSince === null) return;
    this.state = { accumulatedMs: this.elapsedMs(), runningSince: null };
  }

  /** Snapshot for persistence. Restoring a running clock after a crash resumes paused at the saved time. */
  serialize(): ClockState {
    return { accumulatedMs: this.elapsedMs(), runningSince: null };
  }
}
