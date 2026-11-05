-- Goals outlive executions. Projects are scoped shared records, never a group coordinator.
CREATE TABLE work_projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE project_groups (
  project_id TEXT NOT NULL REFERENCES work_projects(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  PRIMARY KEY(project_id,group_id)
);
CREATE TABLE project_facts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES work_projects(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  confirmed_version INTEGER NOT NULL DEFAULT 0,
  UNIQUE(project_id,key)
);
CREATE TABLE project_fact_revisions (
  fact_id TEXT NOT NULL REFERENCES project_facts(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('requirement','decision','interface')),
  content TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('proposed','confirmed','rejected')),
  proposed_by TEXT NOT NULL REFERENCES bots(id),
  source_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  confirmed_by_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(fact_id,version)
);
CREATE TABLE work_goals (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id),
  group_id TEXT NOT NULL REFERENCES groups(id),
  source_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  project_id TEXT REFERENCES work_projects(id),
  project_cursor INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  criteria TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','waiting','needs_attention','completed','cancelled')),
  next_action TEXT NOT NULL DEFAULT '评估目标并安排下一行动',
  next_check_at TEXT,
  deadline TEXT,
  generation INTEGER NOT NULL DEFAULT 1,
  unattended_checks INTEGER NOT NULL DEFAULT 0,
  attention_reason TEXT,
  owner_wait INTEGER NOT NULL DEFAULT 0,
  legacy INTEGER NOT NULL DEFAULT 0,
  delivery TEXT NOT NULL DEFAULT 'accepted' CHECK(delivery IN ('accepted','applied')),
  verification TEXT NOT NULL DEFAULT 'reviewed' CHECK(verification IN ('reviewed','content')),
  result TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
