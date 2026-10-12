import type { GestureEvent } from "@sim/tracking";
import { ACTIONS, EXAM_POINTS, EXAM_POINTS_BY_ID, TESTS, TESTS_BY_ID, type ExamTool, type StudentCase } from "@sim/shared";
import { api, liveSocket } from "../api.js";
import type { Ctx } from "../context.js";
import type { LoggedAction } from "@sim/engine";
import { CaseRuntime } from "../player/case-runtime.js";
import type { SimScene as SimSceneT, View } from "../scene/scene.js";
import { ActionRecorder } from "../sync.js";
import { fmtTime, h, icon, modal, mount, toast, type IconName } from "../ui.js";
import { drawPreview } from "./calibration.js";
import type { Debrief } from "./debrief.js";

type Panel = "history" | "exam" | "investigations" | "management" | "diagnosis";

interface AttemptPayload {
  attempt: { id: string; sessionId: string; caseId: string; status: string };
  sessionStatus: string;
  case: StudentCase;
  actions: (LoggedAction & { id?: string; seq?: number })[];
}

const TOOLS: { id: ExamTool; label: string }[] = [
  { id: "hands", label: "Hands" },
  { id: "stethoscope", label: "Stethoscope" },
  { id: "penlight", label: "Penlight" },
  { id: "hammer", label: "Reflex hammer" },
  { id: "bp_cuff", label: "BP cuff" },
  { id: "thermometer", label: "Thermometer" },
];
const TOPICS: Record<string, string> = {
  presenting_complaint: "Presenting complaint",
  past_history: "Past history",
  drugs: "Drugs",
  allergies: "Allergies",
  social: "Social",
  family: "Family",
  systems_review: "Systems review",
};
const VIEW_LABEL: Record<View, string> = { overview: "Whole patient", chest: "Chest", head: "Head", back: "Back" };
const GENERIC_TURNAROUND_MIN = 2;
const PANELS: { id: Panel; label: string; title: string; icon: IconName }[] = [
  { id: "history", label: "History", title: "History", icon: "history" },
  { id: "exam", label: "Examine", title: "Examination", icon: "exam" },
  { id: "investigations", label: "Tests", title: "Investigations", icon: "tests" },
  { id: "management", label: "Manage", title: "Management", icon: "manage" },
  { id: "diagnosis", label: "Diagnosis", title: "Diagnosis", icon: "diagnosis" },
];
/** Selection mark drawn in CSS (a radio dot or a check box); hidden from screen readers. */
const indicator = (kind: "radio" | "check") => h("span", { class: `indicator ${kind}`, "aria-hidden": "true" });
const doneMark = () => h("span.tick", { "aria-hidden": "true" }, icon("check", 16));
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Preview mode for case authors: the same player, but nothing is stored. Results come from the
 * full case and the debrief from the preview scorer.
 */
export interface PreviewMode {
  results: Map<string, { text: string; values?: { name: string; value: string; unit?: string; flag?: string }[]; image?: string; ecg?: string }>;
  score: (actions: readonly LoggedAction[]) => Promise<Debrief>;
}

