import { randomUUID } from 'node:crypto';
import type { Message } from '@openbot/shared';
import type { Store } from '../store.js';
export type ProjectFact = {
  id: string;
  key: string;
  version: number;
  kind: string;
  content: string;
};
export class ProjectFacts {
  constructor(private store: Store) {}
  check(projectId: string, groupId: string) {
    if (
      !this.store.db
        .prepare('SELECT 1 FROM project_groups WHERE project_id=? AND group_id=?')
        .get(projectId, groupId)
    )
      throw new Error('当前对话无权访问这个项目');
  }
  create(name: string, source: Message) {
    const id = randomUUID();
    this.store.db.transaction(() => {
      this.store.db
        .prepare('INSERT INTO work_projects VALUES(?,?,?)')
        .run(id, name, new Date().toISOString());
      this.store.db.prepare('INSERT INTO project_groups VALUES(?,?)').run(id, source.groupId);
    })();
    return { id, name };
  }
  share(projectId: string, groupId: string, source: Message) {
    this.check(projectId, source.groupId);
    if (source.senderType !== 'human') throw new Error('只有所有者能明确共享项目到另一对话');
    if (!this.store.db.prepare('SELECT 1 FROM groups WHERE id=?').get(groupId))
      throw new Error('目标对话不存在');
    this.store.db
      .prepare('INSERT OR IGNORE INTO project_groups VALUES(?,?)')
      .run(projectId, groupId);
    return { shared: true };
  }
  read(projectId: string, groupId: string) {
    this.check(projectId, groupId);
    return {
      project: this.store.db.prepare('SELECT id,name FROM work_projects WHERE id=?').get(projectId),
      facts: this.current(projectId),
      proposals: this.store.db
        .prepare(
          "SELECT f.id,f.key,r.* FROM project_facts f JOIN project_fact_revisions r ON r.fact_id=f.id AND r.version=f.version WHERE f.project_id=? AND r.state='proposed' ORDER BY f.key",
        )
        .all(projectId),
    };
  }
  current(projectId: string): ProjectFact[] {
    return this.store.db
      .prepare(
        'SELECT f.id,f.key,r.version,r.kind,r.content FROM project_facts f JOIN project_fact_revisions r ON r.fact_id=f.id AND r.version=f.confirmed_version WHERE f.project_id=? ORDER BY f.key',
      )
      .all(projectId) as ProjectFact[];
  }
  propose(
    projectId: string,
    key: string,
    content: string,
    kind: string,
    expectedVersion: number,
    botId: string,
    source: Message,
  ) {
    this.check(projectId, source.groupId);
    const old = this.store.db
      .prepare('SELECT id,version FROM project_facts WHERE project_id=? AND key=?')
      .get(projectId, key) as { id: string; version: number } | undefined;
    if ((old?.version ?? 0) !== expectedVersion)
      throw new Error('项目事实已变更，请读取最新版本后再提议');
    return this.store.db.transaction(() => {
      const id = old?.id ?? randomUUID(),
        version = expectedVersion + 1;
      if (!old)
        this.store.db
          .prepare('INSERT INTO project_facts(id,project_id,key) VALUES(?,?,?)')
          .run(id, projectId, key);
      this.store.db
        .prepare('INSERT INTO project_fact_revisions VALUES(?,?,?,?,?,?,?,?,?)')
        .run(
          id,
          version,
          kind,
          content,
          'proposed',
          botId,
          source.id,
          null,
          new Date().toISOString(),
        );
      this.store.db.prepare('UPDATE project_facts SET version=? WHERE id=?').run(version, id);
      return { factId: id, version, state: 'proposed' };
    })();
  }
  confirm(factId: string, version: number, source: Message) {
    const fact = this.store.db
      .prepare('SELECT project_id,version,confirmed_version FROM project_facts WHERE id=?')
      .get(factId) as
      { project_id: string; version: number; confirmed_version: number } | undefined;
    if (!fact) throw new Error('项目事实不存在');
    this.check(fact.project_id, source.groupId);
    if (source.senderType !== 'human')
      throw new Error('项目决定需要所有者明确确认，Bot 的建议不能直接变为定论');
    if (fact.version !== version) throw new Error('提案已经过期，请先查看当前提案');
    if (fact.confirmed_version === version) return { factId, version, state: 'confirmed' };
    this.store.db.transaction(() => {
      this.store.db
        .prepare(
          "UPDATE project_fact_revisions SET state='confirmed',confirmed_by_message_id=? WHERE fact_id=? AND version=?",
        )
        .run(source.id, factId, version);
      this.store.db
        .prepare('UPDATE project_facts SET confirmed_version=? WHERE id=?')
        .run(version, factId);
    })();
    return { factId, version, state: 'confirmed' };
  }
  capture(goalId: string, runId: string) {
    const row = this.store.db
      .prepare('SELECT project_id,group_id FROM work_goals WHERE id=?')
      .get(goalId) as { project_id: string | null; group_id: string } | undefined;
    if (!row?.project_id) return [];
    this.check(row.project_id, row.group_id);
    const facts = this.current(row.project_id);
    this.store.db
      .prepare(
        'UPDATE worker_runs SET project_cursor=(SELECT COALESCE(MAX(seq),0) FROM work_events) WHERE id=?',
      )
      .run(runId);
    if (facts.length > 40) throw new Error('项目事实过多，请拆分项目范围后执行');
    for (const f of facts)
      this.store.db.prepare('INSERT INTO task_fact_refs VALUES(?,?,?)').run(runId, f.id, f.version);
    return facts;
  }
  assertCurrent(runId: string) {
    const execution = this.store.db
      .prepare(
        'SELECT r.requirement_version,s.version FROM worker_runs r JOIN task_specs s ON s.task_id=r.task_id WHERE r.id=?',
      )
      .get(runId) as { requirement_version: number; version: number } | undefined;
    if (execution && execution.requirement_version !== execution.version)
      throw new Error('执行要求已更新，需要最新要求的证据');
    const changed = this.store.db
      .prepare(
        "SELECT 1 FROM worker_runs r JOIN tasks t ON t.id=r.task_id JOIN work_goals g ON g.id=t.goal_id JOIN project_facts f ON f.project_id=g.project_id JOIN work_events e ON e.entity_id=f.id AND e.kind='fact' WHERE r.id=? AND e.seq>r.project_cursor LIMIT 1",
      )
      .get(runId);
    if (changed) throw new Error('项目约定已更新或新增，需要按当前版本重新验证');
    const goal = this.store.db
      .prepare(
        'SELECT g.version,r.goal_version FROM worker_runs r JOIN tasks t ON t.id=r.task_id JOIN work_goals g ON g.id=t.goal_id WHERE r.id=?',
      )
      .get(runId) as { version: number; goal_version: number } | undefined;
    if (goal && goal.version !== goal.goal_version)
      throw new Error('目标要求已更新，需要新执行的证据');
    const stale = this.store.db
      .prepare(
        'SELECT f.key,r.version,f.confirmed_version FROM task_fact_refs r JOIN project_facts f ON f.id=r.fact_id WHERE r.run_id=? AND r.version!=f.confirmed_version LIMIT 1',
      )
      .get(runId) as { key: string } | undefined;
    if (stale)
      throw new Error(`项目事实“${stale.key}”已更新，旧执行不能用于验收，请按最新约定重新检查`);
  }
}
