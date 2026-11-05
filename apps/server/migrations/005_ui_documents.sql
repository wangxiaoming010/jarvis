CREATE TABLE IF NOT EXISTS ui_documents (
  message_id TEXT PRIMARY KEY REFERENCES messages(id),
  group_id TEXT NOT NULL REFERENCES groups(id), bot_id TEXT REFERENCES bots(id),
  view_id TEXT NOT NULL, revision INTEGER NOT NULL, document TEXT NOT NULL,
  policy TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', response TEXT,
  source_message_id TEXT REFERENCES messages(id),
  UNIQUE(group_id,view_id,revision)
);
CREATE TABLE IF NOT EXISTS ui_actions (
  request_id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES ui_documents(message_id),
  body_hash TEXT NOT NULL, response TEXT NOT NULL, created_at TEXT NOT NULL
);
INSERT OR IGNORE INTO schema_migrations(version) VALUES(5);
