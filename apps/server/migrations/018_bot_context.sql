-- Working context is disposable; original conversations and tool receipts stay authoritative.
CREATE TABLE IF NOT EXISTS bot_context_history (
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  through_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  source_digest TEXT NOT NULL,
  summary TEXT NOT NULL,
  method TEXT NOT NULL CHECK(method IN ('model','extractive')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(bot_id,group_id)
);
CREATE TABLE IF NOT EXISTS bot_context_compactions (
  turn_id TEXT NOT NULL REFERENCES coordinator_turns(id) ON DELETE CASCADE,
  source_digest TEXT NOT NULL,
  summary TEXT NOT NULL,
  method TEXT NOT NULL CHECK(method IN ('model','extractive')),
  created_at TEXT NOT NULL,
  PRIMARY KEY(turn_id,source_digest)
);
CREATE TABLE IF NOT EXISTS bot_context_inputs (
  turn_id TEXT NOT NULL REFERENCES coordinator_turns(id) ON DELETE CASCADE,
  source_digest TEXT NOT NULL,
  context TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(turn_id,source_digest)
);
INSERT OR IGNORE INTO schema_migrations(version) VALUES(18);
