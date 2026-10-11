import type { Checkpoint } from "@sim/shared";
import { firstActionTimes, type LoggedAction } from "./vitals.js";

export interface CheckpointQuestion {
  id: string;
  checkpoint: Checkpoint;
}

/**
 * The questions whose checkpoint has been reached and that have not been answered yet,
 * in case order. The case pauses while this list is non-empty.
 */
export function dueQuestions<Q extends CheckpointQuestion>(
  questions: readonly Q[],
  log: readonly LoggedAction[],
  tMs: number,
  opts: { aboutToDiagnose?: boolean } = {},
): Q[] {
  const answered = new Set(log.filter((a) => a.type === "question.answer" && a.ref).map((a) => a.ref!));
  const acted = firstActionTimes(log);
  return questions.filter((q) => {
    if (answered.has(q.id)) return false;
    const cp = q.checkpoint;
    switch (cp.kind) {
      case "time":
        return tMs >= cp.atMin * 60_000;
      case "after_action":
        return acted.has(cp.action);
      case "before_diagnosis":
        return !!opts.aboutToDiagnose;
    }
  });
}

/** Case time (ms) at which an ordered investigation's result becomes available. */
export function resultReadyAt(orderedAtMs: number, turnaroundMin: number): number {
  return orderedAtMs + Math.round(turnaroundMin * 60_000);
}

/** Investigations ordered so far with their ready time and whether they are ready at `tMs`. */
export function investigationStatus(
  investigations: readonly { id: string; turnaroundMin: number }[],
  log: readonly LoggedAction[],
  tMs: number,
) {
  const ordered = new Map<string, number>();
  for (const a of log) if (a.type === "investigation.order" && a.ref && !ordered.has(a.ref)) ordered.set(a.ref, a.caseTimeMs);
  return investigations
    .filter((t) => ordered.has(t.id))
    .map((t) => {
      const readyAtMs = resultReadyAt(ordered.get(t.id)!, t.turnaroundMin);
      return { id: t.id, orderedAtMs: ordered.get(t.id)!, readyAtMs, ready: tMs >= readyAtMs };
    });
}
