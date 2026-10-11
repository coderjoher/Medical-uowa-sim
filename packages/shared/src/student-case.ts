import type { CaseDefinition } from "./case-schema.js";

/**
 * What the student browser receives. Everything that would reveal the expected answer
 * (relevance flags, points, correct diagnosis, correct/harmful drugs, question answers,
 * feedback) is removed. Investigation results are also removed: the server releases
 * each one only after the student orders it.
 *
 * Vital-sign rules stay, because the case must keep running through a network drop.
 */
export function toStudentCase(c: CaseDefinition) {
  return {
    schemaVersion: c.schemaVersion,
    metadata: {
      id: c.metadata.id,
      version: c.metadata.version,
      title: c.metadata.title,
      course: c.metadata.course,
      specialty: c.metadata.specialty,
      difficulty: c.metadata.difficulty,
      learningObjectives: c.metadata.learningObjectives,
      timeLimitMin: c.metadata.timeLimitMin,
    },
    patient: c.patient,
    history: c.history.map(({ id, topic, text, answer }) => ({ id, topic, text, answer })),
    examination: c.examination.map(({ id, finding }) => ({ id, finding })),
    vitals: c.vitals,
    investigations: c.investigations.map(({ id, turnaroundMin }) => ({ id, turnaroundMin })),
    diagnosis: { options: c.diagnosis.options, maxDifferentials: c.diagnosis.maxDifferentials },
    management: { actions: c.management.actions.map(({ id }) => ({ id })) },
    questions: c.questions.map(({ id, checkpoint, type, prompt, options }) => ({ id, checkpoint, type, prompt, options })),
  };
}

export type StudentCase = ReturnType<typeof toStudentCase>;
