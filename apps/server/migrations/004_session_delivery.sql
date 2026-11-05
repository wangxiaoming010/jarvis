CREATE TABLE IF NOT EXISTS task_session_delivery (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id),
  thread_id TEXT NOT NULL,
  accepted_version INTEGER NOT NULL DEFAULT 0
);
-- Existing native threads already contain their initial assignment.
INSERT OR IGNORE INTO task_session_delivery(task_id,thread_id,accepted_version)
SELECT task_id,thread_id,COALESCE(executed_version,1) FROM task_specs WHERE thread_id IS NOT NULL;
INSERT OR IGNORE INTO schema_migrations(version) VALUES(4);
