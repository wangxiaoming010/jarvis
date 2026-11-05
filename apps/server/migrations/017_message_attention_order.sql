CREATE TABLE message_attention_order (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  weight INTEGER NOT NULL CHECK(weight > 0),
  eligible_at INTEGER NOT NULL,
  started_at INTEGER,
  PRIMARY KEY(message_id, bot_id),
  UNIQUE(message_id, weight)
);
INSERT INTO schema_migrations(version) VALUES(17);
