# Medical Simulation — Stage 1 Delivery Phases

Source: *Medical Simulation — Stage 1 PRD* (Oct 11, 2026, @Abbas).

This breaks the Stage 1 PRD into build phases. Each phase lists its goal, what it delivers,
and an **exit checklist**: the tests that must pass before the phase is done. Tick items as
they pass and link the evidence (CI run, test report, benchmark sheet, sign-off) next to each one.

Test tags:
`[unit]` automated unit test · `[int]` automated integration/API test · `[e2e]` automated browser test ·
`[perf]` measured benchmark · `[manual]` scripted manual check · `[signoff]` written approval from a named person

Weeks follow the PRD timeline (≈28 weeks from kickoff). Phases 2–6 overlap; the order below is the
dependency order.

## Build status (updated Oct 11, 2026)

Ticked items below are proven by automated tests in this repository (`npm test`: 117 unit and
API tests; `npm run test:e2e`: 6 browser tests). Unticked items still need doing: most need the
real lab, real users or a sign-off, and some are partly built (see notes).

| Phase | Built | Still open |
|---|---|---|
| 0 Foundations | Monorepo, TypeScript, lint, tests, CI workflow, Docker Compose (API + PostgreSQL + Caddy HTTPS + daily backups), production install and serving checked locally | `docker compose up` on the real server (Docker was not available in the build environment), lab PC benchmark, open questions |
| 1 Hand tracking | MediaPipe in a Web Worker, One Euro smoothing, pinch hysteresis, hold timing, open-palm menu, swipe, confidence gating, hand-lost handling, calibration, snapping, cursor, camera preview, lighting warning, lab check page | Everything in the real lab (fps, latency, pinch accuracy, go/no-go); replay tests use synthetic landmarks, not recorded sessions |
| 2 Case model | Schema, shared libraries, validator + CLI, reference case, versioned import in the dashboard | Spreadsheet template and spreadsheet → JSON import; finding sounds, ECG and X-ray images; academics' cases |
| 3 Backend | Auth (local accounts; LDAP/SSO slot), roles, courses, labs, seats, sessions, attempts, idempotent action log, answer-free student payload, results release, live WebSocket, backup + restore script | University directory login; HTTPS on the real LAN |
| 4 Room and player | Articraft models (room, bed, monitor, trolley, tools, 4 patients), breathing/blinking/pain animation, live monitor, all case steps, checkpoints, deterioration, captions + speech, refresh resume | Hand-only full-case replay test; frame-rate and load-time measurement on lab PCs; sound/image assets |
| 5 Scoring | Rubric engine, weighting, critical errors, re-scoring, debrief | Academic review of sample attempts |
| 6 Dashboard | Sessions, live seats, pause/resume/end, retry, results, Excel/PDF, case library with preview → sign-off → publish, users, courses, labs, health | Editing users' roles, bulk user import |
| 7 Hardening | Offline buffering, refresh resume, same-origin only, consent notice, mouse mode | Load test for 2 full labs, crash recovery test, security review, lab check on every seat |
| 8-10 Pilots | — | All |

| # | Phase | Weeks | Gate |
|---|-------|-------|------|
| 0 | Foundations & lab benchmark | 1–2 | — |
| 1 | Hand-tracking prototype | 2–5 | **Tracking go/no-go (wk 5)** |
| 2 | Case model & content pipeline | 3–8 (case writing 3–14) | — |
| 3 | Backend core: auth, courses, sessions, action log | 4–9 | — |
| 4 | 3D room, patients & case player | 6–14 | — |
| 5 | Scoring & debrief | 9–14 | — |
| 6 | Instructor dashboard & admin panel | 9–16 | — |
| 7 | Hardening: non-functional requirements | 13–16 | — |
| 8 | Internal alpha | 15–17 | — |
| 9 | Small pilot | 18–19 | — |
| 10 | Course pilot & review | 20–28 | **Stage 2 decision (wk 28)** |

---

## Phase 0 — Foundations & lab benchmark (weeks 1–2)

**Goal:** a working skeleton deployed on the university server and real numbers for the lab hardware.

**Delivers**
- Monorepo (TypeScript): `sim` (Babylon.js), `web` (React dashboard/admin), `api` (Node.js/NestJS), `shared` (case schema, types).
- Docker Compose stack: API, PostgreSQL, object storage (MinIO or file system), HTTPS on the LAN.
- CI: lint, typecheck, unit tests on every push.
- Benchmark of the actual lab PC, screen, webcam, lighting and background at one seat.
- Answers (or owners + deadlines) for the PRD open questions.

