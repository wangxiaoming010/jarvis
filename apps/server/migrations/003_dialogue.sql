CREATE TABLE IF NOT EXISTS conversation_memory (
  bot_id TEXT NOT NULL REFERENCES bots(id), group_id TEXT NOT NULL REFERENCES groups(id),
  summary TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL,
  PRIMARY KEY(bot_id,group_id)
);
CREATE TABLE IF NOT EXISTS dialogue_inbox (
  id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id), group_id TEXT NOT NULL REFERENCES groups(id),
  source_message_id TEXT REFERENCES messages(id), task_id TEXT REFERENCES tasks(id),
  kind TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'queued', created_at TEXT NOT NULL,
  UNIQUE(bot_id,source_message_id), UNIQUE(task_id,kind)
);
CREATE TABLE IF NOT EXISTS task_specs (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id), goal TEXT NOT NULL,
  working_directory TEXT NOT NULL, context_message_id TEXT NOT NULL REFERENCES messages(id),
  context TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, executed_version INTEGER,
  thread_id TEXT, activity TEXT, report TEXT, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS task_changes (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
  source_message_id TEXT REFERENCES messages(id), instruction TEXT NOT NULL,
  version INTEGER NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(task_id,version)
);
INSERT OR IGNORE INTO schema_migrations(version) VALUES(3);
