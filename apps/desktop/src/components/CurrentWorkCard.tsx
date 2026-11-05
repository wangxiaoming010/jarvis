import { useState } from 'react';
import { Button } from '@heroui/react';
import { ArrowUpRight } from 'lucide-react';
import type { Group, Snapshot } from '@openbot/shared';
import { workActivity } from '@openbot/shared';
import { isCurrentTask, type CurrentWork } from '../lib/currentWork';
import { BotAvatar } from './Primitives';
import { GoalCard, TaskCard, taskLabels } from './Overview';

export function CurrentWorkCard({
  item,
  data,
  group,
  onGroup,
  onStop,
  onStopGoal,
}: {
  item: CurrentWork;
  data: Snapshot;
  group: Group;
  onGroup: (id: string) => void;
  onStop: (id: string) => void;
  onStopGoal: (id: string) => Promise<void>;
}) {
  const { goal } = item;
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [ending, setEnding] = useState(false);
  const tasks = item.tasks.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const active = tasks.filter(isCurrentTask);
  const task = active[0];
  const bot = data.bots.find((b) => b.id === (goal?.botId ?? task?.botId));
  const source = data.groups.find((g) => g.id === (goal?.groupId ?? task?.groupId));
  const title = goal?.title ?? task?.input;
  const health = task?.execution?.health;
  const attention = goal?.state === 'needs_attention';
  const state = attention
    ? goal.ownerWait
      ? '需要你决定'
      : '需要关注'
    : task
      ? ({
          unknown: '结果待确认',
          waiting_device: '等待设备连接',
          waiting_owner: '等待你回复',
          waiting_permission: '等待授权',
          stalled: '执行停滞',
          unresponsive: '执行无响应',
          blocked: '执行受阻',
        }[health?.state ?? ''] ?? taskLabels[task.status])
      : goal?.state === 'waiting'
        ? '等待条件满足'
        : '等待后续行动';
  const progress =
    (attention && goal.attentionReason) ||
    task?.error ||
    (health && health.state !== 'running' && workActivity(health.detail)) ||
    (task?.execution?.activity && workActivity(task.execution.activity));
  const nextAction = task?.execution?.contract?.nextAction || goal?.nextAction;
  const updatedAt = task?.execution?.updatedAt ?? goal?.updatedAt ?? task?.createdAt;
  return (
    <article className="current-work-card" data-work-id={item.id}>
      <div className="work-card-header">
        <span className={`task-state ${attention ? 'failed' : (task?.status ?? '')}`}>{state}</span>
        {updatedAt && (
          <time dateTime={updatedAt} title={new Date(updatedAt).toLocaleString('zh-CN')}>
            {new Date(updatedAt).toLocaleTimeString('zh-CN', {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </time>
        )}
      </div>
      <h4>{title}</h4>
      {bot && (
        <div className="work-owner">
          <BotAvatar bot={bot} size="small" />
          <span>{bot.name}</span>
        </div>
      )}
      {source &&
        (source.id === group.id ? (
          <span className="work-source">
            {source.directBotId ? '私聊' : '群组'} · {source.name}
          </span>
        ) : (
          <button className="work-source work-source-link" onClick={() => onGroup(source.id)}>
            {source.directBotId ? '私聊' : '群组'} · {source.name}
            <ArrowUpRight size={12} />
          </button>
        ))}
      <dl className="work-summary">
        {task && task.input !== title && (
          <div>
            <dt>当前执行</dt>
            <dd>{task.input}</dd>
          </div>
        )}
        {progress && (
          <div>
            <dt>最新进展</dt>
            <dd role={attention || task?.error ? 'status' : undefined}>{progress}</dd>
          </div>
        )}
        {nextAction &&
          nextAction !== title &&
          nextAction !== task?.input &&
          nextAction !== progress && (
            <div>
              <dt>下一步</dt>
              <dd>{nextAction}</dd>
            </div>
          )}
        {!task && goal?.nextCheckAt && (
          <div>
            <dt>下次检查</dt>
            <dd>{new Date(goal.nextCheckAt).toLocaleString('zh-CN')}</dd>
          </div>
        )}
      </dl>
      {confirmEnd && goal ? (
        <div className="work-end-confirm">
          <p>
            结束后 {bot?.name ?? 'Bot'} 不再推进这个目标
            {active.length > 0 && '，正在进行的执行也会停止'}。
          </p>
          <div className="work-actions">
            <Button
              variant="tertiary"
              size="sm"
              isDisabled={ending}
              onPress={() => setConfirmEnd(false)}
            >
              返回
            </Button>
            <Button
              variant="danger"
              size="sm"
              isPending={ending}
              onPress={async () => {
                setEnding(true);
                await onStopGoal(goal.id);
                setEnding(false);
                setConfirmEnd(false);
              }}
            >
              确认结束
            </Button>
          </div>
        </div>
      ) : (
        <div className="work-actions">
          {active.length === 1 && task.status !== 'cancelling' && (
            <Button variant="danger-soft" size="sm" onPress={() => onStop(task.correlationId)}>
              停止本轮工作
            </Button>
          )}
          {goal && !['completed', 'cancelled'].includes(goal.state) && (
            <Button variant="tertiary" size="sm" onPress={() => setConfirmEnd(true)}>
              结束目标
            </Button>
          )}
        </div>
      )}
      <details className="work-details">
        <summary>工作详情{tasks.length > 0 && ` · ${tasks.length} 项执行`}</summary>
        {goal && <GoalCard goal={goal} bot={bot} artifacts={data.artifacts} />}
        {tasks.map((execution) => (
          <div key={execution.id}>
            {execution.groupId !== source?.id &&
              data.groups.some((g) => g.id === execution.groupId) && (
                <button
                  className="work-source work-source-link"
                  onClick={() => onGroup(execution.groupId)}
                >
                  查看执行对话
                  <ArrowUpRight size={12} />
                </button>
              )}
            <TaskCard
              task={execution}
              bot={data.bots.find((b) => b.id === execution.botId)}
              onStop={active.length > 1 ? onStop : undefined}
            />
          </div>
        ))}
      </details>
    </article>
  );
}
