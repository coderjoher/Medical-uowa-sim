-- From the load test (docs/load-test.md): the live seat query looks up the latest action of
-- given types per attempt; index that. The old (attempt_id, seq) index duplicated the one the
-- UNIQUE (attempt_id, seq) constraint already creates.
CREATE INDEX IF NOT EXISTS actions_attempt_type_idx ON actions (attempt_id, type, seq);
DROP INDEX IF EXISTS actions_attempt_idx;