export async function playerScreen(
  ctx: Ctx,
  payload: AttemptPayload,
  finished: (attemptId: string, sc: StudentCase, preloaded?: Debrief) => void,
  preview?: PreviewMode,
): Promise<void> {
  const sc = payload.case;
  const attemptId = payload.attempt.id;
  const recorder = new ActionRecorder(attemptId, payload.actions, !!preview);
  const rt = new CaseRuntime(sc, payload.actions, recorder, () => ctx.hand.currentSource());
  const canvas = document.getElementById("scene") as HTMLCanvasElement;
  canvas.style.visibility = "visible";
  // The 3D engine loads on demand, so sign-in and the session list stay light.
  const { SimScene } = await import("../scene/scene.js");
  const scene: SimSceneT = new SimScene(canvas);
  let sessionStatus = payload.sessionStatus;
  let panel: Panel | null = null;
  let tool: ExamTool | null = null;
  let checkpointOpen = false;
  let closeTop: (() => void) | null = null;
  let ending = false;
  const results = new Map<string, { text: string; values?: { name: string; value: string; unit?: string; flag?: string }[]; image?: string; ecg?: string }>();
  const unregister: (() => void)[] = [];

  // ---- Layout -------------------------------------------------------------------------------
  const timer = h("span.timer", { "aria-label": "Case time" });
  const timeFill = h("span.time-fill");
  const vitalsEl = h("div.vitals", { "aria-live": "off" });
  const trackChip = h("span.chip");
  const syncChip = h("span.chip");
  const modeBtn = h("button.small.ghost", { on: { click: () => toggleMode() } });
  const caption = h("div.caption", { role: "status", "aria-live": "polite" });
  const setCaption = (who: string, text: string) =>
    caption.replaceChildren(h("span.speaker", { "aria-hidden": "true" }, who === "Nurse" ? icon("user", 20) : who.charAt(0)), h("p", h("strong", `${who}: `), text));
  const panelEl = h("aside.panel", { "aria-live": "polite", hidden: true });
  const viewChip = h("span.chip");
  const previewCanvas = h("canvas.preview", { width: 240, height: 135, hidden: true, "aria-hidden": "true" });
  const previewBtn = h("button.small.ghost", { on: { click: () => (previewCanvas.hidden = !previewCanvas.hidden) } }, "Camera");
  const navBadges = new Map<Panel, HTMLElement>();

  const nav = h(
    "nav.menubar",
    { "aria-label": "Case sections" },
    ...PANELS.map((p) => {
      const badge = h("span.nav-badge", { "aria-hidden": "true" });
      navBadges.set(p.id, badge);
      return h("button.big.nav", { "data-panel": p.id, on: { click: () => openPanel(p.id) } }, icon(p.icon, 24), h("span", p.label), badge);
    }),
    h("span.nav-sep", { "aria-hidden": "true" }),
    h("button.big.nav.finish", { on: { click: () => confirmFinish() } }, icon("finish", 24), h("span", "Finish case")),
  );

  mount(
    h(
      "div.player",
      h(
        "header.hud",
        h("div.case-id", h("strong.case-title", sc.metadata.title), h("span.case-sub", `${sc.patient.name}, ${sc.patient.age} · ${sc.patient.chiefComplaint}`)),
        h("div.clock", icon("clock", 20), timer, h("span.time-track", { "aria-hidden": "true" }, timeFill)),
        vitalsEl,
        h("div.status", viewChip, trackChip, syncChip, modeBtn, previewBtn),
      ),
      panelEl,
      caption,
      nav,
      previewCanvas,
    ),
  );

  // ---- Scene --------------------------------------------------------------------------------
  scene.appearance = sc.patient.appearance;
  await scene.load(sc.patient.model);
  scene.onMarker = (id) => examine(id);
  const syncMarkers = () => {
    unregister.splice(0).forEach((u) => u());
    for (const m of scene.examMarkers)
      unregister.push(
        ctx.hand.register({
          id: `marker-${m.pointId}`,
          rect: () => m.screenRect(),
          activate: () => examine(m.pointId),
          hover: (on) => scene.hoverMarker(m.pointId, on),
        }),
      );
  };

  // ---- Helpers ------------------------------------------------------------------------------
  const say = (who: string, text: string) => {
    setCaption(who, text);
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "en-GB";
      speechSynthesis.speak(u);
    } catch {
      /* no speech engine: captions still show */
    }
  };

  const playSound = (path?: string) => {
    if (!path) return;
    const a = new Audio(`/media/${path}`);
    a.play().catch(() => {});
  };

  const setActiveNav = () => nav.querySelectorAll("[data-panel]").forEach((b) => b.classList.toggle("active", (b as HTMLElement).dataset.panel === panel));

  /** An image or ECG from the case media, enlarged in a modal when clicked or pinched. */
  const figure = (path: string, alt: string) => {
    const img = h("img.media", { src: `/media/${path}`, alt, loading: "lazy" });
    img.addEventListener("error", () => img.replaceWith(h("small.muted", "(image not available — see the text result)")));
    return h(
      "button.media-button",
      {
        "aria-label": `Enlarge ${alt}`,
        on: {
          click: () => {
            const close = modal(h("div", h("img.media-large", { src: `/media/${path}`, alt }), h("button.big", { on: { click: () => (close(), (closeTop = null)) } }, "Close")), {
              label: alt,
              onClose: () => (closeTop = null),
            });
            closeTop = close;
          },
        },
      },
      img,
    );
  };

  const openPanel = (p: Panel | null) => {
    panel = p;
    setActiveNav();
    if (p !== "exam") {
      tool = null;
      scene.showMarkers(null);
      syncMarkers();
    }
    if (p === "diagnosis" && !askCheckpoints(true)) return;
    renderPanel();
  };

  const renderPanel = () => {
    scene.panelOpen = !!panel;
    if (!panel) {
      panelEl.hidden = true;
      return;
    }
    panelEl.hidden = false;
    const same = panelEl.dataset.panel === panel;
    const scrollTop = same ? (panelEl.querySelector(".panel-body")?.scrollTop ?? 0) : 0;
    const [sub, body] =
      panel === "history" ? historyPanel() : panel === "exam" ? examPanel() : panel === "investigations" ? investigationsPanel() : panel === "management" ? managementPanel() : diagnosisPanel();
    const meta = PANELS.find((x) => x.id === panel)!;
    const bodyEl = h("div.panel-body", ...body);
    panelEl.dataset.panel = panel;
    panelEl.classList.toggle("entering", !same);
    panelEl.replaceChildren(
      h(
        "header.panel-head",
        h("span.panel-icon", icon(meta.icon, 24)),
        h("div.panel-titles", h("h2", meta.title), h("p.panel-sub", sub)),
        h("button.close", { "aria-label": "Close panel", on: { click: () => openPanel(null) } }, icon("close", 22)),
      ),
      bodyEl,
    );
    bodyEl.scrollTop = scrollTop;
    updateBadges();
  };
  /** Progress counts on the section buttons (decorative; the panels say the same in words). */
  const updateBadges = () => {
    const n = (type: string) => new Set(rt.actions.filter((a) => a.type === type).map((a) => a.ref)).size;
    const counts: Record<Panel, string> = {
      history: n("history.ask") ? String(n("history.ask")) : "",
      exam: n("exam.perform") ? String(n("exam.perform")) : "",
      investigations: n("investigation.order") ? String(n("investigation.order")) : "",
      management: n("management.give") ? String(n("management.give")) : "",
      diagnosis: rt.has("diagnosis.submit") ? "✓" : "",
    };
    for (const [p, el] of navBadges) {
      el.textContent = counts[p];
      el.hidden = !counts[p];
    }
  };

  // ---- History ------------------------------------------------------------------------------
  let topic = sc.history[0]?.topic ?? "presenting_complaint";
  const historyPanel = () => {
    const topics = [...new Set(sc.history.map((q) => q.topic))];
    const asked = new Set(rt.actions.filter((a) => a.type === "history.ask").map((a) => a.ref)).size;
    return [
      `${asked} of ${sc.history.length} questions asked`,
      [
      h("div.tabs", { role: "group", "aria-label": "Topics" }, ...topics.map((t) => h("button", { class: t === topic ? "active" : "", "aria-pressed": t === topic, on: { click: () => ((topic = t), renderPanel()) } }, TOPICS[t] ?? t))),
      h(
        "div.list",
        ...sc.history
          .filter((q) => q.topic === topic)
          .map((q) => {
            const asked = rt.has("history.ask", q.id);
            return h(
              "button.item",
              { class: asked ? "item done" : "item", on: { click: () => ask(q.id) } },
              h("span.item-label", q.text),
              asked ? h("small.answer", `“${q.answer}”`) : null,
              asked ? doneMark() : null,
            );
          }),
      ),
      ],
    ] as const;
  };
  const ask = (id: string) => {
    const q = sc.history.find((x) => x.id === id)!;
    if (!rt.has("history.ask", id)) rt.record("history.ask", id);
    say(sc.patient.name.split(" ")[0] ?? "Patient", q.answer);
    renderPanel();
  };

  // ---- Examination --------------------------------------------------------------------------
  const examPanel = () => {
    const found = rt.actions.filter((a) => a.type === "exam.perform").map((a) => a.ref!);
    const unique = [...new Set(found)];
    return [
      unique.length ? `${plural(unique.length, "finding")} recorded` : "Choose an instrument to begin",
      [
      h("p.hint", icon("info", 20), h("span", "Pick an instrument, then point at a highlighted spot on the patient. Swipe or use the view buttons to turn the patient.")),
      h("h3", "Instrument tray"),
      h("div.tray", { role: "group", "aria-label": "Instrument tray" }, ...TOOLS.map((t) => h("button.tool", { class: tool === t.id ? "tool active" : "tool", "aria-pressed": tool === t.id, on: { click: () => pickTool(t.id) } }, t.label))),
      h("h3", "View"),
      h("div.tabs.segmented", { role: "group", "aria-label": "View" }, ...(["overview", "chest", "head", "back"] as View[]).map((v) => h("button", { class: scene.view === v ? "active" : "", "aria-pressed": scene.view === v, on: { click: () => setView(v) } }, VIEW_LABEL[v]))),
      tool
        ? h(
            "div.group",
            h("h3", "Examine"),
            h("div.list.compact", ...EXAM_POINTS.filter((p) => p.tool === tool).map((p) => h("button.item", { class: found.includes(p.id) ? "item done" : "item", on: { click: () => examine(p.id) } }, h("span.item-label", p.label), found.includes(p.id) ? doneMark() : null))),
          )
        : null,
      unique.length
        ? h(
            "div.findings",
            h("h3", "Findings"),
            ...unique.map((id) => {
              const f = sc.examination.find((e) => e.id === id)?.finding;
              return h(
                "div.finding",
                h("p", h("strong", `${EXAM_POINTS_BY_ID.get(id)?.label}: `), findingText(id)),
                f?.sound ? h("button.small.listen", { on: { click: () => playSound(f.sound) } }, icon("volume", 18), "Listen again") : null,
                f?.image ? figure(f.image, EXAM_POINTS_BY_ID.get(id)?.label ?? "Finding") : null,
              );
            }),
          )
        : null,
      ],
    ] as const;
  };
  const findingText = (id: string) => sc.examination.find((e) => e.id === id)?.finding.text ?? "No abnormality found.";
  const pickTool = (t: ExamTool) => {
    tool = tool === t ? null : t;
    const needsBack = tool && EXAM_POINTS.some((p) => p.tool === tool && p.view === "back") && !EXAM_POINTS.some((p) => p.tool === tool && p.view === "front");
    if (needsBack) scene.setView("back");
    scene.showMarkers(tool);
    syncMarkers();
    renderPanel();
  };
  const setView = (v: View) => {
    scene.setView(v);
    rt.record("view.change", "examination", { view: v });
    syncMarkers();
    viewChip.textContent = VIEW_LABEL[v];
    renderPanel();
  };
  const examine = (id: string) => {
    const point = EXAM_POINTS_BY_ID.get(id);
    if (!point) return;
    rt.record("exam.perform", id, { tool: point.tool });
    const f = sc.examination.find((e) => e.id === id)?.finding;
    say(point.label, f?.text ?? "No abnormality found.");
    playSound(f?.sound);
    if (panel === "exam") renderPanel();
  };

  // ---- Investigations -----------------------------------------------------------------------
  const caseTests = new Map(sc.investigations.map((t) => [t.id, t]));
  const investigationsPanel = () => {
    const status = new Map(rt.investigations().map((s) => [s.id, s]));
    const orderedOther = new Map(rt.actions.filter((a) => a.type === "investigation.order" && !caseTests.has(a.ref!)).map((a) => [a.ref!, a.caseTimeMs]));
    const cats = [...new Set(TESTS.map((t) => t.category))];
    const orderedCount = status.size + orderedOther.size;
    const back = [...status.keys(), ...orderedOther.keys()].filter((id) => results.has(id)).length;
    return [
      orderedCount ? `${orderedCount} ordered · ${back} ${back === 1 ? "result" : "results"} back` : "Nothing ordered yet",
      cats.map((c) =>
        h(
          "div.group",
          h("h3", c[0]!.toUpperCase() + c.slice(1)),
          h(
            "div.list.compact",
            ...TESTS.filter((t) => t.category === c).map((t) => {
              const st = status.get(t.id);
              const other = orderedOther.get(t.id);
              const ordered = !!st || other !== undefined;
              const readyAt = st?.readyAtMs ?? (other !== undefined ? other + GENERIC_TURNAROUND_MIN * 60_000 : 0);
              const ready = ordered && rt.now >= readyAt;
              const res = results.get(t.id);
              return h(
                "div.item",
                { class: ordered ? (ready && res ? "item done has-result" : "item done") : "item" },
                h("span.item-label", t.label),
                !ordered
                  ? h("button.small.order", { on: { click: () => order(t.id) } }, "Order")
                  : !ready
                    ? h("small.pill.pending", icon("clock", 15), `Result in ${fmtTime(readyAt - rt.now)}`)
                    : res
                      ? resultView(res)
                      : h("small.pill.pending", "Fetching result…"),
              );
            }),
          ),
        ),
      ),
    ] as const;
  };
  const resultView = (r: { text: string; values?: { name: string; value: string; unit?: string; flag?: string }[]; image?: string; ecg?: string }) =>
    h(
      "div.result",
      h("p", r.text),
      ...(r.values ?? []).map((v) => h("p", { class: `flag-${v.flag ?? "normal"}` }, `${v.name}: ${v.value} ${v.unit ?? ""}`)),
      r.ecg ? figure(r.ecg, "ECG") : null,
      r.image ? figure(r.image, "Image") : null,
    );
  const order = (id: string) => {
    rt.record("investigation.order", id);
    toast(`${TESTS_BY_ID.get(id)?.label} ordered`);
    renderPanel();
  };
  const fetchReadyResults = async () => {
    for (const s of rt.investigations()) {
      if (!s.ready || results.has(s.id)) continue;
      try {
        if (preview) results.set(s.id, preview.results.get(s.id)!);
        else {
          await recorder.flush();
          const r = await api<{ result: { text: string; values?: [] } }>("GET", `/api/attempts/${attemptId}/investigations/${s.id}?at=${Math.floor(rt.now)}`);
          results.set(s.id, r.result);
        }
        toast(`${TESTS_BY_ID.get(s.id)?.label} result is back`);
        if (panel === "investigations") renderPanel();
      } catch {
        /* offline or not synced yet: retry on the next tick */
      }
    }
    for (const a of rt.actions)
      if (a.type === "investigation.order" && !caseTests.has(a.ref!) && !results.has(a.ref!) && rt.now >= a.caseTimeMs + GENERIC_TURNAROUND_MIN * 60_000) {
        results.set(a.ref!, { text: "No significant abnormality." });
        if (panel === "investigations") renderPanel();
      }
  };

  // ---- Management ---------------------------------------------------------------------------
  const managementPanel = () => {
    const given = new Set(rt.actions.filter((a) => a.type === "management.give").map((a) => a.ref));
    const kinds: [string, string][] = [
      ["drug", "Drugs"],
      ["oxygen", "Oxygen"],
      ["fluid", "Fluids"],
      ["procedure", "Procedures"],
      ["referral", "Referral and disposition"],
    ];
    return [
      given.size ? `${plural(given.size, "action")} given` : "Each choice asks you to confirm",
      kinds.map(([k, label]) =>
        h(
          "div.group",
          h("h3", label),
          h("div.list.compact", ...ACTIONS.filter((a) => a.kind === k).map((a) => h("button.item", { class: given.has(a.id) ? "item done" : "item", on: { click: () => confirmGive(a.id) } }, h("span.item-label", a.label), a.dose ? h("small.dose", a.dose) : null, given.has(a.id) ? doneMark() : null))),
        ),
      ),
    ] as const;
  };
  const confirmGive = (id: string) => {
    const a = ACTIONS.find((x) => x.id === id)!;
    const close = modal(
      h(
        "div",
        h("p.eyebrow", icon("manage", 18), "Confirm order"),
        h("h2", `${a.kind === "referral" ? "Confirm" : "Give"} ${a.label}?`),
        a.dose ? h("p.dose-line", a.dose) : null,
        h(
          "div.row.end",
          h("button.primary.big", { on: { click: () => (close(), give(id)) } }, "Confirm"),
          h("button.big", { on: { click: () => close() } }, "Cancel"),
        ),
      ),
      { onClose: () => (closeTop = null), label: "Confirm action" },
    );
    closeTop = close;
  };
  const give = (id: string) => {
    rt.record("management.give", id);
    toast(`${ACTIONS.find((x) => x.id === id)?.label} given`);
    renderPanel();
  };

  // ---- Diagnosis ----------------------------------------------------------------------------
  let mainDx: string | null = null;
  let diffs: string[] = [];
  const lastDx = [...rt.actions].reverse().find((a) => a.type === "diagnosis.submit") as (LoggedAction & { payload?: { main?: string; differentials?: string[] } }) | undefined;
  if (lastDx?.payload?.main) {
    mainDx = lastDx.payload.main;
    diffs = lastDx.payload.differentials ?? [];
  }
  const diagnosisPanel = () =>
    [
      rt.has("diagnosis.submit") ? "Committed — you can still update it" : "Not committed yet",
      [
      h("h3", "Main diagnosis"),
      h(
        "div.list.compact",
        { role: "radiogroup" },
        ...sc.diagnosis.options.map((o) => h("button.item.choice", { class: mainDx === o.id ? "item choice active" : "item choice", role: "radio", "aria-checked": mainDx === o.id, on: { click: () => ((mainDx = o.id), (diffs = diffs.filter((d) => d !== o.id)), renderPanel()) } }, indicator("radio"), h("span.item-label", o.label))),
      ),
      h("h3", `Differentials (up to ${sc.diagnosis.maxDifferentials})`),
      h(
        "div.list.compact",
        { role: "group", "aria-label": "Differentials" },
        ...sc.diagnosis.options
          .filter((o) => o.id !== mainDx)
          .map((o) =>
            h(
              "button.item",
              {
                class: diffs.includes(o.id) ? "item choice active" : "item choice",
                "aria-pressed": diffs.includes(o.id),
                on: {
                  click: () => {
                    diffs = diffs.includes(o.id) ? diffs.filter((d) => d !== o.id) : diffs.length < sc.diagnosis.maxDifferentials ? [...diffs, o.id] : diffs;
                    renderPanel();
                  },
                },
              },
              indicator("check"),
              h("span.item-label", o.label),
            ),
          ),
      ),
      h(
        "button.primary.big.wide",
        {
          disabled: !mainDx,
          on: {
            click: () => {
              rt.record("diagnosis.submit", undefined, { main: mainDx, differentials: diffs });
              toast("Diagnosis committed. Continue with management, then finish the case.");
              openPanel("management");
            },
          },
        },
        lastDx || rt.has("diagnosis.submit") ? "Update diagnosis" : "Commit diagnosis",
      ),
      ],
    ] as const;

  // ---- Checkpoint questions -----------------------------------------------------------------
  /** Opens the next due question; returns true when none is due. Pauses the case while open. */
  const askCheckpoints = (aboutToDiagnose = false): boolean => {
    if (checkpointOpen) return false;
    const q = rt.due(aboutToDiagnose)[0];
    if (!q) return true;
    checkpointOpen = true;
    rt.clock.pause();
    let selected: string[] = [];
    const multi = q.type === "multiple";
    const body = h("div");
    const render = () =>
      body.replaceChildren(
        h("p.eyebrow", icon("pause", 18), "Checkpoint question — the case is paused"),
        h("h2", q.prompt),
        multi ? h("p.muted", "Select all that apply") : "",
        h(
          "div.list.options",
          ...q.options.map((o) =>
            h(
              "button.item",
              {
                class: selected.includes(o.id) ? "item choice active" : "item choice",
                "aria-pressed": selected.includes(o.id),
                on: { click: () => ((selected = multi ? (selected.includes(o.id) ? selected.filter((s) => s !== o.id) : [...selected, o.id]) : [o.id]), render()) },
              },
              indicator(multi ? "check" : "radio"),
              h("span.item-label", o.label),
            ),
          ),
        ),
        h(
          "button.primary.big.wide",
          {
            disabled: !selected.length,
            on: {
              click: () => {
                rt.record("question.answer", q.id, { selected });
                close();
                checkpointOpen = false;
                if (sessionStatus === "open") rt.clock.start();
                if (askCheckpoints(aboutToDiagnose) && aboutToDiagnose) renderPanel();
              },
            },
          },
          "Submit answer",
        ),
      );
    render();
    const close = modal(body, { label: "Checkpoint question" });
    return false;
  };

  // ---- Hand gestures and input mode -----------------------------------------------------------
  let lastLostLog = -Infinity;
  ctx.hand.onGesture = (e: GestureEvent) => {
    if (e.type === "menu") {
      if (closeTop) {
        closeTop();
        closeTop = null;
      } else if (!checkpointOpen) openPanel(panel ? null : "history");
    } else if (e.type === "swipe") {
      if (document.querySelector("[data-modal]")) return;
      const v = scene.cycleView(e.direction === "right" ? 1 : -1);
      rt.record("view.change", "examination", { view: v });
      viewChip.textContent = VIEW_LABEL[v];
      syncMarkers();
      if (panel === "exam") renderPanel();
    } else if (e.type === "hand-lost" && rt.now - lastLostLog > 30_000) {
      lastLostLog = rt.now;
      rt.record("tracking.lost");
    }
  };
  ctx.hand.onFrame = (s) => {
    if (!previewCanvas.hidden) drawPreview(previewCanvas, ctx, s.landmarks);
  };
  const renderMode = () => {
    modeBtn.textContent = ctx.mode === "hand" ? "Switch to mouse" : "Use hand";
    modeBtn.hidden = ctx.mode === "mouse" && !ctx.hand.videoElement && !ctx.fakeHand;
    previewBtn.hidden = ctx.mode !== "hand";
  };
  const toggleMode = () => {
    ctx.mode = ctx.mode === "hand" ? "mouse" : "hand";
    ctx.hand.enabled = ctx.mode === "hand";
    if (ctx.mode === "mouse") document.getElementById("hand-cursor")!.style.display = "none";
    rt.record("input.switch", undefined, { to: ctx.mode });
    renderMode();
  };
  renderMode();

  // ---- Session control (instructor pause / end) ------------------------------------------------
  let pausedClose: (() => void) | null = null;
  const applySession = (status: string) => {
    sessionStatus = status;
    if (status === "paused" && !pausedClose) {
      rt.clock.pause();
      pausedClose = modal(h("div.center-text", h("span.big-icon", icon("pause", 34)), h("h2", "Paused by your instructor"), h("p.muted", "The case timer is stopped. Please wait.")), { label: "Paused" });
    } else if (status === "open" && pausedClose) {
      pausedClose();
      pausedClose = null;
      if (!checkpointOpen) rt.clock.start();
    } else if (status === "ended") {
      void finishCase(true);
    }
  };
  const stopLive = preview
    ? () => {}
    : liveSocket(payload.attempt.sessionId, (m) => {
        if (m.type === "session" && m.status) applySession(m.status);
      });

  // ---- Main loop ----------------------------------------------------------------------------
  const seenMessages = new Set<string>();
  let lastInvRender = 0;
  const tick = () => {
    if (ending) return;
    const v = rt.vitals();
    scene.vitals = v.values;
    for (const m of v.messages)
      if (!seenMessages.has(m)) {
        seenMessages.add(m);
        toast(m, "warn", 8000);
        setCaption("Nurse", m);
      }
    const x = v.values;
    // Monitor colours: HR green, BP red, RR yellow, SpO₂ cyan, temperature white.
    const vital = (cls: string, label: string, value: string, unit: string, alarm = false) =>
      h("span", { class: `vital ${cls}${alarm ? " alarm" : ""}` }, h("small", label), " ", h("b", value), unit ? h("small.unit", unit) : null);
    vitalsEl.replaceChildren(
      vital("hr", "HR", String(x.hr), "", x.hr > 120 || x.hr < 50),
      vital("bp", "BP", `${x.sbp}/${x.dbp}`, "", x.sbp < 90),
      vital("rr", "RR", String(x.rr), "", x.rr > 24),
      vital("spo2", "SpO₂", String(x.spo2), "%", x.spo2 < 92),
      vital("temp", "T", x.temp.toFixed(1), "°C", x.temp >= 38.5 || x.temp < 35),
    );
    const limit = sc.metadata.timeLimitMin * 60_000;
    timer.textContent = `${fmtTime(rt.now)} / ${fmtTime(limit)}`;
    timeFill.style.width = `${Math.min(100, (rt.now / limit) * 100)}%`;
    timer.parentElement!.classList.toggle("alarm", rt.timeLeftMs < 2 * 60_000);
    updateBadges();
    const st = ctx.mode === "mouse" ? "Mouse" : ctx.hand.status === "tracking" ? "Hand tracking" : ctx.hand.status === "no-hand" ? "Hand not visible" : ctx.hand.status === "poor-light" ? "Lighting too poor" : "Starting camera";
    trackChip.textContent = st;
    trackChip.className = `chip ${ctx.mode === "hand" ? (ctx.hand.status !== "tracking" ? "warn" : "ok") : ""}`;
    if (rt.started && rt.clock.running) askCheckpoints();
    // Refresh result countdowns occasionally; frequent re-renders would disturb hand hover.
    if (panel === "investigations" && Date.now() - lastInvRender > 5000 && rt.investigations().some((s) => !s.ready)) {
      lastInvRender = Date.now();
      renderPanel();
    }
    if (rt.started && rt.timeLeftMs <= 0) void timeUp();
  };
  const loop = setInterval(tick, 500);
  // Hand-tracking health every minute, for the tracking metrics in the pilot report.
  const statsLoop = setInterval(() => {
    if (ctx.mode === "hand" && rt.started && !ending) rt.record("tracking.stats", undefined, { ...ctx.hand.takeStats(), renderFps: Math.round(scene.engine.getFps()) }, "system");
  }, 60_000);
  const resultsLoop = setInterval(() => void fetchReadyResults(), 2000);
  recorder.onStatus = (online, pending) => {
    syncChip.textContent = online ? (pending ? `Saving (${pending})` : "Saved") : recorder.conflict ? "Open in another tab — close the other tab" : `Offline — ${pending} saved on this PC`;
    syncChip.className = `chip ${online ? (pending ? "busy" : "ok") : "warn"}`;
  };
  recorder.start();
  void recorder.flush();

  // ---- Start / resume -----------------------------------------------------------------------
  viewChip.textContent = VIEW_LABEL[scene.view];
  if (!rt.started) {
    const close = modal(
      h(
        "div",
        h("p.eyebrow", icon("user", 18), "Handover"),
        h("h2", sc.patient.handover),
        h("div.patient-card", h("span.avatar", { "aria-hidden": "true" }, sc.patient.name.charAt(0)), h("div", h("strong", sc.patient.name), h("p", `${sc.patient.age} · ${sc.patient.chiefComplaint}`))),
        h(
          "ol.steps",
          ...PANELS.map((p) => h("li", icon(p.icon, 20), h("span", p.title))),
        ),
        h("p.muted", `Time limit ${sc.metadata.timeLimitMin} minutes. Take a history, examine, order tests, then commit a diagnosis and plan.`),
        h(
          "button.primary.big.wide",
          {
            on: {
              click: () => {
                close();
                rt.record("case.start");
                if (sessionStatus === "open") rt.clock.start();
                applySession(sessionStatus);
              },
            },
          },
          "Begin",
        ),
      ),
      { label: "Case handover" },
    );
  } else {
    toast("Resumed where you stopped");
    applySession(sessionStatus);
    if (sessionStatus === "open") rt.clock.start();
  }

  // ---- Finishing ----------------------------------------------------------------------------
  const confirmFinish = () => {
    const close = modal(
      h(
        "div",
        h("p.eyebrow", icon("finish", 18), "Finish"),
        h("h2", "Finish the case?"),
        h("p.muted", "Your score is calculated from the actions you took. You cannot return to the case afterwards."),
        rt.has("diagnosis.submit") ? "" : h("p.callout.warn", icon("alert", 20), h("span", "You have not committed a diagnosis yet.")),
        h("div.row.end", h("button.primary.big", { on: { click: () => (close(), void finishCase(false)) } }, "Finish and see results"), h("button.big", { on: { click: () => close() } }, "Keep going")),
      ),
      { onClose: () => (closeTop = null), label: "Finish case" },
    );
    closeTop = close;
  };
  let timeUpShown = false;
  const timeUp = async () => {
    if (timeUpShown) return;
    timeUpShown = true;
    rt.clock.pause();
    if (!rt.has("diagnosis.submit")) {
      openPanel("diagnosis");
      toast("Time is up. Commit your diagnosis, then the case will finish.", "warn", 10_000);
      const wait = setInterval(() => {
        if (rt.has("diagnosis.submit")) {
          clearInterval(wait);
          void finishCase(false);
        }
      }, 500);
    } else void finishCase(false);
  };
  const finishCase = async (byInstructor: boolean) => {
    if (ending) return;
    ending = true;
    clearInterval(loop);
    clearInterval(resultsLoop);
    clearInterval(statsLoop);
    if (!byInstructor) rt.record("case.end");
    rt.clock.pause();
    document.querySelectorAll("[data-modal]").forEach((m) => m.remove());
    mount(h("main.center", h("div.card.narrow", h("h1", "Saving your attempt…"), h("p", "Please keep this window open."))));
    const synced = await recorder.drain();
    if (!synced && !byInstructor) {
      mount(h("main.center", h("div.card.narrow", h("h1", "Still offline"), h("p", "Your actions are saved on this PC and will upload when the network is back."), h("button.primary.big", { on: { click: () => location.reload() } }, "Try again"))));
      return;
    }
    const previewDebrief = preview ? await preview.score(rt.actions) : undefined;
    if (!byInstructor && !preview) await api("POST", `/api/attempts/${attemptId}/finish`);
    stopLive();
    rt.dispose();
    recorder.clear();
    unregister.forEach((u) => u());
    ctx.hand.onGesture = () => {};
    ctx.hand.onFrame = () => {};
    scene.dispose();
    canvas.style.visibility = "hidden"; // otherwise the last frame stays behind the debrief
    finished(attemptId, sc, previewDebrief);
  };

  tick(); // draw the HUD now rather than after the first interval

  (window as unknown as { __sim?: Record<string, unknown> }).__sim = {
    ...((window as unknown as { __sim?: Record<string, unknown> }).__sim ?? {}),
    runtime: rt,
    scene,
  };
}
