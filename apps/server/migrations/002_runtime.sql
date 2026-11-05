CREATE TABLE IF NOT EXISTS bot_bindings(bot_id TEXT PRIMARY KEY REFERENCES bots(id), working_directory TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS agent_sessions(bot_id TEXT NOT NULL REFERENCES bots(id), group_id TEXT NOT NULL REFERENCES groups(id), thread_id TEXT NOT NULL, last_message_id TEXT, PRIMARY KEY(bot_id, group_id));
CREATE TABLE IF NOT EXISTS collaboration_chains(id TEXT PRIMARY KEY, stopped INTEGER NOT NULL DEFAULT 0, calls INTEGER NOT NULL DEFAULT 0, max_rounds INTEGER NOT NULL DEFAULT 6, max_calls INTEGER NOT NULL DEFAULT 12);
CREATE TABLE IF NOT EXISTS task_runtime(task_id TEXT PRIMARY KEY REFERENCES tasks(id), source_message_id TEXT NOT NULL REFERENCES messages(id), lease_id TEXT, UNIQUE(source_message_id,task_id));
CREATE UNIQUE INDEX IF NOT EXISTS one_running_task_per_bot ON tasks(bot_id) WHERE status IN ('running','cancelling');
CREATE TABLE IF NOT EXISTS routing_decisions(message_id TEXT PRIMARY KEY REFERENCES messages(id), status TEXT NOT NULL, action TEXT, bot_ids TEXT NOT NULL DEFAULT '[]', reason TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS task_approvals(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), request_id TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL);
INSERT OR IGNORE INTO schema_migrations(version) VALUES(2);
