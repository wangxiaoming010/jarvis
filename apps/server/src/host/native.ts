import { createHash, randomUUID } from 'node:crypto';
import type { Message, NativeReply, NativeRequestSpec, Task } from '@openbot/shared';
import { nativeReplySchema, nativeRequestSchema } from '@openbot/shared/schemas';
import type { Store } from '../store.js';
const fail = (message: string) => Object.assign(new Error(message), { statusCode: 409 });
type Row = {
  id: string;
  task_id: string;
  lease_id: string;
  request_id: string;
  spec: string;
  status: string;
  response_hash: string | null;
};

/** Only authenticated bridge events can create these host-owned interaction cards. */
export class NativeRequests {
  constructor(
    private store: Store,
    private changed: () => void,
    private send: (
      taskId: string,
      leaseId: string,
      requestId: string,
      response: NativeReply,
    ) => void,
  ) {}
  publish(task: Task, leaseId: string, requestId: string, raw: NativeRequestSpec) {
    const spec = nativeRequestSchema.parse(raw);
    const previous = this.store.db
      .prepare(
        'SELECT id,spec FROM native_requests WHERE task_id=? AND lease_id=? AND request_id=?',
      )
      .get(task.id, leaseId, requestId) as { id: string; spec: string } | undefined;
    if (previous) {
      if (previous.spec !== JSON.stringify(spec)) throw fail('原生请求内容发生变化');
      return previous.id;
    }
    const id = randomUUID(),
      now = new Date().toISOString();
    const source = this.store.db
      .prepare('SELECT source_message_id FROM task_runtime WHERE task_id=?')
      .get(task.id) as { source_message_id: string };
    const message: Message = {
      id: randomUUID(),
      groupId: task.groupId,
      senderId: task.botId,
      senderType: 'bot',
      content: spec.title,
      mentions: [],
      replyTo: source.source_message_id,
      timestamp: now,
      messageType: 'text',
      correlationId: task.correlationId,
    };
    this.store.db.transaction(() => {
      this.store.insertMessage(message);
      this.store.db
        .prepare(
          'INSERT INTO native_requests(id,message_id,task_id,lease_id,request_id,spec,created_at) VALUES(?,?,?,?,?,?,?)',
        )
        .run(id, message.id, task.id, leaseId, requestId, JSON.stringify(spec), now);
      this.store.db
        .prepare('UPDATE task_specs SET activity=?,updated_at=? WHERE task_id=?')
        .run(spec.kind === 'question' ? '等待你的回答' : '等待你确认权限', now, task.id);
    })();
    this.changed();
    return id;
  }
  resolved(taskId: string, leaseId: string, requestId: string, rejected = false) {
    this.store.db
      .prepare(
        "UPDATE native_requests SET status='cancelled' WHERE task_id=? AND lease_id=? AND request_id=? AND (status='pending' OR ?=1)",
      )
      .run(taskId, leaseId, requestId, rejected ? 1 : 0);
    this.changed();
  }
  reply(id: string, raw: NativeReply) {
    const response = nativeReplySchema.parse(raw);
    const canonical = {
      decision: response.decision,
      scope: response.scope ?? 'once',
      answers: Object.fromEntries(
        Object.entries(response.answers ?? {}).sort(([a], [b]) => a.localeCompare(b)),
      ),
    };
    const hash = createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
    const row = this.store.db.prepare('SELECT * FROM native_requests WHERE id=?').get(id) as
      Row | undefined;
    if (!row) throw fail('这条请求不存在');
    if (row.status === 'answered' && row.response_hash === hash) return { ok: true };
    if (row.status !== 'pending') throw fail('这条请求已经处理或失效');
    const spec = JSON.parse(row.spec) as NativeRequestSpec;
    if (response.scope === 'session' && (!spec.allowSession || spec.kind === 'question'))
      throw fail('这条请求只能确认本次操作');
    if (spec.kind === 'question' && response.decision === 'accept') {
      const questions = spec.questions!,
        answers = response.answers ?? {};
      if (Object.keys(answers).some((id) => !questions.some((q) => q.id === id)))
        throw fail('回答不属于这条问题');
      for (const q of questions) {
        const answer = answers[q.id];
        if (
          !answer?.length ||
          (!q.multiSelect && answer.length !== 1) ||
          new Set(answer).size !== answer.length
        )
          throw fail('请完整回答问题');
        if (
          q.options?.length &&
          !q.allowOther &&
          answer.some((value) => !q.options!.some((o) => o.label === value))
        )
          throw fail('请选择问题中提供的选项');
      }
    } else if (response.answers && Object.keys(response.answers).length)
      throw fail('这条请求不接受附加回答');
    const snapshot = this.store.snapshot(),
      task = snapshot.tasks.find((t) => t.id === row.task_id);
    const meta = this.store.db
      .prepare('SELECT lease_id FROM task_runtime WHERE task_id=?')
      .get(row.task_id) as { lease_id: string } | undefined;
    if (
      task?.status !== 'running' ||
      meta?.lease_id !== row.lease_id ||
      !snapshot.groups.find((g) => g.id === task.groupId)?.botIds.includes(task.botId)
    )
      throw fail('原来的执行已停止或发生变化');
    const stored = structuredClone(response);
    for (const q of spec.questions ?? [])
      if (q.isSecret && stored.answers?.[q.id]) stored.answers[q.id] = ['••••••'];
    this.store.db.transaction(() => {
      this.store.db
        .prepare(
          "UPDATE native_requests SET status='answered',response=?,response_hash=? WHERE id=? AND status='pending'",
        )
        .run(JSON.stringify(stored), hash, id);
      this.send(row.task_id, row.lease_id, row.request_id, response);
      this.store.db
        .prepare('UPDATE task_specs SET activity=?,updated_at=? WHERE task_id=?')
        .run('已提交你的回应，等待执行者继续', new Date().toISOString(), row.task_id);
    })();
    this.changed();
    return { ok: true };
  }
}
