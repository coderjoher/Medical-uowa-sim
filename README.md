# UOWA Medical Simulation — Stage 1

A browser-based 3D clinical simulation. Medical students assess and manage a virtual patient
using webcam hand tracking (or the mouse), and are scored on their decisions and on embedded
questions. Everything runs on the university's own server over the campus LAN; webcam video
never leaves the lab PC.

- Product requirements: *Medical Simulation — Stage 1 PRD*
- Delivery phases and test checklists, with current status: [`docs/stage1-phases.md`](docs/stage1-phases.md)
- Screenshots: [`docs/screenshots/`](docs/screenshots)
- Running the lab checks, tracking go/no-go and pilots: [`docs/pilot-runbook.md`](docs/pilot-runbook.md)
- Security review: [`docs/security.md`](docs/security.md) · University login: [`docs/ldap.md`](docs/ldap.md) · Load test: [`docs/load-test.md`](docs/load-test.md)

## What is in the repository

| Path | What it is |
|---|---|
| `packages/shared` | Case JSON schema, shared drug / test / exam-point libraries, case validator, answer-free student view, action log types |
| `packages/engine` | Vital-signs timeline and deterioration, checkpoints, investigation turnaround, case clock, rubric scoring |
| `packages/case-sheet` | Spreadsheet case template (writer) and importer with tab/row/column error messages |
| `packages/tracking` | Hand interaction: One Euro smoothing, pinch hysteresis, gesture holds, swipe, calibration, snapping, synthetic hands for tests |
| `apps/api` | Fastify + PostgreSQL API: auth and roles, courses, labs, versioned cases, sessions, attempts, action sync, scoring, results, Excel/PDF export, live WebSocket. Also serves the two web apps |
| `apps/sim` | Student app (Vite + Babylon.js + MediaPipe in a Web Worker): calibration, 3D room and patient, history / exam / tests / management / diagnosis, checkpoints, debrief, lab check, author preview |
| `apps/dashboard` | Staff dashboard (React) at `/staff/`: sessions, live seats, results and exports, case library, users (with CSV import), courses, labs, seat readiness, score review, pilot report, system health |
| `content/cases` | Case files. `chest-pain-stemi.json` is a reference case built from the PRD's scoring examples; the other two are drafts awaiting academic review |
| `content/assets` | Heart/lung sounds, ECGs and X-rays used by cases, served at `/media/`. Generated placeholders (`npx tsx scripts/generate-assets.ts`), to be replaced by licensed material |
| `tools/loadtest` | Load test that simulates whole labs of students (see `docs/load-test.md`) |
| `assets/models` | Articraft scripts that generate the 3D models, the USDZ → GLB converter and the checks (outputs are in `apps/sim/public/models`) |
| `deploy` | Caddy (HTTPS on the LAN) and the daily backup script |
| `e2e` | Playwright browser tests |

## Run it locally

Requirements: Node 22, PostgreSQL 16.

```bash
npm ci
npm run fetch-mediapipe -w @sim/sim      # copies the MediaPipe runtime + downloads the hand model (once)

# database and demo data
createdb sim
DATABASE_URL=postgres://localhost/sim ADMIN_PASSWORD=admin-pass-123 SEED_DEMO=1 DEMO_PASSWORD=demo-pass-123 npm run seed -w @sim/api

# API on :3000, student app on :5173, dashboard on :5174/staff/
DATABASE_URL=postgres://localhost/sim JWT_SECRET=dev-secret-at-least-32-characters-long npm run dev:api
npm run dev:sim
npm run dev -w @sim/dashboard
```

Demo accounts (with `SEED_DEMO=1`): `instructor`, `author`, `student1`–`student5` with
`DEMO_PASSWORD`, and `admin` with `ADMIN_PASSWORD`. The seed creates course MED-401, "Sim Lab 1"
with 30 seats, every case in `content/cases` (published, reference case first), and an open session.

Useful URLs on the student app:

- `/?labcheck=1`: 2-minute seat check (camera, lighting, tracking and 3D frame rate, headphones),
  saved per seat and shown under **Seat readiness**.
- `/?preview=<caseId>:<version>`: author preview, opened from the case library.

## Tests

```bash
npm run lint && npm run typecheck
npm run validate-cases                    # every file in content/cases
npm test                                  # unit + API integration (needs PostgreSQL: TEST_DATABASE_URL)
npm run build && npm run test:e2e         # browser tests against the built apps (E2E_DATABASE_URL)
```

The API and browser tests drop and recreate the schema of their own databases
(`sim_test`, `sim_e2e` by default). Never point them at a real database.

The hand-tracking tests feed synthetic landmark streams through the same pipeline the camera
uses (`?fakeHand=1` in the browser tests). Accuracy targets (≥ 30 fps, ≤ 100 ms latency, ≥ 95 %
pinches detected) can only be measured with real students in the lab — see Phase 1 in the
phases document.

## Deploy on the university server

```bash
cp .env.example .env        # set SITE_ADDRESS, POSTGRES_PASSWORD, JWT_SECRET, backup settings
docker compose up -d --build
docker compose exec api sh -c 'ADMIN_PASSWORD=... npx tsx apps/api/src/seed.ts'
```

- The image downloads the hand model at build time; at runtime nothing needs the internet.
- Caddy serves HTTPS with its own internal CA (`tls internal`). Install Caddy's root certificate
  on the lab PCs once (`docker compose exec https cat /data/caddy/pki/authorities/local/root.crt`),
  or replace it with the university's certificate in `deploy/Caddyfile`. Browsers only allow the
  webcam on HTTPS.
- Backups: the `backup` service dumps the database daily at `BACKUP_HOUR` (UTC), checks the dump,
  keeps `RETENTION_DAYS` of them in the `backups` volume, and the admin health page shows the last
  success. Run one now with `docker compose exec backup bash /backup.sh now`. Restore with
  `pg_restore --clean -d sim <file>`.
- Students use `https://<SITE_ADDRESS>/`, staff use `https://<SITE_ADDRESS>/staff/`.
- University login: set the `LDAP_*` variables in `.env` ([`docs/ldap.md`](docs/ldap.md)). The
  local `admin` account keeps working as a break-glass login.
- Students can be bulk-loaded from a CSV roster under **Users → Import CSV**.

## Adding a case

Academics write cases in the spreadsheet template — see the
[case authoring guide](docs/case-authoring-guide.md).

1. Get the template from **Case library → Download blank template** (or
   `content/templates/case-template.xlsx`; a filled example sits next to it). Run
   `npm run case-templates` to regenerate both after changing the shared lists.
2. Upload the filled .xlsx in the case library, or check it on the command line with
   `npm run import-case -- case.xlsx` (writes `content/cases/<id>.json`). Problems are listed by
   tab, row and column. Case JSON files can be imported directly too.
3. The author opens **Preview**, plays it, then clicks **Sign off**; an admin clicks **Publish**.
4. To fix only the scoring of a live version, post the corrected case to
   `/api/admin/cases/<id>/<version>/rubric`; stored attempts are re-scored from their action logs.
   Any content change becomes a new version.

## 3D models

Generated with the [Articraft](https://github.com/articraftresearch/Articraft) SDK (Apache-2.0).
See [`assets/models/README.md`](assets/models/README.md) to regenerate them.

For realistic patients, drop a rigged human GLB into `apps/sim/public/models/humans/` — it
replaces the built-in patient automatically. What to provide: [`assets/models/HUMANS.md`](assets/models/HUMANS.md).
Lighting quality (shadows, ambient occlusion, reflections) adapts to the PC; add `?quality=low`
to force the lighter mode on a slow seat.
