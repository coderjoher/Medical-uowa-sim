import type { CaseDefinition, VitalChange, VitalName, Vitals } from "@sim/shared";

type VitalsDef = CaseDefinition["vitals"];

/** The minimal action shape the engine needs; matches ActionLogEntry. */
export interface LoggedAction {
  type: string;
  ref?: string;
  caseTimeMs: number;
}

const TRIGGER_TYPES = new Set(["history.ask", "exam.perform", "investigation.order", "management.give"]);
const MIN = 60_000;

/** First case time (ms) at which each action ref was performed. */
export function firstActionTimes(log: readonly LoggedAction[]): Map<string, number> {
  const times = new Map<string, number>();
  for (const a of log) {
    if (!a.ref || !TRIGGER_TYPES.has(a.type)) continue;
    const prev = times.get(a.ref);
    if (prev === undefined || a.caseTimeMs < prev) times.set(a.ref, a.caseTimeMs);
  }
  return times;
}

interface Application {
  startMs: number;
  change: VitalChange;
  source: string;
  message?: string;
}

const RANGES: Record<VitalName, [number, number, number]> = {
  // min, max, decimals
  hr: [0, 250, 0],
  sbp: [0, 260, 0],
  dbp: [0, 180, 0],
  rr: [0, 60, 0],
  spo2: [0, 100, 0],
  temp: [30, 43, 1],
};

export interface VitalsState {
  values: Vitals;
  /** Ids of events that have started, in start order. */
  firedEvents: string[];
  /** Messages from deterioration events that have started. */
  messages: string[];
}

/**
 * Vital signs at case time `tMs`, as a pure function of the case and the action log.
 * Being pure means the monitor shows the same values after a refresh or on replay.
 */
export function computeVitals(def: VitalsDef, log: readonly LoggedAction[], tMs: number): VitalsState {
  const acted = firstActionTimes(log.filter((a) => a.caseTimeMs <= tMs));
  const apps: Application[] = [];

  for (const e of def.timed) for (const c of e.changes) apps.push({ startMs: e.atMin * MIN, change: c, source: e.id });
  for (const e of def.onAction) {
    const at = acted.get(e.onAction);
    if (at === undefined) continue;
    for (const c of e.changes) apps.push({ startMs: at + e.afterMin * MIN, change: c, source: e.id });
  }
  for (const e of def.deterioration) {
    const startMs = e.atMin * MIN;
    const prevented = e.unlessActions.some((a) => {
      const at = acted.get(a);
      return at !== undefined && at < startMs;
    });
    if (prevented) continue;
    for (const c of e.changes) apps.push({ startMs, change: c, source: e.id, ...(e.message ? { message: e.message } : {}) });
  }

  apps.sort((a, b) => a.startMs - b.startMs);
  const values: Vitals = { ...def.initial };
  const fired: string[] = [];
  const messages: string[] = [];

  for (const app of apps) {
    if (app.startMs > tMs) break;
    if (!fired.includes(app.source)) {
      fired.push(app.source);
      if (app.message) messages.push(app.message);
    }
    const { vital, mode, value, overMin } = app.change;
    const progress = overMin === 0 ? 1 : Math.min(1, (tMs - app.startMs) / (overMin * MIN));
    const current = values[vital];
    values[vital] = mode === "set" ? current + (value - current) * progress : current + value * progress;
  }

  for (const k of Object.keys(values) as VitalName[]) {
    const [lo, hi, dp] = RANGES[k];
    const f = 10 ** dp;
    values[k] = Math.round(Math.min(hi, Math.max(lo, values[k])) * f) / f;
  }
  return { values, firedEvents: fired, messages };
}
