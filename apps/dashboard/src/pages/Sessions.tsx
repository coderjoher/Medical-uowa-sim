import { useState } from "react";
import { api, errorText, type Me } from "../api.js";
import { go } from "../App.js";
import { useGet } from "../hooks.js";

interface SessionRow {
  id: string;
  status: string;
  course: string;
  lab: string;
  startsAt: string;
  endsAt: string;
  allowRetry: boolean;
  cases: { caseId: string; version: number }[];
}

const local = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

export function SessionsPage({ me }: { me: Me }) {
  const [sessions, error, reload] = useGet<SessionRow[]>("/api/sessions");
  const [courses] = useGet<{ id: string; code: string; title: string }[]>("/api/courses");
  const [labs] = useGet<{ id: string; name: string; seats: unknown[] }[]>("/api/labs");
  const [cases] = useGet<{ caseId: string; version: number; title: string; status: string }[]>("/api/admin/cases");
  const now = new Date();
  const [form, setForm] = useState({ courseId: "", labId: "", caseIds: [] as string[], startsAt: local(now), endsAt: local(new Date(now.getTime() + 2 * 3600_000)), allowRetry: false });
  const [msg, setMsg] = useState("");
  const published = (cases ?? []).filter((c) => c.status === "published");

  return (
    <>
      <h1>Sessions</h1>
      <section className="card">
        <h2>Create a session</h2>
        <form
          className="grid"
          onSubmit={async (e) => {
            e.preventDefault();
            setMsg("");
            try {
              const r = await api<{ id: string }>("POST", "/api/sessions", { ...form, startsAt: new Date(form.startsAt).toISOString(), endsAt: new Date(form.endsAt).toISOString() });
              go({ page: "session", id: r.id });
            } catch (err) {
              setMsg(errorText(err));
            }
          }}
        >
          <label>
            Course
            <select required value={form.courseId} onChange={(e) => setForm({ ...form, courseId: e.target.value })}>
              <option value="">Choose…</option>
              {courses?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code} — {c.title}
                </option>
              ))}
            </select>
          </label>
          <label>
            Lab
            <select required value={form.labId} onChange={(e) => setForm({ ...form, labId: e.target.value })}>
              <option value="">Choose…</option>
              {labs?.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name} ({l.seats.length} seats)
                </option>
              ))}
            </select>
          </label>
          <label>
            Opens
            <input type="datetime-local" required value={form.startsAt} onChange={(e) => setForm({ ...form, startsAt: e.target.value })} />
          </label>
          <label>
            Closes
            <input type="datetime-local" required value={form.endsAt} onChange={(e) => setForm({ ...form, endsAt: e.target.value })} />
          </label>
          <fieldset className="span2">
            <legend>Cases</legend>
            {published.length === 0 && <p className="muted">No published cases yet.</p>}
            {published.map((c) => (
              <label key={c.caseId} className="check">
                <input
                  type="checkbox"
                  checked={form.caseIds.includes(c.caseId)}
                  onChange={(e) => setForm({ ...form, caseIds: e.target.checked ? [...form.caseIds, c.caseId] : form.caseIds.filter((x) => x !== c.caseId) })}
                />
                {c.title} <span className="muted">v{c.version}</span>
              </label>
            ))}
          </fieldset>
          <label className="check span2">
            <input type="checkbox" checked={form.allowRetry} onChange={(e) => setForm({ ...form, allowRetry: e.target.checked })} />
            Students may retry cases
          </label>
          <div className="span2">
            <button className="primary" type="submit" disabled={!form.caseIds.length}>
              Create session
            </button>
            <span className="error">{msg}</span>
          </div>
        </form>
      </section>
      <section className="card">
        <h2>{me.role === "admin" ? "All sessions" : "Your sessions"}</h2>
        {error && <p className="error">{error}</p>}
        <table>
          <thead>
            <tr>
              <th>Course</th>
              <th>Lab</th>
              <th>Window</th>
              <th>Cases</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {sessions?.map((s) => (
              <tr key={s.id}>
                <td>{s.course}</td>
                <td>{s.lab}</td>
                <td>
                  {new Date(s.startsAt).toLocaleString()} – {new Date(s.endsAt).toLocaleTimeString()}
                </td>
                <td>{s.cases.map((c) => c.caseId).join(", ")}</td>
                <td>
                  <span className={`badge ${s.status}`}>{s.status}</span>
                </td>
                <td>
                  <button onClick={() => go({ page: "session", id: s.id })}>Open</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <button className="link" onClick={reload}>
          Refresh
        </button>
      </section>
    </>
  );
}
