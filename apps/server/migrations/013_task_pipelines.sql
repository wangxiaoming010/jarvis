CREATE TABLE task_pipelines (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id),
  group_id TEXT NOT NULL REFERENCES groups(id),
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  archived_at TEXT
);
CREATE TABLE task_pipeline_bindings (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id),
  pipeline_id TEXT NOT NULL REFERENCES task_pipelines(id)
);
CREATE INDEX task_pipeline_queue ON task_pipeline_bindings(pipeline_id,task_id);
CREATE TABLE pipeline_sessions (
  pipeline_id TEXT NOT NULL REFERENCES task_pipelines(id),
  provider TEXT NOT NULL CHECK(provider IN ('codex','claude-code')),
  bridge_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(pipeline_id,provider,bridge_id),
  UNIQUE(provider,bridge_id,thread_id)
);
INSERT INTO task_pipelines(id,bot_id,group_id,title,created_at)
SELECT t.id,t.bot_id,t.group_id,s.goal,t.created_at FROM tasks t
JOIN task_specs s ON s.task_id=t.id JOIN task_workers w ON w.task_id=t.id;
INSERT INTO task_pipeline_bindings(task_id,pipeline_id)
SELECT id,id FROM task_pipelines;
INSERT OR REPLACE INTO pipeline_sessions(pipeline_id,provider,bridge_id,thread_id,updated_at)
SELECT r.task_id,r.provider,r.bridge_id,r.thread_id,COALESCE(r.finished_at,r.started_at)
FROM worker_runs r WHERE r.thread_id IS NOT NULL AND EXISTS(SELECT 1 FROM task_pipelines p WHERE p.id=r.task_id)
ORDER BY r.started_at,r.rowid;
INSERT OR IGNORE INTO pipeline_sessions(pipeline_id,provider,bridge_id,thread_id,updated_at)
SELECT p.id,w.provider,b.bridge_id,s.thread_id,s.updated_at
FROM task_pipelines p JOIN task_workers w ON w.task_id=p.id JOIN bots b ON b.id=p.bot_id
JOIN task_specs s ON s.task_id=p.id WHERE s.thread_id IS NOT NULL AND b.bridge_id IS NOT NULL;

CREATE TABLE task_health (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id),
  state TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  last_activity_at TEXT,
  last_heartbeat_at TEXT,
  observed_at TEXT NOT NULL
);
INSERT INTO task_health(task_id,state,last_activity_at,observed_at)
SELECT t.id,t.status,COALESCE(s.updated_at,t.started_at,t.created_at),COALESCE(s.updated_at,t.created_at)
FROM tasks t LEFT JOIN task_specs s ON s.task_id=t.id;
CREATE TRIGGER task_health_created AFTER INSERT ON tasks BEGIN
  INSERT INTO task_health(task_id,state,last_activity_at,observed_at)
  VALUES(NEW.id,NEW.status,NEW.created_at,NEW.created_at);
END;
CREATE TRIGGER task_health_status AFTER UPDATE OF status ON tasks BEGIN
  UPDATE task_health SET state=NEW.status,detail=COALESCE(NEW.error,''),observed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE task_id=NEW.id;
END;
CREATE TABLE worker_reports (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  lease_id TEXT NOT NULL REFERENCES worker_runs(id),
  kind TEXT NOT NULL CHECK(kind IN ('progress','milestone','blocked')),
  summary TEXT NOT NULL,
  digest TEXT NOT NULL,
  created_at TEXT NOT NULL,
  notified_at TEXT,
  UNIQUE(task_id,lease_id,kind,digest)
);
CREATE INDEX worker_reports_pending ON worker_reports(task_id,notified_at,created_at);
INSERT INTO schema_migrations(version) VALUES(13);
