# Load test

PRD requirement: **"Concurrency: at least 2 full labs at once (assumed 60 students)."**

`tools/loadtest/` simulates whole lab sessions against the real API. Students log in, join a
session at a seat, work a case while their browser syncs the action log, fetch investigation
results and finish. Instructors watch the live seat view over the WebSocket at the same time.
The test then checks in the database that nothing was lost.

**Result:** the target load (60 students in 2 labs) and 4× that load (240 students) both passed
every threshold on a 4-vCPU sandbox, with large margins. Action-sync p95 was 16–17 ms against
a 300 ms limit. Probe runs with 600 and 1200 students also passed. At 1200 students the host CPU
was saturated (p95 latency 72 ms), which is about where this machine runs out.

## Files

| File | What it does |
|---|---|
| `tools/loadtest/server.mts` | Starts the API (`buildApp`) on port 4200 against its own database `sim_load`, created if missing. It drops and recreates the schema, migrates, seeds admin and demo data, and adds N students (default 120) enrolled in MED-401. It also creates 2 labs × 60 seats with one open session per lab running `chest-pain-stemi`. It prints the session ids and writes `out/setup.json` and `out/students.csv`. |
| `tools/loadtest/run.mts` | The load generator: S students, M instructor WebSockets, then the report and PASS/FAIL. It works in local mode (reads `out/setup.json`) or against any deployed URL. |
| `tools/loadtest/explain.mts` | Runs `EXPLAIN ANALYZE` and timings for the hot queries on the data a run left behind, and compares them with the proposed fixes. |
| `tools/loadtest/out/` | Reports (`report-<label>-<time>.json`), server logs and query plans. This folder is git-ignored. |

## What one simulated student does

1. `POST /api/auth/login`, then `GET /api/my/sessions` and `GET /api/labs` (the labs call is made once and shared) to find the lab's seats.
2. `POST /api/sessions/:id/attempts` with a seat. If an existing attempt is resumed, the student continues after its stored log.
3. For `DURATION` seconds: every 2 s (first tick at a random offset) it sends **1–4 new actions** with increasing `seq` and `caseTimeMs`. The actions follow a whole case compressed into the run, in this order:
   - `case.start`
   - history questions
   - examinations
   - every investigation ordered, shortest turnaround first
   - the 3 questions answered
   - management
   - one `diagnosis.submit`
   - filler actions

   Mixed in throughout are `view.change`, `tracking.lost`, `tracking.recalibrate`, `input.switch` and one `tracking.stats` per minute, as the real client does. All refs come from the case the server returns.
4. **10% of batches re-send the previous batch** together with the new actions, as when a response is lost. A failed request keeps its actions and re-sends them next tick, like the client's offline buffer.
5. Each investigation result is fetched once, as soon as its turnaround has passed.
6. At the end it sends `case.end`, flushes anything not yet acknowledged and calls `POST /api/attempts/:id/finish`.

The case clock runs in real time (`SPEED=1`) because the API rejects result fetches whose case
time is ahead of the wall clock. With a 2–3 minute run, only the short-turnaround tests (ECG,
glucose, and CXR at 3 min) come back. Every other kind of request runs at full rate.

**This model is heavier than real students.** The browser (`apps/sim/src/sync.ts`) flushes when
an action is recorded and retries every 2 s. A real student produces perhaps 100–300 actions
over 15–25 minutes, which is about 0.1–0.3 requests/s. The simulated student sends 0.5
syncs/s carrying about 1.25 actions/s. So one simulated student is roughly 2–5 real students for
the action-sync path.

Instructors: M sockets (default 2) connect to `/api/live?session=…`, assigned round-robin to the
sessions. They count `seat` messages and measure **seat-update lag**: the time from sending an
action POST until a seat message for that attempt shows an `elapsedMs` at least as late as the
batch's last step action. This is the end-to-end time from a student acting to the instructor
seeing it. The API publishes the seat update *before* it answers the POST, so lag measured from
the POST response is about 0 or negative. The report includes that figure too (`lagFromResponseMs`).

## Measurements and thresholds

The report covers:

- latency for every endpoint (p50/p95/p99/max/mean)
- status counts and error counts by status
- requests/s and actions/s
- WebSocket message counts and lag, and seat updates never seen
- action-sync p95 for every 10 s window, to see drift as logs grow
- once a second: CPU and RSS of the server process, total CPU of all `postgres` processes, and host CPU (from `/proc`)
- the generator's own CPU and event-loop delay, to confirm the client was not the bottleneck

