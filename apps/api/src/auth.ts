import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { FastifyReply, FastifyRequest } from "fastify";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export type Role = "student" | "instructor" | "case_author" | "admin";

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  role: Role;
}

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(pw, salt, 64);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(pw: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [algo, saltB64, hashB64] = stored.split("$");
  if (algo !== "scrypt" || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, "base64");
  const actual = await scrypt(pw, Buffer.from(saltB64, "base64"), expected.length);
  return timingSafeEqual(actual, expected);
}

/**
 * Where credentials are checked. Stage 1 ships local accounts; an LDAP/SSO provider can be
 * plugged in once the university confirms what it has (PRD open question).
 */
export interface AuthProvider {
  authenticate(username: string, password: string): Promise<AuthUser | null>;
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: AuthUser;
    user: AuthUser;
  }
}

/** Route guard: valid token and one of the allowed roles. */
export const requireRole =
  (...roles: Role[]) =>
  async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      await req.jwtVerify();
    } catch {
      return reply.code(401).send({ error: "not signed in" });
    }
    if (roles.length && !roles.includes(req.user.role)) return reply.code(403).send({ error: "not allowed for your role" });
  };