**Exit checklist**
- [ ] `[int]` `docker compose up` on a clean machine brings up all services; health endpoint returns OK.
- [ ] `[manual]` App is reachable over HTTPS from a lab PC on the campus LAN with **no internet** connection.
- [x] `[int]` CI runs lint + typecheck + unit tests and blocks merge on failure. (GitHub Actions run 38146918764 green; also runs build and browser tests. Blocking merges needs a branch-protection rule in GitHub settings.)
- [ ] `[perf]` Babylon.js test scene (placeholder room + one low-poly patient) runs **≥ 60 fps** at native resolution on the lab PC.
- [ ] `[perf]` MediaPipe Hand Landmarker (GPU, Web Worker) runs **≥ 30 fps** on the lab PC while the test scene renders.
- [ ] `[manual]` Webcam (1080p/60fps), lighting and backdrop checked at different times of day; findings recorded.
- [ ] `[manual]` Browser version (Chrome or Edge, Windows) chosen and pinned for all labs.
- [ ] `[signoff]` Open questions answered or assigned: pilot course/department, seats per lab and labs at once, exact PC/screen specs, SSO/LDAP availability, content & IP ownership, pilot semester, 70/30 weighting.
- [ ] `[signoff]` Academic partners confirmed and case-writing start booked for week 3.

---

## Phase 1 — Hand-tracking prototype (weeks 2–5) → **GO/NO-GO GATE**

**Goal:** prove hand tracking is reliable in the real lab before anything depends on it.
Prototype scope (PRD pilot step 1): one patient, stethoscope exam only.

**Delivers**
- Tracking in a Web Worker (MediaPipe Tasks Vision, GPU), decoupled from rendering.
- One Euro filter on landmarks; confidence threshold that drops low-quality frames.
- Gesture recognizer: point, pinch (with start/release hysteresis relative to hand size), open palm (hold), swipe left/right; 150–200 ms hold before trigger.
- Calibration (~10 s): open hand, point, pinch; dominant-hand choice; hand size, reach and pinch distance; reachable area mapped to full screen.
- Hand cursor with hover / pinch / hold states; magnetic snapping to targets ≥ 64 px.
- Toggleable camera preview with skeleton; warnings for hand out of frame and poor lighting.
- Mouse and touch working in parallel at all times; per-action input-source logging.
- Lab check routine (2-minute per-seat test: camera, lighting, tracking fps, audio).

**Exit checklist — automated**
- [x] `[unit]` One Euro filter: reduces jitter on a recorded noisy landmark stream without adding more than one frame of lag on a step input.
- [x] `[unit]` Pinch hysteresis: distance crossing the start threshold triggers pinch; it does not release until crossing the (larger) release threshold; thresholds scale with measured hand size.
- [x] `[unit]` Gesture hold: a gesture shorter than 150 ms never fires; one held ≥ 200 ms always fires exactly once.
- [x] `[unit]` Frames below the confidence threshold are ignored and do not move the cursor.
- [x] `[unit]` Swipe left/right detected from recorded sequences; no swipe fired from normal pointing movement.
- [x] `[unit]` Calibration maps the measured reachable box to the full screen (corners reach screen corners).
- [x] `[unit]` Snapping picks the nearest target within range and none outside it.
- [ ] `[int]` Replay tests: recorded landmark sessions (good light, poor light, hand leaving frame) produce the expected gesture event sequence.
- [ ] `[e2e]` Mouse and touch still click, drag and hold while tracking is active; switching to mouse is one action.
- [x] `[e2e]` Every action log entry records its input source (hand / mouse / touch).
- [ ] `[e2e]` Network inspection: no video frames or images leave the browser (no upload requests during a tracked session).

**Exit checklist — in the real lab (10–15 students, stethoscope exam)**
- [ ] `[perf]` Tracking frame rate **≥ 30 fps** on lab PCs.
- [ ] `[perf]` Hand-to-cursor latency **≤ 100 ms** (measured, e.g. high-speed camera or timestamped LED test).
- [ ] `[perf]` Intended pinches detected **≥ 95%**.
- [ ] `[perf]` Unintended pinches **≤ 1 per 5 minutes** of use.
- [ ] `[perf]` Hand lost **≤ 1 per 5 minutes**; recovery **< 1 s**.
- [ ] `[perf]` 3D scene still **≥ 60 fps** with tracking running.
- [ ] `[manual]` Calibration completes in ~10 s for every participant; re-calibration works from the open-palm menu.
- [ ] `[manual]` Out-of-frame and poor-lighting warnings appear when provoked.
- [ ] `[manual]` Lab check routine completes in ≤ 2 minutes per seat.
- [ ] `[manual]` Participants rating tracking "reliable" ≥ 80% (early read of the pilot target).
- [ ] `[signoff]` **Go/no-go decision recorded.** If no-go: build continues mouse-only and tracking moves to a later stage.

