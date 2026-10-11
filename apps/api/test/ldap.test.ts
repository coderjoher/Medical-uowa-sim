/**
 * LDAP sign-in against a real OpenLDAP server (slapd), started per test run in a temp directory with
 * its own CA/server certificate, the memberof overlay and ACLs that only let the service account search.
 * Needs the `slapd` binary (apt-get install slapd) and `openssl`; the suite is skipped otherwise.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { Attribute, Change, Client } from "ldapts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { hashPassword } from "../src/auth.js";
import { createDb, migrate, type Db } from "../src/db.js";
import {
  combinedAuthProvider,
  escapeFilterValue,
  ldapAuthProvider,
  ldapConfigFromEnv,
  mapRole,
  normaliseDN,
  type LdapConfig,
  type LdapLogger,
} from "../src/ldap.js";
import { localAuthProvider } from "../src/routes/auth.js";
import { TEST_DB } from "./setup.js";

const SLAPD = ["/usr/sbin/slapd", "/usr/local/libexec/slapd"].find(existsSync);
const BASE = "dc=uowa,dc=test";
const ROOT_DN = `cn=admin,${BASE}`;
const ROOT_PW = "root-secret";
const SVC_DN = `cn=sim-svc,ou=service,${BASE}`;
const SVC_PW = "svc-secret-123";
const PEOPLE = `ou=people,${BASE}`;
const GROUPS = `ou=groups,${BASE}`;
const group = (cn: string) => `cn=${cn},${GROUPS}`;
const person = (uid: string) => `uid=${uid},${PEOPLE}`; // `*` and parentheses need no escaping in a DN (RFC 4514)

// uid → [password, displayName | null, groups]
const USERS: Record<string, [string, string | null, string[]]> = {
  alice: ["alice-pw-1", "Alice Student", ["sim-students"]],
  ivan: ["ivan-pw-1", "Dr Ivan Instructor", ["sim-instructors", "sim-students"]],
  amira: ["amira-pw-1", "Amira Admin", ["sim-students", "sim-authors", "sim-instructors", "sim-admins"]],
  carl: ["carl-pw-1", "Carl Author", ["sim-authors", "sim-students"]],
  nobody: ["nobody-pw-1", "No Groups", []],
  dave: ["dave-pw-1", null, ["sim-students"]],
  eve: ["eve-pw-1", "Eve Before", ["sim-students"]],
  "weird*(name)": ["weird-pw-1", "Weird Name", ["sim-students"]],
  admin: ["ldap-admin-pw", "Directory Admin Impostor", ["sim-admins"]],
  httpuser: ["http-pw-1", "Http User", ["sim-instructors"]],
};
const ALL_PASSWORDS = [ROOT_PW, SVC_PW, ...Object.values(USERS).map((u) => u[0]), "local-admin-pw"];

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });

const waitForPort = async (port: number, ms = 10_000) => {
  const until = Date.now() + ms;
  for (;;) {
    const ok = await new Promise<boolean>((resolve) => {
      const c = net.connect(port, "127.0.0.1", () => (c.end(), resolve(true)));
      c.once("error", () => resolve(false));
    });
    if (ok) return;
    if (Date.now() > until) throw new Error(`slapd did not start listening on ${port}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};

/** TCP proxy in front of slapd: counts connections and can be "unplugged" to simulate an outage. */
function startProxy(targetPort: number) {
  const state = { connections: 0, sockets: new Set<net.Socket>() };
  const server = net.createServer((client) => {
    state.connections++;
    const upstream = net.connect(targetPort, "127.0.0.1");
    for (const s of [client, upstream]) {
      state.sockets.add(s);
      s.on("close", () => state.sockets.delete(s));
      s.on("error", () => s.destroy());
    }
    client.pipe(upstream).pipe(client);
  });
  return new Promise<{ port: number; state: typeof state; close: () => Promise<void> }>((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({
        port: (server.address() as net.AddressInfo).port,
        state,
        close: () => new Promise<void>((r) => (state.sockets.forEach((s) => s.destroy()), server.close(() => r()))),
      }),
    ),
  );
}

