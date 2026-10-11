import { ACTIONS, EXAM_POINTS, TESTS } from "@sim/shared";

/**
 * The case template: one tab per part of the case model (PRD "Case authoring"). Academics
 * fill one row per item; ids may be left blank and are generated. The same layout drives the
 * template writer and the importer, so they cannot drift apart.
 */

export type ListName =
  | "yesno"
  | "difficulty"
  | "model"
  | "sex"
  | "topic"
  | "relevance"
  | "examPoint"
  | "test"
  | "action"
  | "classification"
  | "vital"
  | "changeMode"
  | "eventType"
  | "checkpoint"
  | "questionType"
  | "flag";

export const LISTS: Record<ListName, readonly string[]> = {
  yesno: ["yes", "no"],
  difficulty: ["easy", "medium", "hard"],
  model: ["adult_male", "adult_female", "elderly", "child"],
  sex: ["male", "female"],
  topic: ["presenting_complaint", "past_history", "drugs", "allergies", "social", "family", "systems_review"],
  relevance: ["essential", "useful", "irrelevant"],
  examPoint: EXAM_POINTS.map((p) => p.id),
  test: TESTS.map((t) => t.id),
  action: ACTIONS.map((a) => a.id),
  classification: ["correct", "acceptable", "neutral", "harmful"],
  vital: ["hr", "sbp", "dbp", "rr", "spo2", "temp"],
  changeMode: ["set", "delta"],
  eventType: ["timed", "after_action", "deterioration"],
  checkpoint: ["time", "after_action", "before_diagnosis"],
  questionType: ["single", "multiple", "short_list"],
  flag: ["normal", "high", "low", "critical"],
};

export interface Column {
  key: string;
  header: string;
  width: number;
  required?: boolean;
  list?: ListName;
  kind?: "text" | "number" | "yesno" | "list";
  note?: string;
}

export interface TableSheet {
  name: string;
  intro: string;
  columns: Column[];
}

/** Two-column Field | Value sheets. */
export interface FieldSheet {
  name: string;
  intro: string;
  fields: (Column & { repeat?: boolean })[];
}

const c = (key: string, header: string, width: number, extra: Partial<Column> = {}): Column => ({ key, header, width, ...extra });

export const FIELD_SHEETS: Record<"metadata" | "patient" | "vitals" | "rubric", FieldSheet> = {
  metadata: {
    name: "Metadata",
    intro: "About the case. Add one row per learning objective and per author.",
    fields: [
      c("id", "Case id", 30, { required: true, note: "Short, lowercase, no spaces, e.g. chest-pain-stemi" }),
      c("title", "Title", 30, { required: true }),
      c("course", "Course", 30, { required: true }),
      c("specialty", "Specialty", 30, { required: true }),
      c("difficulty", "Difficulty", 30, { required: true, list: "difficulty" }),
      c("timeLimitMin", "Time limit (minutes)", 30, { required: true, kind: "number" }),
      { ...c("learningObjective", "Learning objective", 30, { required: true }), repeat: true },
      { ...c("author", "Author", 30, { required: true }), repeat: true },
      c("reviewedBy", "Reviewed by (second academic)", 30),
    ],
  },
  patient: {
    name: "Patient",
    intro: "Who the patient is and what the student hears at handover.",
    fields: [
      c("model", "3D model", 30, { required: true, list: "model" }),
      c("name", "Name", 30, { required: true }),
      c("age", "Age (years)", 30, { required: true, kind: "number" }),
      c("sex", "Sex", 30, { required: true, list: "sex" }),
      c("chiefComplaint", "Chief complaint", 30, { required: true }),
      c("handover", "Handover (read at the start)", 30, { required: true }),
      c("appearance", "Appearance cues (comma separated: breathing, blinking, pain, coughing, sweating, pale)", 30),
    ],
  },
  vitals: {
    name: "Vitals",
    intro: "Starting vital signs. Changes over time go on the 'Vital events' tab.",
    fields: [
      c("hr", "Heart rate (bpm)", 30, { required: true, kind: "number" }),
      c("sbp", "Systolic BP (mmHg)", 30, { required: true, kind: "number" }),
      c("dbp", "Diastolic BP (mmHg)", 30, { required: true, kind: "number" }),
      c("rr", "Respiratory rate (/min)", 30, { required: true, kind: "number" }),
      c("spo2", "SpO2 (%)", 30, { required: true, kind: "number" }),
      c("temp", "Temperature (°C)", 30, { required: true, kind: "number" }),
    ],
  },
  rubric: {
    name: "Rubric",
    intro: "How the case is scored. Decision and question weights must add up to 1 (default 0.7 / 0.3).",
    fields: [
      c("decisionWeight", "Decision weight (0-1)", 30, { kind: "number" }),
      c("questionWeight", "Question weight (0-1)", 30, { kind: "number" }),
      c("passMark", "Pass mark (%)", 30, { kind: "number" }),
      c("irrelevantHistoryPenalty", "Penalty per irrelevant history question", 30, { kind: "number" }),
      c("maxDifferentials", "Maximum differentials a student may list", 30, { kind: "number" }),
    ],
  },
};

