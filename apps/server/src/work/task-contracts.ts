import type { Message, Task } from '@openbot/shared';
import type { Store } from '../store.js';

export type WorkPlan = {
  criteria?: string[];
  nextAction?: string;
  waitCondition?: string | null;
  nextWakeAt?: string | null;
  deadline?: string | null;
  maxRuns?: number;
};
export type AcceptanceEvidence = {
  criterion: string;
  source: 'result' | 'report' | 'delegation';
  quote: string;
  reportId?: string;
  delegationId?: string;
};

/** Persistent commitments and evidence; time passing never executes external effects. */
export class TaskContracts {
  constructor(private store: Store) {}
  plan(task: Task, plan: WorkPlan, human: boolean) {
    if (plan.maxRuns !== undefined && !human) throw new Error('只有用户的新要求可以增加执行预算');
    if (['cancelled', 'cancelling'].includes(task.status))
      throw new Error('已停止的工作不能重新安排唤醒');
    if (plan.criteria && !plan.criteria.length) throw new Error('验收条件不能为空');
    const old = this.store.db
      .prepare('SELECT * FROM task_contracts WHERE task_id=?')
      .get(task.id) as {
      criteria: string;
      next_action: string;
      wait_condition: string | null;
      next_wake_at: string | null;
      deadline: string | null;
      max_runs: number;
      state: string;
    };
    if (!old) throw new Error('任务契约不存在');
    if (old.state === 'cancelled') throw new Error('已停止的工作不能重新安排唤醒');
    const wake =
      plan.nextWakeAt === undefined
        ? old.next_wake_at
        : plan.nextWakeAt
          ? new Date(plan.nextWakeAt).toISOString()
          : null;
    if (plan.nextWakeAt && (!Number.isFinite(Date.parse(wake!)) || Date.parse(wake!) <= Date.now()))
      throw new Error('下次检查时间必须在未来');
    if (plan.deadline && !Number.isFinite(Date.parse(plan.deadline)))
      throw new Error('截止时间无效');
    const criteria = plan.criteria ?? (JSON.parse(old.criteria) as string[]);
    if (plan.criteria && task.status === 'completed')
      throw new Error('先续接任务，再修改已验收的契约');
    const waitCondition =
      plan.waitCondition === undefined ? old.wait_condition : plan.waitCondition;
    this.store.db
      .prepare(
        'UPDATE task_contracts SET criteria=?,next_action=?,wait_condition=?,next_wake_at=?,deadline=?,max_runs=?,state=?,generation=generation+1,updated_at=? WHERE task_id=?',
      )
      .run(
        JSON.stringify([...new Set(criteria)]),
        plan.nextAction ?? old.next_action,
        waitCondition,
        wake,
        plan.deadline === undefined
          ? old.deadline
          : plan.deadline
            ? new Date(plan.deadline).toISOString()
            : null,
        plan.maxRuns ?? old.max_runs,
        task.status === 'completed' ? 'completed' : wake || waitCondition ? 'waiting' : 'active',
        new Date().toISOString(),
        task.id,
      );
  }
  link(task: Task, source: Message) {
    const group = this.store
      .snapshot()
      .groups.find((g) => g.id === source.groupId && g.botIds.includes(task.botId));
    if (source.senderType !== 'human' || !group)
      throw new Error('跨对话接续需要当前所有者在目标对话中提出要求');
    this.store.db
      .prepare(
        'INSERT INTO task_conversations(task_id,group_id,source_message_id,linked_at) VALUES(?,?,?,?) ON CONFLICT(task_id,group_id) DO UPDATE SET source_message_id=excluded.source_message_id,linked_at=excluded.linked_at',
      )
      .run(task.id, source.groupId, source.id, new Date().toISOString());
    this.store.db
      .prepare(
        'INSERT INTO task_routes VALUES(?,?,?) ON CONFLICT(task_id) DO UPDATE SET group_id=excluded.group_id,source_message_id=excluded.source_message_id',
      )
      .run(task.id, source.groupId, source.id);
    this.store.db
      .prepare('UPDATE task_runtime SET source_message_id=? WHERE task_id=?')
      .run(source.id, task.id);
    this.store.db
      .prepare('UPDATE work_goals SET group_id=?,source_message_id=? WHERE id=? AND legacy=1')
      .run(source.groupId, source.id, task.goalId ?? null);
    // Pending outcomes follow the explicitly selected conversation, never broadcast to every link.
    this.store.db
      .prepare(
        "UPDATE dialogue_inbox SET group_id=?,payload=json_set(payload,'$.sourceMessageId',?) WHERE task_id=? AND status IN ('queued','failed')",
      )
      .run(source.groupId, source.id, task.id);
  }
  canRun(taskId: string, allowStopped = false) {
    const row = this.store.db
      .prepare(
        'SELECT c.max_runs,c.state,(SELECT count(*) FROM worker_runs WHERE task_id=c.task_id) AS runs FROM task_contracts c WHERE task_id=?',
      )
      .get(taskId) as { max_runs: number; state: string; runs: number } | undefined;
    return !row || ((allowStopped || row.state !== 'cancelled') && row.runs < row.max_runs);
  }
  accept(
    task: Task,
    run: { id: string; requirement_version: number; result: string | null },
    evidence: AcceptanceEvidence[],
  ) {
    const row = this.store.db
      .prepare('SELECT criteria FROM task_contracts WHERE task_id=?')
      .get(task.id) as { criteria: string };
    const criteria = JSON.parse(row.criteria) as string[];
    if (run.requirement_version !== task.execution?.version)
      throw new Error('执行证据对应的要求已过期，需要重新检查最新要求');
    for (const criterion of criteria) {
      const proof = evidence.find((e) => e.criterion === criterion);
      if (!proof) throw new Error(`验收证据缺失：${criterion}`);
    }
    for (const proof of evidence) {
      if (!criteria.includes(proof.criterion)) throw new Error('证据必须对应当前契约中的验收项');
      const report =
        proof.source === 'report'
          ? (this.store.db
              .prepare('SELECT summary FROM worker_reports WHERE id=? AND task_id=? AND lease_id=?')
              .get(proof.reportId, task.id, run.id) as { summary: string } | undefined)
          : undefined;
      const delegation =
        proof.source === 'delegation'
          ? (this.store.db
              .prepare(
                "SELECT d.result FROM bot_delegations d JOIN tasks t ON t.id=d.child_task_id WHERE d.id=? AND d.task_id=? AND d.state='completed' AND t.status='completed'",
              )
              .get(proof.delegationId, task.id) as { result: string } | undefined)
          : undefined;
      const actual =
        proof.source === 'result'
          ? run.result
          : proof.source === 'delegation'
            ? delegation?.result
            : report?.summary;
      if (!actual?.includes(proof.quote.trim()) || !proof.quote.trim())
        throw new Error('证据引用不在本次真实执行结果中');
      this.store.db
        .prepare('INSERT OR REPLACE INTO task_acceptance VALUES(?,?,?,?,?,?,?)')
        .run(
          task.id,
          run.id,
          run.requirement_version,
          proof.criterion,
          proof.quote,
          proof.source === 'result'
            ? `run:${run.id}`
            : proof.source === 'delegation'
              ? `delegation:${proof.delegationId}`
              : `report:${proof.reportId}`,
          new Date().toISOString(),
        );
    }
    this.store.db
      .prepare(
        "UPDATE task_contracts SET state='completed',next_wake_at=NULL,wait_condition=NULL,generation=generation+1,updated_at=? WHERE task_id=?",
      )
      .run(new Date().toISOString(), task.id);
  }
  wake(now: number, notify: (task: Task, kind: string, facts: object) => void) {
    const rows = this.store.db
      .prepare(
        "SELECT c.task_id,c.generation,c.next_action,c.wait_condition,c.next_wake_at,c.deadline,s.version FROM task_contracts c JOIN task_specs s ON s.task_id=c.task_id WHERE c.state IN ('active','waiting') AND (c.next_wake_at<=? OR c.deadline<=?)",
      )
      .all(new Date(now).toISOString(), new Date(now).toISOString()) as {
      task_id: string;
      generation: number;
      next_action: string;
      wait_condition: string | null;
      next_wake_at: string | null;
      deadline: string | null;
      version: number;
    }[];
    for (const row of rows) {
      const task = this.store.snapshot().tasks.find((t) => t.id === row.task_id);
      if (!task || ['completed', 'cancelled'].includes(task.status)) continue;
      const due = [
        { reason: 'scheduled_check', at: row.next_wake_at },
        { reason: 'deadline', at: row.deadline },
      ].filter((event) => event.at && Date.parse(event.at) <= now);
      for (const event of due)
        this.store.db.transaction(() => {
          const marker = `goal:${row.generation}:${event.reason}:${event.at}`;
          if (
            this.store.db
              .prepare('SELECT id FROM dialogue_inbox WHERE task_id=? AND kind=?')
              .get(task.id, marker)
          )
            return;
          notify(task, marker, {
            ...row,
            reason: event.reason,
            automaticExecution: false,
          });
          if (event.reason === 'scheduled_check')
            this.store.db
              .prepare(
                'UPDATE task_contracts SET next_wake_at=NULL WHERE task_id=? AND generation=?',
              )
              .run(task.id, row.generation);
        })();
    }
  }
}
