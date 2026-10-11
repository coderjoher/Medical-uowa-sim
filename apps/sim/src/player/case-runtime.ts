import { CaseClock, computeVitals, dueQuestions, investigationStatus, type LoggedAction } from "@sim/engine";
import type { ActionLogEntry, ActionType, InputSource, StudentCase } from "@sim/shared";
import type { ActionRecorder } from "../sync.js";

/**
 * Client-side case state: a pure function of the student case, the action log and the case
 * clock, so a refresh or crash resumes at the same step with the same vitals and timer.
 */
export class CaseRuntime {
  readonly clock: CaseClock;
  private log: LoggedAction[];
  private clockSaver: ReturnType<typeof setInterval>;

  constructor(
    readonly sc: StudentCase,
    serverLog: readonly LoggedAction[],
    readonly recorder: ActionRecorder,
    private readonly source: () => InputSource,
  ) {
    const ids = new Set((serverLog as (LoggedAction & { id?: string })[]).map((a) => a.id).filter(Boolean));
    this.log = [...serverLog, ...recorder.pending.filter((a) => !ids.has(a.id))].sort((a, b) => a.caseTimeMs - b.caseTimeMs);
    const lastT = this.log.reduce((m, a) => Math.max(m, a.caseTimeMs), 0);
    const saved = recorder.savedClock();
    this.clock = new CaseClock(() => performance.now(), { accumulatedMs: Math.max(saved?.accumulatedMs ?? 0, lastT), runningSince: null });
    this.clockSaver = setInterval(this.saveClock, 1000);
    addEventListener("pagehide", this.saveClock);
  }

  private saveClock = () => this.recorder.saveClock(this.clock.serialize());

  get now(): number {
    return this.clock.elapsedMs();
  }

  get actions(): readonly LoggedAction[] {
    return this.log;
  }

  get started(): boolean {
    return this.log.some((a) => a.type === "case.start");
  }

  has(type: string, ref?: string): boolean {
    return this.log.some((a) => a.type === type && (ref === undefined || a.ref === ref));
  }

  record(type: ActionType, ref?: string, payload?: Record<string, unknown>): ActionLogEntry {
    const e = this.recorder.record(type, ref, this.now, this.source(), payload);
    this.log.push(e);
    return e;
  }

  vitals() {
    return computeVitals(this.sc.vitals, this.log, this.now);
  }

  due(aboutToDiagnose = false) {
    return dueQuestions(this.sc.questions, this.log, this.now, { aboutToDiagnose });
  }

  investigations() {
    return investigationStatus(this.sc.investigations, this.log, this.now);
  }

  get timeLeftMs(): number {
    return this.sc.metadata.timeLimitMin * 60_000 - this.now;
  }

  dispose(): void {
    clearInterval(this.clockSaver);
    removeEventListener("pagehide", this.saveClock);
    this.saveClock();
  }
}
