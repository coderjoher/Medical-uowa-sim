# Security review — Stage 1

Scope: the API, the student app, the staff dashboard and the deployment files in this
repository, reviewed against the PRD's security and privacy requirements. Each control below
is checked by an automated test unless marked otherwise.

## Requirements from the PRD

| Requirement | How it is met | Evidence |
|---|---|---|
| University login (LDAP or SSO) | LDAP / Active Directory sign-in with group → role mapping; local accounts kept for a break-glass admin | `apps/api/src/ldap.ts`, `apps/api/test/ldap.test.ts` (real OpenLDAP), `docs/ldap.md` |
| Role-based access | Every route declares the roles allowed; students only reach their own attempts | role-matrix and ownership tests in `apps/api/test/api.test.ts`, `users.test.ts` |
| HTTPS on the LAN | Caddy terminates TLS (`deploy/Caddyfile`); HSTS header from the API | `security.test.ts` (headers); TLS itself to be checked on the server |
| Case answers never sent before needed | Student case view strips relevance, points, correct answers and feedback; results only after ordering + turnaround | `api.test.ts`, `validate-case.test.ts` |
| Webcam video stays in the browser | Tracking runs in a Web Worker on the lab PC; only JSON is ever sent | `e2e/student.spec.ts` (all requests same-origin JSON) |

## Controls added in the review

- **Sign-in rate limit**: 10 attempts per minute per client address *and* username
  (`429 Too many sign-in attempts`). This slows guessing, and it stops repeated failures from
  locking real users out of the university directory. Other seats and other users are not
  affected. (`security.test.ts`)
- **Same response for unknown users**: an unknown username is checked against a dummy password
  hash, so response time and message don't reveal which usernames exist.
- **Security headers and Content Security Policy** (helmet):
  - Sources: `default-src 'self'`; scripts from `'self'` plus `'wasm-unsafe-eval'`, which
    MediaPipe needs to compile WebAssembly.
  - Embedding and plug-ins: `frame-ancestors 'none'`, `object-src 'none'`.
  - Other headers: `nosniff`, HSTS and a referrer policy.
  - Verified: the real MediaPipe pipeline runs under this policy with no violations
    (`e2e/real-tracking.spec.ts`).
- **No tokens in logs**: request logs redact the `token` query parameter used by the live
  WebSocket, and the `Authorization` header. (`security.test.ts`)
- **JWT secret**: at least 32 characters, or the server refuses to start.
- **Investigation results**: a request for a case time ahead of the attempt's elapsed wall time
  is refused, so results cannot be pulled early by editing the request.
- **Proxy awareness**: `trustProxy` behind Caddy, so rate limits and logs use the real client
  address.

## Other findings checked

- **SQL:** all queries are parameterised. The two template strings in `routes/pilot.ts` only
  insert fixed text, never user input.
- **XSS:** there is no `innerHTML`, `eval` or `dangerouslySetInnerHTML`. The student app builds
  the DOM with text nodes, and React escapes the dashboard.
- **Path traversal:** static files are served by `@fastify/static` 10 (patched advisories), and
  encoded `..` paths under `/media/` are refused. (`e2e/pilot.spec.ts`)
- **Dependencies:** `npm audit --omit=dev` reports 0 vulnerabilities. Two fixes were needed:
  `@fastify/jwt` was upgraded to 10 (fast-jwt advisories) and `uuid` was pinned to 11 under
  exceljs.
- **Uploads:**
  - Case spreadsheets and CSV rosters are limited to authors and admins, with a 5 MB body limit.
  - Spreadsheets are parsed in memory and never executed.
  - CSV imports are validated in full before anything is written.
- **Passwords:** stored with scrypt (random salt) and compared in constant time; minimum length 8.
- **CORS:** not enabled; the apps and API share one origin.
- **Preview token:** the dashboard passes it to the preview tab in the URL fragment. The fragment
  is never sent to the server, and the app removes it from the address bar.

## Residual risks and actions for the university

1. **Session tokens:**
   - Tokens are valid for 12 hours and stored in `sessionStorage`, so they disappear when the
     browser is closed.
   - There is no server-side revocation. Deleting a user stops new sign-ins, but a token
     already issued still works until it expires.
   - If immediate revocation is needed, add a token denylist.
2. **TLS certificates:** `tls internal` uses Caddy's own CA. Install its root certificate on the
   lab PCs, or use a university certificate. *(manual, on the server)*
3. **Server hardening (outside this repository):** restrict the server's firewall to the campus
   LAN, rotate `POSTGRES_PASSWORD` and `JWT_SECRET` from the examples, and keep backups on
   separate storage. *(manual)*
4. **Directory service account:** use a read-only account limited to searching users, with LDAPS
   or StartTLS (`docs/ldap.md`).
5. **Data retention:** results and action logs are kept until deleted. Agree the retention
   period with the university and set `RETENTION_DAYS` for backups. *(open question in the PRD)*
6. **Penetration test:** not done. Recommended before the course pilot, on the real server.
