# Lab and pilot runbook — Stage 1

How to run the steps in [`stage1-phases.md`](stage1-phases.md) that need the real lab, real
students or staff. The software is in place. This page says who does what, in which order, and
where each result is recorded.

All results below are stored on the server and appear in the dashboard under **Seat readiness**,
**Score review** or **Pilot report**. The Pilot report has an **Export to Excel** button that
produces the report for the university.

## 1. Server install (Phase 0)

1. On the university server: `cp .env.example .env`, set `SITE_ADDRESS`, `POSTGRES_PASSWORD`,
   `JWT_SECRET` (32+ characters), the `LDAP_*` settings ([`ldap.md`](ldap.md)) and the backup
   settings. Then run `docker compose up -d --build`.
2. Seed the admin: `docker compose exec api sh -c 'ADMIN_PASSWORD=... npx tsx apps/api/src/seed.ts'`.
3. Install Caddy's root certificate on every lab PC (README, "Deploy"), or put the university
   certificate in `deploy/Caddyfile`.
4. From a lab PC **with the internet unplugged**, open `https://<SITE_ADDRESS>/` and `/staff/`.
   Both must load, and the admin **System health** page must show the database and a backup.
5. Run a backup now (`docker compose exec backup bash /backup.sh now`). Restore it on a spare
   machine with `pg_restore --clean -d sim <file>`, then check that the users and sessions match.
6. Check that `http://<SITE_ADDRESS>/` redirects to HTTPS.
7. Re-run the load test against the real server and the confirmed lab sizes
   ([`load-test.md`](load-test.md), "Against a deployed server"). Size the server from the report.

Record: browser and version pinned for the labs, PC and screen specs, and the webcam model.

## 2. Lab check on every seat (Phases 0, 1, 7)

Before each session block, run this at every seat. It takes about 2 minutes per seat.

1. Sign in as an instructor at `https://<SITE_ADDRESS>/?labcheck=1` and pick the seat.
2. Sit as a student would and hold a hand up. The page checks the camera, the lighting, the
   tracking frame rate (≥ 30 fps), the 3D frame rate with the real room (≥ 60 fps) and that a
   hand is seen.
3. Click **Play test tone**, then answer whether you heard it, and **Save result**.
4. On the dashboard, open **Seat readiness** and pick the lab. Every seat must show *ready*.
   For a seat marked ✗, fix the cause (front lighting, camera angle, headphones, PC) and run the
   check again.

Repeat it in the morning and the afternoon at least once to find lighting problems.

## 3. Hand-tracking go/no-go (Phase 1, week 5)

Aim for at least 10 testers (staff and student volunteers), on at least 3 lab seats.

1. Each tester calibrates and plays one case with hand tracking only. The app stores tracking
   telemetry (frame rate, hand losses, processing latency) with the attempt every minute.
2. Observers count intended pinches that were missed and unintended ones, per tester.
3. Measure end-to-end latency once per seat type. Film the hand and the screen together with a
   high-speed phone camera (240 fps), and count the frames from the pinch to the cursor change.
4. Testers answer the case survey ("Did tracking feel reliable?"). The **Pilot report** shows
   the share who rated it reliable.
5. Compare with the PRD targets:

   | Metric | Target |
   |---|---|
   | Intended pinches detected | ≥ 95 % |
   | Unintended pinches | ≤ 1 per 5 min |
   | Hand lost | ≤ 1 per 5 min, recovery < 1 s |
   | Tracking frame rate | ≥ 30 fps |
   | Latency (high-speed camera) | ≤ 100 ms |
   | Testers who felt it reliable | ≥ 80 % |

6. Record the go/no-go decision in `stage1-phases.md` (Phase 1). If the decision is no-go, the
   app keeps working mouse-only. Students pick **Use the mouse** on the start screen and nothing
   else changes.

## 4. Cases and scoring review (Phases 2, 5, 8)

1. Academics fill the spreadsheet template ([`case-authoring-guide.md`](case-authoring-guide.md)).
   They upload it in **Case library**, fix the problems listed by tab, row and column, and open
   **Preview**.
2. The author plays the case end to end in preview, checks that it takes 15–25 minutes, and
   clicks **Sign off**. A **second academic** then plays it in preview. An admin publishes it
   only after both have reviewed it.
3. Replace the placeholder sounds, ECGs and X-rays in `content/assets/` with licensed material
   (same file names, or update the case). Run `npm run validate-cases` to check that every file
   exists. `content/assets/README.md` lists each file and what it should be.
4. The two extra cases, `child-asthma` and `elderly-sepsis`, are marked DRAFT. They need
   academic review before use.
5. **Score review:** after students have played, each academic opens **Score review** and picks
   the case. The page proposes a fixed sample of attempts. For each attempt the academic looks
   at the timeline and the score and marks **Agree** or **Disagree**, with a comment. The Pilot
   report shows the agreement rate. The PRD target is a majority agreement on 20 attempts.
6. If scoring is wrong, correct the rubric of the live version. The README, "Adding a case",
   step 4, explains how. Stored attempts are re-scored and keep a record of the rubric they used.

## 5. Internal alpha (Phase 8)

- Import all 10–15 cases, then preview, sign off and second-review each one as above.
- Academics and staff play every case in the lab, as students would.
- Log content and scoring bugs. Close every blocker before the small pilot.

## 6. Small pilot (Phase 9) and course pilot (Phase 10)

Before each session:

- Import the course roster under **Users → Import CSV**. With LDAP, students can also just sign
  in.
- Run the lab check on every seat (section 2).

During each session:

1. The instructor creates the session (course, cases, lab, time window, retries allowed) and
   watches **Live**. Seats show tracking and connection warnings.
2. If a student loses a session to a technical problem, the instructor clicks **Retry** with
   reason **Technical**. The report counts these as sessions lost to technical failure.
3. After each case, students see the debrief and a short survey (hand tracking reliable? useful
   for learning?).

At the end of the course:

1. Students answer the course survey from their session list (**Course feedback**). Instructors
   answer theirs on the Pilot report page (willing to use it next semester?).
2. Open **Pilot report** and export it to Excel. The success metrics are listed with their
   targets:

   | Metric | Target |
   |---|---|
   | Students rating hand tracking reliable | ≥ 80 % |
   | Students finishing a case without switching to mouse | ≥ 70 % (from the action logs) |
   | Students rating cases useful | ≥ 75 % |
   | Case sessions lost to technical failure | ≤ 2 % |
   | Instructors willing to use it next semester | all |
   | Academic reviewers agreeing with scores | majority on 20 attempts |

3. Add the per-cohort results and the most-missed items to the report. Export them from
   **Results** for each session.
4. Deliver the report to the university and record the Stage 2 decision.