Verification runs after the load phase and is not counted in the latencies:

- `GET /api/attempts/:id`: the stored action count must equal the unique actions sent
- `GET /api/attempts/:id/result`: the attempt must have a result
- with `DATABASE_URL`, the same checks directly in SQL: the attempts are finished, `results` rows equal attempts, and the `actions` count per attempt equals the unique actions sent

| Check | Threshold |
|---|---|
| 5xx responses | 0 |
| action sync p95 | < 300 ms |
| action sync p99 | < 1000 ms |
| seat-update lag p95 | < 2000 ms |
| all students completed | S / S |
| all attempts finished and scored | DB: results = attempts = finished |
| no lost actions | stored count = unique actions sent, for every attempt |
| idempotency | duplicates reported by the API = duplicates re-sent |

The process exits with code 0 if every check passes and 1 if any fails.

## Running it locally

```sh
service postgresql start                    # if it is down; DB user sim/sim with CREATEDB
npx tsx tools/loadtest/server.mts           # terminal 1 (STUDENTS=240 for the stress run)
npx tsx tools/loadtest/run.mts --students=60 --duration=180 --label=60-students     # terminal 2
npx tsx tools/loadtest/explain.mts          # optional: query plans on what the run stored
```

Restart `server.mts` before every run. Sessions do not allow retries, so a student who finished
cannot start the case again. The restart drops the `sim_load` schema.

Settings can be environment variables or flags (`--ramp=0` is the same as `RAMP=0`):

| Setting | Default | Meaning |
|---|---|---|
| `STUDENTS` | 60 | simulated students (tested up to 1200) |
| `DURATION` | 180 | seconds each student works after joining |
| `RAMP` | 20 | seconds over which logins are spread (0 = everyone at once) |
| `INTERVAL_MS` | 2000 | sync interval |
| `INSTRUCTORS` | 2 | live sockets |
| `DUP_RATE` | 0.1 | share of batches that re-send the previous batch |
| `SPEED` | 1 | case clock speed. Above 1, longer turnarounds fall inside the run, but result fetches are switched off (the server would reject them). |
| `INVESTIGATION_FETCH` | 1 | 0 = do not fetch results |
| `TRACKING_STATS` | 1 | 0 for a server older than the pilot release, which rejects `tracking.stats` |
| `LABEL`, `OUT` | | report name and path |

`server.mts` takes `PORT` (4200), `STUDENTS` (120), `LABS` (2), `SEATS_PER_LAB` (60),
`LOAD_DATABASE_URL`, `PASSWORD` and `DB_POOL` (20, the same as production).

## Running it against the university server

The generator only needs HTTP(S) access, so run it from any machine on the campus network. A
laptop is enough: at 240 students the generator used 13% of one core. Use a dedicated test
course so that real results are not mixed with load-test results.

1. **Accounts.** In the dashboard (Admin → users → import CSV), create a course such as
   `LOADTEST`. Then import students with columns `username,display_name,role,password,courses`,
   for example `lt001,Load Test 001,student,Lt-pass-0001,LOADTEST`. With LDAP sign-in, use local
   accounts that have a password, because the test should not lock out directory accounts. Add an
   instructor account to the course.
2. **Labs and session.** Use the real labs and seats. Create one session per lab with the
   reference case in the `LOADTEST` course as that instructor. Its time window must cover the
   run. Either allow retries, or create a fresh session for each run: a student who has finished
   gets 409 when joining again.
3. **Credentials CSV** for the generator: `username,password[,sessionId][,seatLabel]` with one
   line per student. A header line is optional. Without `sessionId`, students are spread
   round-robin over `SESSION_IDS`. Without `seatLabel`, seats are taken in order.
4. **Run it.** Use https URLs; the WebSocket uses wss automatically.

   ```sh
   BASE_URL=https://sim.uowa.edu.iq SESSION_IDS=<lab1-session>,<lab2-session> \
   STUDENTS_CSV=loadtest-students.csv INSTRUCTOR_USER=lt-instructor INSTRUCTOR_PASS=... \
   npx tsx tools/loadtest/run.mts --students=60 --duration=180 --label=uni-60
   ```

   The account and session settings are only needed in this mode:
   - `DATABASE_URL`: optional, a read-only connection that adds the SQL verification. Without it,
     verification goes through the API only.
   - `SERVER_PID`: optional, and only when the generator runs on the server itself.
   - Otherwise, watch the server with `docker stats` or `pidstat -p <pid> 1` while the test runs.
