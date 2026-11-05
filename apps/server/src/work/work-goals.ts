import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { Message, WorkGoal } from '@openbot/shared';
import type { Store } from '../store.js';
import { WorkArtifacts } from './work-artifacts.js';
import { ProjectFacts } from './project-facts.js';

import { goalSelect } from './work-records.js';
export type GoalWait = {
  kind: 'task' | 'goal' | 'delegation' | 'fact' | 'artifact' | 'human' | 'file';
  id: string;
  state: string;
  afterVersion?: number;
};
export type GoalPlan = {
  nextAction?: string;
  nextCheckAt?: string | null;
  deadline?: string | null;
  waitFor?: GoalWait[];
  needsHuman?: string | null;
};
export type GoalNotice = (goal: WorkGoal, key: string, facts: object) => void;
export type GoalEvidence = {
  criterion: string;
  source: 'artifact' | 'delegation';
  id: string;
  version: number;
};
const interval = 300000;
export class WorkGoals {
  constructor(private store: Store) {}
  get(id: string, botId?: string, groupId?: string): WorkGoal {
    const row = this.store.db.prepare(`${goalSelect} WHERE id=?`).get(id) as
      (Omit<WorkGoal, 'criteria'> & { criteria: string }) | undefined;
    if (!row || (botId && row.botId !== botId)) throw new Error('目标不存在或不属于你');
    if (groupId && row.groupId !== groupId) throw new Error('请先由用户将目标接续到当前对话');
    return { ...row, criteria: JSON.parse(row.criteria) };
  }
  list(botId: string, groupId?: string, offset = 0, query = '') {
    const rows = this.store.db
      .prepare(
        `${goalSelect} WHERE bot_id=? ${groupId ? 'AND group_id=?' : ''} AND instr(lower(title),lower(?))>0 ORDER BY CASE WHEN state IN ('active','waiting','needs_attention') THEN 0 ELSE 1 END,updated_at DESC,id LIMIT 40 OFFSET ?`,
      )
      .all(...(groupId ? [botId, groupId, query, offset] : [botId, query, offset])) as {
      id: string;
    }[];
    return rows.map((r) => this.get(r.id));
  }
  create(
    source: Message,
    botId: string,
    title: string,
    criteria: string[],
    options: {
      projectId?: string;
      legacy?: boolean;
      delivery?: 'accepted' | 'applied';
      verification?: 'reviewed' | 'content';
    } = {},
  ) {
    if (!criteria.length) throw new Error('目标必须有验收条件');
    if (
      !this.store.db
        .prepare('SELECT 1 FROM group_bots WHERE group_id=? AND bot_id=?')
        .get(source.groupId, botId)
    )
      throw new Error('负责人不在当前对话');
    if (
      options.projectId &&
      !this.store.db
        .prepare('SELECT 1 FROM project_groups WHERE project_id=? AND group_id=?')
        .get(options.projectId, source.groupId)
    )
      throw new Error('项目未授权给当前对话');
    const id = randomUUID(),
      now = new Date().toISOString();
    this.store.db
      .prepare(
        'INSERT INTO work_goals(id,bot_id,group_id,source_message_id,project_id,title,criteria,legacy,delivery,verification,next_check_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        id,
        botId,
        source.groupId,
        source.id,
        options.projectId ?? null,
        title,
        JSON.stringify([...new Set(criteria)]),
        options.legacy ? 1 : 0,
        options.delivery ?? 'accepted',
        options.verification ?? 'reviewed',
        new Date(Date.now() + interval).toISOString(),
        now,
        now,
      );
    this.store.db
      .prepare(
        'UPDATE work_goals SET project_cursor=(SELECT COALESCE(MAX(seq),0) FROM work_events) WHERE id=?',
      )
      .run(id);
    return this.get(id);
  }
  link(goal: WorkGoal, source: Message) {
    if (
      source.senderType !== 'human' ||
      !this.store.db
        .prepare('SELECT 1 FROM group_bots WHERE group_id=? AND bot_id=?')
        .get(source.groupId, goal.botId)
    )
      throw new Error('接续目标需要所有者在当前对话提出要求');
    // Moving communication never silently shares project records with another conversation.
    if (
      goal.projectId &&
      !this.store.db
        .prepare('SELECT 1 FROM project_groups WHERE project_id=? AND group_id=?')
        .get(goal.projectId, source.groupId)
    )
      throw new Error('请先由所有者明确关联项目到当前对话，再接续其目标');
    this.store.db
      .prepare('UPDATE work_goals SET group_id=?,source_message_id=?,updated_at=? WHERE id=?')
      .run(source.groupId, source.id, new Date().toISOString(), goal.id);
    this.store.db
      .prepare(
        "UPDATE dialogue_inbox SET group_id=?,payload=json_set(payload,'$.sourceMessageId',?) WHERE goal_id=? AND status IN ('queued','failed')",
      )
      .run(source.groupId, source.id, goal.id);
  }
  usable(goal: WorkGoal, human = false) {
    if (['cancelled', 'completed'].includes(goal.state))
      throw new Error('目标已结束，请由用户明确重新开启');
    if (goal.ownerWait && !human) throw new Error('目标正在等待所有者决定，不能自动重新安排执行');
  }
  plan(goal: WorkGoal, plan: GoalPlan, human = false) {
    this.usable(goal, human || Boolean(plan.needsHuman));
    const now = Date.now();
    if (plan.nextCheckAt && Date.parse(plan.nextCheckAt) <= now)
      throw new Error('检查时间必须在未来');
    const waits = plan.waitFor;
    if (waits) for (const w of waits) this.checkWait(goal, w);
    this.store.db.transaction(() => {
      if (waits) {
        this.store.db.prepare('DELETE FROM goal_waits WHERE goal_id=?').run(goal.id);
        const cursor = (
          this.store.db.prepare('SELECT COALESCE(MAX(seq),0) AS n FROM work_events').get() as {
            n: number;
          }
        ).n;
        for (const w of waits)
          this.store.db
            .prepare('INSERT INTO goal_waits VALUES(?,?,?,?,?,?)')
            .run(goal.id, w.kind, w.id, w.state, w.afterVersion ?? -1, cursor);
      }
      const check = plan.nextCheckAt === undefined ? goal.nextCheckAt : plan.nextCheckAt;
      // A text action alone does not make progress: always retain a bounded reconciliation timer.
      this.store.db
        .prepare(
          'UPDATE work_goals SET next_action=?,next_check_at=?,deadline=?,state=?,attention_reason=?,generation=generation+1,unattended_checks=?,updated_at=? WHERE id=?',
        )
        .run(
          plan.nextAction ?? goal.nextAction,
          plan.needsHuman ? null : (check ?? new Date(now + interval).toISOString()),
          plan.deadline === undefined ? goal.deadline : plan.deadline,
          plan.needsHuman ? 'needs_attention' : waits?.length ? 'waiting' : 'active',
          plan.needsHuman ?? null,
          human || waits?.length || plan.needsHuman ? 0 : goal.unattendedChecks,
          new Date(now).toISOString(),
          goal.id,
        );
      this.store.db
        .prepare(
          'UPDATE work_goals SET project_cursor=(SELECT COALESCE(MAX(seq),0) FROM work_events) WHERE id=?',
        )
        .run(goal.id);
      this.store.db
        .prepare('UPDATE work_goals SET owner_wait=? WHERE id=?')
        .run(plan.needsHuman ? 1 : 0, goal.id);
    })();
  }
  private checkWait(goal: WorkGoal, w: GoalWait) {
    const states: Record<GoalWait['kind'], string[]> = {
      task: ['queued', 'running', 'cancelling', 'reviewing', 'completed', 'failed', 'cancelled'],
      goal: ['active', 'waiting', 'needs_attention', 'completed', 'cancelled'],
      delegation: [
        'offered',
        'accepted',
        'rejected',
        'submitted',
        'completed',
        'cancelled',
        'expired',
      ],
      fact: ['confirmed'],
      artifact: ['produced', 'verified', 'accepted', 'applied'],
      human: ['received'],
      file: ['exists', 'missing'],
    };
    if (!states[w.kind].includes(w.state)) throw new Error('等待的事件状态无效');
    let allowed = false;
    if (w.kind === 'file') allowed = isAbsolute(w.id);
    if (w.kind === 'human') allowed = w.id === goal.groupId && w.state === 'received';
    if (w.kind === 'task')
      allowed = Boolean(
        this.store.db.prepare('SELECT 1 FROM tasks WHERE id=? AND goal_id=?').get(w.id, goal.id),
      );
    if (w.kind === 'goal')
      allowed =
        w.id !== goal.id &&
        Boolean(
          this.store.db
            .prepare('SELECT 1 FROM work_goals WHERE id=? AND bot_id=? AND group_id=?')
            .get(w.id, goal.botId, goal.groupId),
        );
    if (w.kind === 'delegation')
      allowed = Boolean(
        this.store.db
          .prepare('SELECT 1 FROM bot_delegations WHERE id=? AND goal_id=?')
          .get(w.id, goal.id),
      );
    if (w.kind === 'fact')
      allowed = Boolean(
        this.store.db
          .prepare('SELECT 1 FROM project_facts WHERE id=? AND project_id=?')
          .get(w.id, goal.projectId),
      );
    if (w.kind === 'artifact')
      allowed = Boolean(
        this.store.db
          .prepare('SELECT 1 FROM work_artifacts WHERE id=? AND goal_id=?')
          .get(w.id, goal.id),
      );
    if (!allowed) throw new Error('等待条件不在目标的授权范围内');
  }
  reconcile(goalId: string) {
    const goal = this.get(goalId);
    if (['completed', 'cancelled', 'needs_attention'].includes(goal.state)) return;
    this.store.db
      .prepare('UPDATE work_goals SET next_check_at=COALESCE(next_check_at,?) WHERE id=?')
      .run(new Date(Date.now() + interval).toISOString(), goal.id);
  }
  revise(goal: WorkGoal, expectedVersion: number, criteria: string[], source: Message) {
    this.usable(goal, source.senderType === 'human');
    if (source.senderType !== 'human' || expectedVersion !== goal.version || !criteria.length)
      throw new Error('目标变更需要所有者的新要求和当前版本');
    this.store.db
      .prepare(
        "UPDATE work_goals SET criteria=?,version=version+1,generation=generation+1,state='active',owner_wait=0,attention_reason=NULL,next_check_at=?,unattended_checks=0,updated_at=? WHERE id=?",
      )
      .run(
        JSON.stringify(criteria),
        new Date(Date.now() + interval).toISOString(),
        new Date().toISOString(),
        goal.id,
      );
    return this.get(goal.id);
  }
  reopen(goal: WorkGoal, expectedVersion: number, instruction: string, source: Message) {
    if (
      source.senderType !== 'human' ||
      !['completed', 'cancelled'].includes(goal.state) ||
      goal.version !== expectedVersion
    )
      throw new Error('重新接下目标需要所有者的新要求和已结束目标的当前版本');
    this.store.db
      .prepare(
        "UPDATE work_goals SET version=version+1,state='active',owner_wait=0,source_message_id=?,next_action=?,next_check_at=?,result=NULL,attention_reason=NULL,unattended_checks=0,generation=generation+1,updated_at=? WHERE id=?",
      )
      .run(
        source.id,
        instruction,
        new Date(Date.now() + interval).toISOString(),
        new Date().toISOString(),
        goal.id,
      );
    return this.get(goal.id);
  }
  complete(goal: WorkGoal, expectedVersion: number, evidence: GoalEvidence[]) {
    this.usable(goal);
    if (goal.version !== expectedVersion) throw new Error('目标要求版本已变化');
    if (
      this.store.db
        .prepare(
          "SELECT 1 FROM tasks WHERE goal_id=? AND (status IN ('queued','running','cancelling','reviewing') OR (SELECT status FROM worker_runs WHERE task_id=tasks.id ORDER BY started_at DESC,rowid DESC LIMIT 1)='unknown') UNION ALL SELECT 1 FROM bot_delegations WHERE goal_id=? AND state IN ('offered','accepted','submitted') LIMIT 1",
        )
        .get(goal.id, goal.id)
    )
      throw new Error('目标仍有尚未结束或未验收的执行与委托');
    this.validateEvidence(goal, evidence, new Set([goal.id]));
    this.store.db.transaction(() => {
      for (const e of evidence)
        this.store.db
          .prepare('INSERT OR REPLACE INTO goal_acceptance VALUES(?,?,?,?,?,?,?)')
          .run(
            goal.id,
            goal.version,
            e.criterion,
            e.source,
            e.id,
            e.version,
            new Date().toISOString(),
          );
      this.store.db
        .prepare(
          "UPDATE work_goals SET state='completed',result=?,next_check_at=NULL,next_action='',attention_reason=NULL,generation=generation+1,updated_at=? WHERE id=?",
        )
        .run(JSON.stringify(evidence), new Date().toISOString(), goal.id);
      this.store.db.prepare('DELETE FROM goal_waits WHERE goal_id=?').run(goal.id);
    })();
    return this.get(goal.id);
  }
  private validateEvidence(
    goal: WorkGoal,
    evidence: GoalEvidence[],
    visited: Set<string>,
    inheritedReview = false,
  ) {
    const reviewed = inheritedReview || goal.verification === 'reviewed';
    for (const criterion of goal.criteria)
      if (!evidence.some((e) => e.criterion === criterion))
        throw new Error(`目标证据缺失：${criterion}`);
    const artifacts = new WorkArtifacts(this.store);
    for (const e of evidence) {
      if (!goal.criteria.includes(e.criterion)) throw new Error('证据不属于当前目标要求');
      if (e.source === 'artifact') {
        const a = artifacts.get(e.id);
        const delegated = this.store.db
          .prepare(
            "SELECT 1 FROM bot_delegations WHERE goal_id=? AND child_goal_id=? AND state='completed'",
          )
          .get(goal.id, a.goalId);
        if (
          (a.goalId !== goal.id && !delegated) ||
          a.version !== e.version ||
          !(goal.delivery === 'applied'
            ? a.state === 'applied'
            : ['accepted', 'applied'].includes(a.state))
        )
          throw new Error('交付版本尚未被接受或未满足目标的应用要求');
        artifacts.assertUnchanged(a);
        if (reviewed) {
          const checks = this.store.db
            .prepare(
              "SELECT method,verifier_run_id FROM artifact_checks WHERE artifact_id=? AND version=? AND method IN ('independent_run','human')",
            )
            .all(a.id, a.version) as { method: string; verifier_run_id: string | null }[];
          if (!checks.some((c) => c.method === 'human')) {
            const independent = checks.find(
              (c) => c.method === 'independent_run' && c.verifier_run_id,
            );
            if (!independent)
              throw new Error('此目标需要独立执行或人工复核，内容语法检查不能替代交付验证');
            new ProjectFacts(this.store).assertCurrent(independent.verifier_run_id!);
          }
        }
      } else {
        const d = this.store.db
          .prepare(
            "SELECT g.version,g.delivery FROM bot_delegations d JOIN work_goals g ON g.id=d.child_goal_id WHERE d.id=? AND d.goal_id=? AND d.state='completed' AND g.state='completed'",
          )
          .get(e.id, goal.id) as { version: number; delivery: string } | undefined;
        if (
          !d ||
          d.version !== e.version ||
          (goal.delivery === 'applied' && d.delivery !== 'applied')
        )
          throw new Error('委托没有当前版本的完整交付验收');
        const child = this.store.db
          .prepare('SELECT child_goal_id FROM bot_delegations WHERE id=?')
          .get(e.id) as { child_goal_id: string };
        const accepted = this.get(child.child_goal_id);
        if (accepted.legacy || visited.has(accepted.id))
          throw new Error('委托必须有正式的目标交付验收，不能循环引用');
        const rows = this.store.db
          .prepare(
            'SELECT criterion,source,entity_id AS id,version FROM goal_acceptance WHERE goal_id=? AND goal_version=?',
          )
          .all(accepted.id, accepted.version) as GoalEvidence[];
        this.validateEvidence(accepted, rows, new Set([...visited, accepted.id]), reviewed);
      }
    }
  }
  attention(goalId: string, reason: string, ownerWait = true) {
    this.store.db
      .prepare(
        "UPDATE work_goals SET state=?,attention_reason=?,owner_wait=?,next_check_at=?,generation=generation+1,updated_at=? WHERE id=? AND state NOT IN ('completed','cancelled')",
      )
      .run(
        ownerWait ? 'needs_attention' : 'active',
        reason,
        ownerWait ? 1 : 0,
        ownerWait ? null : new Date(Date.now() + interval).toISOString(),
        new Date().toISOString(),
        goalId,
      );
  }
  scan(now: number, notify: GoalNotice) {
    const goals = this.store.db
      .prepare("SELECT id FROM work_goals WHERE legacy=0 AND state IN ('active','waiting')")
      .all() as { id: string }[];
    for (const { id } of goals) {
      const g = this.get(id);
      if (
        !this.store.db
          .prepare('SELECT 1 FROM group_bots WHERE group_id=? AND bot_id=?')
          .get(g.groupId, g.botId)
      ) {
        this.attention(id, '负责人已离开目标的沟通对话，需要所有者重新接续');
        continue;
      }
      const changed = this.store.db
        .prepare(
          "SELECT e.seq,f.key,f.id,e.version FROM work_events e JOIN project_facts f ON f.id=e.entity_id JOIN work_goals g ON g.project_id=f.project_id WHERE g.id=? AND e.kind='fact' AND e.seq>g.project_cursor ORDER BY e.seq DESC LIMIT 1",
        )
        .get(id) as { seq: number; key: string; id: string; version: number } | undefined;
      if (changed) {
        this.store.db
          .prepare('UPDATE work_goals SET project_cursor=? WHERE id=?')
          .run(changed.seq, id);
        this.attention(id, `项目约定“${changed.key}”已更新，需要按新版本调整工作`, false);
        notify(this.get(id), `fact:${changed.id}:${changed.version}`, {
          reason: 'project_changed',
          factId: changed.id,
          version: changed.version,
        });
        continue;
      }
      const waits = this.store.db.prepare('SELECT * FROM goal_waits WHERE goal_id=?').all(id) as {
        kind: GoalWait['kind'];
        entity_id: string;
        desired_state: string;
        after_version: number;
        after_event: number;
      }[];
      const match = waits
        .map((w) => {
          const event = this.store.db
            .prepare(
              'SELECT * FROM work_events WHERE kind=? AND entity_id=? AND state=? AND version>? AND seq>? ORDER BY seq LIMIT 1',
            )
            .get(w.kind, w.entity_id, w.desired_state, w.after_version, w.after_event) as
            { seq: number } | undefined;
          if (event || w.kind === 'human') return event;
          const current =
            w.kind === 'file'
              ? { state: existsSync(w.entity_id) ? 'exists' : 'missing', version: 0 }
              : w.kind === 'task'
                ? this.store.db
                    .prepare('SELECT status AS state,0 AS version FROM tasks WHERE id=?')
                    .get(w.entity_id)
                : w.kind === 'goal'
                  ? this.store.db
                      .prepare('SELECT state,version FROM work_goals WHERE id=?')
                      .get(w.entity_id)
                  : w.kind === 'delegation'
                    ? this.store.db
                        .prepare('SELECT state,0 AS version FROM bot_delegations WHERE id=?')
                        .get(w.entity_id)
                    : w.kind === 'artifact'
                      ? this.store.db
                          .prepare('SELECT state,version FROM work_artifacts WHERE id=?')
                          .get(w.entity_id)
                      : this.store.db
                          .prepare(
                            "SELECT 'confirmed' AS state,confirmed_version AS version FROM project_facts WHERE id=? AND confirmed_version>0",
                          )
                          .get(w.entity_id);
          const row = current as { state: string; version: number } | undefined;
          return row?.state === w.desired_state && row.version > w.after_version
            ? {
                seq: 0,
                kind: w.kind,
                entity_id: w.entity_id,
                state: row.state,
                version: row.version,
              }
            : undefined;
        })
        .find(Boolean);
      if (match) {
        this.store.db.transaction(() => {
          this.store.db.prepare('DELETE FROM goal_waits WHERE goal_id=?').run(id);
          this.store.db
            .prepare(
              "UPDATE work_goals SET state='active',next_check_at=?,unattended_checks=0 WHERE id=?",
            )
            .run(new Date(now + interval).toISOString(), id);
          notify(this.get(id), `condition:${g.generation}:${match.seq}`, {
            reason: 'condition',
            event: match,
          });
        })();
      }
      const deadline = g.deadline && Date.parse(g.deadline) <= now;
      const due = g.nextCheckAt && Date.parse(g.nextCheckAt) <= now;
      if (!deadline && !due) continue;
      // Ongoing work has its own heartbeats and completion events; do not poll it with the model.
      const busy = this.store.db
        .prepare(
          "SELECT 1 FROM tasks WHERE goal_id=? AND status IN ('queued','running','cancelling','reviewing') UNION ALL SELECT 1 FROM bot_delegations WHERE goal_id=? AND state IN ('offered','accepted','submitted') LIMIT 1",
        )
        .get(id, id);
      if (busy && !deadline) {
        this.store.db
          .prepare('UPDATE work_goals SET next_check_at=? WHERE id=?')
          .run(new Date(now + interval).toISOString(), id);
        continue;
      }
      if (match && !deadline) continue;
      const n = g.unattendedChecks + 1;
      this.store.db.transaction(() => {
        if (deadline || n >= 3)
          this.attention(
            id,
            deadline
              ? '目标已到截止时间，请确认交付情况或调整安排。'
              : '目标尚未安排后续行动，请确认下一步。',
          );
        else
          this.store.db
            .prepare('UPDATE work_goals SET unattended_checks=?,next_check_at=? WHERE id=?')
            .run(n, new Date(now + interval).toISOString(), id);
        notify(this.get(id), `check:${g.generation}:${n}:${deadline ? 'deadline' : 'due'}`, {
          reason: deadline ? 'deadline' : n >= 3 ? 'needs_attention' : 'check',
          nextAction: g.nextAction,
        });
      })();
    }
  }
}
