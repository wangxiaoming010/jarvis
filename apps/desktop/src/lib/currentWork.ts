import type { Group, Snapshot, Task, WorkGoal } from '@openbot/shared';

export const isCurrentTask = (task: Task) =>
  ['queued', 'running', 'cancelling', 'reviewing'].includes(task.status);

export interface CurrentWork {
  id: string;
  goal?: WorkGoal;
  tasks: Task[];
}

// A goal and its executions are one work item. Scope private chats to the Bot,
// while group chats remain scoped to that conversation's communication route.
export function currentWork(data: Snapshot, group: Group): CurrentWork[] {
  const inScope = (item: { groupId: string; botId: string }) =>
    group.directBotId ? item.botId === group.directBotId : item.groupId === group.id;
  const tasks = data.tasks.filter(inScope);
  const goals = (data.goals ?? []).filter((goal) => !goal.legacy && inScope(goal));
  const items: CurrentWork[] = goals.flatMap((goal) => {
    const executions = tasks.filter((task) => task.goalId === goal.id);
    return !['completed', 'cancelled'].includes(goal.state) || executions.some(isCurrentTask)
      ? [{ id: goal.id, goal, tasks: executions }]
      : [];
  });
  const included = new Set(items.flatMap((item) => item.tasks.map((task) => task.id)));
  for (const task of tasks)
    if (isCurrentTask(task) && !included.has(task.id)) items.push({ id: task.id, tasks: [task] });
  const updatedAt = (item: CurrentWork) =>
    Math.max(
      Date.parse(item.goal?.updatedAt ?? '') || 0,
      ...item.tasks.map((task) => Date.parse(task.execution?.updatedAt ?? task.createdAt)),
    );
  return items.sort((a, b) => updatedAt(b) - updatedAt(a));
}