5. **Rate limit.** Logins are limited to 10 per minute per (client address, username). One login
   per student is fine, even when all the traffic comes from one generator machine. Do not
   repeat a run with the same accounts within a minute after failed logins. Behind Caddy, the API
   must trust the proxy (`TRUST_PROXY` on, the default in `server.ts`). Otherwise every student
   appears to come from Caddy's address.
6. **Clean up.** Delete the test course's sessions and accounts afterwards, or keep them for the
   next test.

Run 60 students first, during the time the real labs would use. Then run the 2-lab test with the
real lab PCs on the same network if possible, because that also tests the LAN, Wi-Fi and TLS
termination, which this sandbox did not.

## Results measured here

**Machine.** One sandbox VM ran everything: 4 vCPU Intel Xeon @ 2.10 GHz (`nproc` = 4), 16 GB
RAM, Linux 6.18, Node 22.22.0, and PostgreSQL 16.15 with default settings (shared_buffers
128 MB, `jit = on`, `synchronous_commit = on`). The API server, PostgreSQL and the generator were
three separate processes on the same 4 vCPUs. Traffic went over loopback, so there was no TLS
and no LAN. **The host was shared with another busy workload**: a parallel build and test
session running headless Chrome took up to 3 cores at times, and host CPU averaged 40–70% even
when the API was nearly idle. The figures below are therefore pessimistic. The code under test
was commit `e086fec` plus the work in progress on the tree at the time (API source hash
`612b726b06d3`, which `server.mts` records in the report). The 1200 probe ran on commit
`b5eaa3f` with the same API source hash.

### Target: 60 students (2 labs × 30 seats used), 3 minutes, 2 instructor sockets

| endpoint | count | req/s | p50 ms | p95 ms | p99 ms | max ms | errors |
|---|--:|--:|--:|--:|--:|--:|---|
| POST /api/attempts/:id/actions | 5460 | 27.4 | 7.5 | 15.7 | 23.7 | 107.9 | – |
| GET /api/attempts/:id/investigations/:testId | 120 | 0.6 | 3.1 | 7.0 | 15.1 | 26.4 | – |
| POST /api/sessions/:id/attempts (join) | 60 | 0.3 | 9.5 | 16.4 | 20.8 | 20.8 | – |
| POST /api/attempts/:id/finish | 60 | 0.3 | 10.3 | 19.1 | 53.6 | 53.6 | – |
| POST /api/auth/login | 60 | 0.3 | 51.8 | 63.8 | 71.3 | 71.3 | – |
| GET /api/my/sessions | 60 | 0.3 | 7.4 | 14.5 | 26.0 | 26.0 | – |

- **Throughput:** 29 req/s and 68 actions/s. 13,597 unique actions were sent, plus 1,366 duplicate re-sends.
- **WebSocket:** 2 × 2,790 seat messages. Lag p50 7 ms, p95 15 ms, p99 24 ms, max 107 ms. No update was missed.
- **Resources**, measured while all 60 were active:
  - API process: 5.6% of one core on average (p95 22%, which includes the logins); RSS 229 → 249 MB.
  - PostgreSQL: 7.8% of one core.
  - Generator: 6% of one core.

| Check | Result | Value |
|---|---|---|
| zero 5xx | PASS | 0 (0 network errors) |
| action sync p95 < 300 ms | PASS | 15.7 ms |
| action sync p99 < 1000 ms | PASS | 23.7 ms |
| seat-update lag p95 < 2000 ms | PASS | 15.2 ms (5,394 updates, 0 never seen) |
| all students completed | PASS | 60/60 |
| all attempts finished and scored | PASS | DB: 60 attempts, 60 finished, 60 results |
| no lost actions | PASS | 0 mismatches (API and DB) |
| duplicates detected = re-sent | PASS | 1,366/1,366 |

### Stress: 240 students (4 labs' worth, 120 per session), 2 minutes

