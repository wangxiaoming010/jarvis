import { randomUUID } from 'node:crypto';
import type { Message, Task, WorkGoal } from '@openbot/shared';
import type { Store } from '../store.js';
import { WorkGoals } from '../work/work-goals.js';
export type Delegation = {
  id: string;
  task_id: string | null;
  goal_id: string;
  child_goal_id: string | null;
  group_id: string;
  source_bot_id: string;
  target_bot_id: string;
  source_message_id: string;
  child_task_id: string | null;
  goal: string;
  criteria: string;
  state: string;
  result: string | null;
  expires_at: string;
};
type Notify = (
  botId: string,
  groupId: string,
  sourceId: string,
  kind: string,
  facts: object,
  taskId?: string,
  goalId?: string,
) => void;

/** Direct peer-to-peer contracts. No group-level model makes ownership decisions. */
export class BotDelegations {
  constructor(
    private store: Store,
    private notify: Notify,
    private stop: (id: string) => void,
  ) {}
  get(id: string, botId: string) {
    const d = this.store.db
      .prepare('SELECT * FROM bot_delegations WHERE id=? AND (source_bot_id=? OR target_bot_id=?)')
      .get(id, botId, botId) as Delegation | undefined;
    if (!d) throw new Error('委托不存在或不属于你');
    return d;
  }
  list(botId: string, groupId: string) {
    return this.store.db
      .prepare(
        `SELECT d.* FROM bot_delegations d WHERE (source_bot_id=? OR target_bot_id=?) AND (d.group_id=? OR EXISTS(SELECT 1 FROM work_goals g WHERE g.id IN (d.goal_id,d.child_goal_id) AND g.bot_id=? AND g.group_id=?)) ORDER BY created_at DESC LIMIT 24`,
      )
      .all(botId, botId, groupId, botId, groupId);
  }
  visible(d: Delegation, botId: string, groupId: string) {
    if (d.group_id === groupId) return true;
    return Boolean(
      this.store.db
        .prepare('SELECT 1 FROM work_goals WHERE id=? AND bot_id=? AND group_id=?')
        .get(botId === d.source_bot_id ? d.goal_id : d.child_goal_id, botId, groupId),
    );
  }
  offer(
    task: Task,
    target: string,
    title: string,
    criteria: string[],
    source: Message,
    expiresAt?: string,
  ) {
    if (['cancelled', 'completed', 'failed'].includes(task.status) || !task.goalId)
      throw new Error('只能为尚在负责的工作请求协作');
    return this.offerGoal(
      new WorkGoals(this.store).get(task.goalId),
      target,
      title,
      criteria,
      source,
      expiresAt,
      task.id,
    );
  }
  offerGoal(
    goal: WorkGoal,
    target: string,
    title: string,
    criteria: string[],
    source: Message,
    expiresAt?: string,
    taskId?: string,
  ) {
    new WorkGoals(this.store).usable(goal);
    const members = this.store.snapshot().groups.find((g) => g.id === source.groupId)?.botIds ?? [];
    if (target === goal.botId || !members.includes(target) || !members.includes(goal.botId))
      throw new Error('只能委托当前群内其他同事');
    const parents = this.store.db
      .prepare(
        'WITH RECURSIVE parents(bot,goal) AS (SELECT source_bot_id,goal_id FROM bot_delegations WHERE child_goal_id=? UNION SELECT d.source_bot_id,d.goal_id FROM bot_delegations d JOIN parents p ON d.child_goal_id=p.goal) SELECT bot FROM parents',
      )
      .all(goal.id) as { bot: string }[];
    if (parents.some((p) => p.bot === target))
      throw new Error('不能把同一条工作链重新委托给上游负责人');
    const old = this.store.db
      .prepare(
        "SELECT id FROM bot_delegations WHERE goal_id=? AND target_bot_id=? AND goal=? AND state IN ('offered','accepted','submitted')",
      )
      .get(goal.id, target, title) as { id: string } | undefined;
    if (old) return this.get(old.id, goal.botId);
    const count = this.store.db
      .prepare(
        "SELECT count(*) AS n FROM bot_delegations WHERE goal_id=? AND state IN ('offered','accepted','submitted')",
      )
      .get(goal.id) as { n: number };
    if (count.n >= 6) throw new Error('这项目标同时等待的协作已达到上限');
    const expiry = expiresAt ? Date.parse(expiresAt) : Date.now() + 86400000;
    if (!Number.isFinite(expiry) || expiry <= Date.now()) throw new Error('协作期限必须在未来');
    const id = randomUUID(),
      now = new Date().toISOString();
    this.store.db
      .prepare(
        'INSERT INTO bot_delegations(id,task_id,goal_id,group_id,source_bot_id,target_bot_id,source_message_id,goal,criteria,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        id,
        taskId ?? null,
        goal.id,
        source.groupId,
        goal.botId,
        target,
        source.id,
        title,
        JSON.stringify(criteria),
        new Date(expiry).toISOString(),
        now,
        now,
      );
    const d = this.get(id, goal.botId);
    this.notify(target, source.groupId, source.id, `delegation:offer:${id}`, d);
    return d;
  }
  respond(
    d: Delegation,
    botId: string,
    decision: 'accept' | 'reject',
    reason: string,
    create: () => Task | WorkGoal | undefined,
  ) {
    if (d.target_bot_id !== botId) throw new Error('只有接收方能接受或拒绝委托');
    if (d.state !== 'offered') throw new Error('这项委托已经处理或撤销');
    if (Date.parse(d.expires_at) <= Date.now()) throw new Error('这项委托已过期');
    let child: Task | WorkGoal | undefined;
    if (decision === 'accept') {
      child = create();
      if (!child) throw new Error('当前不能接下工作，委托仍保留为待接受');
    }
    const state = decision === 'accept' ? 'accepted' : 'rejected';
    this.store.db
      .prepare(
        'UPDATE bot_delegations SET state=?,child_task_id=?,child_goal_id=?,result=?,updated_at=? WHERE id=?',
      )
      .run(
        state,
        child && !('title' in child) ? child.id : null,
        child ? ('title' in child ? child.id : child.goalId) : null,
        reason,
        new Date().toISOString(),
        d.id,
      );
    this.notify(
      d.source_bot_id,
      d.group_id,
      d.source_message_id,
      `delegation:${state}:${d.id}`,
      { ...d, state, child_task_id: child?.id, reason },
      d.task_id ?? undefined,
      d.goal_id,
    );
    return {
      state,
      childTaskId: child && !('title' in child) ? child.id : undefined,
      childGoalId: child ? ('title' in child ? child.id : child.goalId) : undefined,
    };
  }
  submit(task: Task) {
    const d = this.store.db
      .prepare("SELECT * FROM bot_delegations WHERE child_task_id=? AND state='accepted'")
      .get(task.id) as Delegation | undefined;
    if (!d) return;
    this.store.db
      .prepare("UPDATE bot_delegations SET state='submitted',result=?,updated_at=? WHERE id=?")
      .run(task.result, new Date().toISOString(), d.id);
    this.notify(
      d.source_bot_id,
      d.group_id,
      d.source_message_id,
      `delegation:result:${d.id}:${task.execution?.version}`,
      { ...d, state: 'submitted', result: task.result },
      d.task_id ?? undefined,
      d.goal_id,
    );
  }
  outcome(task: Task, runId: string) {
    if (!['failed', 'cancelled'].includes(task.status)) return;
    const d = this.store.db
      .prepare(
        "SELECT * FROM bot_delegations WHERE (child_task_id=? OR (child_task_id IS NULL AND child_goal_id=?)) AND state='accepted'",
      )
      .get(task.id, task.goalId ?? null) as Delegation | undefined;
    if (!d) return;
    if (task.status === 'cancelled' && d.child_task_id) {
      this.cancel(task.id);
      return;
    }
    this.notify(
      d.source_bot_id,
      d.group_id,
      d.source_message_id,
      `delegation:blocked:${d.id}:${runId}`,
      { ...d, childStatus: task.status, error: task.error, result: task.result },
      d.task_id ?? undefined,
      d.goal_id,
    );
  }
  submitGoal(goal: WorkGoal) {
    const d = this.store.db
      .prepare(
        "SELECT * FROM bot_delegations WHERE child_goal_id=? AND child_task_id IS NULL AND state='accepted'",
      )
      .get(goal.id) as Delegation | undefined;
    if (!d) return;
    this.store.db
      .prepare("UPDATE bot_delegations SET state='submitted',result=?,updated_at=? WHERE id=?")
      .run(goal.result, new Date().toISOString(), d.id);
    this.notify(
      d.source_bot_id,
      d.group_id,
      d.source_message_id,
      `delegation:result:${d.id}:${goal.version}`,
      { ...d, state: 'submitted', result: goal.result },
      undefined,
      d.goal_id,
    );
  }
  review(d: Delegation, botId: string, accept: boolean, feedback: string) {
    if (d.source_bot_id !== botId || d.state !== 'submitted')
      throw new Error('只有发起方能验收已提交的协作结果');
    const goal = d.child_goal_id ? new WorkGoals(this.store).get(d.child_goal_id) : undefined;
    const child = d.child_task_id
      ? this.store.snapshot().tasks.find((t) => t.id === d.child_task_id)
      : undefined;
    if (d.child_task_id ? child?.status !== 'completed' : goal?.state !== 'completed')
      throw new Error('协作方的工作尚未验收完成');
    this.store.db
      .prepare('UPDATE bot_delegations SET state=?,updated_at=? WHERE id=?')
      .run(accept ? 'completed' : 'accepted', new Date().toISOString(), d.id);
    if (!accept && goal)
      this.store.db
        .prepare(
          "UPDATE work_goals SET state='active',version=version+?,next_action=?,next_check_at=?,generation=generation+1,unattended_checks=0 WHERE id=?",
        )
        .run(
          d.child_task_id ? 0 : 1,
          feedback,
          new Date(Date.now() + 300000).toISOString(),
          goal.id,
        );
    if (!accept)
      this.notify(
        d.target_bot_id,
        d.group_id,
        d.source_message_id,
        `delegation:rework:${d.id}:${child?.execution?.version ?? goal?.version}`,
        { ...d, feedback, state: 'accepted' },
        child?.id,
        goal?.id,
      );
    return { state: accept ? 'completed' : 'accepted' };
  }
  cancelGoal(goalId: string, state: 'cancelled' | 'expired' = 'cancelled') {
    const goal = new WorkGoals(this.store).get(goalId);
    this.store.db
      .prepare(
        "UPDATE work_goals SET state='cancelled',next_check_at=NULL,generation=generation+1 WHERE id=?",
      )
      .run(goalId);
    this.store.db.prepare('DELETE FROM goal_waits WHERE goal_id=?').run(goalId);
    const outgoing = this.store.db
      .prepare(
        "SELECT * FROM bot_delegations WHERE goal_id=? AND state IN ('offered','accepted','submitted')",
      )
      .all(goalId) as Delegation[];
    for (const d of outgoing) {
      this.store.db
        .prepare('UPDATE bot_delegations SET state=?,updated_at=? WHERE id=?')
        .run(state, new Date().toISOString(), d.id);
      if (d.child_goal_id) this.cancelGoal(d.child_goal_id, state);
    }
    for (const t of this.store.db
      .prepare(
        "SELECT id FROM tasks WHERE goal_id=? AND status IN ('queued','running','cancelling','reviewing')",
      )
      .all(goalId) as { id: string }[])
      this.stop(t.id);
    const incoming = this.store.db
      .prepare(
        "SELECT * FROM bot_delegations WHERE child_goal_id=? AND state IN ('accepted','submitted')",
      )
      .get(goalId) as Delegation | undefined;
    if (incoming) {
      this.store.db
        .prepare('UPDATE bot_delegations SET state=?,updated_at=? WHERE id=?')
        .run(state, new Date().toISOString(), incoming.id);
      this.notify(
        incoming.source_bot_id,
        incoming.group_id,
        incoming.source_message_id,
        `delegation:${state}:${incoming.id}`,
        { ...incoming, state },
        incoming.task_id ?? undefined,
        incoming.goal_id,
      );
    }
    return { ...goal, state: 'cancelled' };
  }
  cancel(taskId: string, state: 'cancelled' | 'expired' = 'cancelled') {
    // A colleague can stop its own assignment; the requester must not wait until expiry.
    const incoming = this.store.db
      .prepare(
        "SELECT * FROM bot_delegations WHERE child_task_id=? AND state IN ('accepted','submitted')",
      )
      .get(taskId) as Delegation | undefined;
    if (incoming) {
      this.store.db
        .prepare('UPDATE bot_delegations SET state=?,updated_at=? WHERE id=?')
        .run(state, new Date().toISOString(), incoming.id);
      this.notify(
        incoming.source_bot_id,
        incoming.group_id,
        incoming.source_message_id,
        `delegation:${state}:${incoming.id}`,
        { ...incoming, state },
        incoming.task_id ?? undefined,
        incoming.goal_id,
      );
    }
    const rows = this.store.db
      .prepare(
        "SELECT * FROM bot_delegations WHERE task_id=? AND state IN ('offered','accepted','submitted')",
      )
      .all(taskId) as Delegation[];
    for (const d of rows) {
      this.store.db
        .prepare('UPDATE bot_delegations SET state=?,updated_at=? WHERE id=?')
        .run(state, new Date().toISOString(), d.id);
      if (d.child_goal_id) this.cancelGoal(d.child_goal_id, state);
      else if (d.child_task_id) this.stop(d.child_task_id);
      this.notify(
        d.target_bot_id,
        d.group_id,
        d.source_message_id,
        `delegation:${state}:${d.id}`,
        { ...d, state },
        d.child_task_id ?? undefined,
      );
    }
  }
  scan(now: number) {
    const rows = this.store.db
      .prepare(
        "SELECT * FROM bot_delegations WHERE state IN ('offered','accepted','submitted') AND expires_at<=?",
      )
      .all(new Date(now).toISOString()) as Delegation[];
    for (const d of rows) {
      this.store.db
        .prepare("UPDATE bot_delegations SET state='expired',updated_at=? WHERE id=?")
        .run(new Date(now).toISOString(), d.id);
      if (d.child_goal_id) this.cancelGoal(d.child_goal_id, 'expired');
      else if (d.child_task_id) this.stop(d.child_task_id);
      this.notify(
        d.source_bot_id,
        d.group_id,
        d.source_message_id,
        `delegation:expired:${d.id}`,
        { ...d, state: 'expired' },
        d.task_id ?? undefined,
        d.goal_id,
      );
    }
  }
}
