-- Bot identity owns coordination; native providers belong to individual executions.
DROP INDEX IF EXISTS one_running_task_per_bot;
CREATE TABLE IF NOT EXISTS bot_memory (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id),
  group_id TEXT REFERENCES groups(id) ON DELETE CASCADE,
  scope TEXT NOT NULL DEFAULT 'group' CHECK(scope IN ('group','bot')),
  key TEXT NOT NULL,
  content TEXT NOT NULL,
  source_message_id TEXT REFERENCES messages(id),
  updated_at TEXT NOT NULL,
  CHECK((scope='bot' AND group_id IS NULL) OR (scope='group' AND group_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS bot_memory_key ON bot_memory(bot_id,scope,COALESCE(group_id,''),key);
CREATE TABLE IF NOT EXISTS coordinator_turns (
  id TEXT PRIMARY KEY,
  inbox_id TEXT NOT NULL UNIQUE REFERENCES dialogue_inbox(id),
  bot_id TEXT NOT NULL REFERENCES bots(id),
  messages TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  rounds INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS coordinator_calls (
  turn_id TEXT NOT NULL REFERENCES coordinator_turns(id),
  call_id TEXT NOT NULL,
  name TEXT NOT NULL,
  arguments TEXT NOT NULL,
  result TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(turn_id,call_id)
);
CREATE TABLE IF NOT EXISTS task_workers (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id),
  provider TEXT NOT NULL CHECK(provider IN ('codex','claude-code')),
  resource_key TEXT NOT NULL,
  parent_task_id TEXT REFERENCES tasks(id),
  review TEXT NOT NULL DEFAULT 'pending',
  verification TEXT,
  watchdog_at TEXT,
  silent INTEGER NOT NULL DEFAULT 0,
  stopped INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS worker_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  bot_id TEXT NOT NULL REFERENCES bots(id),
  bridge_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  requirement_version INTEGER NOT NULL,
  thread_id TEXT,
  status TEXT NOT NULL,
  result TEXT,
  error TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS worker_runs_task ON worker_runs(task_id,started_at);
CREATE INDEX IF NOT EXISTS coordinator_turns_bot ON coordinator_turns(bot_id,created_at);
INSERT OR IGNORE INTO schema_migrations(version) VALUES(10);