| endpoint | count | req/s | p50 ms | p95 ms | p99 ms | max ms | errors |
|---|--:|--:|--:|--:|--:|--:|---|
| POST /api/attempts/:id/actions | 14640 | 104.8 | 5.6 | 16.8 | 30.3 | 157.3 | – |
| GET /api/attempts/:id/investigations/:testId | 480 | 3.4 | 2.8 | 8.2 | 13.5 | 20.6 | – |
| POST /api/sessions/:id/attempts (join) | 240 | 1.7 | 9.1 | 23.0 | 45.6 | 52.6 | – |
| POST /api/attempts/:id/finish | 240 | 1.7 | 8.0 | 12.1 | 14.5 | 15.2 | – |
| POST /api/auth/login | 240 | 1.7 | 61.3 | 95.1 | 104.8 | 114.9 | – |
| GET /api/my/sessions | 240 | 1.7 | 6.5 | 19.2 | 40.4 | 58.6 | – |

- **Throughput:** 115 req/s (145 req/s at peak) and 260 actions/s. 36,322 unique actions were sent.
- **WebSocket:** 2 × 7,560 seat messages. Lag p50 5 ms, p95 16 ms, p99 30 ms, max 157 ms.
- **Resources**, measured while all 240 were active:
  - API process: 14% of one core; 78% p95 during the login ramp, because scrypt hashing ran at 12 logins/s. RSS 256 → 263 MB.
  - PostgreSQL: 27% of one core.
  - Generator: 13%.

All 8 checks passed. 0 5xx. Action sync p95 16.8 ms and p99 30.3 ms. Seat lag p95 16.3 ms
(14,489 updates, 0 never seen). 240/240 students completed, 240 attempts were finished with 240
results, and no actions were lost. Duplicates matched: 3,541/3,541.

### Headroom probes (not required)

| run | peak req/s | action p95 / p99 | seat lag p95 | API CPU* | Postgres CPU* | result |
|---|--:|--:|--:|--:|--:|---|
| 600 students, 60 s ramp, 2 min | 389 | 17 / 28 ms | 17 ms | 29% | 72% | all PASS |
| 1200 students, 60 s ramp, 2 min | 644 | 72 / 122 ms | 70 ms | 48% | 130% | all PASS; host CPU saturated (p95 96%) |
| 120 logins at the same instant (`RAMP=0`) | – | 16 / 31 ms | 20 ms | – | – | all PASS; login p50 1.26 s, **p95 2.45 s**, max 2.58 s |

\* While all students were active. 100% = one core. The 600 probe ran on a slightly earlier tree
(before the investigation case-time check). That check only affects how many results are
fetched.

## What the numbers mean for sizing

- **The PRD target needs a small fraction of one core.** Two full labs of 60 students cost about
  0.06 core for Node and 0.08 core for PostgreSQL, using a model that sends 2–5× more syncs than
  real students do. Latency is set by round trips (4 statements per sync), not by load. It
  stayed flat for the whole 3 minutes, so it did not drift as the logs grew.
- **Scaling is about linear.** Each simulated student costs about 0.05–0.1% of a core in Node and
  0.1% in PostgreSQL, and less than 0.1 MB of extra RSS. The production pool of 20 DB
  connections was enough at every load tested. PostgreSQL is the larger consumer, at about 2 ms of CPU per sync
  (4 statements, 2 commits).
- **Memory:** the API stays near 250–310 MB RSS even at 1200 students. 2 GB for the API plus
  2 GB for PostgreSQL is plenty.
- **Storage:** about 330 bytes per action including indexes, and about 4 KB per result. An attempt
  of 150–300 actions is 50–100 KB. 120 students a day for 200 teaching days is about 1–2 GB a year.
- **Recommendation:** the 4 vCPU / 8 GB server already planned (or anything of that size) has
  more than 10× headroom over 2 labs. 2 vCPU / 4 GB would still meet the target. Even in this
  noisy shared sandbox, the knee was at roughly 1000+ concurrent simulated students. The limits
  in practice are elsewhere:
  - **Lab-start login bursts.** Password checks use scrypt on libuv's thread pool, which has 4
    threads by default. About 50 logins/s fit through it. 120 students pressing "Sign in" in the
    same second waited up to 2.6 s. By the same rate, 60 would wait about 1.2 s (estimated, not measured). That is acceptable for a
    once-per-session action. On a server with more than 4 cores, set `UV_THREADPOOL_SIZE` to
    the core count to raise the limit.
  - **The network.** Wi-Fi, switches and TLS at Caddy were not measured here, which is why
    the test should be repeated against the university server from the lab PCs.

