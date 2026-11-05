-- Lasting human preferences are injected separately from recalled historical facts.
ALTER TABLE bot_memory ADD COLUMN kind TEXT NOT NULL DEFAULT 'fact' CHECK(kind IN ('fact','preference'));
-- Human messages are curated for memory whether or not the Bot chose to reply.
CREATE TABLE IF NOT EXISTS memory_curation (
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed','skipped','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  saved INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(bot_id,message_id)
);
CREATE INDEX IF NOT EXISTS memory_curation_pending ON memory_curation(status,bot_id);
INSERT OR IGNORE INTO schema_migrations(version) VALUES(19);
