import { useEffect, useState } from "react";
import { api, token, type Me } from "./api.js";
import { CasesPage } from "./pages/Cases.js";
import { CoursesPage, LabsPage, UsersPage } from "./pages/Admin.js";
import { HealthPage } from "./pages/Health.js";
import { Login } from "./pages/Login.js";
import { PilotPage, ReadinessPage, ScoreReviewPage } from "./pages/Pilot.js";
import { SessionDetail } from "./pages/SessionDetail.js";
import { SessionsPage } from "./pages/Sessions.js";

export type Route =
  | { page: "sessions" }
  | { page: "session"; id: string }
  | { page: "cases" }
  | { page: "review" }
  | { page: "readiness" }
  | { page: "pilot" }
  | { page: "users" }
  | { page: "courses" }
  | { page: "labs" }
  | { page: "health" };

const NAV: { page: Route["page"]; label: string; roles: Me["role"][] }[] = [
  { page: "sessions", label: "Sessions", roles: ["instructor", "admin"] },
  { page: "cases", label: "Case library", roles: ["instructor", "case_author", "admin"] },
  { page: "review", label: "Score review", roles: ["case_author", "admin"] },
  { page: "readiness", label: "Seat readiness", roles: ["instructor", "admin"] },
  { page: "pilot", label: "Pilot report", roles: ["instructor", "admin"] },
  { page: "users", label: "Users", roles: ["admin"] },
  { page: "courses", label: "Courses", roles: ["admin"] },
  { page: "labs", label: "Labs", roles: ["admin"] },
  { page: "health", label: "System health", roles: ["admin"] },
];

const parseHash = (): Route => {
  const [page, id] = location.hash.replace(/^#\/?/, "").split("/");
  if (page === "session" && id) return { page: "session", id };
  return NAV.some((n) => n.page === page) ? ({ page } as Route) : { page: "sessions" };
};

export const go = (r: Route) => {
  location.hash = r.page === "session" ? `/session/${r.id}` : `/${r.page}`;
};

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [ready, setReady] = useState(false);
  const [route, setRoute] = useState<Route>(parseHash());

  useEffect(() => {
    const on = () => setRoute(parseHash());
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);

  useEffect(() => {
    if (!token.get()) return setReady(true);
    api<Me>("GET", "/api/me")
      .then(setMe)
      .catch(() => token.set(null))
      .finally(() => setReady(true));
  }, []);

  if (!ready) return null;
  if (!me) return <Login onLogin={setMe} />;

  const nav = NAV.filter((n) => n.roles.includes(me.role));
  const allowed = nav.some((n) => n.page === (route.page === "session" ? "sessions" : route.page));
  const current: Route = allowed ? route : { page: nav[0]?.page ?? "cases" } as Route;

  return (
    <div className="layout">
      <header>
        <span className="brand">
          <span className="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 20s-8-4.9-8-10.6A4.4 4.4 0 0 1 12 6.6a4.4 4.4 0 0 1 8 2.8C20 15.1 12 20 12 20z" />
            </svg>
          </span>
          <strong>Simulation dashboard</strong>
        </span>
        <nav>
          {nav.map((n) => (
            <a key={n.page} href={`#/${n.page}`} className={current.page === n.page || (current.page === "session" && n.page === "sessions") ? "active" : ""}>
              {n.label}
            </a>
          ))}
        </nav>
        <span className="me">
          {me.displayName} · {me.role.replace("_", " ")}
          <button
            className="link"
            onClick={() => {
              token.set(null);
              setMe(null);
            }}
          >
            Sign out
          </button>
        </span>
      </header>
      <main>
        {current.page === "sessions" && <SessionsPage me={me} />}
        {current.page === "session" && <SessionDetail id={current.id} />}
        {current.page === "cases" && <CasesPage me={me} />}
        {current.page === "review" && <ScoreReviewPage />}
        {current.page === "readiness" && <ReadinessPage />}
        {current.page === "pilot" && <PilotPage me={me} />}
        {current.page === "users" && <UsersPage />}
        {current.page === "courses" && <CoursesPage />}
        {current.page === "labs" && <LabsPage />}
        {current.page === "health" && <HealthPage />}
      </main>
    </div>
  );
}
