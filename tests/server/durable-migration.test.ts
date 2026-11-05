import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../../apps/server/src/store';

it('upgrades populated version-13 work without losing identity, source, native session or memory and reopens idempotently', () => {
  const directory = mkdtempSync(join(tmpdir(), 'openbot-migration-'));
  const path = join(directory, 'db.sqlite');
  let db = new Database(path);
  try {
    db.pragma('foreign_keys = ON');
    const migrations = new URL('../../apps/server/migrations/', import.meta.url);
    for (const file of readdirSync(migrations)
      .filter((f) => /^\d+.*\.sql$/.test(f) && Number(f.slice(0, 3)) <= 13)
      .sort())
      db.transaction(() => db.exec(readFileSync(new URL(file, migrations), 'utf8')))();
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO bots(id,owner_id,name,description,provider,created_at) VALUES('b','owner','BB','','codex',?)",
    ).run(now);
    db.prepare("INSERT INTO groups VALUES('g','项目群','',?)").run(now);
    db.prepare("INSERT INTO group_bots VALUES('g','b')").run();
    db.prepare(
      "INSERT INTO messages(id,group_id,sender_id,sender_type,content,timestamp,message_type) VALUES('m','g','owner','human','持续负责',?,'text')",
    ).run(now);
    db.prepare(
      "INSERT INTO tasks(id,group_id,bot_id,input,status,created_at,correlation_id) VALUES('t','g','b','持续负责','completed',?,'chain')",
    ).run(now);
    db.prepare("INSERT INTO task_runtime(task_id,source_message_id) VALUES('t','m')").run();
    db.prepare(
      "INSERT INTO task_specs(task_id,goal,context_message_id,context,updated_at) VALUES('t','持续负责','m','[]',?)",
    ).run(now);
    db.prepare(
      "INSERT INTO task_workers(task_id,provider,resource_key) VALUES('t','codex','*')",
    ).run();
    db.prepare("INSERT INTO task_pipelines VALUES('p','b','g','持续负责',?,NULL)").run(now);
    db.prepare("INSERT INTO task_pipeline_bindings VALUES('t','p')").run();
    db.prepare("INSERT INTO pipeline_sessions VALUES('p','codex','device','native-thread',?)").run(
      now,
    );
    db.prepare(
      "INSERT INTO bot_memory(id,bot_id,scope,key,content,source_message_id,updated_at) VALUES('memory','b','bot','preference','偏好中文','m',?)",
    ).run(now);
    db.close();
    let store = createStore(path);
    db = store.db;
    expect(store.snapshot().tasks).toContainEqual(
      expect.objectContaining({
        id: 't',
        groupId: 'g',
        execution: expect.objectContaining({
          pipeline: { id: 'p', title: '持续负责' },
          contract: expect.objectContaining({ state: 'completed' }),
        }),
      }),
    );
    expect(db.prepare('SELECT * FROM task_routes').get()).toEqual({
      task_id: 't',
      group_id: 'g',
      source_message_id: 'm',
    });
    expect(db.prepare('SELECT thread_id FROM pipeline_sessions').get()).toEqual({
      thread_id: 'native-thread',
    });
    expect(db.prepare('SELECT content,source_message_id,state FROM bot_memory').get()).toEqual({
      content: '偏好中文',
      source_message_id: 'm',
      state: 'active',
    });
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
    store = createStore(path);
    db = store.db;
    expect(db.prepare('SELECT count(*) AS n FROM task_conversations').get()).toEqual({ n: 1 });
    expect(
      db.prepare('SELECT count(*) AS n FROM schema_migrations WHERE version=14').get(),
    ).toEqual({ n: 1 });
    expect(store.snapshot().bots).toHaveLength(1);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  } finally {
    if (db.open) db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('migrates a populated version-14 delegation into goal ownership while retaining original task/session history', () => {
  const directory = mkdtempSync(join(tmpdir(), 'openbot-v14-goals-')),
    path = join(directory, 'db.sqlite');
  let db = new Database(path);
  try {
    db.pragma('foreign_keys = ON');
    const migrations = new URL('../../apps/server/migrations/', import.meta.url);
    for (const file of readdirSync(migrations)
      .filter((f) => /^\d+.*\.sql$/.test(f) && Number(f.slice(0, 3)) <= 14)
      .sort())
      db.transaction(() => db.exec(readFileSync(new URL(file, migrations), 'utf8')))();
    const now = new Date().toISOString();
    db.prepare("INSERT INTO groups VALUES('g','项目群','',?)").run(now);
    for (const [b, name] of [
      ['bb', 'BB'],
      ['dev', 'DEV'],
    ]) {
      db.prepare(
        "INSERT INTO bots(id,owner_id,name,description,provider,created_at) VALUES(?,'owner',?,'','codex',?)",
      ).run(b, name, now);
      db.prepare("INSERT INTO group_bots VALUES('g',?)").run(b);
    }
    db.prepare(
      "INSERT INTO messages(id,group_id,sender_id,sender_type,content,timestamp,message_type) VALUES('m','g','owner','human','推进项目',?,'text')",
    ).run(now);
    for (const [id, b, status] of [
      ['parent', 'bb', 'reviewing'],
      ['child', 'dev', 'running'],
    ]) {
      db.prepare(
        "INSERT INTO tasks(id,group_id,bot_id,input,status,created_at,correlation_id) VALUES(?,'g',?,'推进项目',?,?,'chain')",
      ).run(id, b, status, now);
      db.prepare("INSERT INTO task_runtime(task_id,source_message_id) VALUES(?,'m')").run(id);
      db.prepare(
        "INSERT INTO task_specs(task_id,goal,context_message_id,context,updated_at) VALUES(?,'推进项目','m','[]',?)",
      ).run(id, now);
      db.prepare(
        "INSERT INTO task_workers(task_id,provider,resource_key) VALUES(?,'codex','*')",
      ).run(id);
      db.prepare("INSERT INTO task_routes VALUES(?,'g','m')").run(id);
      db.prepare("INSERT INTO task_conversations VALUES(?,'g','m',?)").run(id, now);
    }
    db.prepare(
      "INSERT INTO bot_delegations(id,task_id,group_id,source_bot_id,target_bot_id,source_message_id,child_task_id,goal,criteria,state,result,expires_at,created_at,updated_at) VALUES('d','parent','g','bb','dev','m','child','核实接口','[\"接口可用\"]','accepted','已接下','2099-01-01T00:00:00.000Z',?,?)",
    ).run(now, now);
    db.prepare(
      "INSERT INTO worker_runs(id,task_id,bot_id,bridge_id,provider,requirement_version,thread_id,status,started_at) VALUES('run','child','dev','device','codex',1,'native-thread','running',?)",
    ).run(now);
    db.close();
    const store = createStore(path);
    db = store.db;
    expect(
      db
        .prepare(
          'SELECT task_id,goal_id,child_task_id,child_goal_id,state,result FROM bot_delegations',
        )
        .get(),
    ).toEqual({
      task_id: 'parent',
      goal_id: 'parent',
      child_task_id: 'child',
      child_goal_id: 'child',
      state: 'accepted',
      result: '已接下',
    });
    expect(store.snapshot().goals).toHaveLength(2);
    expect(db.prepare('SELECT thread_id,status FROM worker_runs').get()).toEqual({
      thread_id: 'native-thread',
      status: 'unknown',
    });
    expect(
      db.prepare('SELECT count(*) AS n FROM schema_migrations WHERE version=15').get(),
    ).toEqual({ n: 1 });
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
    db = createStore(path).db;
    expect(db.prepare('SELECT count(*) AS n FROM work_goals').get()).toEqual({ n: 2 });
  } finally {
    if (db.open) db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
