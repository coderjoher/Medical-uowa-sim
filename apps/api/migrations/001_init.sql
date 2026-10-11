-- Stage 1 schema: users, courses, labs, versioned cases, sessions, attempts, action log, results.

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username      text NOT NULL UNIQUE,
  display_name  text NOT NULL,
  role          text NOT NULL CHECK (role IN ('student', 'instructor', 'case_author', 'admin')),
  password_hash text,               -- null when the user signs in through LDAP/SSO
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE courses (
  id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code  text NOT NULL UNIQUE,
  title text NOT NULL
);

CREATE TABLE course_members (
  course_id uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (course_id, user_id)
);

CREATE TABLE labs (
  id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE
);

CREATE TABLE seats (
  id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lab_id uuid NOT NULL REFERENCES labs(id) ON DELETE CASCADE,
  label  text NOT NULL,
  UNIQUE (lab_id, label)
);

-- Case versions are immutable; results always point at the version played.
-- rubric_revision increments when a rubric correction is applied to the same version.
CREATE TABLE case_versions (
  case_id         text NOT NULL,
  version         int  NOT NULL,
  title           text NOT NULL,
  course_code     text NOT NULL,
  definition      jsonb NOT NULL,
  rubric_revision int  NOT NULL DEFAULT 1,
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'signed_off', 'published', 'retired')),
  imported_by     uuid REFERENCES users(id),
  signed_off_by   uuid REFERENCES users(id),
  signed_off_at   timestamptz,
  published_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (case_id, version)
);

CREATE TABLE sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id     uuid NOT NULL REFERENCES courses(id),
  lab_id        uuid NOT NULL REFERENCES labs(id),
  instructor_id uuid NOT NULL REFERENCES users(id),
  cases         jsonb NOT NULL,     -- [{ "caseId": "...", "version": 1 }]
  starts_at     timestamptz NOT NULL,
  ends_at       timestamptz NOT NULL,
  allow_retry   boolean NOT NULL DEFAULT false,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paused', 'ended')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);

CREATE TABLE attempts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id   uuid NOT NULL REFERENCES sessions(id),
  student_id   uuid NOT NULL REFERENCES users(id),
  case_id      text NOT NULL,
  case_version int  NOT NULL,
  attempt_no   int  NOT NULL DEFAULT 1,
  seat_id      uuid REFERENCES seats(id),
  status       text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'finished')),
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (case_id, case_version) REFERENCES case_versions(case_id, version),
  UNIQUE (session_id, student_id, case_id, attempt_no)
);

-- Instructor-granted extra attempt for one student (e.g. after a technical problem).
CREATE TABLE retry_grants (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES sessions(id),
  student_id uuid NOT NULL REFERENCES users(id),
  case_id    text NOT NULL,
  granted_by uuid NOT NULL REFERENCES users(id),
  used       boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Every student action. id is client-generated so re-sent batches are ignored.
CREATE TABLE actions (
  id           uuid PRIMARY KEY,
  attempt_id   uuid NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  seq          int  NOT NULL,
  case_time_ms bigint NOT NULL,
  client_ts    timestamptz NOT NULL,
  server_ts    timestamptz NOT NULL DEFAULT now(),
  type         text NOT NULL,
  ref          text,
  payload      jsonb,
  input_source text NOT NULL,
  UNIQUE (attempt_id, seq)
);
CREATE INDEX actions_attempt_idx ON actions (attempt_id, seq);

CREATE TABLE results (
  attempt_id      uuid PRIMARY KEY REFERENCES attempts(id) ON DELETE CASCADE,
  case_id         text NOT NULL,
  case_version    int  NOT NULL,
  rubric_revision int  NOT NULL,
  total_pct       numeric(5,2) NOT NULL,
  passed          boolean NOT NULL,
  report          jsonb NOT NULL,
  scored_at       timestamptz NOT NULL DEFAULT now()
);
