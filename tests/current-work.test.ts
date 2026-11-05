import { expect, it } from 'vitest';
import type { Group, Snapshot, Task, WorkGoal } from '@openbot/shared';
import { currentWork } from '../apps/desktop/src/lib/currentWork';

const group: Group = {
  id: 'group',
  name: '项目群',
  description: '',
  botIds: ['bob', 'alice'],
  createdAt: '',
};
const direct: Group = { ...group, id: 'direct', name: 'Bob', botIds: ['bob'], directBotId: 'bob' };
const goal = (patch: Partial<WorkGoal> = {}): WorkGoal => ({
  id: 'goal',
  botId: 'bob',
  groupId: group.id,
  sourceMessageId: null,
  projectId: null,
  title: '交付项目',
  criteria: ['测试通过'],
  version: 1,
  state: 'active',
  nextAction: '',
  nextCheckAt: null,
  deadline: null,
  generation: 1,
  unattendedChecks: 0,
  attentionReason: null,
  ownerWait: 0,
  legacy: 0,
  delivery: 'accepted',
  verification: 'reviewed',
  result: null,
  createdAt: '2026-11-04T08:00:00Z',
  updatedAt: '2026-11-04T08:00:00Z',
  ...patch,
});
const task = (patch: Partial<Task> = {}): Task => ({
  id: 'task',
  goalId: 'goal',
  botId: 'bob',
  groupId: group.id,
  input: '修复问题',
  status: 'running',
  createdAt: '2026-11-04T08:00:00Z',
  startedAt: null,
  finishedAt: null,
  result: null,
  error: null,
  correlationId: 'chain',
  round: 0,
  ...patch,
});
const snapshot = (tasks: Task[], goals: WorkGoal[] = []): Snapshot => ({
  tasks,
  goals,
  groups: [group, direct],
  bots: [],
  messages: [],
  user: { id: 'owner', name: '我' },
  revision: 1,
});

it('counts a goal and all of its executions as one current work item', () => {
  const tasks = [
    task({ id: 'previous', status: 'completed' }),
    task(),
    task({ id: 'verification', status: 'queued' }),
  ];
  const items = currentWork(snapshot(tasks, [goal()]), group);
  expect(items).toHaveLength(1);
  expect(items[0]).toEqual({ id: 'goal', goal: goal(), tasks });
});

it('shows a Bot’s work across group and private conversations in its private chat', () => {
  const tasks = [
    task(),
    task({ id: 'private-task', goalId: null, groupId: direct.id }),
    task({ id: 'colleague', goalId: null, botId: 'alice' }),
  ];
  const items = currentWork(
    snapshot(tasks, [goal(), goal({ id: 'colleague-goal', botId: 'alice' })]),
    direct,
  );
  expect(items.map((item) => item.id)).toEqual(['goal', 'private-task']);
  expect(items.flatMap((item) => item.tasks.map((t) => t.id))).toEqual(['task', 'private-task']);
});

it('keeps group work scoped to its current conversation route', () => {
  const tasks = [
    task({ goalId: null }),
    task({ id: 'private-task', goalId: null, groupId: direct.id, originGroupId: group.id }),
  ];
  const data = snapshot(tasks, [goal({ id: 'private-goal', groupId: direct.id })]);
  expect(currentWork(data, group).map((item) => item.id)).toEqual(['task']);
});

it('keeps goals visible while waiting between executions, without showing finished standalone tasks', () => {
  const tasks = [
    task({ status: 'completed' }),
    task({ id: 'done', goalId: null, status: 'completed' }),
  ];
  const items = currentWork(snapshot(tasks, [goal({ state: 'waiting' })]), group);
  expect(items).toHaveLength(1);
  expect(items[0].goal?.state).toBe('waiting');
  expect(items[0].tasks.map((t) => t.id)).toEqual(['task']);
});

it('does not hide active execution when its goal has ended', () => {
  const items = currentWork(snapshot([task()], [goal({ state: 'completed' })]), group);
  expect(items).toHaveLength(1);
  expect(items[0].tasks).toEqual([task()]);
  expect(
    currentWork(snapshot([task({ status: 'completed' })], [goal({ state: 'completed' })]), group),
  ).toEqual([]);
});

it('keeps active tasks with legacy or missing goals and never merges by title', () => {
  const tasks = [
    task(),
    task({ id: 'orphan', goalId: 'missing' }),
    task({ id: 'independent', goalId: null }),
  ];
  expect(currentWork(snapshot(tasks, [goal({ legacy: 1 })]), group).map((item) => item.id)).toEqual(
    ['task', 'orphan', 'independent'],
  );
});

it('retains each active state, but removes failed and stopped standalone executions', () => {
  const statuses: Task['status'][] = [
    'queued',
    'running',
    'cancelling',
    'reviewing',
    'completed',
    'failed',
    'cancelled',
  ];
  const tasks = statuses.map((status) => task({ id: status, goalId: null, status }));
  expect(currentWork(snapshot(tasks), group).map((item) => item.id)).toEqual(statuses.slice(0, 4));
});

it('sorts work by its most recent goal or execution update without mutating the snapshot', () => {
  const tasks = [
    task({ id: 'older', goalId: null }),
    task({ id: 'newer', goalId: null, createdAt: '2026-11-04T09:00:00Z' }),
  ];
  const data = snapshot(tasks, [goal({ updatedAt: '2026-11-04T10:00:00Z' })]);
  expect(currentWork(data, group).map((item) => item.id)).toEqual(['goal', 'newer', 'older']);
  expect(data.tasks.map((t) => t.id)).toEqual(['older', 'newer']);
});
