import { z } from "zod";

/**
 * The case model from the Stage 1 PRD. A case is data, not code: the same room and
 * patient models play any case that passes this schema plus the semantic checks in
 * `validate-case.ts`.
 *
 * Fields marked "answer" are stripped before a case is sent to the student browser
 * (see `toStudentCase`).
 */

const id = z.string().regex(/^[a-z0-9][a-z0-9_.-]*$/, "ids are lowercase letters, digits, _ . -");
const feedback = z.string().min(1).optional();

export const VitalName = z.enum(["hr", "sbp", "dbp", "rr", "spo2", "temp"]);
export type VitalName = z.infer<typeof VitalName>;

export const Vitals = z.object({
  hr: z.number().min(0).max(300),
  sbp: z.number().min(0).max(300),
  dbp: z.number().min(0).max(200),
  rr: z.number().min(0).max(80),
  spo2: z.number().min(0).max(100),
  temp: z.number().min(25).max(45),
});
export type Vitals = z.infer<typeof Vitals>;

/** A change to one or more vitals. `mode: "set"` jumps to the value; `delta` adds to it. */
export const VitalChange = z.object({
  vital: VitalName,
  mode: z.enum(["set", "delta"]).default("set"),
  value: z.number(),
  /** Minutes over which the change ramps linearly; 0 = instant. */
  overMin: z.number().min(0).default(0),
});
export type VitalChange = z.infer<typeof VitalChange>;

/** Changes that happen at a fixed case time regardless of what the student does. */
export const TimedVitalEvent = z.object({
  id,
  atMin: z.number().min(0),
  changes: z.array(VitalChange).min(1),
});

/** Changes triggered by an action (e.g. oxygen given -> SpO2 rises). */
export const ActionVitalEvent = z.object({
  id,
  /** Ref of the action, e.g. a management action id or investigation id. */
  onAction: id,
  afterMin: z.number().min(0).default(0),
  changes: z.array(VitalChange).min(1),
});

/** Deterioration: fires at `atMin` unless one of `unlessActions` happened first. */
export const DeteriorationEvent = z.object({
  id,
  atMin: z.number().min(0),
  unlessActions: z.array(id).min(1),
  changes: z.array(VitalChange).min(1),
  message: z.string().optional(),
});

export const Metadata = z.object({
  id,
  version: z.number().int().min(1),
  title: z.string().min(1),
  course: z.string().min(1),
  specialty: z.string().min(1),
  difficulty: z.enum(["easy", "medium", "hard"]),
  learningObjectives: z.array(z.string().min(1)).min(1),
  timeLimitMin: z.number().positive(),
  authors: z.array(z.string().min(1)).min(1),
  reviewedBy: z.string().min(1).optional(),
});

export const Patient = z.object({
  model: z.enum(["adult_male", "adult_female", "elderly", "child"]),
  name: z.string().min(1),
  age: z.number().int().min(0).max(120),
  sex: z.enum(["male", "female"]),
  chiefComplaint: z.string().min(1),
  handover: z.string().min(1),
  appearance: z.array(z.enum(["breathing", "blinking", "pain", "coughing", "sweating", "pale"])).default([]),
});

export const HistoryTopic = z.enum(["presenting_complaint", "past_history", "drugs", "allergies", "social", "family", "systems_review"]);

export const HistoryQuestion = z.object({
  id,
  topic: HistoryTopic,
  text: z.string().min(1),
  answer: z.string().min(1),
  /** answer */
  relevance: z.enum(["essential", "useful", "irrelevant"]),
  /** answer: points when asked (essential/useful). */
  points: z.number().min(0).default(0),
  feedback,
});

export const Finding = z.object({
  text: z.string().min(1),
  sound: z.string().optional(),
  image: z.string().optional(),
});

export const ExamPoint = z.object({
  /** Must exist in the shared exam-point library. */
  id,
  finding: Finding,
  /** answer */
  relevant: z.boolean(),
  /** answer */
  points: z.number().min(0).default(0),
  feedback,
});

export const InvestigationResult = z.object({
  text: z.string().min(1),
  values: z.array(z.object({ name: z.string(), value: z.string(), unit: z.string().optional(), flag: z.enum(["normal", "high", "low", "critical"]).optional() })).default([]),
  image: z.string().optional(),
  ecg: z.string().optional(),
});

