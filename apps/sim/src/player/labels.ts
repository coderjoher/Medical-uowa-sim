import { ACTIONS_BY_ID, EXAM_POINTS_BY_ID, TESTS_BY_ID, type StudentCase } from "@sim/shared";

/** Human-readable label for an action ref, for findings lists, the debrief and the timeline. */
export function labelFor(sc: StudentCase, type: string, ref?: string): string {
  if (!ref) return type === "diagnosis.submit" ? "Diagnosis committed" : type === "case.start" ? "Case started" : type === "case.end" ? "Case finished" : type;
  switch (type) {
    case "history.ask":
      return sc.history.find((q) => q.id === ref)?.text ?? ref;
    case "exam.perform":
      return EXAM_POINTS_BY_ID.get(ref)?.label ?? ref;
    case "investigation.order":
      return `Ordered ${TESTS_BY_ID.get(ref)?.label ?? ref}`;
    case "management.give":
      return `Gave ${ACTIONS_BY_ID.get(ref)?.label ?? ref}`;
    case "question.answer":
      return sc.questions.find((q) => q.id === ref)?.prompt ?? ref;
    default:
      return ref;
  }
}

/** Label for a scored item ref in the debrief (which area it came from decides the lookup). */
export function itemLabel(sc: StudentCase, area: string, ref: string): string {
  switch (area) {
    case "history":
      return sc.history.find((q) => q.id === ref)?.text ?? ref;
    case "examination":
      return EXAM_POINTS_BY_ID.get(ref)?.label ?? ref;
    case "investigations":
      return TESTS_BY_ID.get(ref)?.label ?? ref;
    case "diagnosis":
      return sc.diagnosis.options.find((d) => d.id === ref)?.label ?? ref;
    case "management":
    case "safety":
      return ref.includes(">") ? ref.split(">").map((r) => ACTIONS_BY_ID.get(r)?.label ?? r).join(" before ") : (ACTIONS_BY_ID.get(ref)?.label ?? ref);
    case "questions":
      return sc.questions.find((q) => q.id === ref)?.prompt ?? ref;
    default:
      return ref;
  }
}
