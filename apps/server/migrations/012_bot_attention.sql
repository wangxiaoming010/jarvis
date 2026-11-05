CREATE TABLE attention_decisions (
  inbox_id TEXT PRIMARY KEY REFERENCES dialogue_inbox(id) ON DELETE CASCADE,
  input TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','completed','failed','bypassed','budget_limited')),
  wake INTEGER CHECK(wake IN (0,1)),
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  updated_at TEXT NOT NULL
);
ALTER TABLE collaboration_chains ADD COLUMN bot_wakes INTEGER NOT NULL DEFAULT 0;
INSERT INTO schema_migrations(version) VALUES(12);