export const Investigation = z.object({
  /** Must exist in the shared test library. */
  id,
  result: InvestigationResult,
  turnaroundMin: z.number().min(0),
  /** answer */
  indicated: z.boolean(),
  /** answer: points when ordered and indicated. */
  points: z.number().min(0).default(0),
  /** answer: points removed when ordered and not indicated (positive number). */
  penalty: z.number().min(0).default(0),
  feedback,
});

export const DiagnosisOption = z.object({ id, label: z.string().min(1) });

export const Diagnosis = z.object({
  options: z.array(DiagnosisOption).min(2),
  /** answer */
  correct: id,
  /** answer */
  correctPoints: z.number().min(0),
  /** answer: differentials that earn points when listed. */
  acceptable: z.array(z.object({ id, points: z.number().min(0) })).default([]),
  /** Maximum number of differentials the student may list. */
  maxDifferentials: z.number().int().min(0).default(3),
  feedback,
});

export const ManagementAction = z.object({
  /** Must exist in the shared drug or action library. */
  id,
  /** answer */
  classification: z.enum(["correct", "acceptable", "neutral", "harmful"]),
  /** answer: points for correct/acceptable; penalty (positive number) for harmful. */
  points: z.number().min(0).default(0),
  /** answer: full points only if given within this many case minutes. */
  withinMin: z.number().positive().optional(),
  /** answer: points when given after `withinMin`. */
  latePoints: z.number().min(0).default(0),
  /** answer: a critical error caps the result at "not passed". */
  critical: z.boolean().default(false),
  feedback,
});

export const Management = z.object({
  actions: z.array(ManagementAction).min(1),
  /** answer: actions that must happen in this order where it matters. */
  requiredOrder: z
    .array(z.object({ sequence: z.array(id).min(2), penalty: z.number().min(0), feedback }))
    .default([]),
});

export const Checkpoint = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("time"), atMin: z.number().min(0) }),
  z.object({ kind: z.literal("after_action"), action: id }),
  z.object({ kind: z.literal("before_diagnosis") }),
]);

export const Question = z.object({
  id,
  checkpoint: Checkpoint,
  type: z.enum(["single", "multiple", "short_list"]),
  prompt: z.string().min(1),
  options: z.array(z.object({ id, label: z.string().min(1) })).min(2),
  /** answer */
  correct: z.array(id).min(1),
  /** answer */
  points: z.number().positive(),
  feedback,
});

export const Rubric = z.object({
  /** Share of the case score from clinical decisions; the rest comes from questions. */
  decisionWeight: z.number().min(0).max(1).default(0.7),
  questionWeight: z.number().min(0).max(1).default(0.3),
  /** Percent needed to pass (0-100). */
  passMark: z.number().min(0).max(100).default(60),
  /** Points removed per irrelevant history question (efficiency). */
  irrelevantHistoryPenalty: z.number().min(0).default(0.5),
});

export const CaseDefinition = z.object({
  schemaVersion: z.literal(1),
  metadata: Metadata,
  patient: Patient,
  history: z.array(HistoryQuestion).min(1),
  examination: z.array(ExamPoint).min(1),
  vitals: z.object({
    initial: Vitals,
    timed: z.array(TimedVitalEvent).default([]),
    onAction: z.array(ActionVitalEvent).default([]),
    deterioration: z.array(DeteriorationEvent).default([]),
  }),
  investigations: z.array(Investigation).default([]),
  diagnosis: Diagnosis,
  management: Management,
  questions: z.array(Question).default([]),
  rubric: Rubric.default({}),
});

export type CaseDefinition = z.infer<typeof CaseDefinition>;
export type CaseDefinitionInput = z.input<typeof CaseDefinition>;
export type HistoryQuestion = z.infer<typeof HistoryQuestion>;
export type ExamPoint = z.infer<typeof ExamPoint>;
export type Investigation = z.infer<typeof Investigation>;
export type ManagementAction = z.infer<typeof ManagementAction>;
export type Question = z.infer<typeof Question>;
export type Checkpoint = z.infer<typeof Checkpoint>;
export type TimedVitalEvent = z.infer<typeof TimedVitalEvent>;
export type ActionVitalEvent = z.infer<typeof ActionVitalEvent>;
export type DeteriorationEvent = z.infer<typeof DeteriorationEvent>;
