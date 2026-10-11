import { useState } from "react";
import { api, errorText, token } from "../api.js";
import { useGet } from "../hooks.js";

interface User {
  id: string;
  username: string;
  displayName: string;
  role: string;
}

export function UsersPage() {
  const [users, error, reload] = useGet<User[]>("/api/admin/users");
  const [form, setForm] = useState({ username: "", displayName: "", role: "student", password: "" });
  const [msg, setMsg] = useState("");
  const [filter, setFilter] = useState("");
  return (
    <>
      <h1>Users and roles</h1>
      <section className="card">
        <h2>Add a user</h2>
        <form
          className="grid"
          onSubmit={async (e) => {
            e.preventDefault();
            setMsg("");
            try {
              await api("POST", "/api/admin/users", { ...form, ...(form.password ? {} : { password: undefined }) });
              setForm({ username: "", displayName: "", role: form.role, password: "" });
              reload();
            } catch (err) {
              setMsg(errorText(err));
            }
          }}
        >
          <label>
            Username
            <input required value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
          </label>
          <label>
            Full name
            <input required value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
          </label>
          <label>
            Role
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              <option value="student">Student</option>
              <option value="instructor">Instructor</option>
              <option value="case_author">Case author</option>
              <option value="admin">Admin</option>
            </select>
          </label>
          <label>
            Password (8+ characters; leave empty for university sign-in)
            <input type="password" minLength={8} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete="new-password" />
          </label>
          <div className="span2">
            <button className="primary" type="submit">
              Add user
            </button>
            <span className="error">{msg}</span>
          </div>
        </form>
      </section>
      <CsvImport onDone={reload} />
      <section className="card">
        <input placeholder="Filter users" aria-label="Filter users" value={filter} onChange={(e) => setFilter(e.target.value)} />
        {error && <p className="error">{error}</p>}
        <table>
          <thead>
            <tr>
              <th>Username</th>
              <th>Name</th>
              <th>Role</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {users
              ?.filter((u) => `${u.username} ${u.displayName} ${u.role}`.toLowerCase().includes(filter.toLowerCase()))
              .map((u) => (
                <UserRow key={u.id} u={u} onChange={reload} onError={setMsg} />
              ))}
          </tbody>
        </table>
      </section>
    </>
  );
}

