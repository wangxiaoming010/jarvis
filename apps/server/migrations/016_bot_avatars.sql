CREATE TABLE bot_avatars (
  bot_id TEXT PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK(type IN ('emoji','image')),
  value TEXT NOT NULL
);
INSERT INTO schema_migrations(version) VALUES(16);
