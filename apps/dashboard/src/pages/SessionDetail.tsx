import { useEffect, useMemo, useState } from "react";
import { api, download, errorText, fmtTime, live, type Seat } from "../api.js";
import { useGet } from "../hooks.js";

interface Results {
  results: { attemptId: string; studentName: string; username: string; caseId: string; attemptNo: number; totalPct: number; passed: boolean; criticalErrors: number; questionsPct: number }[];
  cohort: { caseId: string; students: number; meanPct: number; medianPct: number; passRate: number; mostMissed: { ref: string; area: string; missed: number; missedPct: number }[] }[];
}

export function SessionDetail({ id }: { id: string }) {
  const [tab, setTab] = useState<"live" | "results">("live");
  const [seats, setSeats] = useState<Map<string, Seat>>(new Map());
  const [status, setStatus] = useState("");
  const [msg, setMsg] = useState("");
  const [, setTick] = useState(0);

  useEffect(() => {
    setSeats(new Map());
    const stop = live(id, (m) => {
      if (m.type === "session" && m.status) setStatus(m.status);
      if (m.type === "seat" && m.seat) setSeats((prev) => new Map(prev).set(m.seat!.attemptId, m.seat!));
    });
    const t = setInterval(() => setTick((x) => x + 1), 5000);
    return () => {
      stop();
      clearInterval(t);
    };
  }, [id]);

  const control = async (action: "pause" | "resume" | "end") => {
    if (action === "end" && !confirm("End the session for everyone? Running attempts will be closed and scored.")) return;
    try {
      const r = await api<{ status: string }>("POST", `/api/sessions/${id}/${action}`);
      setStatus(r.status);
      if (action === "end") {
        const l = await api<{ seats: Seat[] }>("GET", `/api/sessions/${id}/live`);
        setSeats(new Map(l.seats.map((s) => [s.attemptId, s])));
      }
    } catch (e) {
      setMsg(errorText(e));
    }
  };

  const retry = async (s: Seat) => {
    try {
      await api("POST", `/api/sessions/${id}/retry`, { studentId: s.studentId, caseId: s.caseId });
      setMsg(`Retry allowed for ${s.studentName}.`);
    } catch (e) {
      setMsg(errorText(e));
    }
  };

  const list = useMemo(() => [...seats.values()].sort((a, b) => (a.seat ?? "~").localeCompare(b.seat ?? "~") || a.studentName.localeCompare(b.studentName) || a.attemptNo - b.attemptNo), [seats]);
  const running = list.filter((s) => s.status === "in_progress").length;

  return (
    <>
      <h1>
        Session <span className={`badge ${status}`}>{status || "…"}</span>
      </h1>
      <div className="toolbar">
        <button className={tab === "live" ? "primary" : ""} onClick={() => setTab("live")}>
          Live seats
        </button>
        <button className={tab === "results" ? "primary" : ""} onClick={() => setTab("results")}>
          Results
        </button>
        <span className="spacer" />
        {status === "open" && <button onClick={() => control("pause")}>Pause for everyone</button>}
        {status === "paused" && <button onClick={() => control("resume")}>Resume</button>}
        {status !== "ended" && (
          <button className="danger" onClick={() => control("end")}>
            End session
          </button>
        )}
      </div>
      {msg && <p className="note">{msg}</p>}
      {tab === "live" ? (
        <section>
          <p className="muted">
            {running} running · {list.length - running} finished
          </p>
          <div className="seats">
            {list.map((s) => (
              <article key={s.attemptId} className={`seat ${s.status} ${s.warnings.length ? "warn" : ""}`} aria-label={`${s.studentName} ${s.seat ?? ""}`}>
                <header>
                  <strong>{s.studentName}</strong>
                  <span className="muted">{s.seat ?? "no seat"}</span>
                </header>
                <p>
                  {s.caseId}
                  {s.attemptNo > 1 ? ` · attempt ${s.attemptNo}` : ""}
                </p>
                <p className="step">{s.step}</p>
                <p className="muted">
                  {fmtTime(s.elapsedMs)} · {s.inputSource ?? "—"}
                </p>
                {s.warnings.map((w) => (
                  <p key={w} className="warning">
                    {w}
                  </p>
                ))}
                {s.status === "finished" && status !== "ended" && <button onClick={() => retry(s)}>Allow retry</button>}
              </article>
            ))}
          </div>
          {list.length === 0 && <p className="muted">No students have joined yet.</p>}
        </section>
      ) : (
        <ResultsView id={id} />
      )}
    </>
  );
}

function ResultsView({ id }: { id: string }) {
  const [r, error, reload] = useGet<Results>(`/api/sessions/${id}/results`);
  const [msg, setMsg] = useState("");
  const dl = (ext: "xlsx" | "pdf") => download(`/api/sessions/${id}/results.${ext}`, `results.${ext}`).catch((e) => setMsg(errorText(e)));
  if (error) return <p className="error">{error}</p>;
  if (!r) return <p>Loading…</p>;
  return (
    <section>
      <div className="toolbar">
        <button onClick={() => dl("xlsx")}>Export to Excel</button>
        <button onClick={() => dl("pdf")}>Export to PDF</button>
        <button className="link" onClick={reload}>
          Refresh
        </button>
        <span className="error">{msg}</span>
      </div>
      {r.cohort.map((c) => (
        <div className="card" key={c.caseId}>
          <h2>{c.caseId}</h2>
          <p>
            {c.students} students · mean {c.meanPct}% · median {c.medianPct}% · pass rate {c.passRate}%
          </p>
          <h3>Most missed decisions</h3>
          <table>
            <tbody>
              {c.mostMissed.map((m) => (
                <tr key={`${m.area}${m.ref}`}>
                  <td>{m.ref}</td>
                  <td className="muted">{m.area}</td>
                  <td>
                    <div className="bar">
                      <span style={{ width: `${m.missedPct}%` }} />
                    </div>
                  </td>
                  <td>{m.missedPct}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      <div className="card">
        <h2>Students</h2>
        <table>
          <thead>
            <tr>
              <th>Student</th>
              <th>Case</th>
              <th>Attempt</th>
              <th>Score</th>
              <th>Result</th>
              <th>Critical errors</th>
              <th>Questions</th>
            </tr>
          </thead>
          <tbody>
            {r.results.map((x) => (
              <tr key={x.attemptId}>
                <td>{x.studentName}</td>
                <td>{x.caseId}</td>
                <td>{x.attemptNo}</td>
                <td>{x.totalPct}%</td>
                <td>
                  <span className={`badge ${x.passed ? "open" : "ended"}`}>{x.passed ? "Passed" : "Not passed"}</span>
                </td>
                <td>{x.criticalErrors}</td>
                <td>{x.questionsPct}%</td>
              </tr>
            ))}
          </tbody>
        </table>
        {r.results.length === 0 && <p className="muted">No finished attempts yet.</p>}
      </div>
    </section>
  );
}
