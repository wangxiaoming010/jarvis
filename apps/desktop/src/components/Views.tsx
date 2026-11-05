import { useState } from 'react';
import { Button } from '@heroui/react';
import { motion } from 'motion/react';
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  Bot as BotIcon,
  Camera,
  Hash,
  Link2,
  MessageSquare,
  Plus,
  Search,
  Sparkles,
} from 'lucide-react';
import type { Bot, Snapshot } from '@openbot/shared';
import { BotAvatar, Dialog, EmptySmall, Status } from './Primitives';
import { TaskCard, GoalCard } from './Overview';
export function BotsView({
  data,
  onCreate,
  onBridge,
  onChat,
  onAvatar,
}: {
  data: Snapshot;
  onCreate: () => void;
  onBridge: (bot: Bot) => void;
  onChat: (bot: Bot) => void;
  onAvatar: (bot: Bot) => void;
}) {
  return (
    <div className="page-view">
      <div className="page-title">
        <div>
          <h1>Bot</h1>
        </div>
        <Button className="accent-button" onPress={onCreate}>
          <Plus size={17} />
          创建 Bot
        </Button>
      </div>
      <div className="stats-strip">
        <div>
          <BotIcon size={18} />
          <span>Bot</span>
          <strong>{data.bots.length}</strong>
        </div>
        <div>
          <span className="green-dot" />
          <span>执行已连接</span>
          <strong>{data.bots.filter((b) => b.status !== 'offline').length}</strong>
        </div>
        <div>
          <Activity size={17} />
          <span>执行中</span>
          <strong>{data.tasks.filter((t) => t.status === 'running').length}</strong>
        </div>
      </div>
      {data.bots.length ? (
        <div className="bot-grid">
          {data.bots.map((bot, index) => (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: index * 0.04 }}
              className="bot-profile"
              key={bot.id}
            >
              <div className="bot-profile-top">
                <button
                  className="bot-avatar-edit"
                  aria-label={`修改 ${bot.name} 的头像`}
                  onClick={() => onAvatar(bot)}
                  title="修改头像"
                >
                  <BotAvatar bot={bot} size="large" />
                  <span className="bot-avatar-edit-icon">
                    <Camera size={12} />
                  </span>
                </button>
                <Status status={bot.status} />
              </div>
              <h2>{bot.name}</h2>

              {bot.description && <p>{bot.description}</p>}
              <div className="bot-profile-groups">
                <Hash size={13} />
                {data.groups.filter((g) => !g.directBotId && g.botIds.includes(bot.id)).length}{' '}
                个协作群组
              </div>
              <Button className="accent-button" fullWidth onPress={() => onChat(bot)}>
                <MessageSquare size={15} />
                单独聊天
                <ArrowRight size={15} />
              </Button>
              <Button variant="outline" fullWidth onPress={() => onBridge(bot)}>
                <Link2 size={15} />
                查看执行状态
                <ArrowUpRight size={15} />
              </Button>
            </motion.div>
          ))}
          <button className="new-bot-card" onClick={onCreate}>
            <span>
              <Plus size={25} />
            </span>
            <strong>创建 Bot</strong>
          </button>
        </div>
      ) : (
        <div className="big-empty">
          <div className="empty-bots-art">
            <span>
              <BotIcon size={40} strokeWidth={1.5} />
            </span>
            <i>
              <Sparkles size={20} />
            </i>
          </div>
          <h2>还没有 Bot</h2>

          <Button className="accent-button" onPress={onCreate}>
            <Plus size={17} />
            创建第一位 Bot
          </Button>
        </div>
      )}
    </div>
  );
}
export function ActivityView({ data, onGroup }: { data: Snapshot; onGroup: (id: string) => void }) {
  const [tab, setTab] = useState<'messages' | 'tasks'>('messages');
  const goals = data.goals?.filter((g) => !g.legacy) ?? [];
  const workCount = data.tasks.length + goals.length;
  const messages = data.messages
    .filter((m) => m.senderType !== 'system')
    .slice()
    .reverse();
  return (
    <div className="page-view">
      <div className="page-title">
        <div>
          <h1>活动记录</h1>
        </div>
        <span className="history-count">
          {messages.length} 条消息 · {goals.length} 个目标 · {data.tasks.length} 项任务
        </span>
      </div>
      <div className="activity-tabs">
        <button className={tab === 'messages' ? 'active' : ''} onClick={() => setTab('messages')}>
          <MessageSquare size={16} />
          消息<span>{messages.length}</span>
        </button>
        <button className={tab === 'tasks' ? 'active' : ''} onClick={() => setTab('tasks')}>
          <Activity size={16} />
          目标与任务<span>{workCount}</span>
        </button>
      </div>
      {tab === 'messages' ? (
        messages.length ? (
          <div className="activity-list">
            {messages.map((m) => (
              <button key={m.id} onClick={() => onGroup(m.groupId)}>
                <span className="activity-icon">
                  <MessageSquare size={17} />
                </span>
                <div>
                  <strong>
                    {data.bots.find((b) => b.id === m.senderId)?.name ?? '我'}
                    <span>
                      {data.groups.find((g) => g.id === m.groupId)?.directBotId
                        ? '私聊 · '
                        : '群组 · '}
                      {data.groups.find((g) => g.id === m.groupId)?.name}
                    </span>
                  </strong>
                  <p>{m.content}</p>
                </div>
                <time>
                  {new Date(m.timestamp).toLocaleDateString('zh-CN', {
                    month: 'numeric',
                    day: 'numeric',
                  })}{' '}
                  {new Date(m.timestamp).toLocaleTimeString('zh-CN', {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </time>
                <ArrowUpRight size={15} />
              </button>
            ))}
          </div>
        ) : (
          <EmptySmall
            icon={<MessageSquare size={25} />}
            title="还没有消息"
            description="私聊和群组消息会显示在这里。"
          />
        )
      ) : workCount ? (
        <div className="task-history">
          {goals
            .slice()
            .reverse()
            .map((g) => (
              <GoalCard
                key={g.id}
                goal={g}
                bot={data.bots.find((b) => b.id === g.botId)}
                artifacts={data.artifacts}
              />
            ))}
          {data.tasks
            .slice()
            .reverse()
            .map((t) => (
              <TaskCard key={t.id} task={t} bot={data.bots.find((b) => b.id === t.botId)} />
            ))}
        </div>
      ) : (
        <EmptySmall
          icon={<Activity size={25} />}
          title="还没有工作记录"
          description="目标和任务进展会显示在这里。"
        />
      )}
    </div>
  );
}
export function SearchDialog({
  data,
  onClose,
  onGroup,
  onBot,
}: {
  data: Snapshot;
  onClose: () => void;
  onGroup: (id: string, query?: string) => void;
  onBot: (bot: Bot) => void;
}) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const groups = data.groups.filter(
    (g) => !g.directBotId && (!q || `${g.name} ${g.description}`.toLowerCase().includes(q)),
  );
  const bots = data.bots.filter(
    (b) => !q || `${b.name} ${b.description}`.toLowerCase().includes(q),
  );
  const messages = q
    ? data.messages
        .filter((m) => m.senderType !== 'system' && m.content.toLowerCase().includes(q))
        .slice(-12)
        .reverse()
    : [];
  return (
    <Dialog open onClose={onClose} title="搜索" wide>
      <div className="global-search">
        <Search size={19} />
        <input
          autoFocus
          aria-label="搜索群组、Bot 和消息"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索群组、Bot 和消息…"
        />
        <kbd>ESC</kbd>
      </div>
      <div className="search-results">
        {groups.length > 0 && (
          <>
            <h4>协作群组</h4>
            {groups.map((g) => (
              <button
                key={g.id}
                onClick={() => {
                  onGroup(g.id);
                  onClose();
                }}
              >
                <Hash size={17} />
                <div>
                  <strong>{g.name}</strong>
                  <small>{g.description}</small>
                </div>
                <ArrowRight size={15} />
              </button>
            ))}
          </>
        )}
        {bots.length > 0 && (
          <>
            <h4>Bot</h4>
            {bots.map((b) => (
              <button
                key={b.id}
                onClick={() => {
                  onClose();
                  onBot(b);
                }}
              >
                <BotAvatar bot={b} size="small" />
                <div>
                  <strong>{b.name}</strong>
                  {b.description && <small>{b.description}</small>}
                </div>
                <Status status={b.status} />
              </button>
            ))}
          </>
        )}
        {messages.length > 0 && (
          <>
            <h4>相关消息</h4>
            {messages.map((m) => (
              <button
                key={m.id}
                onClick={() => {
                  onGroup(m.groupId, query);
                  onClose();
                }}
              >
                <MessageSquare size={16} />
                <div>
                  <strong>{m.content.slice(0, 90)}</strong>
                  <small>
                    {data.groups.find((g) => g.id === m.groupId)?.directBotId ? '单聊 · ' : '#'}
                    {data.groups.find((g) => g.id === m.groupId)?.name}
                  </small>
                </div>
                <ArrowRight size={15} />
              </button>
            ))}
          </>
        )}
        {!groups.length && !bots.length && !messages.length && (
          <EmptySmall
            icon={<Search size={23} />}
            title="没有找到相关结果"
            description="试试其他关键词。"
          />
        )}
      </div>
      <div className="search-footer">
        <span>{groups.length + bots.length + messages.length} 项结果</span>
      </div>
    </Dialog>
  );
}
