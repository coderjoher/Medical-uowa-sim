import { useState } from "react";
import { api, ApiError, download, errorText, token, type Me } from "../api.js";
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
  const [msg, setMsg] = useState<{ ok: boolean; text: string; list?: string[] } | null>(null);
  const canAuthor = me.role === "admin" || me.role === "case_author";

  const importFile = async (f: File) => {
    setMsg(null);
    try {
      let r: { caseId: string; version: number };
      const bytes = await f.arrayBuffer();
      // .xlsx files are zip archives ("PK"); anything else is treated as case JSON.
      const isXlsx = new Uint8Array(bytes.slice(0, 2)).every((b, i) => b === [0x50, 0x4b][i]);
      if (isXlsx) {
        // The filled spreadsheet template goes up as raw bytes.
        const res = await fetch("/api/admin/cases/xlsx", {
          method: "POST",
          headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", authorization: `Bearer ${token.get()}` },
          body: bytes,
        });
        const json = await res.json();
        if (!res.ok) throw new ApiError(res.status, json.error, json.details);
        r = json;
      } else {
        r = await api("POST", "/api/admin/cases", JSON.parse(new TextDecoder().decode(bytes)));
      }
      setMsg({ ok: true, text: `Imported ${r.caseId} as version ${r.version} (draft). Preview it, then sign it off.` });
      reload();
    } catch (e) {
      if (e instanceof ApiError && e.details?.length) setMsg({ ok: false, text: `${e.message} (${e.details.length}):`, list: e.details.map((d) => `${d.path || "case"} — ${d.message}`) });
      else setMsg({ ok: false, text: e instanceof SyntaxError ? `Not valid JSON: ${e.message}` : errorText(e) });
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
          <p className="muted">
            Academics fill in the case template (one tab per part of the case). Upload the filled .xlsx — or a case .json — and it is checked against the case rules and the shared drug, test and
            exam-point lists before it is stored as a new draft version. Problems are listed by tab, row and column.
          </p>
          <div className="row">
            <button onClick={() => download("/api/admin/case-template.xlsx", "case-template.xlsx").catch((e) => setMsg({ ok: false, text: errorText(e) }))}>Download blank template</button>
            <input
              type="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/json,.json"
              aria-label="Case file"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) void importFile(f);
              }}
            />
          </div>
          {msg && (
            <div className={msg.ok ? "note" : "error"} role={msg.ok ? "status" : "alert"}>
              <p>{msg.text}</p>
              {msg.list && (
                <ul className="issues">
                  {msg.list.map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
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
                  {canAuthor && (
                    <button onClick={() => download(`/api/admin/cases/${c.caseId}/${c.version}/xlsx`, `${c.caseId}-v${c.version}.xlsx`).catch((e) => setMsg({ ok: false, text: errorText(e) }))}>
                      Spreadsheet
                    </button>
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
