-- Work belongs to a Bot. Conversations are explicit, auditable communication routes.
CREATE TABLE task_conversations (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  source_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  linked_at TEXT NOT NULL,
  PRIMARY KEY(task_id,group_id)
);
INSERT INTO task_conversations SELECT t.id,t.group_id,r.source_message_id,t.created_at FROM tasks t JOIN task_runtime r ON r.task_id=t.id;
CREATE TABLE task_routes (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES groups(id),
  source_message_id TEXT NOT NULL REFERENCES messages(id)
);
INSERT INTO task_routes SELECT task_id,group_id,source_message_id FROM task_conversations WHERE source_message_id IS NOT NULL;

CREATE TABLE task_contracts (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  criteria TEXT NOT NULL DEFAULT '[]',
  next_action TEXT NOT NULL DEFAULT '',
  wait_condition TEXT,
  next_wake_at TEXT,
  deadline TEXT,
  generation INTEGER NOT NULL DEFAULT 1,
  max_runs INTEGER NOT NULL DEFAULT 12 CHECK(max_runs BETWEEN 1 AND 100),
  state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','waiting','completed','cancelled')),
  updated_at TEXT NOT NULL
);
INSERT INTO task_contracts(task_id,state,updated_at) SELECT id,CASE status WHEN 'completed' THEN 'completed' WHEN 'cancelled' THEN 'cancelled' ELSE 'active' END,created_at FROM tasks;
CREATE TRIGGER task_contract_created AFTER INSERT ON tasks BEGIN
  INSERT INTO task_contracts(task_id,updated_at) VALUES(NEW.id,NEW.created_at);
END;
CREATE TRIGGER task_contract_stopped AFTER UPDATE OF stopped ON task_workers WHEN NEW.stopped=1 BEGIN
  UPDATE task_contracts SET state='cancelled',next_wake_at=NULL,generation=generation+1 WHERE task_id=NEW.task_id;
END;
CREATE TABLE task_acceptance (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES worker_runs(id) ON DELETE CASCADE,
  requirement_version INTEGER NOT NULL,
  criterion TEXT NOT NULL,
  evidence TEXT NOT NULL,
  source TEXT NOT NULL,
  verified_at TEXT NOT NULL,
  PRIMARY KEY(task_id,run_id,criterion)
);

CREATE TABLE bot_delegations (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES groups(id),
  source_bot_id TEXT NOT NULL REFERENCES bots(id),
  target_bot_id TEXT NOT NULL REFERENCES bots(id),
  source_message_id TEXT NOT NULL REFERENCES messages(id),
  child_task_id TEXT UNIQUE REFERENCES tasks(id),
  goal TEXT NOT NULL,
  criteria TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'offered' CHECK(state IN ('offered','accepted','rejected','submitted','completed','cancelled','expired')),
  result TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(source_bot_id!=target_bot_id)
);
CREATE UNIQUE INDEX delegation_active ON bot_delegations(task_id,target_bot_id,goal) WHERE state IN ('offered','accepted','submitted');

ALTER TABLE bot_memory ADD COLUMN provenance TEXT NOT NULL DEFAULT 'inference';
ALTER TABLE bot_memory ADD COLUMN importance INTEGER NOT NULL DEFAULT 1;
ALTER TABLE bot_memory ADD COLUMN expires_at TEXT;
ALTER TABLE bot_memory ADD COLUMN state TEXT NOT NULL DEFAULT 'active';
CREATE TABLE bot_memory_revisions (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL REFERENCES bot_memory(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  source_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  provenance TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX memory_recall ON bot_memory(bot_id,state,scope,group_id);

ALTER TABLE task_workers ADD COLUMN resource_mode TEXT NOT NULL DEFAULT 'exclusive';
CREATE TABLE pipeline_workspaces (
  pipeline_id TEXT PRIMARY KEY REFERENCES task_pipelines(id),
  root TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  base_commit TEXT NOT NULL,
  created_at TEXT NOT NULL,
  review TEXT
);
CREATE INDEX inbox_bot_queue ON dialogue_inbox(bot_id,status,created_at);
INSERT INTO schema_migrations(version) VALUES(14);