## Problems found and fixes

None of these blocked the target. They are listed by impact.

**Status after the load test:** items 1 and 2 are fixed by `apps/api/migrations/003_action_indexes.sql`; item 3 is exposed as `UV_THREADPOOL_SIZE` in `docker-compose.yml`; item 5 is fixed — a different action reusing a sequence number is now refused with 409 (tested in `apps/api/test/api.test.ts`) and the student app shows "Open in another tab" instead of dropping it. Item 4 is left for later. The measurements below are from before these changes.

1. **The whole-session seat query is slow because of PostgreSQL JIT and three correlated
   subqueries over each attempt's whole log.**
   - **Where:** `apps/api/src/seats.ts`, `sessionSeats(db, sessionId)` without an attempt id.
   - **When it runs:** on every instructor WebSocket connect or reconnect, on `GET /api/sessions/:id/live` and on session end. The per-sync, single-attempt form is not affected.
   - **Cause:** for each attempt, the `tracking.lost`, `tracking.recalibrate` and `input.switch` subqueries each do a bitmap heap scan of all that attempt's actions through `actions_attempt_idx` and then filter on `type`. The plan cost (about 129k for 120 attempts) is above `jit_above_cost` (100k), so PostgreSQL JIT-compiles 57 functions on each call.
   - **Evidence** (`tools/loadtest/explain.mts`, data from the 240 run: 120 attempts per session, about 150 actions each; `out/explain-240-final.txt`):

     | variant | median | p95 |
     |---|--:|--:|
     | current query | 47.9 ms | 60.2 ms |
     | of which JIT | 27.8 ms | |
     | `SET jit = off` | 19.2 ms | 20.3 ms |
     | one-pass rewrite (one `LATERAL` with `FILTER` aggregates) | 9.9 ms | 12.9 ms |
     | index `(attempt_id, type, seq)` | 3.7 ms | 5.3 ms |

     On the 600-student data (300 attempts per session), the current query takes 77 ms median and 117 ms p95, and with the index 8 ms. The cost grows with attempts × log length.
   - **Fix:** add an index in a new migration:

     ```sql
     CREATE INDEX actions_attempt_type_idx ON actions (attempt_id, type, seq);
     DROP INDEX actions_attempt_idx;
     ```

     Dropping `actions_attempt_idx` is item 2. With the new index, the `type =` subqueries become short index scans. The investigation lookup (`type = 'investigation.order' AND ref = $2`) uses the same index. Optionally also `ALTER DATABASE sim SET jit = off`: JIT does not help this OLTP workload.
2. **Duplicate index on `actions`.**
   - **Where:** `001_init.sql` declares `UNIQUE (attempt_id, seq)`, which creates `actions_attempt_id_seq_key`, and also `CREATE INDEX actions_attempt_idx ON actions (attempt_id, seq)`. The two indexes are identical and the same size.
   - **Cost:** every action insert maintains both, which means extra write and WAL work on the hottest path, and the planner gains nothing from the second one.
   - **Fix:** drop `actions_attempt_idx` in the same migration as item 1. The unique index serves every `(attempt_id[, seq])` lookup.
3. **Login bursts are limited by scrypt on a thread pool of 4.** See the sizing section: 120 simultaneous logins give p95 2.45 s.
   - **Fix:** set `UV_THREADPOOL_SIZE` to the core count in the API container's environment, if the server has more than 4 cores. Do not lower the scrypt cost.
4. **Minor, for later:**
   - Each action sync runs 4 separate statements: owner check, insert, `UPDATE … RETURNING max(seq)`, and the seat query. They commit twice.
   - The seat query re-plans each time, with about 0.4 ms of planning against about 0.3 ms of execution.
   - Merging the insert and `last_seen_at` update into one transaction, and using a named prepared statement for the seat query, would cut PostgreSQL CPU per sync. That CPU is the dominant cost at high concurrency (130% of a core at 1200 students).
   - None of this is needed for 2 labs.
5. **Correctness note on lost actions** (not seen in any run): actions are de-duplicated by both `id` and `(attempt_id, seq)` with `ON CONFLICT DO NOTHING`. If a client ever re-used a `seq` for a *different* action, that action would be dropped silently and counted as a "duplicate". That could happen with two tabs on one attempt, or with lost localStorage plus a resume that did not reload the log. Consider counting conflicts on `seq` with a different `id` separately, and logging them.
