import { readFileSync } from "node:fs";
import type { ConnectionOptions } from "node:tls";
import { Client, InvalidCredentialsError, type Entry } from "ldapts";
import type { AuthProvider, AuthUser, Role } from "./auth.js";
import type { Db } from "./db.js";

/**
 * University directory sign-in (OpenLDAP or Active Directory).
 *
 * Flow per login: connect (ldaps:// or ldap:// + StartTLS) → bind as the service account (or stay
 * anonymous) → search for exactly one entry matching the user filter → bind as that entry's DN with
 * the supplied password → read display name and groups → map groups to a role → upsert into `users`
 * with password_hash NULL. Configuration lives in environment variables; see docs/ldap.md.
 */

export interface LdapConfig {
  url: string;
  bindDN?: string;
  bindPassword?: string;
  userBase: string;
  /** Search filter; `{username}` is replaced with the RFC 4515-escaped username. */
  userFilter: string;
  displayNameAttr: string;
  groupAttr: string;
  /** Group DNs per role, already normalised (see normaliseDN). */
  groups: Record<Role, string[]>;
  /** Role for users in no mapped group; null refuses them. */
  defaultRole: Role | null;
  tlsCAFile?: string;
  startTLS: boolean;
  /** Upper bound for one whole login against the directory (connect, binds, searches). */
  timeoutMs: number;
}

/** pino-style logger (Fastify's `app.log` fits). Never receives passwords. */
export interface LdapLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

const consoleLogger: LdapLogger = {
  info: (obj, msg) => console.info(msg ?? "", obj),
  warn: (obj, msg) => console.warn(msg ?? "", obj),
  error: (obj, msg) => console.error(msg ?? "", obj),
};

const ROLES_BY_PRIVILEGE: Role[] = ["admin", "instructor", "case_author", "student"];
const ROLE_ENV: Record<Role, string> = {
  admin: "LDAP_ADMIN_GROUPS",
  instructor: "LDAP_INSTRUCTOR_GROUPS",
  case_author: "LDAP_AUTHOR_GROUPS",
  student: "LDAP_STUDENT_GROUPS",
};

/** RFC 4515 escaping of a value placed inside a search filter: `\ * ( )` and NUL become `\XX`. */
export function escapeFilterValue(value: string): string {
  return value.replace(/[\\*()\0]/g, (c) => "\\" + c.charCodeAt(0).toString(16).padStart(2, "0"));
}

/** Lower-cases a DN and removes optional spaces around `,` `=` `+`, so DNs compare reliably. */
export function normaliseDN(dn: string): string {
  return dn.trim().replace(/\s*(?<!\\)([,=+])\s*/g, "$1").toLowerCase();
}

/**
 * Group lists hold whole DNs, which themselves contain commas, so DNs are separated by `;` (or newlines).
 * "cn=sim-admins,ou=groups,dc=uowa,dc=edu,dc=iq; cn=it-staff,ou=groups,dc=uowa,dc=edu,dc=iq"
 */
