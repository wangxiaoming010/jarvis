import type { AgentJob, Message } from '@openbot/shared';

/** The native thread owns history. Only initial relevant context or new instructions go into a turn. */
export function buildTurnInput(job: AgentJob) {
  const execution = job.task.execution;
  const source = job.messages.find((m) => m.id === job.sourceMessageId);
  const quoted = job.messages.filter((m) => m.id !== job.sourceMessageId);
  const quote = (m: Message) => {
    const name =
      m.senderType === 'human'
        ? '用户'
        : (job.members.find((b) => b.id === m.senderId)?.name ?? '群内伙伴');
    return `${name}：\n${m.content}`;
  };
  if (job.session && job.acceptedVersion !== 0) {
    if (execution) {
      const changes = execution.changes.filter((c) => c.version > (job.acceptedVersion ?? 1));
      return changes.length
        ? changes.map((c) => c.instruction).join('\n\n')
        : '请接着当前会话中尚未完成的工作继续；不要重复已完成的操作。';
    }
    // Legacy Bot×Group threads also receive only the latest request and explicit reply context.
    const referenced = source?.replyTo
      ? quoted.filter((m) => m.id === source.replyTo && m.senderId !== job.bot.id)
      : [];
    return [...referenced.map(quote), job.task.input].join('\n\n');
  }
  const parts = [source?.content ?? job.task.input];
  if (execution && execution.goal.trim() !== job.task.input.trim())
    parts.push(`本次工作说明：\n${execution.goal}`);
  if (quoted.length)
    parts.push(`相关引用（仅供理解本次要求）：\n${quoted.map(quote).join('\n\n')}`);
  // Changes made while queued have not been delivered to this new native thread yet.
  if (execution?.changes.length)
    parts.push(`开始前补充的要求：\n${execution.changes.map((c) => c.instruction).join('\n\n')}`);
  return parts.join('\n\n');
}