export const TABLE_SHEETS: Record<
  "history" | "examination" | "events" | "investigations" | "resultValues" | "diagnosis" | "management" | "order" | "questions" | "options",
  TableSheet
> = {
  history: {
    // "History" is a reserved sheet name in Excel.
    name: "History questions",
    intro: "One row per question the student can ask, with the patient's answer.",
    columns: [
      c("id", "Id (optional)", 16),
      c("topic", "Topic", 22, { required: true, list: "topic" }),
      c("text", "Question", 44, { required: true }),
      c("answer", "Patient's answer", 50, { required: true }),
      c("relevance", "Relevance", 14, { required: true, list: "relevance" }),
      c("points", "Points", 9, { kind: "number" }),
      c("feedback", "Feedback after the case", 44),
    ],
  },
  examination: {
    name: "Examination",
    intro: "One row per exam point with its finding. Exam points come from the shared list (see 'Lists').",
    columns: [
      c("id", "Exam point", 26, { required: true, list: "examPoint" }),
      c("text", "Finding (text)", 44, { required: true }),
      c("sound", "Sound file", 22),
      c("image", "Image file", 22),
      c("relevant", "Relevant?", 11, { required: true, kind: "yesno", list: "yesno" }),
      c("points", "Points", 9, { kind: "number" }),
      c("feedback", "Feedback after the case", 40),
    ],
  },
  events: {
    name: "Vital events",
    intro:
      "Changes to vital signs. timed = at a case minute; after_action = some minutes after an action; deterioration = at a case minute unless one of the listed actions happened first. Use several rows with the same Event id for several vitals.",
    columns: [
      c("id", "Event id", 16, { required: true }),
      c("type", "Type", 15, { required: true, list: "eventType" }),
      c("atMin", "At minute (timed / deterioration)", 14, { kind: "number" }),
      c("action", "Action (after_action)", 20),
      c("afterMin", "Minutes after action", 12, { kind: "number" }),
      c("unless", "Unless these actions (deterioration, comma separated)", 26),
      c("vital", "Vital", 9, { required: true, list: "vital" }),
      c("mode", "Change", 9, { list: "changeMode" }),
      c("value", "Value", 9, { required: true, kind: "number" }),
      c("overMin", "Over minutes", 10, { kind: "number" }),
      c("message", "Message shown (deterioration)", 34),
    ],
  },
  investigations: {
    name: "Investigations",
    intro: "One row per orderable test with its result. Numeric results go on 'Result values'.",
    columns: [
      c("id", "Test", 18, { required: true, list: "test" }),
      c("text", "Result (text)", 50, { required: true }),
      c("image", "Image file", 20),
      c("ecg", "ECG file", 20),
      c("turnaroundMin", "Turnaround (case minutes)", 12, { required: true, kind: "number" }),
      c("indicated", "Indicated?", 11, { required: true, kind: "yesno", list: "yesno" }),
      c("points", "Points if indicated", 10, { kind: "number" }),
      c("penalty", "Penalty if not indicated", 10, { kind: "number" }),
      c("feedback", "Feedback after the case", 40),
    ],
  },
  resultValues: {
    name: "Result values",
    intro: "Optional numeric values shown with a test result.",
    columns: [
      c("test", "Test", 18, { required: true, list: "test" }),
      c("name", "Name", 20, { required: true }),
      c("value", "Value", 12, { required: true }),
      c("unit", "Unit", 12),
      c("flag", "Flag", 12, { list: "flag" }),
    ],
  },
  diagnosis: {
    name: "Diagnosis",
    intro: "All diagnoses the student can choose from. Mark exactly one as correct; give points to acceptable differentials.",
    columns: [
      c("id", "Id (optional)", 18),
      c("label", "Diagnosis", 44, { required: true }),
      c("correct", "Correct?", 10, { kind: "yesno", list: "yesno" }),
      c("points", "Points (correct or acceptable)", 12, { kind: "number" }),
      c("feedback", "Feedback (on the correct row)", 44),
    ],
  },
  management: {
    name: "Management",
    intro: "Drugs and actions that score or are harmful. Actions come from the shared list (see 'Lists').",
    columns: [
      c("id", "Action", 22, { required: true, list: "action" }),
      c("classification", "Classification", 14, { required: true, list: "classification" }),
      c("points", "Points (or penalty if harmful)", 12, { kind: "number" }),
      c("withinMin", "Full points only within (minutes)", 12, { kind: "number" }),
      c("latePoints", "Points if later", 10, { kind: "number" }),
      c("critical", "Critical error?", 11, { kind: "yesno", list: "yesno" }),
      c("feedback", "Feedback after the case", 44),
    ],
  },
  order: {
    name: "Required order",
    intro: "Actions that must be given in this order (comma separated), and the penalty if they are not.",
    columns: [c("sequence", "Actions in order", 40, { required: true }), c("penalty", "Penalty", 10, { required: true, kind: "number" }), c("feedback", "Feedback", 44)],
  },
  questions: {
    name: "Questions",
    intro: "Checkpoint questions. Their options go on 'Question options'.",
    columns: [
      c("id", "Question id", 16, { required: true }),
      c("checkpoint", "When asked", 16, { required: true, list: "checkpoint" }),
      c("atMin", "At minute (time)", 10, { kind: "number" }),
      c("action", "After action", 18),
      c("type", "Type", 12, { required: true, list: "questionType" }),
      c("prompt", "Question", 50, { required: true }),
      c("points", "Points", 9, { required: true, kind: "number" }),
      c("feedback", "Feedback after the case", 40),
    ],
  },
  options: {
    name: "Question options",
    intro: "One row per option. Mark the right option(s) as correct.",
    columns: [
      c("question", "Question id", 16, { required: true }),
      c("id", "Option id (optional)", 16),
      c("label", "Option", 44, { required: true }),
      c("correct", "Correct?", 10, { kind: "yesno", list: "yesno" }),
    ],
  },
};

/** Tab order in the workbook. */
export const SHEET_ORDER = [
  "Instructions",
  FIELD_SHEETS.metadata.name,
  FIELD_SHEETS.patient.name,
  TABLE_SHEETS.history.name,
  TABLE_SHEETS.examination.name,
  FIELD_SHEETS.vitals.name,
  TABLE_SHEETS.events.name,
  TABLE_SHEETS.investigations.name,
  TABLE_SHEETS.resultValues.name,
  TABLE_SHEETS.diagnosis.name,
  TABLE_SHEETS.management.name,
  TABLE_SHEETS.order.name,
  TABLE_SHEETS.questions.name,
  TABLE_SHEETS.options.name,
  FIELD_SHEETS.rubric.name,
  "Lists",
];