/** Accepts TCP connections and never answers: a hung directory server. */
function startBlackHole() {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((s) => {
    sockets.add(s);
    s.on("error", () => {});
  });
  return new Promise<{ port: number; close: () => Promise<void> }>((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ port: (server.address() as net.AddressInfo).port, close: () => new Promise<void>((r) => (sockets.forEach((s) => s.destroy()), server.close(() => r()))) }),
    ),
  );
}

const capturingLog = () => {
  const lines: { level: string; obj: object; msg?: string }[] = [];
  const log: LdapLogger = {
    info: (obj, msg) => lines.push({ level: "info", obj, msg }),
    warn: (obj, msg) => lines.push({ level: "warn", obj, msg }),
    error: (obj, msg) => lines.push({ level: "error", obj, msg }),
  };
  return { log, lines };
};

describe.skipIf(!SLAPD)("LDAP sign-in (real slapd)", () => {
  let dir: string;
  let slapd: ChildProcess | undefined;
  let ldapPort: number;
  let ldapsPort: number;
  let proxy: Awaited<ReturnType<typeof startProxy>>;
  let db: Db;
  let caFile: string;
  const logs = capturingLog();

  /** Env for a provider that talks to slapd through the counting proxy. */
  const baseEnv = (): Record<string, string> => ({
    LDAP_URL: `ldap://127.0.0.1:${proxy.port}`,
    LDAP_BIND_DN: SVC_DN,
    LDAP_BIND_PASSWORD: SVC_PW,
    LDAP_USER_BASE: PEOPLE,
    // Group DNs in a different case/spacing than the server returns: comparison must be case-insensitive.
    LDAP_ADMIN_GROUPS: "CN=Sim-Admins, OU=Groups, DC=uowa, DC=test",
    LDAP_INSTRUCTOR_GROUPS: `${group("sim-instructors")}; ${group("unused-group")}`,
    LDAP_AUTHOR_GROUPS: group("sim-authors"),
    LDAP_STUDENT_GROUPS: group("sim-students"),
    LDAP_TIMEOUT_MS: "3000",
  });
  const cfg = (over: Record<string, string | undefined> = {}): LdapConfig => ldapConfigFromEnv({ ...baseEnv(), ...over })!;
  const provider = (over: Record<string, string | undefined> = {}) => ldapAuthProvider(db, cfg(over), { log: logs.log });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "sim-slapd-"));
    mkdirSync(join(dir, "data"));
    // Throwaway CA and a server certificate for 127.0.0.1.
    const ossl = (...args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
    ossl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.crt", "-days", "2", "-subj", "/CN=Sim Test CA", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign");
    ossl("req", "-newkey", "rsa:2048", "-nodes", "-keyout", "server.key", "-out", "server.csr", "-subj", "/CN=127.0.0.1");
    writeFileSync(join(dir, "ext.cnf"), "subjectAltName=IP:127.0.0.1,DNS:localhost\nextendedKeyUsage=serverAuth\n");
    ossl("x509", "-req", "-in", "server.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", "server.crt", "-days", "2", "-extfile", "ext.cnf");
    caFile = join(dir, "ca.crt");

    writeFileSync(
      join(dir, "slapd.conf"),
      `include /etc/ldap/schema/core.schema
include /etc/ldap/schema/cosine.schema
include /etc/ldap/schema/inetorgperson.schema
include /etc/ldap/schema/nis.schema
modulepath /usr/lib/ldap
moduleload back_mdb
moduleload memberof
pidfile ${dir}/slapd.pid
TLSCACertificateFile ${dir}/ca.crt
TLSCertificateFile ${dir}/server.crt
TLSCertificateKeyFile ${dir}/server.key
database mdb
suffix "${BASE}"
rootdn "${ROOT_DN}"
rootpw ${ROOT_PW}
directory ${dir}/data
overlay memberof
access to attrs=userPassword by self =x by anonymous auth by * none
access to * by dn.exact="${SVC_DN}" read by self read by anonymous auth by * none
`,
    );
    ldapPort = await freePort();
    ldapsPort = await freePort();
    slapd = spawn(SLAPD!, ["-f", join(dir, "slapd.conf"), "-h", `ldap://127.0.0.1:${ldapPort}/ ldaps://127.0.0.1:${ldapsPort}/`, "-d", "0"], { stdio: "ignore" });
    await waitForPort(ldapPort);
    await waitForPort(ldapsPort);

    const admin = new Client({ url: `ldap://127.0.0.1:${ldapPort}` });
    await admin.bind(ROOT_DN, ROOT_PW);
    await admin.add(BASE, { objectClass: ["dcObject", "organization"], dc: "uowa", o: "UOWA Test" });
    for (const ou of ["people", "groups", "service"]) await admin.add(`ou=${ou},${BASE}`, { objectClass: "organizationalUnit", ou });
    await admin.add(SVC_DN, { objectClass: ["organizationalRole", "simpleSecurityObject"], cn: "sim-svc", userPassword: SVC_PW });
    for (const [uid, [pw, displayName]] of Object.entries(USERS)) {
      await admin.add(person(uid), { objectClass: "inetOrgPerson", uid, cn: `${uid} cn`, sn: uid, userPassword: pw, ...(displayName ? { displayName } : {}) });
    }
    for (const g of ["sim-admins", "sim-instructors", "sim-authors", "sim-students", "unused-group"]) {
      const members = Object.entries(USERS)
        .filter(([, [, , groups]]) => groups.includes(g))
        .map(([uid]) => person(uid));
      await admin.add(group(g), { objectClass: "groupOfNames", cn: g, member: members.length ? members : [ROOT_DN] });
    }
    await admin.unbind();

    proxy = await startProxy(ldapPort);
    db = createDb(TEST_DB);
    await db.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
    await migrate(db);
    await db.query("INSERT INTO users (username, display_name, role, password_hash) VALUES ('admin', 'Local Break-glass Admin', 'admin', $1)", [await hashPassword("local-admin-pw")]);
  }, 60_000);

  afterAll(async () => {
    await proxy?.close();
    await db?.end();
    slapd?.kill("SIGTERM");
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    logs.lines.length = 0;
  });

  it("correct password: creates the user with mapped role and display name, no local password", async () => {
    const u = await provider().authenticate("Alice", "alice-pw-1");
    expect(u).toMatchObject({ username: "alice", displayName: "Alice Student", role: "student" });
    const row = (await db.query("SELECT id, display_name, role, password_hash FROM users WHERE username = 'alice'")).rows[0];
    expect(row).toMatchObject({ id: u!.id, display_name: "Alice Student", role: "student", password_hash: null });
  });

  it("falls back to cn when the display name attribute is missing", async () => {
    expect(await provider().authenticate("dave", "dave-pw-1")).toMatchObject({ displayName: "dave cn", role: "student" });
  });

  it("wrong password or unknown user → null", async () => {
    expect(await provider().authenticate("alice", "wrong-password")).toBeNull();
    expect(await provider().authenticate("ghost", "alice-pw-1")).toBeNull();
  });

  it("empty password → null without opening a connection to the directory", async () => {
    const before = proxy.state.connections;
    expect(await provider().authenticate("alice", "")).toBeNull();
    expect(await provider().authenticate("", "alice-pw-1")).toBeNull();
    expect(proxy.state.connections).toBe(before);
  });

  it("escapes filter metacharacters in the username (no LDAP injection)", async () => {
    expect(escapeFilterValue("*)(uid=*")).toBe("\\2a\\29\\28uid=\\2a");
    expect(escapeFilterValue("a\\b\0")).toBe("a\\5cb\\00");
    const p = provider();
    // With a raw filter these would match alice (or everyone) and bind with alice's password.
    for (const evil of ["*)(uid=*", "*", "al*", "alice)(|(uid=*", "*)(|(objectClass=*"]) {
      expect(await p.authenticate(evil, "alice-pw-1"), evil).toBeNull();
    }
    expect((await db.query("SELECT count(*)::int AS n FROM users WHERE username LIKE '%*%' OR username LIKE '%(%'")).rows[0].n).toBe(0);
    // A real uid containing metacharacters still matches exactly once.
    expect(await p.authenticate("weird*(name)", "weird-pw-1")).toMatchObject({ username: "weird*(name)", role: "student" });
  });

  it("maps roles by highest privilege: admin > instructor > case_author > student", async () => {
    const p = provider();
    expect((await p.authenticate("amira", "amira-pw-1"))?.role).toBe("admin");
    expect((await p.authenticate("ivan", "ivan-pw-1"))?.role).toBe("instructor");
    expect((await p.authenticate("carl", "carl-pw-1"))?.role).toBe("case_author");
    expect((await p.authenticate("alice", "alice-pw-1"))?.role).toBe("student");
  });

  it("user in no mapped group: default role student, or refused with LDAP_DEFAULT_ROLE=none", async () => {
    expect(await provider({ LDAP_DEFAULT_ROLE: "none" }).authenticate("nobody", "nobody-pw-1")).toBeNull();
    expect((await db.query("SELECT 1 FROM users WHERE username = 'nobody'")).rowCount).toBe(0);
    expect((await provider().authenticate("nobody", "nobody-pw-1"))?.role).toBe("student");
  });

  it("updates display name and role on each login (same user id)", async () => {
    const first = await provider().authenticate("eve", "eve-pw-1");
    expect(first).toMatchObject({ displayName: "Eve Before", role: "student" });

    const admin = new Client({ url: `ldap://127.0.0.1:${ldapPort}` });
    await admin.bind(ROOT_DN, ROOT_PW);
    await admin.modify(person("eve"), new Change({ operation: "replace", modification: new Attribute({ type: "displayName", values: ["Eve After"] }) }));
    await admin.modify(group("sim-instructors"), new Change({ operation: "add", modification: new Attribute({ type: "member", values: [person("eve")] }) }));
    await admin.unbind();

    const second = await provider().authenticate("eve", "eve-pw-1");
    expect(second).toEqual({ id: first!.id, username: "eve", displayName: "Eve After", role: "instructor" });
    expect((await db.query("SELECT display_name, role FROM users WHERE id = $1", [first!.id])).rows[0]).toEqual({ display_name: "Eve After", role: "instructor" });
  });

  it("refuses sign-in when the service account is missing and anonymous search is not allowed", async () => {
    expect(await provider({ LDAP_BIND_DN: undefined, LDAP_BIND_PASSWORD: undefined }).authenticate("alice", "alice-pw-1")).toBeNull();
  });

  it("never lets a directory account take over or change a local account", async () => {
    // Directory has uid=admin with its own password; the local break-glass admin must stay untouched.
    expect(await provider().authenticate("admin", "ldap-admin-pw")).toBeNull();
    const combined = combinedAuthProvider(localAuthProvider(db), provider(), { log: logs.log });
    expect(await combined.authenticate("admin", "ldap-admin-pw")).toBeNull();
    const row = (await db.query("SELECT display_name, role, password_hash FROM users WHERE username = 'admin'")).rows[0];
    expect(row.display_name).toBe("Local Break-glass Admin");
    expect(row.role).toBe("admin");
    expect(row.password_hash).toMatch(/^scrypt\$/);
  });

  it("local admin still signs in locally while LDAP is unreachable; LDAP users get null quickly", async () => {
    const dead = await freePort(); // nothing listens here
    const combined = combinedAuthProvider(localAuthProvider(db), provider({ LDAP_URL: `ldap://127.0.0.1:${dead}`, LDAP_TIMEOUT_MS: "1000" }), { log: logs.log });
    expect(await combined.authenticate("admin", "local-admin-pw")).toMatchObject({ username: "admin", role: "admin", displayName: "Local Break-glass Admin" });
    expect(await combined.authenticate("admin", "wrong")).toBeNull();
    const t0 = Date.now();
    expect(await combined.authenticate("alice", "alice-pw-1")).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(logs.lines.some((l) => l.level === "error")).toBe(true);
  });

  it("a hung LDAP server (accepts, never answers) cannot hang logins: null within the timeout", async () => {
    const hole = await startBlackHole();
    try {
      for (const extra of [{}, { LDAP_STARTTLS: "1" }, { LDAP_URL: `ldaps://127.0.0.1:${hole.port}` }]) {
        const p = provider({ LDAP_URL: `ldap://127.0.0.1:${hole.port}`, LDAP_TIMEOUT_MS: "500", LDAP_TLS_CA: caFile, ...extra });
        const t0 = Date.now();
        expect(await p.authenticate("alice", "alice-pw-1")).toBeNull();
        expect(Date.now() - t0, JSON.stringify(extra)).toBeLessThan(1500);
      }
    } finally {
      await hole.close();
    }
  });

  it("supports ldaps:// and StartTLS with LDAP_TLS_CA, and rejects untrusted certificates", async () => {
    const ldaps = { LDAP_URL: `ldaps://127.0.0.1:${ldapsPort}`, LDAP_TLS_CA: caFile };
    expect((await provider(ldaps).authenticate("ivan", "ivan-pw-1"))?.role).toBe("instructor");
    const starttls = { LDAP_URL: `ldap://127.0.0.1:${ldapPort}`, LDAP_STARTTLS: "1", LDAP_TLS_CA: caFile };
    expect((await provider(starttls).authenticate("carl", "carl-pw-1"))?.role).toBe("case_author");
    // Without our CA the server certificate is not trusted: refuse, do not fall back to plain text.
    expect(await provider({ ...ldaps, LDAP_TLS_CA: undefined }).authenticate("ivan", "ivan-pw-1")).toBeNull();
    expect(await provider({ ...starttls, LDAP_TLS_CA: undefined }).authenticate("carl", "carl-pw-1")).toBeNull();
  });

  it("never writes passwords to the log", async () => {
    const dead = await freePort();
    const p = provider({ LDAP_URL: `ldap://127.0.0.1:${dead}`, LDAP_TIMEOUT_MS: "500" });
    await p.authenticate("alice", "alice-pw-1");
    await provider().authenticate("alice", "wrong-password");
    await provider({ LDAP_DEFAULT_ROLE: "none" }).authenticate("nobody", "nobody-pw-1");
    await provider().authenticate("admin", "ldap-admin-pw");
    expect(logs.lines.length).toBeGreaterThan(0);
    const text = JSON.stringify(logs.lines);
    for (const pw of [...ALL_PASSWORDS, "wrong-password"]) expect(text).not.toContain(pw);
  });

  describe("through buildApp", () => {
    let app: FastifyInstance;
    let ldapDown = false;
    beforeAll(async () => {
      const live = provider();
      const down = provider({ LDAP_URL: `ldap://127.0.0.1:${await freePort()}`, LDAP_TIMEOUT_MS: "500" });
      const ldap = { isLocalAccount: live.isLocalAccount, authenticate: (u: string, p: string) => (ldapDown ? down : live).authenticate(u, p) };
      app = await buildApp({ db, jwtSecret: "test-secret-0123456789-abcdefghij", authProvider: combinedAuthProvider(localAuthProvider(db), ldap, { log: logs.log }) });
    });
    afterAll(async () => {
      await app.close();
    });

    it("POST /api/auth/login returns a token for an LDAP user", async () => {
      const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "HttpUser", password: "http-pw-1" } });
      expect(r.statusCode).toBe(200);
      const { token, user } = r.json();
      expect(user).toMatchObject({ username: "httpuser", displayName: "Http User", role: "instructor" });
      const me = await app.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${token}` } });
      expect(me.json()).toMatchObject({ id: user.id, role: "instructor" });
    });

    it("wrong password and directory outage give 401 (never 500 or LDAP details); local admin still works", async () => {
      const wrong = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "httpuser", password: "nope-nope" } });
      expect(wrong.statusCode).toBe(401);
      ldapDown = true;
      try {
        const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "httpuser", password: "http-pw-1" } });
        expect(r.statusCode).toBe(401);
        expect(r.json()).toEqual({ error: "wrong username or password" });
        const local = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "local-admin-pw" } });
        expect(local.statusCode).toBe(200);
        expect(local.json().user.role).toBe("admin");
      } finally {
        ldapDown = false;
      }
    });
  });
});

describe("ldapConfigFromEnv", () => {
  const min = { LDAP_URL: "ldaps://ldap.uowa.edu.iq", LDAP_USER_BASE: "ou=people,dc=uowa,dc=edu,dc=iq" };

  it("returns null when LDAP_URL is unset", () => {
    expect(ldapConfigFromEnv({})).toBeNull();
    expect(ldapConfigFromEnv({ LDAP_URL: "  " })).toBeNull();
  });

  it("applies defaults", () => {
    expect(ldapConfigFromEnv(min)).toEqual({
      url: "ldaps://ldap.uowa.edu.iq",
      userBase: min.LDAP_USER_BASE,
      userFilter: "(uid={username})",
      displayNameAttr: "displayName",
      groupAttr: "memberOf",
      groups: { admin: [], instructor: [], case_author: [], student: [] },
      defaultRole: "student",
      startTLS: false,
      timeoutMs: 5000,
    });
  });

  it("parses every setting", () => {
    const c = ldapConfigFromEnv({
      ...min,
      LDAP_URL: "ldap://dc1.uowa.local:389",
      LDAP_BIND_DN: "CN=svc-sim,OU=Service,DC=uowa,DC=local",
      LDAP_BIND_PASSWORD: " pw with spaces ",
      LDAP_USER_FILTER: "(&(objectClass=user)(sAMAccountName={username}))",
      LDAP_DISPLAY_NAME_ATTR: "name",
      LDAP_GROUP_ATTR: "isMemberOf",
      LDAP_ADMIN_GROUPS: "CN=Sim Admins,OU=Groups,DC=uowa,DC=local ; CN=IT, OU=Groups, DC=uowa, DC=local",
      LDAP_DEFAULT_ROLE: "none",
      LDAP_TLS_CA: "/etc/ssl/uowa-ca.pem",
      LDAP_STARTTLS: "1",
      LDAP_TIMEOUT_MS: "2500",
    })!;
    expect(c).toMatchObject({
      bindDN: "CN=svc-sim,OU=Service,DC=uowa,DC=local",
      bindPassword: " pw with spaces ",
      userFilter: "(&(objectClass=user)(sAMAccountName={username}))",
      displayNameAttr: "name",
      groupAttr: "isMemberOf",
      defaultRole: null,
      tlsCAFile: "/etc/ssl/uowa-ca.pem",
      startTLS: true,
      timeoutMs: 2500,
    });
    expect(c.groups.admin).toEqual(["cn=sim admins,ou=groups,dc=uowa,dc=local", "cn=it,ou=groups,dc=uowa,dc=local"]);
  });

  it("rejects invalid settings at startup", () => {
    expect(() => ldapConfigFromEnv({ ...min, LDAP_URL: "http://x" })).toThrow(/LDAP_URL/);
    expect(() => ldapConfigFromEnv({ LDAP_URL: min.LDAP_URL })).toThrow(/LDAP_USER_BASE/);
    expect(() => ldapConfigFromEnv({ ...min, LDAP_USER_FILTER: "(uid=x)" })).toThrow(/\{username\}/);
    expect(() => ldapConfigFromEnv({ ...min, LDAP_BIND_DN: "cn=svc" })).toThrow(/LDAP_BIND_PASSWORD/);
    expect(() => ldapConfigFromEnv({ ...min, LDAP_DEFAULT_ROLE: "superuser" })).toThrow(/LDAP_DEFAULT_ROLE/);
    expect(() => ldapConfigFromEnv({ ...min, LDAP_STARTTLS: "1" })).toThrow(/STARTTLS/);
    expect(() => ldapConfigFromEnv({ ...min, LDAP_TIMEOUT_MS: "soon" })).toThrow(/LDAP_TIMEOUT_MS/);
  });

  it("mapRole compares DNs case- and space-insensitively and picks the highest role", () => {
    const groups = { admin: [normaliseDN("CN=A,DC=x")], instructor: [normaliseDN("cn=i,dc=x")], case_author: [normaliseDN("cn=c,dc=x")], student: [normaliseDN("cn=s,dc=x")] };
    expect(mapRole(["cn=s, dc=x", "CN=C,DC=X"], { groups, defaultRole: null })).toBe("case_author");
    expect(mapRole(["cn=a,dc=x", "cn=s,dc=x"], { groups, defaultRole: null })).toBe("admin");
    expect(mapRole(["cn=other,dc=x"], { groups, defaultRole: null })).toBeNull();
    expect(mapRole([], { groups, defaultRole: "student" })).toBe("student");
  });
});
