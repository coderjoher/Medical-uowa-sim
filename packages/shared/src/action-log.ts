import { z } from "zod";

/**
 * Every student action is logged with a timestamp so scores can be recalculated when a
 * rubric is corrected, and so tracking problems can be measured (input source per action).
 */
export const InputSource = z.enum(["hand", "mouse", "touch", "keyboard", "system"]);
export type InputSource = z.infer<typeof InputSource>;

export const ActionType = z.enum([
  "case.start",
  "case.pause",
  "case.resume",
  "case.end",
  "history.ask",
  "exam.perform",
  "investigation.order",
  "question.answer",
  "diagnosis.submit",
  "management.give",
  "view.change",
  "input.switch",
  "tracking.lost",
  "tracking.recalibrate",
  /** Periodic hand-tracking health sample: fps, pipeline latency, losses since the last sample. */
  "tracking.stats",
]);
export type ActionType = z.infer<typeof ActionType>;

export const ActionLogEntry = z.object({
  /** Client-generated UUID; the server ignores repeats, so batches can be re-sent safely. */
  id: z.string().uuid(),
  /** Monotonic per attempt; defines order even if batches arrive out of order. */
  seq: z.number().int().min(0),
  /** Case clock in ms (pauses excluded). */
  caseTimeMs: z.number().int().min(0),
  clientTs: z.string().datetime(),
  type: ActionType,
  ref: z.string().optional(),
  payload: z.record(z.unknown()).optional(),
  inputSource: InputSource,
});
export type ActionLogEntry = z.infer<typeof ActionLogEntry>;

/** Actions about the session or input, not clinical decisions: left out of timelines and seat steps. */
export const NON_CLINICAL_TYPES: readonly ActionType[] = ["view.change", "tracking.lost", "tracking.recalibrate", "tracking.stats", "input.switch"];

export const DiagnosisPayload = z.object({ main: z.string(), differentials: z.array(z.string()).default([]) });
export const AnswerPayload = z.object({ selected: z.array(z.string()) });
