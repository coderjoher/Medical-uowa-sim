import { api } from "../api.js";
import { h, mount } from "../ui.js";

const KEY = "sim.seat.tools";

/** Lets lab staff say which seat this PC is (remembered on the PC). Resolves to a seat id or null. */
export async function pickSeat(title: string): Promise<string | null> {
  const labs = await api<{ id: string; name: string; seats: { id: string; label: string }[] }[]>("GET", "/api/labs");
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(KEY);
  } catch {
    /* ignore */
  }
  return new Promise((resolve) => {
    const sel = h(
      "select",
      { "aria-label": "Seat" },
      h("option", { value: "" }, "Not at a lab seat"),
      ...labs.map((l) => h("optgroup", { label: l.name }, ...l.seats.map((s) => h("option", { value: s.id, selected: s.id === saved }, `${l.name} · ${s.label}`)))),
    );
    mount(
      h(
        "main.center",
        h(
          "div.card.narrow",
          h("h1", title),
          h("label", "Which seat is this PC?", sel),
          h(
            "button.primary.big",
            {
              on: {
                click: () => {
                  try {
                    if (sel.value) localStorage.setItem(KEY, sel.value);
                  } catch {
                    /* ignore */
                  }
                  resolve(sel.value || null);
                },
              },
            },
            "Continue",
          ),
        ),
      ),
    );
  });
}
