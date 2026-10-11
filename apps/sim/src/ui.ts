/** Minimal DOM helpers: h("div.cls", {attrs}, ...children). */
type Child = Node | string | number | null | undefined | false;
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
      else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
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
  const t = h("div.toast", { class: `toast ${kind}`, role: "status" }, text);
  document.body.append(t);
  setTimeout(() => t.remove(), ms);
}
