import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseCsv } from "../src/csv.js";
import { makeSession, makeWorld, PW, type World } from "./setup.js";

let w: World;
beforeAll(async () => {
  w = await makeWorld();
});
afterAll(async () => {
  await w.app.close();
  await w.db.end();
});

const csv = (body: string, who = "admin") => w.app.inject({ method: "POST", url: "/api/admin/users/import", headers: { ...w.as(who), "content-type": "text/csv" }, payload: body });
const login = (username: string, password: string) => w.app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password } });

describe("csv parser", () => {
  it("handles quotes, doubled quotes, semicolons, CRLF and a byte-order mark", () => {
    expect(parseCsv('\uFEFFa;b\r\n"x;1";"say ""hi"""\r\n')).toEqual([
      ["a", "b"],
      ["x;1", 'say "hi"'],
    ]);
    expect(parseCsv("a,b\n1,2\n\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});

describe("user management", () => {
  it("edits a user's name, role and password", async () => {
    const r = await w.app.inject({ method: "PATCH", url: `/api/admin/users/${w.ids.bob}`, headers: w.as("admin"), payload: { displayName: "Bob B", role: "instructor", password: "new-password-1" } });
    expect(r.json()).toMatchObject({ displayName: "Bob B", role: "instructor" });
    expect((await login("bob", "new-password-1")).json().user.role).toBe("instructor");
    expect((await login("bob", PW)).statusCode).toBe(401);
    expect((await w.app.inject({ method: "PATCH", url: `/api/admin/users/${w.ids.admin}`, headers: w.as("admin"), payload: { role: "student" } })).statusCode).toBe(409);
    expect((await w.app.inject({ method: "PATCH", url: `/api/admin/users/${w.ids.alice}`, headers: w.as("instructor"), payload: { role: "admin" } })).statusCode).toBe(403);
  });

  it("imports a roster from CSV, creating, updating and enrolling users", async () => {
    const { courseId } = await makeSession(w);
    const code = (await w.db.query("SELECT code FROM courses WHERE id = $1", [courseId])).rows[0].code;
    const r = await csv(`username,display_name,role,password,courses\nnew1,New One,student,password-123,${code}\nnew2,"Two, New",Student,,${code}\nalice,Alice Updated,student,,\n`);
    expect(r.statusCode).toBe(201);
    expect(r.json()).toEqual({ created: 2, updated: 1, enrolled: 2 });
    expect((await login("new1", "password-123")).statusCode).toBe(200);
    expect((await w.db.query("SELECT display_name FROM users WHERE username = 'new2'")).rows[0].display_name).toBe("Two, New");
    expect((await login("alice", PW)).statusCode).toBe(200); // password kept when the column is empty
  });

  it("imports nothing when any row is wrong, and lists every problem", async () => {
    const before = (await w.db.query("SELECT count(*)::int AS n FROM users")).rows[0].n;
    const r = await csv("username;display_name;role;courses\ngood1;Good;student;\nbad user;Bad;student;\ngood2;;doctor;NOPE-1\ngood1;Again;student;\n");
    expect(r.statusCode).toBe(400);
    expect(r.json().details).toEqual(
      expect.arrayContaining([
        { path: "line 3", message: 'invalid username "bad user"' },
        { path: "line 4", message: "display_name is empty" },
        { path: "line 4", message: 'role must be student, instructor, case_author or admin (got "doctor")' },
        { path: "line 4", message: 'unknown course "NOPE-1"' },
        { path: "line 5", message: 'username "good1" appears twice' },
      ]),
    );
    expect((await w.db.query("SELECT count(*)::int AS n FROM users")).rows[0].n).toBe(before);
    expect((await csv("name,role\nx,student")).statusCode).toBe(400);
    expect((await csv("username,display_name,role\nz1,Z,student", "instructor")).statusCode).toBe(403);
  });

  it("instructors only see their own courses; admins and authors see all", async () => {
    await makeSession(w); // a course the instructor teaches
    await w.app.inject({ method: "POST", url: "/api/admin/courses", headers: w.as("admin"), payload: { code: "OTHER-1", title: "Not theirs" } });
    const mine = (await w.app.inject({ method: "GET", url: "/api/courses", headers: w.as("instructor") })).json().map((c: { code: string }) => c.code);
    expect(mine).not.toContain("OTHER-1");
    expect(mine.length).toBeGreaterThan(0);
    const all = (await w.app.inject({ method: "GET", url: "/api/courses", headers: w.as("admin") })).json().map((c: { code: string }) => c.code);
    expect(all).toContain("OTHER-1");
    expect((await w.app.inject({ method: "GET", url: "/api/courses", headers: w.as("other_instructor") })).json()).toEqual([]);
  });
});