function UserRow({ u, onChange, onError }: { u: User; onChange: () => void; onError: (m: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(u.displayName);
  const [role, setRole] = useState(u.role);
  const [password, setPassword] = useState("");
  const save = async () => {
    try {
      await api("PATCH", `/api/admin/users/${u.id}`, { ...(name !== u.displayName ? { displayName: name } : {}), ...(role !== u.role ? { role } : {}), ...(password ? { password } : {}) });
      setEditing(false);
      setPassword("");
      onChange();
    } catch (e) {
      onError(errorText(e));
    }
  };
  if (!editing)
    return (
      <tr>
        <td>{u.username}</td>
        <td>{u.displayName}</td>
        <td>{u.role.replace("_", " ")}</td>
        <td className="actions">
          <button onClick={() => setEditing(true)}>Edit</button>
          <button
            className="link danger"
            onClick={async () => {
              if (!confirm(`Delete ${u.username}?`)) return;
              try {
                await api("DELETE", `/api/admin/users/${u.id}`);
                onChange();
              } catch (e) {
                onError(errorText(e));
              }
            }}
          >
            Delete
          </button>
        </td>
      </tr>
    );
  return (
    <tr>
      <td>{u.username}</td>
      <td>
        <input aria-label={`Name of ${u.username}`} value={name} onChange={(e) => setName(e.target.value)} />
      </td>
      <td>
        <select aria-label={`Role of ${u.username}`} value={role} onChange={(e) => setRole(e.target.value)}>
          <option value="student">Student</option>
          <option value="instructor">Instructor</option>
          <option value="case_author">Case author</option>
          <option value="admin">Admin</option>
        </select>
        <input type="password" minLength={8} placeholder="New password (optional)" aria-label={`New password for ${u.username}`} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
      </td>
      <td className="actions">
        <button className="primary" onClick={save}>
          Save
        </button>
        <button onClick={() => (setEditing(false), setName(u.displayName), setRole(u.role), setPassword(""))}>Cancel</button>
      </td>
    </tr>
  );
}

/** Bulk import of users from a CSV roster. */
function CsvImport({ onDone }: { onDone: () => void }) {
  const [result, setResult] = useState<{ ok: boolean; text: string; list?: string[] } | null>(null);
  const upload = async (text: string) => {
    setResult(null);
    const res = await fetch("/api/admin/users/import", { method: "POST", headers: { "content-type": "text/csv", authorization: `Bearer ${token.get()}` }, body: text });
    const json = await res.json();
    if (res.ok) {
      setResult({ ok: true, text: `Imported: ${json.created} created, ${json.updated} updated, ${json.enrolled} course enrolments.` });
      onDone();
    } else setResult({ ok: false, text: json.error, list: json.details?.map((d: { path: string; message: string }) => `${d.path} — ${d.message}`) });
  };
  return (
    <section className="card">
      <h2>Import users from CSV</h2>
      <p className="muted">
        Columns: <code>username, display_name, role, password, courses</code>. Role is student, instructor, case_author or admin. Leave password empty for university sign-in; separate several course codes with |. Nothing is
        imported if any row has a problem.
      </p>
      <input type="file" accept=".csv,text/csv" aria-label="Users CSV" onChange={async (e) => {
        const f = e.target.files?.[0];
        e.target.value = "";
        if (f) await upload(await f.text());
      }} />
      {result && (
        <div className={result.ok ? "note" : "error"} role={result.ok ? "status" : "alert"}>
          <p>{result.text}</p>
          {result.list && (
            <ul className="issues">
              {result.list.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

export function CoursesPage() {
  const [courses, error, reload] = useGet<{ id: string; code: string; title: string }[]>("/api/courses");
  const [users] = useGet<User[]>("/api/admin/users");
  const [open, setOpen] = useState<string | null>(null);
  const [members, , reloadMembers] = useGet<User[]>(open ? `/api/admin/courses/${open}/members` : null);
  const [form, setForm] = useState({ code: "", title: "" });
  const [pick, setPick] = useState<string[]>([]);
  const [msg, setMsg] = useState("");
  return (
    <>
      <h1>Courses</h1>
      <section className="card">
        <form
          className="row"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await api("POST", "/api/admin/courses", form);
              setForm({ code: "", title: "" });
              reload();
            } catch (err) {
              setMsg(errorText(err));
            }
          }}
        >
          <input required placeholder="Code, e.g. MED-401" aria-label="Course code" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} />
          <input required placeholder="Title" aria-label="Course title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          <button className="primary" type="submit">
            Add course
          </button>
        </form>
        <p className="error">{msg || error}</p>
      </section>
      {courses?.map((c) => (
        <section className="card" key={c.id}>
          <div className="row">
            <h2>
              {c.code} — {c.title}
            </h2>
            <span className="spacer" />
            <button onClick={() => setOpen(open === c.id ? null : c.id)}>{open === c.id ? "Close" : "Members"}</button>
          </div>
          {open === c.id && (
            <>
              <p className="muted">{members?.length ?? 0} members: {members?.map((m) => m.displayName).join(", ")}</p>
              <label>
                Add members
                <select multiple size={8} value={pick} onChange={(e) => setPick([...e.target.selectedOptions].map((o) => o.value))}>
                  {users
                    ?.filter((u) => !members?.some((m) => m.id === u.id) && (u.role === "student" || u.role === "instructor"))
                    .map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.displayName} ({u.username}, {u.role})
                      </option>
                    ))}
                </select>
              </label>
              <button
                className="primary"
                disabled={!pick.length}
                onClick={async () => {
                  await api("POST", `/api/admin/courses/${c.id}/members`, { userIds: pick });
                  setPick([]);
                  reloadMembers();
                }}
              >
                Add selected
              </button>
            </>
          )}
        </section>
      ))}
    </>
  );
}

export function LabsPage() {
  const [labs, error, reload] = useGet<{ id: string; name: string; seats: { id: string; label: string }[] }[]>("/api/labs");
  const [name, setName] = useState("");
  const [count, setCount] = useState(30);
  const [msg, setMsg] = useState("");
  return (
    <>
      <h1>Labs and seats</h1>
      <section className="card">
        <form
          className="row"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await api("POST", "/api/admin/labs", { name, seats: Array.from({ length: count }, (_, i) => `Seat ${String(i + 1).padStart(2, "0")}`) });
              setName("");
              reload();
            } catch (err) {
              setMsg(errorText(err));
            }
          }}
        >
          <input required placeholder="Lab name" aria-label="Lab name" value={name} onChange={(e) => setName(e.target.value)} />
          <label className="inline">
            Seats <input type="number" min={1} max={200} value={count} onChange={(e) => setCount(Number(e.target.value))} />
          </label>
          <button className="primary" type="submit">
            Add lab
          </button>
        </form>
        <p className="error">{msg || error}</p>
      </section>
      <section className="card">
        <table>
          <thead>
            <tr>
              <th>Lab</th>
              <th>Seats</th>
            </tr>
          </thead>
          <tbody>
            {labs?.map((l) => (
              <tr key={l.id}>
                <td>{l.name}</td>
                <td>{l.seats.length}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
