CREATE TABLE IF NOT EXISTS native_requests (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL UNIQUE REFERENCES messages(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  lease_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  spec TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  response TEXT,
  response_hash TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(task_id,lease_id,request_id)
);
CREATE TRIGGER IF NOT EXISTS expire_native_requests
AFTER UPDATE OF status ON tasks WHEN NEW.status != 'running'
BEGIN
  UPDATE native_requests SET status='cancelled' WHERE task_id=NEW.id AND status='pending';
END;
INSERT OR IGNORE INTO schema_migrations(version) VALUES(6);