---

## Phase 2 — Case model & content pipeline (weeks 3–8; case writing runs to week 14)

**Goal:** cases are data, not code. Any case loads into the same room and patients without new logic.

**Delivers**
- Versioned JSON schema in `shared` covering: metadata, patient, history (topics, answers, essential/useful/irrelevant), examination points (text/sound/image findings), vital signs (start values, timed changes, action-triggered changes), investigations (results, turnaround, indicated), diagnosis (correct + acceptable differentials), management (correct/acceptable/harmful, required order, timing), checkpoint questions (single/multi MCQ, short answer from list), scoring rubric (points, penalties, critical errors, decision/question split), feedback per key decision.
- Shared libraries: drug list, test list, exam points.
- Case template spreadsheet (one tab per case part) for academics.
- Import + validation script: spreadsheet → JSON.
- One fully worked reference case (e.g. 45-year-old man, chest pain 2 h).

**Exit checklist**
- [x] `[unit]` Schema validates the reference case and rejects each required field when removed.
- [x] `[unit]` Validator flags: missing fields, unknown drugs, unknown tests, unknown exam points, broken references (e.g. a question or rubric item pointing to a non-existent action).
- [x] `[unit]` Validator rejects invalid values: negative turnaround, vitals out of physiological range, weighting not summing to 100%, no correct diagnosis.
- [ ] `[int]` Spreadsheet template → import script → JSON round-trips the reference case with no data loss.
- [x] `[int]` Importing a changed case creates a **new version number**; older versions stay readable.
- [ ] `[int]` Case JSON stored in the case/asset store; assets (sounds, images, ECGs) referenced by ID resolve.
- [ ] `[manual]` An academic fills the template for a second case with no developer help beyond the guide.
- [ ] `[signoff]` Template and schema approved by the academic partners.
- [ ] `[signoff]` First 5 cases drafted (PRD risk mitigation: start with 5, add the rest).

---

## Phase 3 — Backend core (weeks 4–9)

**Goal:** login, roles, courses, labs, sessions and a durable action log.

**Delivers**
- University login (LDAP or SSO if available; local accounts otherwise) and role-based access: Student, Instructor, Case author, Admin.
- Entities: users, courses, labs, seats, cases + versions + publish status, sessions, attempts, action logs, results.
- REST API + WebSocket channel for live seat status.
- Case delivery that **never sends answers to the browser before they are needed**.
- Action log endpoint: timestamped, idempotent, accepts buffered batches.
- Daily backups of database and case files with retention policy.

**Exit checklist**
- [ ] `[int]` Login works against university directory (or documented fallback); bad credentials rejected.
- [x] `[int]` Role matrix test: each role can reach only its endpoints (student cannot read results of others, instructor cannot edit users, etc.).
- [x] `[int]` Student joins only a session that an instructor launched for their course/lab.
- [x] `[int]` Case payload sent to the student contains no correct diagnosis, rubric, harmful/correct flags, question answers or feedback; investigation results are released only after ordering + turnaround.
- [x] `[int]` Action log: entries stored with client and server timestamps; duplicate batch submissions do not create duplicate actions; out-of-order batches are ordered correctly.
- [x] `[int]` Every attempt is stored against the exact case version played.
- [x] `[int]` WebSocket pushes seat status changes to a subscribed instructor within 2 s.
- [ ] `[manual]` Backup runs nightly; a restore to a fresh server succeeds and data matches.
- [ ] `[manual]` All traffic is HTTPS on the LAN; HTTP redirects or is refused.

---

## Phase 4 — 3D room, patients & case player (weeks 6–14)

**Goal:** the full student encounter, playable by hand and by mouse.

**Delivers**
- Stylized clinical examination room: bed, monitor, equipment tray, doctor's desk (glTF/GLB, Draco/KTX2).
- 3–4 patient models (adult male, adult female, elderly, child) with breathing, blinking, pain, coughing animations.
- Case player flow: log in → calibrate (skipped in mouse mode) → brief/handover → history → examination → investigations → checkpoint questions → diagnosis → management → debrief hand-off.
- Free movement between history, exam and investigations via open-palm menu.
- Exam tools: stethoscope, penlight, hammer, BP cuff; highlighted exam points reveal text/sound/image findings.
- Vital-signs monitor with timeline changes, action-triggered changes and deterioration events.
- Patient answers as text **and** spoken audio, with captions.
- Always-on HUD: vitals, case timer, tracking state, instant switch to mouse.
- Swipe to rotate patient / change view (front, back, close-ups).

