import type { ScoreReport } from "@sim/engine";
import type { StudentCase } from "@sim/shared";
import { api } from "../api.js";
import { itemLabel, labelFor } from "../player/labels.js";
import { fmtTime, h, mount } from "../ui.js";

export interface Debrief {
  report: ScoreReport;
  timeline: { type: string; ref?: string; caseTimeMs: number }[];
  diagnosis: { correct: string; feedback: string | null };
}

const AREA_LABEL: Record<string, string> = {
  history: "History",
  examination: "Examination",
  investigations: "Investigations",
  diagnosis: "Diagnosis",
  management: "Management",
  safety: "Safety",
  questions: "Checkpoint questions",
};

/** Score, pass status, what went well, what was missed, and feedback for each key decision. */
export async function debriefScreen(attemptId: string, sc: StudentCase, back: () => void, preloaded?: Debrief): Promise<void> {
  mount(h("main.center", h("p", "Loading your results…")));
  const d = preloaded ?? (await api<Debrief>("GET", `/api/attempts/${attemptId}/result`));
  const r = d.report;
  const keyItems = r.items.filter((i) => i.key);
  const well = keyItems.filter((i) => i.done);
  const missed = keyItems.filter((i) => !i.done);
  const penalties = r.items.filter((i) => i.points < 0);

  const item = (i: ScoreReport["items"][number]) =>
    h(
      "li",
      h("strong", itemLabel(sc, i.area, i.ref)),
      h("span.muted", ` · ${AREA_LABEL[i.area]}${i.atMs !== undefined ? ` · ${fmtTime(i.atMs)}` : ""}${i.note ? ` · ${i.note}` : ""}`),
      i.feedback ? h("p.feedback", i.feedback) : null,
    );

  mount(
    h(
      "main.page.debrief",
      preloaded ? h("p.warn", "Preview — this play-through was not stored.") : null,
      h("h1", sc.metadata.title),
      h(
        "section.card.score",
        h("div.big-score", `${Math.round(r.totalPct)}%`),
        h("div", { class: r.passed ? "pass" : "fail" }, r.passed ? "Passed" : "Not passed"),
        h("p.muted", `Decisions ${r.decisions.pct}% × ${Math.round(r.weights.decisions * 100)}% + questions ${r.questions.pct}% × ${Math.round(r.weights.questions * 100)}% · pass mark ${r.passMark}%`),
        r.criticalErrors.length ? h("div.critical", h("h3", "Critical error"), ...r.criticalErrors.map((c) => h("p", h("strong", itemLabel(sc, "safety", c.ref)), c.feedback ? ` — ${c.feedback}` : ""))) : null,
        h(
          "table.areas",
          h("thead", h("tr", h("th", "Area"), h("th", "Points"))),
          // Fixed order: stored reports come back from the database with keys reordered.
          h(
            "tbody",
            ...(["history", "examination", "investigations", "diagnosis", "management", "safety"] as const).map((a) => {
              const v = r.areas[a];
              return h("tr", h("td", AREA_LABEL[a]!), h("td", v.max ? `${v.points} / ${v.max}` : `${v.points}`));
            }),
          ),
        ),
      ),
      h("section.card", h("h2", "Correct diagnosis"), h("p", itemLabel(sc, "diagnosis", d.diagnosis.correct)), d.diagnosis.feedback ? h("p.feedback", d.diagnosis.feedback) : null),
      h("section.card", h("h2", `What you missed (${missed.length})`), missed.length ? h("ul", ...missed.map(item)) : h("p", "Nothing — well done.")),
      penalties.length ? h("section.card", h("h2", "Actions that cost points"), h("ul", ...penalties.map(item))) : null,
      h("section.card", h("h2", `What went well (${well.length})`), h("ul", ...well.map(item))),
      h(
        "section.card",
        h("h2", "Your timeline"),
        h("ol.timeline", ...d.timeline.map((t) => h("li", h("span.time", fmtTime(t.caseTimeMs)), labelFor(sc, t.type, t.ref)))),
      ),
      h("button.primary.big", { on: { click: back } }, "Back to sessions"),
    ),
  );
}
