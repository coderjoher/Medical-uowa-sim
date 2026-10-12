/** Minimal DOM helpers: h("div.cls", {attrs}, ...children). */
type Child = Node | SVGElement | string | number | null | undefined | false;
type Attrs = Record<string, unknown> & { on?: Record<string, (e: Event) => void> };

export function h<K extends keyof HTMLElementTagNameMap>(tag: K | `${K}.${string}` | `${K}#${string}`, attrs: Attrs | Child = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const [base, ...rest] = tag.split(/(?=[.#])/);
  const el = document.createElement(base as K);
  for (const r of rest) {
    if (r.startsWith(".")) el.classList.add(r.slice(1));
    else el.id = r.slice(1);
  }
  if (attrs && typeof attrs === "object" && !(attrs instanceof Node)) {
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "on") for (const [ev, fn] of Object.entries(v as Record<string, (e: Event) => void>)) el.addEventListener(ev, fn);
      else if (k === "class") el.className = String(v);
      else if (k === "style" && typeof v === "object")
        for (const [prop, val] of Object.entries(v as Record<string, string>)) {
          if (prop.startsWith("--")) el.style.setProperty(prop, val);
          else (el.style as unknown as Record<string, string>)[prop] = val;
        }
      else if (typeof v === "boolean") {
        if (v) el.setAttribute(k, "");
        else el.removeAttribute(k);
      }
      else if (v !== undefined && v !== null) el.setAttribute(k, String(v));
    }
  } else children.unshift(attrs as Child);
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

export const app = () => document.getElementById("app")!;

export function mount(...nodes: Node[]): void {
  app().replaceChildren(...nodes);
}

/** Stroke icons on a 24 × 24 grid. Decorative only: always hidden from screen readers. */
const ICONS = {
  history: ["M21 12a8.5 8.5 0 0 1-12.3 7.6L3.5 21l1.4-4.9A8.5 8.5 0 1 1 21 12z", "M8.5 10.5h7M8.5 14h4.5"],
  exam: ["M5 3.5v5a5 5 0 0 0 10 0v-5", "M10 13.5v2a5 5 0 0 0 10 0v-2.7", "M20 8.6m-2.2 0a2.2 2.2 0 1 0 4.4 0a2.2 2.2 0 1 0-4.4 0"],
  tests: ["M9 3h6M10 3v6.2L4.6 18.4A1.8 1.8 0 0 0 6.2 21h11.6a1.8 1.8 0 0 0 1.6-2.6L14 9.2V3", "M6.8 15h10.4"],
  manage: ["M10.6 20.4a4.9 4.9 0 0 1-7-7l6.8-6.8a4.9 4.9 0 0 1 7 7z", "M7 10l7 7"],
  diagnosis: ["M9 3.5h6v3H9z", "M9 5H6.5A1.5 1.5 0 0 0 5 6.5v13A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5v-13A1.5 1.5 0 0 0 17.5 5H15", "M9 13.5l2.2 2.2 4.3-4.4"],
  finish: ["M5 21V4", "M5 4h12l-2.5 4.2L17 12.5H5"],
  close: ["M6 6l12 12M18 6L6 18"],
  check: ["M5 12.5l4.5 4.5L19 7.5"],
  clock: ["M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0-18 0", "M12 7v5l3.2 2"],
  alert: ["M12 3.5l9.5 16.5h-19z", "M12 10v4.5", "M12 17.3v.2"],
  info: ["M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0-18 0", "M12 11v5.5", "M12 7.8v.2"],
  play: ["M8 5.5l11 6.5-11 6.5z"],
  pause: ["M9 5v14M15 5v14"],
  hand: ["M8 13V6a1.5 1.5 0 0 1 3 0v5", "M11 11V4.5a1.5 1.5 0 0 1 3 0V11", "M14 11V6a1.5 1.5 0 0 1 3 0v6", "M17 9.5a1.5 1.5 0 0 1 3 0v5a6.5 6.5 0 0 1-6.5 6.5h-1.6a6.5 6.5 0 0 1-5.4-2.9L4.2 14.6a1.6 1.6 0 0 1 2.6-1.9L8 14.5"],
  mouse: ["M12 3a6 6 0 0 1 6 6v6a6 6 0 0 1-12 0V9a6 6 0 0 1 6-6z", "M12 7v4"],
  saved: ["M7 18.5a4.8 4.8 0 1 1 .8-9.6A6 6 0 0 1 19.4 10 4.2 4.2 0 0 1 18 18.5z", "M9.5 13.5l2 2 3.5-3.5"],
  offline: ["M7 18.5a4.8 4.8 0 1 1 .8-9.6A6 6 0 0 1 19.4 10 4.2 4.2 0 0 1 18 18.5z", "M4 4l16 16"],
  camera: ["M3.5 8h3.5l2-3h6l2 3h3.5v11.5h-17z", "M12 13.5m-3.5 0a3.5 3.5 0 1 0 7 0a3.5 3.5 0 1 0-7 0"],
  view: ["M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z", "M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0"],
  user: ["M12 8m-4 0a4 4 0 1 0 8 0a4 4 0 1 0-8 0", "M4.5 20.5a7.5 7.5 0 0 1 15 0"],
  volume: ["M4 9.5h3.5L12 5.5v13l-4.5-4H4z", "M15.5 9a4 4 0 0 1 0 6", "M18 6.5a7.5 7.5 0 0 1 0 11"],
  heart: ["M12 20s-8-4.9-8-10.6A4.4 4.4 0 0 1 12 6.6a4.4 4.4 0 0 1 8 2.8C20 15.1 12 20 12 20z"],
  arrow: ["M5 12h14M13 6l6 6-6 6"],
} as const;
export type IconName = keyof typeof ICONS;

export function icon(name: IconName, size = 22): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  for (const [k, v] of Object.entries({ viewBox: "0 0 24 24", width: size, height: size, fill: "none", stroke: "currentColor", "stroke-width": 1.9, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false", class: "icon" }))
    svg.setAttribute(k, String(v));
  for (const d of ICONS[name]) {
    const p = document.createElementNS(ns, "path");
    p.setAttribute("d", d);
    svg.append(p);
  }
  return svg;
}

/** A modal layer. Hand targets are restricted to the top-most modal while one is open. */
export function modal(content: Node, opts: { onClose?: () => void; label?: string } = {}): () => void {
  const layer = h("div.modal", { "data-modal": "", role: "dialog", "aria-modal": "true", "aria-label": opts.label ?? "dialog" }, h("div.modal-card", content));
  document.body.append(layer);
  const close = () => {
    layer.remove();
    opts.onClose?.();
  };
  return close;
}

export const fmtTime = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

export function toast(text: string, kind: "info" | "warn" = "info", ms = 4000): void {
  const t = h("div.toast", { class: `toast ${kind}`, role: "status" }, icon(kind === "warn" ? "alert" : "info", 20), h("span", text));
  // Toasts stack downwards instead of covering each other.
  const shown = document.querySelectorAll(".toast").length;
  t.style.setProperty("--stack", String(shown));
  document.body.append(t);
  setTimeout(() => {
    t.classList.add("leaving");
    setTimeout(() => t.remove(), 200);
  }, ms);
}
