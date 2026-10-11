-- Measurement for the tracking go/no-go, lab readiness, and the pilot success metrics.

-- Lab check routine results, one row per run at a seat.
CREATE TABLE lab_checks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seat_id       uuid REFERENCES seats(id) ON DELETE SET NULL,
  user_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  camera_ok     boolean NOT NULL,
  light_level   numeric(4,3),
  tracking_fps  numeric(6,2),
  render_fps    numeric(6,2),
  hand_seen     boolean NOT NULL,
  audio_ok      boolean NOT NULL,
  passed        boolean NOT NULL,
  user_agent    text,
  details       jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lab_checks_seat_idx ON lab_checks (seat_id, created_at DESC);

-- Hand-tracking test runs (PRD "Tracking prototype test" metrics).
CREATE TABLE tracking_tests (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seat_id             uuid REFERENCES seats(id) ON DELETE SET NULL,
  duration_ms         int NOT NULL,
  targets             int NOT NULL,
  detected            int NOT NULL,
  false_clicks        int NOT NULL,
  rest_ms             int NOT NULL,
  hand_lost           int NOT NULL,
  recovery_ms         int[] NOT NULL DEFAULT '{}',
  tracking_fps        numeric(6,2),
  render_fps          numeric(6,2),
  pipeline_p95_ms     numeric(7,2),
  felt_reliable       boolean,
  details             jsonb,
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- Surveys: after a case (students), end of course (students), end of pilot (instructors).
CREATE TABLE surveys (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('student_case', 'student_course', 'instructor')),
  attempt_id  uuid REFERENCES attempts(id) ON DELETE CASCADE,
  course_id   uuid REFERENCES courses(id) ON DELETE CASCADE,
  answers     jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX surveys_once_per_attempt ON surveys (user_id, attempt_id) WHERE attempt_id IS NOT NULL;
CREATE UNIQUE INDEX surveys_once_per_course ON surveys (user_id, kind, course_id) WHERE attempt_id IS NULL;

-- Academic review: does the score reflect the student's performance?
CREATE TABLE score_reviews (
  attempt_id   uuid NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  reviewer_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agrees       boolean NOT NULL,
  comment      text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (attempt_id, reviewer_id)
);

-- Why an instructor granted a retry ("technical" counts as a session lost to technical failure).
ALTER TABLE retry_grants ADD COLUMN reason text NOT NULL DEFAULT 'other' CHECK (reason IN ('technical', 'other'));