export function parseGroupList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(/[;\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map(normaliseDN);
}

/** Reads LDAP settings from the environment. Returns null when LDAP_URL is unset (LDAP disabled). Throws on invalid settings. */
export function ldapConfigFromEnv(env: Record<string, string | undefined> = process.env): LdapConfig | null {
  const get = (k: string) => {
    const v = env[k]?.trim();
    return v ? v : undefined;
  };
  const url = get("LDAP_URL");
  if (!url) return null;
  if (!/^ldaps?:\/\/[^/?#]+\/?$/i.test(url)) throw new Error("LDAP_URL must look like ldap://host[:port] or ldaps://host[:port]");

  const userBase = get("LDAP_USER_BASE");
  if (!userBase) throw new Error("LDAP_USER_BASE is required when LDAP_URL is set");

  const userFilter = get("LDAP_USER_FILTER") ?? "(uid={username})";
  if (!userFilter.includes("{username}")) throw new Error("LDAP_USER_FILTER must contain {username}");

  const bindDN = get("LDAP_BIND_DN");
  const bindPassword = env.LDAP_BIND_PASSWORD; // not trimmed: passwords may have spaces
  if (bindDN && !bindPassword) throw new Error("LDAP_BIND_PASSWORD is required when LDAP_BIND_DN is set");

  const rawDefault = (get("LDAP_DEFAULT_ROLE") ?? "student").toLowerCase();
  let defaultRole: Role | null;
  if (rawDefault === "none") defaultRole = null;
  else if ((ROLES_BY_PRIVILEGE as string[]).includes(rawDefault)) defaultRole = rawDefault as Role;
  else throw new Error(`LDAP_DEFAULT_ROLE must be one of ${ROLES_BY_PRIVILEGE.join(", ")}, none`);

  const startTLS = ["1", "true", "yes"].includes((get("LDAP_STARTTLS") ?? "").toLowerCase());
  if (startTLS && url.toLowerCase().startsWith("ldaps:")) throw new Error("LDAP_STARTTLS cannot be combined with an ldaps:// URL");

  const timeoutMs = Number(get("LDAP_TIMEOUT_MS") ?? 5000);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("LDAP_TIMEOUT_MS must be a positive number of milliseconds");

  const groups = Object.fromEntries(ROLES_BY_PRIVILEGE.map((r) => [r, parseGroupList(env[ROLE_ENV[r]])])) as Record<Role, string[]>;

  return {
    url,
    ...(bindDN ? { bindDN, bindPassword } : {}),
    userBase,
    userFilter,
    displayNameAttr: get("LDAP_DISPLAY_NAME_ATTR") ?? "displayName",
    groupAttr: get("LDAP_GROUP_ATTR") ?? "memberOf",
    groups,
    defaultRole,
    ...(get("LDAP_TLS_CA") ? { tlsCAFile: get("LDAP_TLS_CA") } : {}),
    startTLS,
    timeoutMs,
  };
}

/** Highest-privilege role whose group list intersects the user's groups; otherwise the default role (or null). */
export function mapRole(userGroups: string[], config: Pick<LdapConfig, "groups" | "defaultRole">): Role | null {
  const mine = new Set(userGroups.map(normaliseDN));
  for (const role of ROLES_BY_PRIVILEGE) if (config.groups[role].some((g) => mine.has(g))) return role;
  return config.defaultRole;
}

const asStrings = (v: Entry[string] | undefined): string[] => {
  if (v === undefined) return [];
  return (Array.isArray(v) ? v : [v]).map((x) => (Buffer.isBuffer(x) ? x.toString("utf8") : String(x)));
};

class LoginTimeout extends Error {
  constructor(ms: number) {
    super(`LDAP login did not finish within ${ms} ms`);
    this.name = "LoginTimeout";
  }
}

export interface LdapAuthProvider extends AuthProvider {
  /** True when the username belongs to a local account (password_hash set), which must not sign in through LDAP. */
  isLocalAccount(username: string): Promise<boolean>;
}

export interface LdapProviderOptions {
  log?: LdapLogger;
}

/** Authenticates against the directory and keeps the `users` table in step. Never throws for directory problems: returns null and logs. */
export function ldapAuthProvider(db: Db, config: LdapConfig, opts: LdapProviderOptions = {}): LdapAuthProvider {
  const log = opts.log ?? consoleLogger;
  const tlsOptions: ConnectionOptions = { minVersion: "TLSv1.2" };
  // Read once at startup so a missing CA file fails loudly at boot, not at the first login.
  if (config.tlsCAFile) tlsOptions.ca = [readFileSync(config.tlsCAFile)];
  const secure = config.url.toLowerCase().startsWith("ldaps:");
  if (!secure && !config.startTLS) log.warn({ url: config.url }, "LDAP is configured without TLS; passwords will cross the network in clear text. Use ldaps:// or LDAP_STARTTLS=1.");

  async function directoryLogin(username: string, password: string, client: Client): Promise<{ dn: string; displayName: string; groups: string[] } | null> {
    if (config.startTLS) await client.startTLS(tlsOptions);
    if (config.bindDN) await client.bind(config.bindDN, config.bindPassword);

    const filter = config.userFilter.split("{username}").join(escapeFilterValue(username));
    const attributes = [config.displayNameAttr, "cn", config.groupAttr];
    const { searchEntries } = await client.search(config.userBase, { scope: "sub", filter, attributes, sizeLimit: 2 });
    if (searchEntries.length !== 1) {
      if (searchEntries.length > 1) log.warn({ username, matches: searchEntries.length }, "LDAP user filter matched more than one entry; refusing sign-in");
      return null;
    }
    const found = searchEntries[0]!;

    try {
      await client.bind(found.dn, password);
    } catch (e) {
      if (e instanceof InvalidCredentialsError) return null;
      throw e;
    }

    // Re-read as the user where allowed (AD lets users read their own memberOf); fall back to what the service account saw.
    let entry: Entry = found;
    try {
      const self = await client.search(found.dn, { scope: "base", filter: "(objectClass=*)", attributes });
      if (self.searchEntries[0]) entry = self.searchEntries[0];
    } catch {
      /* keep the service-account view */
    }
    const pick = (attr: string, from: Entry) => asStrings(from[attr]).concat(asStrings(found[attr]));
    const displayName = pick(config.displayNameAttr, entry)[0] ?? pick("cn", entry)[0] ?? username;
    const groups = [...new Set(pick(config.groupAttr, entry))];
    return { dn: found.dn, displayName, groups };
  }

  async function withDirectory<T>(fn: (client: Client) => Promise<T>): Promise<T> {
    const client = new Client({
      url: config.url,
      timeout: config.timeoutMs,
      connectTimeout: config.timeoutMs,
      // ldapts switches to implicit TLS whenever tlsOptions is given, so pass it only for ldaps://.
      ...(secure ? { tlsOptions } : {}),
      strictDN: false,
    });
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new LoginTimeout(config.timeoutMs)), config.timeoutMs);
    });
    const work = fn(client);
    work.catch(() => {}); // a late rejection after the deadline must not become an unhandled rejection
    try {
      return await Promise.race([work, deadline]);
    } finally {
      clearTimeout(timer);
      client.unbind().catch(() => {});
    }
  }

  async function isLocalAccount(username: string): Promise<boolean> {
    const { rows } = await db.query("SELECT 1 FROM users WHERE username = $1 AND password_hash IS NOT NULL", [username]);
    return rows.length > 0;
  }

  return {
    isLocalAccount,
    async authenticate(rawUsername, password) {
      const username = rawUsername.trim().toLowerCase();
      // An empty password turns a simple bind into an "unauthenticated bind" that many servers accept.
      if (!username || typeof password !== "string" || password.length === 0) return null;

      let result: Awaited<ReturnType<typeof directoryLogin>>;
      try {
        result = await withDirectory((client) => directoryLogin(username, password, client));
      } catch (e) {
        const err = e as Error & { code?: unknown };
        log.error({ username, err: { name: err.name, message: err.message, code: err.code } }, "LDAP sign-in failed: directory error");
        return null;
      }
      if (!result) return null;

      const role = mapRole(result.groups, config);
      if (!role) {
        log.info({ username, dn: result.dn }, "LDAP user is in no mapped group and LDAP_DEFAULT_ROLE=none; refusing sign-in");
        return null;
      }

      // Local accounts (password_hash set) are never taken over or changed by a directory login.
      const { rows } = await db.query(
        `INSERT INTO users (username, display_name, role, password_hash) VALUES ($1, $2, $3, NULL)
         ON CONFLICT (username) DO UPDATE SET display_name = EXCLUDED.display_name, role = EXCLUDED.role
           WHERE users.password_hash IS NULL
         RETURNING id, username, display_name, role`,
        [username, result.displayName, role],
      );
      const u = rows[0];
      if (!u) {
        log.warn({ username }, "LDAP sign-in refused: a local account with this username exists");
        return null;
      }
      return { id: u.id, username: u.username, displayName: u.display_name, role: u.role } satisfies AuthUser;
    },
  };
}

/**
 * Local accounts (with a password_hash) sign in locally, so the break-glass admin works while the
 * directory is down; everyone else signs in through LDAP. Directory failures yield null, never a 500.
 */
export function combinedAuthProvider(local: AuthProvider, ldap: LdapAuthProvider, opts: LdapProviderOptions = {}): AuthProvider {
  const log = opts.log ?? consoleLogger;
  return {
    async authenticate(rawUsername, password) {
      const username = rawUsername.trim().toLowerCase();
      if (await ldap.isLocalAccount(username)) return local.authenticate(username, password);
      try {
        return await ldap.authenticate(username, password);
      } catch (e) {
        log.error({ username, err: { name: (e as Error).name, message: (e as Error).message } }, "LDAP sign-in failed");
        return null;
      }
    },
  };
}
