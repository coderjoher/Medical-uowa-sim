import { api, ApiError } from "../api.js";
import { h, modal } from "../ui.js";

/** 1-5 rating as large buttons (hand-friendly). */
function ratingRow(label: string, onPick: (n: number) => void) {
  const row = h("div.rating", { role: "radiogroup", "aria-label": label });
  for (let n = 1; n <= 5; n++) {
    const b = h("button.big", { role: "radio", "aria-checked": "false", on: { click: () => {
      row.querySelectorAll("button").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
      onPick(n);
    } } }, String(n));
    row.append(b);
  }
  return h("div", h("p", h("strong", label), h("span.muted", " (1 = not at all, 5 = very)")), row);
}

function yesNo(label: string, onPick: (v: boolean) => void) {
  const row = h("div.rating", { role: "radiogroup", "aria-label": label });
  for (const v of [true, false]) {
    const b = h("button.big", { role: "radio", "aria-checked": "false", on: { click: () => {
      row.querySelectorAll("button").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
      onPick(v);
    } } }, v ? "Yes" : "No");
    row.append(b);
  }
  return h("div", h("p", h("strong", label)), row);
}

/** Short survey under the debrief, about this case. */
export function caseSurvey(attemptId: string): HTMLElement {
  const a: { usedHand?: boolean; trackingReliable?: boolean; useful?: number } = {};
  const status = h("p.muted", { role: "status" });
  const reliability = h("div", { hidden: true }, yesNo("Did hand tracking feel reliable?", (v) => ((a.trackingReliable = v), check())));
  const comment = h("textarea", { rows: 2, "aria-label": "Comment (optional)", placeholder: "Anything we should improve? (optional)" });
  const send = h("button.primary.big", { disabled: true, on: { click: async () => {
    try {
      await api("POST", "/api/surveys", { kind: "student_case", attemptId, answers: { ...a, ...(comment.value.trim() ? { comment: comment.value.trim() } : {}) } });
      card.replaceChildren(h("p", "Thank you for your feedback."));
    } catch (e) {
      status.textContent = e instanceof ApiError && e.status === 409 ? "You already sent feedback for this case." : "Could not send feedback.";
    }
  } } }, "Send feedback");
  const check = () => (send.disabled = a.usedHand === undefined || a.useful === undefined || (a.usedHand && a.trackingReliable === undefined));
  const card = h(
    "section.card.survey",
    h("h2", "Quick feedback"),
    yesNo("Did you use hand tracking?", (v) => {
      a.usedHand = v;
      reliability.hidden = !v;
      if (!v) delete a.trackingReliable;
      check();
    }),
    reliability,
    ratingRow("How useful was this case for your learning?", (n) => ((a.useful = n), check())),
    comment,
    h("div.row", send),
    status,
  );
  return card;
}

/** End-of-course survey (PRD pilot metrics), opened from the sessions screen. */
export function courseSurvey(courseId: string, courseLabel: string, done: () => void): void {
  const a: { trackingReliable?: boolean; useful?: number } = {};
  const comment = h("textarea", { rows: 3, "aria-label": "Comment (optional)", placeholder: "Comments (optional)" });
  const status = h("p.error", { role: "alert" });
  const send = h("button.primary.big", { disabled: true, on: { click: async () => {
    try {
      await api("POST", "/api/surveys", { kind: "student_course", courseId, answers: { ...a, ...(comment.value.trim() ? { comment: comment.value.trim() } : {}) } });
      close();
      done();
    } catch (e) {
      status.textContent = e instanceof ApiError && e.status === 409 ? "You already answered this survey." : "Could not send feedback.";
    }
  } } }, "Send");
  const check = () => (send.disabled = a.trackingReliable === undefined || a.useful === undefined);
  const close = modal(
    h(
      "div",
      h("h2", `Course feedback · ${courseLabel}`),
      yesNo("Overall, was hand tracking reliable?", (v) => ((a.trackingReliable = v), check())),
      ratingRow("Overall, how useful were the cases for your learning?", (n) => ((a.useful = n), check())),
      comment,
      h("div.row", send, h("button.big", { on: { click: () => close() } }, "Later")),
      status,
    ),
    { label: "Course feedback" },
  );
}
