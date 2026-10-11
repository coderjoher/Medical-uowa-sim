import { useState } from "react";
import { api, download, errorText, type Me } from "../api.js";
import { useGet } from "../hooks.js";

interface Metric {
  key: string;
  label: string;
  value: number | null;
  unit: string;
  target: string;
  met: boolean | null;
  basis: string;
}

interface Report {
  generatedAt: string;
  success: Metric[];
  tracking: Metric[];
  counts: { attempts: number; finished: number; surveys: number };
  comments: string[];
}

function MetricTable({ metrics }: { metrics: Metric[] }) {
  return (
    <table>
      <thead>
        <tr>
          <th>Measure</th>
          <th>Result</th>
          <th>Target</th>
          <th />
          <th>Basis</th>
        </tr>
      </thead>
      <tbody>
        {metrics.map((m) => (
          <tr key={m.key}>
            <td>{m.label}</td>
            <td>
              <strong>{m.value === null ? "no data" : `${m.value} ${m.unit}`}</strong>
            </td>
            <td>{m.target}</td>
            <td>{m.met === null ? <span className="muted">—</span> : m.met ? <span className="badge open">met</span> : <span className="badge ended">not met</span>}</td>
            <td className="muted small">{m.basis}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** PRD "Success metrics and pilot plan": the numbers that decide whether Stage 2 starts. */
export function PilotPage({ me }: { me: Me }) {
  const [courses] = useGet<{ id: string; code: string; title: string }[]>("/api/courses");
  const [courseId, setCourseId] = useState("");
  const [report, error, reload] = useGet<Report>(`/api/admin/pilot-report${courseId ? `?courseId=${courseId}` : ""}`);
  const [msg, setMsg] = useState("");
  const [willing, setWilling] = useState<boolean | null>(null);
  const [comment, setComment] = useState("");

  return (
    <>
      <h1>Pilot report</h1>
      <div className="toolbar">
        <label className="inline">
          Course
          <select value={courseId} onChange={(e) => setCourseId(e.target.value)}>
            <option value="">All courses</option>
            {courses?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.code}
              </option>
            ))}
          </select>
        </label>
        <button onClick={reload}>Refresh</button>
        <button onClick={() => download(`/api/admin/pilot-report.xlsx${courseId ? `?courseId=${courseId}` : ""}`, "pilot-report.xlsx").catch((e) => setMsg(errorText(e)))}>Export to Excel</button>
      </div>
      {error && <p className="error">{error}</p>}
      {report && (
        <>
          <section className="card">
            <h2>Success metrics (decide Stage 2)</h2>
            <MetricTable metrics={report.success} />
            <p className="muted small">
              {report.counts.attempts} attempts · {report.counts.finished} finished by the student · {report.counts.surveys} survey answers. Generated {new Date(report.generatedAt).toLocaleString()}.
            </p>
          </section>
          <section className="card">
            <h2>Hand tracking (prototype go/no-go)</h2>
            <p className="muted">From hand-tracking test runs (student app → "Hand-tracking test").</p>
            <MetricTable metrics={report.tracking} />
          </section>
          {report.comments.length > 0 && (
            <section className="card">
              <h2>Comments ({report.comments.length})</h2>
              <ul>
                {report.comments.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
      {me.role === "instructor" && courseId && (
        <section className="card">
          <h2>Your feedback</h2>
          <p>Would you use the simulation with this course again next semester?</p>
          <div className="row">
            <button className={willing === true ? "primary" : ""} onClick={() => setWilling(true)}>
              Yes
            </button>
            <button className={willing === false ? "primary" : ""} onClick={() => setWilling(false)}>
              No
            </button>
            <input placeholder="Comment (optional)" aria-label="Comment" value={comment} onChange={(e) => setComment(e.target.value)} />
            <button
              className="primary"
              disabled={willing === null}
              onClick={async () => {
                try {
                  await api("POST", "/api/surveys", { kind: "instructor", courseId, answers: { willingNextSemester: willing, ...(comment ? { comment } : {}) } });
                  setMsg("Thank you — your answer is recorded.");
                  reload();
                } catch (e) {
                  setMsg(errorText(e));
                }
              }}
            >
              Send
            </button>
          </div>
        </section>
      )}
      {msg && <p className="note">{msg}</p>}
    </>
  );
}

interface SeatCheck {
  seatId: string;
  label: string;
  passed: boolean | null;
  checkedAt: string | null;
  trackingFps: number | null;
  renderFps: number | null;
  lightLevel: number | null;
  cameraOk: boolean | null;
  handSeen: boolean | null;
  audioOk: boolean | null;
}

/** Latest lab check per seat (PRD "Lab check routine"). */
export function ReadinessPage() {
  const [labs] = useGet<{ id: string; name: string }[]>("/api/labs");
  const [labId, setLabId] = useState("");
  const [seats, error, reload] = useGet<SeatCheck[]>(labId ? `/api/admin/lab-readiness?labId=${labId}` : null);
  const today = (d: string | null) => d !== null && new Date(d).toDateString() === new Date().toDateString();
  const ready = seats?.filter((s) => s.passed && today(s.checkedAt)).length ?? 0;
  return (
    <>
      <h1>Seat readiness</h1>
      <div className="toolbar">
        <label className="inline">
          Lab
          <select value={labId} onChange={(e) => setLabId(e.target.value)}>
            <option value="">Choose…</option>
            {labs?.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
        {labId && <button onClick={reload}>Refresh</button>}
        <span className="muted">Run the lab check at each seat: student app → "Lab check for this seat".</span>
      </div>
      {error && <p className="error">{error}</p>}
      {seats && (
        <>
          <p>
            <strong>
              {ready} of {seats.length}
            </strong>{" "}
            seats passed a check today.
          </p>
          <div className="seats">
            {seats.map((s) => (
              <article key={s.seatId} className={`seat ${s.passed && today(s.checkedAt) ? "" : "warn"}`} aria-label={s.label}>
                <header>
                  <strong>{s.label}</strong>
                  <span className={`badge ${s.passed === null ? "" : s.passed ? "open" : "ended"}`}>{s.passed === null ? "never checked" : s.passed ? "ready" : "not ready"}</span>
                </header>
                {s.checkedAt && (
                  <>
                    <p className="muted small">{new Date(s.checkedAt).toLocaleString()}</p>
                    <p className="small">
                      tracking {s.trackingFps ?? "—"} fps · 3D {s.renderFps ?? "—"} fps · light {s.lightLevel ?? "—"}
                    </p>
                    <p className="small">
                      camera {s.cameraOk ? "✓" : "✗"} · hand {s.handSeen ? "✓" : "✗"} · audio {s.audioOk ? "✓" : "✗"}
                    </p>
                  </>
                )}
              </article>
            ))}
          </div>
        </>
      )}
    </>
  );
}

interface Sampled {
  id: string;
  caseVersion: number;
  totalPct: number;
  passed: boolean;
  myVerdict: boolean | null;
  reviews: number;
  agrees: number;
}

interface ReviewView {
  case: { history: { id: string; text: string }[]; examination: { id: string }[]; diagnosis: { options: { id: string; label: string }[] } };
  report: { totalPct: number; passed: boolean; criticalErrors: { ref: string }[]; areas: Record<string, { points: number; max: number }>; items: { area: string; ref: string; key: boolean; done: boolean; points: number }[] };
  timeline: { type: string; ref?: string; caseTimeMs: number; payload?: Record<string, unknown> }[];
  diagnosis: { correct: string };
}

/** PRD: "Academics agreeing scores reflect student performance — majority, on a sample of 20 attempts". */
export function ScoreReviewPage() {
  const [cases] = useGet<{ caseId: string; title: string }[]>("/api/admin/cases");
  const [caseId, setCaseId] = useState("");
  const [sample, error, reload] = useGet<Sampled[]>(caseId ? `/api/admin/score-review?caseId=${encodeURIComponent(caseId)}&size=20` : null);
  const [open, setOpen] = useState<string | null>(null);
  const [view] = useGet<ReviewView>(open ? `/api/admin/score-review/${open}` : null);
  const [comment, setComment] = useState("");
  const [msg, setMsg] = useState("");
  const caseIds = [...new Map((cases ?? []).map((c) => [c.caseId, c.title])).entries()];
  const verdict = async (agrees: boolean) => {
    try {
      await api("POST", `/api/admin/score-review/${open}`, { agrees, ...(comment ? { comment } : {}) });
      setComment("");
      setOpen(null);
      reload();
    } catch (e) {
      setMsg(errorText(e));
    }
  };
  const fmt = (ms: number) => `${String(Math.floor(ms / 60000)).padStart(2, "0")}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;
  return (
    <>
      <h1>Score review</h1>
      <p className="muted">
        Each reviewer sees the same anonymous sample of up to 20 finished attempts. For each, look at what the student did and the score they got, and say whether the score reflects their performance.
      </p>
      <div className="toolbar">
        <label className="inline">
          Case
          <select value={caseId} onChange={(e) => (setCaseId(e.target.value), setOpen(null))}>
            <option value="">Choose…</option>
            {caseIds.map(([id, title]) => (
              <option key={id} value={id}>
                {title}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error && <p className="error">{error}</p>}
      {msg && <p className="error">{msg}</p>}
      {sample && (
        <section className="card">
          <p>
            {sample.filter((s) => s.myVerdict !== null).length} of {sample.length} reviewed by you.
          </p>
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Score</th>
                <th>Result</th>
                <th>Your verdict</th>
                <th>All reviewers</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {sample.map((s, i) => (
                <tr key={s.id}>
                  <td>{i + 1}</td>
                  <td>{s.totalPct}%</td>
                  <td>{s.passed ? "Passed" : "Not passed"}</td>
                  <td>{s.myVerdict === null ? "—" : s.myVerdict ? "Agrees" : "Disagrees"}</td>
                  <td>
                    {s.agrees}/{s.reviews} agree
                  </td>
                  <td>
                    <button onClick={() => setOpen(s.id)}>Review</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {sample.length === 0 && <p className="muted">No finished attempts for this case yet.</p>}
        </section>
      )}
      {open && view && (
        <section className="card" aria-label="Attempt under review">
          <h2>
            Attempt — {view.report.totalPct}% · {view.report.passed ? "Passed" : "Not passed"}
            {view.report.criticalErrors.length > 0 && <span className="badge ended">critical error</span>}
          </h2>
          <div className="grid">
            <div>
              <h3>What the student did</h3>
              <ol className="small">
                {view.timeline.map((t, i) => (
                  <li key={i}>
                    <span className="muted">{fmt(t.caseTimeMs)}</span> {t.type.replace(".", " ")} {t.ref ?? ""}
                    {t.type === "diagnosis.submit" && t.payload ? ` — ${String(t.payload.main)}` : ""}
                  </li>
                ))}
              </ol>
            </div>
            <div>
              <h3>Score by area</h3>
              <table>
                <tbody>
                  {["history", "examination", "investigations", "diagnosis", "management", "safety"].map((a) => (
                    <tr key={a}>
                      <td>{a}</td>
                      <td>
                        {view.report.areas[a]?.points}
                        {view.report.areas[a]?.max ? ` / ${view.report.areas[a]?.max}` : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <h3>Missed key decisions</h3>
              <ul className="small">
                {view.report.items
                  .filter((x) => x.key && !x.done)
                  .map((x) => (
                    <li key={`${x.area}${x.ref}`}>
                      {x.area}: {x.ref}
                    </li>
                  ))}
              </ul>
            </div>
          </div>
          <div className="row">
            <strong>Does this score reflect the student's performance?</strong>
            <button className="primary" onClick={() => verdict(true)}>
              Agree
            </button>
            <button className="danger" onClick={() => verdict(false)}>
              Disagree
            </button>
            <input placeholder="Comment (optional)" aria-label="Review comment" value={comment} onChange={(e) => setComment(e.target.value)} />
          </div>
        </section>
      )}
    </>
  );
}