**Exit checklist**
- [x] `[unit]` Vitals engine: starting values, scheduled changes and action-triggered changes produce the expected values at given case times.
- [x] `[unit]` Deterioration event fires on time if the action is missing (e.g. SpO2 drops when oxygen not given within 5 case-minutes) and is cancelled if the action happens first.
- [x] `[unit]` Investigation results appear only after their in-case turnaround time.
- [x] `[unit]` Checkpoints pause the case at their set points and resume after answering.
- [ ] `[unit]` Player loads every case in the library with no case-specific code (data-driven test over all case files).
- [x] `[e2e]` Full reference case completed with **mouse only**.
- [ ] `[e2e]` Full reference case completed with **hand tracking only** (replayed landmark input).
- [ ] `[e2e]` Student can move between history, exam and investigations in any order.
- [x] `[e2e]` Every action (question asked, exam point, test ordered, answer, diagnosis, drug) produces one timestamped log entry.
- [x] `[e2e]` Captions shown for all patient speech.
- [ ] `[perf]` First case ready **≤ 15 s** on lab PC; assets cached after first load (second load faster, verified in network panel).
- [ ] `[perf]` Room + patient + monitor ≥ 60 fps at native resolution on lab PC.
- [ ] `[manual]` Each patient model and animation reviewed; exam findings (heart/lung sounds, pupil response) play correctly through headphones.
- [ ] `[manual]` Hit targets ≥ ~64 px on the lab screen at seat distance.

---

## Phase 5 — Scoring & debrief (weeks 9–14)

**Goal:** automatic, re-calculable scoring that academics trust.

**Delivers**
- Scoring service: rubric per case version; decisions + questions combined (default 70/30, set per case).
- Area scoring: history, examination, investigations, diagnosis, management (order + timing), safety.
- Critical errors cap the result at "not passed".
- Questions: single/multiple-answer MCQ and short answers chosen from a list.
- Re-scoring from the action log when a rubric is corrected.
- Student debrief: score, pass/not passed, timeline of actions vs expected path, feedback per key decision.

**Exit checklist** (use the PRD examples as test fixtures)
- [x] `[unit]` History: essential question asked → points (e.g. radiation of pain +2); irrelevant questions apply only the light efficiency penalty.
- [x] `[unit]` Examination: relevant point performed → points (e.g. chest auscultation +3).
- [x] `[unit]` Investigations: indicated test → points (ECG +5); unnecessary test → light penalty (CT −1).
- [x] `[unit]` Diagnosis: correct +10; acceptable differential +4; other diagnosis 0.
- [x] `[unit]` Management: correct action within time window scores (aspirin within 10 case-minutes +5); late or out-of-required-order scores as defined in the rubric.
- [x] `[unit]` Safety: harmful action penalized (contraindicated drug −10).
- [x] `[unit]` Critical error → "not passed" regardless of total points.
- [x] `[unit]` MCQ single and multiple answer and list-based short answers scored correctly, including partial/incorrect selections per rubric.
- [x] `[unit]` Final score = decisions × weight + questions × weight, using the per-case split (default 70/30).
- [x] `[unit]` Gesture/movement quality never affects score (same actions via mouse vs hand → identical score).
- [x] `[int]` Changing a rubric and re-scoring stored attempts from the action log gives the new expected results; old results remain traceable to their rubric version.
- [x] `[e2e]` Debrief shows score, pass status, action timeline vs expected path, and feedback for every key decision.
- [ ] `[signoff]` Academics review scored sample attempts for the reference case and agree with the results.

---

## Phase 6 — Instructor dashboard & admin panel (weeks 9–16)

**Goal:** instructors run labs and read results; admins run the system.

**Delivers**
- Instructor dashboard (React): create session (course, case(s), lab, time window, retry allowed), live seat view, pause/end for everyone, allow retry for one student, results per student/case/cohort, most-missed decisions, export to Excel and PDF.
- Admin panel: users and roles, courses, labs and seats, case library with versions and publish status, system health (server status, active sessions, storage, backups).
- Case authoring flow: import → validation → preview mode → author sign-off → publish to course.

