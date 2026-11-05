import type { Task } from './index.js';

/** Internal references are useful for coordination, not for the group conversation. */
export function conversationalText(content: string, tasks: Task[]) {
  let text = content;
  for (const task of tasks) {
    const ids = [task.id, task.id.slice(0, 8)];
    for (const id of ids) {
      const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      text = text.replace(new RegExp(`任务(?:编号)?[\\s:：#]*${escaped}`, 'g'), '这件事');
      text = text.replaceAll(id, '这件事');
    }
    for (const id of [task.execution?.contextMessageId, task.correlationId])
      if (id) text = text.replaceAll(id, '');
  }
  return text.trim();
}

export function workActivity(activity: string | null | undefined) {
  if (!activity) return '';
  if (/等待所有者批准|等待.*审批/.test(activity)) return '等待你授权操作。';
  if (/连接(?:已)?中断|结果未知/.test(activity))
    return '连接已中断，执行结果尚未确认，未自动重试。';
  if (/续接|新要求/.test(activity)) return '正在按新要求继续执行。';
  if (/当前任务要求/.test(activity)) return '正在执行任务。';
  if (/启动本地执行会话/.test(activity)) return '正在准备执行。';
  if (/命令已结束/.test(activity)) {
    const exitCode = activity.match(/退出码\s*(-?\d+)/)?.[1];
    return exitCode && Number(exitCode) !== 0 ? '命令执行失败。' : '命令执行结束。';
  }
  if (/运行本地命令/.test(activity)) return '正在运行命令。';
  if (/文件变更|文件操作/.test(activity)) return '正在处理文件。';
  if (/执行者正在处理任务/.test(activity)) return '正在执行任务。';
  if (/执行已完成/.test(activity)) return '执行已结束。';
  if (/执行已停止/.test(activity)) return '执行已停止。';
  if (/执行失败/.test(activity)) return '执行失败，尚未完成。';
  return activity;
}

export function workProgress(task: Task) {
  const e = task.execution;
  let text: string;
  if (e?.pendingChange?.status === 'interrupted') text = '变更处理已中断，尚未按新要求继续。';
  else if (e?.pendingChange) text = '正在停止当前执行，之后按新要求继续。';
  else if (task.status === 'queued') text = '任务正在等待执行。';
  else if (task.status === 'cancelling') text = '正在停止执行。';
  else if (task.status === 'cancelled') text = '执行已停止。';
  else if (task.status === 'reviewing') text = '执行结果已返回，等待验收。';
  else if (task.status === 'failed')
    text = `执行失败，尚未完成。${task.error ? `\n${task.error}` : ''}`;
  else if (task.status === 'completed') text = task.result?.trim() ? task.result : '已完成。';
  else {
    const report = e?.report?.trim();
    const activity = workActivity(e?.activity);
    text =
      [report, activity && !report?.includes(activity) ? activity : '']
        .filter(Boolean)
        .join('\n') || '正在执行，暂无新进展。';
  }
  return conversationalText(text, [task]);
}
