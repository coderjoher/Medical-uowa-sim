import { useState } from "react";
import { api, errorText, token, type Me } from "../api.js";
import { useGet } from "../hooks.js";

interface CaseRow {
  caseId: string;
  version: number;
  title: string;
  course: string;
  status: "draft" | "signed_off" | "published" | "retired";
  rubricRevision: number;
  createdAt: string;
}

/**
 * Stage 1 authoring flow: academics fill the template, the dev team imports it here (validated),
 * the author plays it in preview and signs it off, then an admin publishes it to the course.
 */
export function CasesPage({ me }: { me: Me }) {
  const [cases, error, reload] = useGet<CaseRow[]>("/api/admin/cases");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const canAuthor = me.role === "admin" || me.role === "case_author";

  const importFile = async (f: File) => {
    setMsg(null);
    try {
      const json = JSON.parse(await f.text());
      const r = await api<{ caseId: string; version: number }>("POST", "/api/admin/cases", json);
      setMsg({ ok: true, text: `Imported ${r.caseId} as version ${r.version} (draft). Preview it, then sign it off.` });
      reload();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof SyntaxError ? `Not valid JSON: ${e.message}` : errorText(e) });
    }
  };

  const act = async (c: CaseRow, action: "signoff" | "publish") => {
    try {
      await api("POST", `/api/admin/cases/${c.caseId}/${c.version}/${action}`);
      reload();
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) });
    }
  };

  return (
    <>
      <h1>Case library</h1>
      {canAuthor && (
        <section className="card">
          <h2>Import a case</h2>
          <p className="muted">Choose a case JSON file. It is checked against the case schema and the shared drug, test and exam-point lists before it is stored as a new draft version.</p>
          <input type="file" accept="application/json,.json" aria-label="Case file" onChange={(e) => e.target.files?.[0] && importFile(e.target.files[0])} />
          {msg && <p className={msg.ok ? "note" : "error"}>{msg.text}</p>}
        </section>
      )}
      <section className="card">
        {error && <p className="error">{error}</p>}
        <table>
          <thead>
            <tr>
              <th>Case</th>
              <th>Version</th>
              <th>Course</th>
              <th>Status</th>
              <th>Rubric rev.</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {cases?.map((c) => (
              <tr key={`${c.caseId}@${c.version}`}>
                <td>
                  {c.title}
                  <div className="muted small">{c.caseId}</div>
                </td>
                <td>v{c.version}</td>
                <td>{c.course}</td>
                <td>
                  <span className={`badge ${c.status}`}>{c.status.replace("_", " ")}</span>
                </td>
                <td>{c.rubricRevision}</td>
                <td className="actions">
                  {canAuthor && (
                    // The token goes in the fragment (never sent to the server); the app removes it from the URL.
                    <a className="button" href={`/?preview=${encodeURIComponent(`${c.caseId}:${c.version}`)}#token=${encodeURIComponent(token.get() ?? "")}`} target="_blank" rel="noreferrer">
                      Preview
                    </a>
                  )}
                  {canAuthor && c.status === "draft" && <button onClick={() => act(c, "signoff")}>Sign off</button>}
                  {me.role === "admin" && c.status === "signed_off" && (
                    <button className="primary" onClick={() => act(c, "publish")}>
                      Publish
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