**Exit checklist**
- [x] `[e2e]` Instructor creates a session with course, cases, lab, time window and retry flag; students in that lab can join only within the window.
- [x] `[e2e]` Live view shows each seat's student name, current step, elapsed time, and tracking/connection warnings, updating in real time.
- [x] `[e2e]` Pause and end apply to every seat in the session.
- [x] `[e2e]` Allow-retry for one student creates a new attempt for that student only.
- [x] `[e2e]` Results views per student, per case and per cohort; most-missed items per case are correct against fixture data.
- [x] `[int]` Excel and PDF exports open correctly and match on-screen numbers.
- [ ] `[e2e]` Admin CRUD for users/roles, courses, labs and seats.
- [x] `[e2e]` Case library shows versions and publish status; a case cannot be published without validation passing and author sign-off in preview mode.
- [x] `[e2e]` A published case appears for the course; an unpublished one does not.
- [x] `[manual]` System health page shows server status, active sessions, storage use and last backup time.
- [ ] `[int]` Role checks: instructors only see their courses; case authors cannot reach admin functions.

---

## Phase 7 — Hardening: non-functional requirements (weeks 13–16)

**Goal:** prove the system holds up in a full lab and never loses an attempt.

**Exit checklist**
- [ ] `[perf]` Rendering ≥ 60 fps and tracking ≥ 30 fps / ≤ 100 ms with a real case running on lab PCs.
- [ ] `[perf]` Load test: **2 full labs at once (≥ 60 students, adjust to confirmed lab sizes)** with no errors and acceptable API/WebSocket latency; server sized from results.
- [x] `[int]` Network drop: disconnect LAN mid-case → actions buffered locally → reconnect → all actions synced in order, no duplicates.
- [x] `[e2e]` Browser refresh mid-case resumes at the same step with the same timer, vitals and answers.
- [ ] `[e2e]` Browser crash / tab kill resumes the attempt on relaunch.
- [x] `[int]` Runs with no internet access (all assets and libraries served from campus server).
- [ ] `[manual]` Security review: role-based access, HTTPS only, no answer leakage in payloads, source maps or local storage.
- [ ] `[manual]` Privacy: confirmed no webcam video or images stored or sent; consent notice shown to students before tracking starts.
- [ ] `[manual]` Accessibility: whole case completable in mouse mode; captions for all speech.
- [ ] `[manual]` Backups and retention policy verified with university IT.
- [ ] `[manual]` Lab check routine run on every seat in the pilot lab(s); all pass.

---

## Phase 8 — Internal alpha (weeks 15–17)

**Goal:** academics play every case; content and scoring are fixed before students see them.

**Exit checklist**
- [ ] `[manual]` All 10–15 cases imported, validated, previewed and signed off by their author.
- [ ] `[signoff]` Every case reviewed by a **second academic** before going live.
- [ ] `[manual]` Each case played end to end by an academic; content and scoring bugs logged and fixed.
- [ ] `[manual]` Session length 15–25 minutes per case confirmed.
- [ ] `[signoff]` Scoring review: academics review sample attempts and agree scores reflect performance.
- [ ] `[manual]` No open blocker or critical bugs.

---

## Phase 9 — Small pilot (weeks 18–19)

**Goal:** one student group, 3–5 cases, observers in the room.

**Exit checklist**
- [ ] `[manual]` Session run end to end by an instructor using only the dashboard.
- [ ] `[manual]` Observer notes collected; tracking, usability and content issues triaged.
- [ ] `[perf]` Case sessions lost to technical failure ≤ 2%.
- [ ] `[perf]` Input-source logs reviewed: share of actions by hand vs mouse, and where students switched.
- [ ] `[manual]` Fixes from the small pilot deployed and regression-tested before the course pilot.

---

## Phase 10 — Course pilot & Stage 2 decision (weeks 20–28)

**Goal:** full course cohort, all cases, end-of-course survey, results report, Stage 2 decision.

**Exit checklist — PRD success metrics**
- [ ] `[perf]` Students rating hand tracking reliable **≥ 80%**.
- [ ] `[perf]` Students finishing a case without switching to mouse **≥ 70%**.
- [ ] `[perf]` Students rating the cases useful for learning **≥ 75%**.
- [ ] `[perf]` Case sessions lost to technical failure **≤ 2%**.
- [ ] `[signoff]` **All** pilot instructors willing to use it next semester.
- [ ] `[signoff]` Majority of academic reviewers agree scores reflect performance on a sample of **20 attempts**.
- [ ] `[manual]` Survey administered and analysed; per-cohort results and most-missed items exported.
- [ ] `[signoff]` Results report delivered to the university; **Stage 2 go/no-go recorded**.

---

## Out of scope for Stage 1 (do not build)

Photorealistic graphics · grading of physical skill/movement · final-exam use · VR/MR/phone AR ·
full hospital (Stage 2) · self-service case editor (Stage 2) · physiology engine and AI-voiced patient (Stage 3) ·
body tracking, AR, VR/MR headsets (Stages 4–6) · multiplayer team cases · remote access from home ·
Arabic interface · free-text answers · two-hand gestures.
