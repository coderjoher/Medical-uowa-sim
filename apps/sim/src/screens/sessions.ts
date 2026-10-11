import { api } from "../api.js";
import type { Ctx } from "../context.js";
import { h, mount } from "../ui.js";
import { courseSurvey } from "./surveys.js";

interface MySession {
  id: string;
  status: string;
  course: string;
  courseId: string;
  lab: string;
  labId: string;
  endsAt: string;
  cases: { caseId: string; version: number; title: string; attempts: { id: string; status: string; attemptNo: number }[] }[];
}

const seatKey = (labId: string) => `sim.seat.${labId}`;
const getSeat = (labId: string) => {
  try {
    return localStorage.getItem(seatKey(labId));
  } catch {
    return null;
  }
};

export async function sessionsScreen(_ctx: Ctx, start: (sessionId: string, caseId: string, seatId: string | null) => void): Promise<void> {
  mount(h("main.center", h("p", "Loading your sessions…")));
  const [sessions, labs, answered] = await Promise.all([
    api<MySession[]>("GET", "/api/my/sessions"),
    api<{ id: string; seats: { id: string; label: string }[] }[]>("GET", "/api/labs"),
    api<{ kind: string; courseId: string | null }[]>("GET", "/api/my/surveys"),
  ]);
  if (!sessions.length) {
    mount(h("main.center", h("div.card.narrow", h("h1", "No open session"), h("p", "Your instructor has not opened a session for your course yet."), h("button", { on: { click: () => location.reload() } }, "Check again"))));
    return;
  }
  const list = sessions.map((s) => {
    const seats = labs.find((l) => l.id === s.labId)?.seats ?? [];
    const seatSel = h("select", { "aria-label": "Seat" }, h("option", { value: "" }, "Choose this PC's seat"), ...seats.map((x) => h("option", { value: x.id, selected: getSeat(s.labId) === x.id }, x.label)));
    seatSel.addEventListener("change", () => {
      try {
        localStorage.setItem(seatKey(s.labId), seatSel.value);
      } catch {
        /* ignore */
      }
    });
    return h(
      "section.card",
      h("h2", `${s.course} · ${s.lab}`),
      s.status === "paused" ? h("p.warn", "Paused by your instructor") : null,
      h("label", "Seat ", seatSel),
      ...s.cases.map((c) => {
        const inProgress = c.attempts.find((a) => a.status === "in_progress");
        const done = c.attempts.filter((a) => a.status === "finished").length;
        return h(
          "div.case-row",
          h("div", h("strong", c.title ?? c.caseId), done ? h("span.muted", ` · completed ${done}×`) : null),
          h("button.primary.big", { on: { click: () => start(s.id, c.caseId, seatSel.value || null) } }, inProgress ? "Resume" : done ? "Try again" : "Start"),
        );
      }),
    );
  });
  // End-of-course feedback, once per course, for courses where the student has finished a case.
  const feedback = [...new Map(sessions.filter((s) => s.cases.some((c) => c.attempts.some((a) => a.status === "finished"))).map((s) => [s.courseId, s.course])).entries()]
    .filter(([id]) => !answered.some((x) => x.kind === "student_course" && x.courseId === id))
    .map(([id, label]) => h("button.big", { on: { click: () => courseSurvey(id, label, () => void sessionsScreen(_ctx, start)) } }, `Course feedback: ${label}`));
  mount(h("main.page", h("h1", "Your sessions"), ...list, ...(feedback.length ? [h("section.card", h("p", "Tell us how the simulation worked for you this course."), h("div.row", ...feedback))] : [])));
}
