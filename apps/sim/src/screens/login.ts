import { api, auth, ApiError } from "../api.js";
import type { Ctx, User } from "../context.js";
import { h, mount } from "../ui.js";

export function loginScreen(ctx: Ctx, next: () => void): void {
  const err = h("p.error", { role: "alert" });
  const username = h("input", { name: "username", autocomplete: "username", required: true, "aria-label": "Username" });
  const password = h("input", { name: "password", type: "password", autocomplete: "current-password", required: true, "aria-label": "Password" });
  const form = h(
    "form.card.narrow",
    {
      on: {
        submit: async (e) => {
          e.preventDefault();
          err.textContent = "";
          try {
            const r = await api<{ token: string; user: User }>("POST", "/api/auth/login", { username: username.value, password: password.value });
            const preview = new URLSearchParams(location.search).has("preview");
            if (preview ? !["case_author", "admin"].includes(r.user.role) : r.user.role !== "student") {
              err.textContent = preview ? "Preview is for case authors and admins." : "This app is for students. Staff use the dashboard.";
              return;
            }
            auth.token = r.token;
            ctx.user = r.user;
            next();
          } catch (e2) {
            err.textContent = e2 instanceof ApiError && e2.status === 401 ? "Wrong username or password." : "Cannot reach the server. Check the network and try again.";
          }
        },
      },
    },
    h("h1", "Clinical Simulation"),
    h("label", "Username", username),
    h("label", "Password", password),
    h("button.primary", { type: "submit" }, "Sign in"),
    err,
    h("p.muted", h("a", { href: "?labcheck=1" }, "Run the lab check for this seat")),
  );
  mount(h("main.center", form));
  username.focus();
}