ALTER TABLE tasks ADD COLUMN goal_id TEXT REFERENCES work_goals(id) ON DELETE SET NULL;
ALTER TABLE worker_runs ADD COLUMN goal_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE worker_runs ADD COLUMN project_cursor INTEGER NOT NULL DEFAULT 0;
ALTER TABLE task_workers ADD COLUMN verify_artifact_ids TEXT NOT NULL DEFAULT '[]';
INSERT INTO work_goals(id,bot_id,group_id,source_message_id,title,criteria,state,legacy,next_check_at,created_at,updated_at)
SELECT t.id,t.bot_id,COALESCE(r.group_id,t.group_id),rt.source_message_id,s.goal,c.criteria,
CASE WHEN c.state='cancelled' THEN 'cancelled' WHEN t.status='completed' THEN 'completed' ELSE 'active' END,
1,COALESCE(c.next_wake_at,strftime('%Y-%m-%dT%H:%M:%fZ','now','+5 minutes')),t.created_at,c.updated_at
FROM tasks t JOIN task_specs s ON s.task_id=t.id JOIN task_contracts c ON c.task_id=t.id
JOIN task_runtime rt ON rt.task_id=t.id LEFT JOIN task_routes r ON r.task_id=t.id;
UPDATE tasks SET goal_id=id WHERE id IN (SELECT id FROM work_goals);
ALTER TABLE dialogue_inbox ADD COLUMN goal_id TEXT REFERENCES work_goals(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX goal_inbox_event ON dialogue_inbox(goal_id,kind) WHERE goal_id IS NOT NULL;

CREATE TABLE work_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  state TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE goal_waits (
  goal_id TEXT NOT NULL REFERENCES work_goals(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('task','goal','delegation','fact','artifact','human','file')),
  entity_id TEXT NOT NULL,
  desired_state TEXT NOT NULL,
  after_version INTEGER NOT NULL DEFAULT -1,
  after_event INTEGER NOT NULL,
  PRIMARY KEY(goal_id,kind,entity_id)
);
CREATE INDEX goal_checks ON work_goals(state,next_check_at);
CREATE INDEX work_event_entity ON work_events(kind,entity_id,seq);
CREATE TRIGGER work_task_event AFTER UPDATE OF status ON tasks WHEN OLD.status!=NEW.status BEGIN
  INSERT INTO work_events(kind,entity_id,state) VALUES('task',NEW.id,NEW.status);
END;
CREATE TRIGGER work_goal_event AFTER UPDATE OF state ON work_goals WHEN OLD.state!=NEW.state BEGIN
  INSERT INTO work_events(kind,entity_id,state,version) VALUES('goal',NEW.id,NEW.state,NEW.version);
END;
CREATE TRIGGER work_human_event AFTER INSERT ON messages WHEN NEW.sender_type='human' BEGIN
  INSERT INTO work_events(kind,entity_id,state) VALUES('human',NEW.group_id,'received');
END;
CREATE TRIGGER work_fact_event AFTER UPDATE OF confirmed_version ON project_facts WHEN OLD.confirmed_version!=NEW.confirmed_version BEGIN
  INSERT INTO work_events(kind,entity_id,state,version) VALUES('fact',NEW.id,'confirmed',NEW.confirmed_version);
END;

-- Keep the existing peer protocol; an offer can be owned by a goal without a producer task.
ALTER TABLE bot_delegations RENAME TO old_bot_delegations;
DROP INDEX delegation_active;
CREATE TABLE bot_delegations (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  goal_id TEXT NOT NULL REFERENCES work_goals(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES groups(id),
  source_bot_id TEXT NOT NULL REFERENCES bots(id),
  target_bot_id TEXT NOT NULL REFERENCES bots(id),
  source_message_id TEXT NOT NULL REFERENCES messages(id),
  child_task_id TEXT UNIQUE REFERENCES tasks(id),
  child_goal_id TEXT UNIQUE REFERENCES work_goals(id),
  goal TEXT NOT NULL,
  criteria TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'offered' CHECK(state IN ('offered','accepted','rejected','submitted','completed','cancelled','expired')),
  result TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(source_bot_id!=target_bot_id)
);
INSERT INTO bot_delegations(id,task_id,goal_id,group_id,source_bot_id,target_bot_id,source_message_id,child_task_id,child_goal_id,goal,criteria,state,result,expires_at,created_at,updated_at)
SELECT d.id,d.task_id,t.goal_id,d.group_id,d.source_bot_id,d.target_bot_id,d.source_message_id,d.child_task_id,c.goal_id,d.goal,d.criteria,d.state,d.result,d.expires_at,d.created_at,d.updated_at
FROM old_bot_delegations d JOIN tasks t ON t.id=d.task_id LEFT JOIN tasks c ON c.id=d.child_task_id;
DROP TABLE old_bot_delegations;
CREATE UNIQUE INDEX delegation_active ON bot_delegations(goal_id,target_bot_id,goal) WHERE state IN ('offered','accepted','submitted');
CREATE TRIGGER work_delegation_event AFTER UPDATE OF state ON bot_delegations WHEN OLD.state!=NEW.state BEGIN
  INSERT INTO work_events(kind,entity_id,state) VALUES('delegation',NEW.id,NEW.state);
END;

CREATE TABLE task_fact_refs (
  run_id TEXT NOT NULL REFERENCES worker_runs(id) ON DELETE CASCADE,
  fact_id TEXT NOT NULL REFERENCES project_facts(id),
  version INTEGER NOT NULL,
  PRIMARY KEY(run_id,fact_id)
);
CREATE TABLE work_artifacts (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES work_goals(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  producer_run_id TEXT REFERENCES worker_runs(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('file','git','report')),
  locator TEXT NOT NULL,
  application_path TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  digest TEXT NOT NULL,
  manifest TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'produced' CHECK(state IN ('produced','verified','accepted','applied')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE artifact_history (
  artifact_id TEXT NOT NULL REFERENCES work_artifacts(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  digest TEXT NOT NULL,
  manifest TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(artifact_id,version)
);
CREATE TABLE artifact_checks (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES work_artifacts(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  method TEXT NOT NULL CHECK(method IN ('json','independent_run','human','application')),
  verifier_run_id TEXT REFERENCES worker_runs(id) ON DELETE SET NULL,
  source_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  evidence TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE task_artifact_refs (
  run_id TEXT NOT NULL REFERENCES worker_runs(id) ON DELETE CASCADE,
  artifact_id TEXT NOT NULL REFERENCES work_artifacts(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  digest TEXT NOT NULL,
  PRIMARY KEY(run_id,artifact_id)
);
CREATE TABLE goal_acceptance (
  goal_id TEXT NOT NULL REFERENCES work_goals(id) ON DELETE CASCADE,
  goal_version INTEGER NOT NULL,
  criterion TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('artifact','delegation')),
  entity_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  accepted_at TEXT NOT NULL,
  PRIMARY KEY(goal_id,goal_version,criterion)
);
CREATE TRIGGER work_artifact_event AFTER UPDATE OF state,version ON work_artifacts WHEN OLD.state!=NEW.state OR OLD.version!=NEW.version BEGIN
  INSERT INTO work_events(kind,entity_id,state,version) VALUES('artifact',NEW.id,NEW.state,NEW.version);
END;
INSERT INTO schema_migrations(version) VALUES(15);
