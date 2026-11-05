import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Button } from '@heroui/react';
import { AnimatePresence, motion } from 'motion/react';
import {
  ArrowDown,
  ArrowUp,
  AtSign,
  Bot as BotIcon,
  CheckCheck,
  CornerDownLeft,
  Hash,
  MessageSquare,
  Reply,
  Sparkles,
  Users,
  X,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Bot, Group, Message, Snapshot, NativeReply } from '@openbot/shared';
import { statusLabel } from '@openbot/shared';
import { NativeInteraction } from './NativeInteraction';
import type { ActionEnvelope } from '@openbot/shared/ui/types';
import { BotAvatar, IconButton } from './Primitives';
import { rehypeMentions, splitMentions } from '../lib/mentions';
const DynamicMessage = lazy(() => import('./DynamicMessage'));
export function Welcome({
  group,
  hasBots,
  onBot,
  onMembers,
  onCompose,
}: {
  group: Group;
  hasBots: boolean;
  onBot: () => void;
  onMembers: () => void;
  onCompose: () => void;
}) {
  if (group.directBotId)
    return (
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        className="welcome"
      >
        <div className="welcome-bot">
          <BotIcon size={39} strokeWidth={1.5} />
        </div>

        <h1>与 {group.name} 聊天</h1>
        <p className="welcome-copy">直接发送消息即可。</p>
        <Button className="accent-button" onPress={onCompose}>
          <MessageSquare size={17} />
          开始聊天
        </Button>
      </motion.div>
    );
  return (
    <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="welcome">
      <div className="welcome-graphic" aria-hidden="true">
        <div className="orbit orbit-one" />
        <div className="orbit orbit-two" />
        <span className="orbit-node human-node">
          <Users size={19} />
        </span>
        <span className="orbit-node star-node">
          <Sparkles size={17} />
        </span>
        <div className="welcome-bot">
          <BotIcon size={39} strokeWidth={1.5} />
          <span className="bot-spark" />
        </div>
        <span className="orbit-dot" />
      </div>

      <h1>开始群聊</h1>
      <p className="welcome-copy">
        {hasBots ? '发送消息开始讨论，输入 @ 可指定 Bot。' : '先添加 Bot，再开始讨论。'}
      </p>
      <div className="start-cards">
        <button onClick={onBot}>
          <span className="step-icon peach">
            <BotIcon size={20} />
          </span>
          <strong>创建 Bot</strong>

          <span className="step-arrow">↗</span>
        </button>
        <button onClick={onMembers}>
          <span className="step-icon lavender">
            <Users size={20} />
          </span>
          <strong>管理成员</strong>

          <span className="step-arrow">↗</span>
        </button>
        <button onClick={onCompose}>
          <span className="step-icon green">
            <MessageSquare size={20} />
          </span>
          <strong>开始聊天</strong>

          <span className="step-arrow">↗</span>
        </button>
      </div>
    </motion.div>
  );
}
function MentionText({ content, bots }: { content: string; bots: Bot[] }) {
  return splitMentions(content, bots).map((part, index) =>
    part.botId ? (
      <span className="chat-mention" data-bot-id={part.botId} key={index}>
        {part.text}
      </span>
    ) : (
      part.text
    ),
  );
}
function MessageBody({ message, bots }: { message: Message; bots: Bot[] }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeMentions, bots]]}
        components={{
          a: ({ children, href }) => {
            const safe = href && /^https?:\/\//i.test(href);
            return safe ? (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            ) : (
              <span>{children}</span>
            );
          },
          img: ({ alt }) => <span className="image-placeholder">[图片：{alt ?? '外部图片'}]</span>,
        }}
      >
        {message.content}
      </ReactMarkdown>
    </div>
  );
}
function MessageItem({
  message,
  data,
  onReply,
  onRetryBot,
  draftScope,
  connected,
  onUiAction,
  onNativeReply,
}: {
  message: Message;
  data: Snapshot;
  onReply: (m: Message) => void;
  onRetryBot?: (messageId: string, botId: string) => void;
  draftScope: string;
  connected: boolean;
  onUiAction: (messageId: string, action: ActionEnvelope) => Promise<void>;
  onNativeReply: (id: string, response: NativeReply) => Promise<void>;
}) {
  const bot = data.bots.find((b) => b.id === message.senderId);
  const isHuman = message.senderType === 'human';
  const replied = data.messages.find((m) => m.id === message.replyTo);
  const card = message.nativeRequest ? (
    <NativeInteraction
      request={message.nativeRequest}
      connected={connected}
      onReply={onNativeReply}
    />
  ) : message.ui ? (
    <Suspense fallback={<p role="status">正在打开…</p>}>
      <DynamicMessage
        message={message}
        draftScope={draftScope}
        connected={connected}
        onAction={onUiAction}
      />
    </Suspense>
  ) : null;
  if (message.senderType === 'system' && card)
    return <div className="system-card-message">{card}</div>;
  if (message.senderType === 'system')
    return (
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="system-message">
        <span>
          <BotIcon size={14} />
        </span>
        <p>{message.content}</p>
      </motion.div>
    );
  return (
    <motion.article
      initial={{ opacity: 0, y: 7 }}
      animate={{ opacity: 1, y: 0 }}
      className={`message-row${isHuman ? ' message-row--human' : ''}`}
    >
      {bot ? <BotAvatar bot={bot} /> : <span className="human-avatar">我</span>}
      <div className="message-content">
        <div className="message-meta">
          <strong>{bot?.name ?? data.user.name}</strong>
          {bot && <span className="bot-tag">Bot</span>}
          <time
            dateTime={message.timestamp}
            title={new Date(message.timestamp).toLocaleString('zh-CN')}
          >
            {new Date(message.timestamp).toLocaleTimeString('zh-CN', {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </time>
          <span className="message-delivered" title="已保存">
            <CheckCheck size={13} />
          </span>
        </div>
        {replied && (
          <button
            className="reply-preview"
            onClick={() =>
              document
                .getElementById(`message-${replied.id}`)
                ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
            }
          >
            <Reply size={12} />
            <span>{replied.content.slice(0, 100)}</span>
          </button>
        )}
        {onRetryBot &&
          data.dialogueFailures?.some(
            (f) => f.messageId === message.id && f.groupId === message.groupId,
          ) && (
            <div className="dialogue-retry-row" role="status">
              {data.dialogueFailures
                .filter((f) => f.messageId === message.id && f.groupId === message.groupId)
                .map((f) => {
                  const failedBot = data.bots.find((b) => b.id === f.botId);
                  return failedBot ? (
                    <span className="dialogue-retry-item" key={f.botId}>
                      <small>
                        {f.stage === 'attention' ? '群消息判断失败：' : ''}
                        {f.error}
                      </small>
                      <button onClick={() => onRetryBot(message.id, f.botId)}>
                        重试 {failedBot.name}
                      </button>
                    </span>
                  ) : null;
                })}
            </div>
          )}
        <div id={`message-${message.id}`} className="message-body">
          {card ?? <MessageBody message={message} bots={data.bots} />}
        </div>
      </div>
      <IconButton label="回复消息" onPress={() => onReply(message)} className="message-action">
        <Reply size={15} />
      </IconButton>
    </motion.article>
  );
}
export function Timeline({
  data,
  group,
  onBot,
  onMembers,
  onSend,
  onRetryBot,
  onUiAction,
  onNativeReply,
  connected,
  search,
  draftScope,
}: {
  data: Snapshot;
  group: Group;
  onBot: () => void;
  onMembers: () => void;
  onSend: (content: string, replyTo: string | null, id: string) => Promise<void>;
  onRetryBot?: (messageId: string, botId: string) => void;
  onUiAction: (messageId: string, action: ActionEnvelope) => Promise<void>;
  onNativeReply: (id: string, response: NativeReply) => Promise<void>;
  connected: boolean;
  search: string;
  draftScope: string;
}) {
  const messages = data.messages.filter((m) => m.groupId === group.id);
  const filtered = search
    ? messages.filter((m) => m.content.toLowerCase().includes(search.toLowerCase()))
    : messages;
  const [reply, setReply] = useState<Message | null>(null);
  const [content, setContent] = useState(
    () => sessionStorage.getItem(`openbot.draft.${draftScope}.${group.id}`) ?? '',
  );
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState('');
  const [mentionOpen, setMentionOpen] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const highlights = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const lastId = useRef('');
  const pendingId = useRef<string | null>(null);
  const bots = data.bots.filter((b) => group.botIds.includes(b.id));
  const mentionMatch = content.match(/(?:^|\s)@([\p{L}\p{N}_-]*)$/u);
  const showMentions =
    !group.directBotId && (mentionOpen || Boolean(mentionMatch)) && !mentionDismissed;
  const suggestions = bots.filter(
    (b) => !mentionMatch?.[1] || b.name.toLowerCase().startsWith(mentionMatch[1].toLowerCase()),
  );
  useEffect(() => {
    sessionStorage.setItem(`openbot.draft.${draftScope}.${group.id}`, content);
    if (textarea.current) {
      textarea.current.style.height = 'auto';
      textarea.current.style.height = `${Math.min(textarea.current.scrollHeight, 160)}px`;
      if (highlights.current) highlights.current.scrollTop = textarea.current.scrollTop;
    }
  }, [content, group.id, draftScope]);
  useEffect(() => {
    const id = messages.at(-1)?.id;
    if (id && id !== lastId.current) {
      if (atBottom || messages.at(-1)?.senderId === data.user.id)
        list.current?.scrollTo({ top: list.current.scrollHeight, behavior: 'smooth' });
      lastId.current = id;
    }
  }, [messages.length, atBottom, data.user.id]);
  useEffect(() => {
    const frame = requestAnimationFrame(() =>
      list.current?.scrollTo({ top: list.current.scrollHeight }),
    );
    return () => cancelAnimationFrame(frame);
  }, []);
  async function send() {
    if (!content.trim() || sending || !connected) return;
    setSending(true);
    setSendError('');
    const id = pendingId.current ?? crypto.randomUUID();
    pendingId.current = id;
    try {
      await onSend(content, reply?.id ?? null, id);
      pendingId.current = null;
      setContent('');
      setReply(null);
      setMentionOpen(false);
      textarea.current?.focus();
    } catch (e) {
      setSendError((e as Error).message);
    } finally {
      setSending(false);
    }
  }
  function mention(bot: Bot) {
    setContent((c) =>
      mentionMatch
        ? c.replace(/@([\p{L}\p{N}_-]*)$/u, `@${bot.name} `)
        : `${c}${c && !c.endsWith(' ') ? ' ' : ''}@${bot.name} `,
    );
    setMentionOpen(false);
    textarea.current?.focus();
  }
  return (
    <>
      <div
        className="timeline"
        ref={list}
        onScroll={() => {
          if (list.current)
            setAtBottom(
              list.current.scrollHeight - list.current.scrollTop - list.current.clientHeight < 120,
            );
        }}
      >
        {!messages.length && !search ? (
          <Welcome
            group={group}
            hasBots={bots.length > 0}
            onBot={onBot}
            onMembers={onMembers}
            onCompose={() => textarea.current?.focus()}
          />
        ) : (
          <div className="messages-wrap">
            <div className="group-beginning">
              <span>{group.directBotId ? <BotIcon size={22} /> : <Hash size={22} />}</span>
              <h2>{group.name}</h2>
              {!group.directBotId && group.description && <p>{group.description}</p>}
            </div>
            <div className="date-divider">
              <span />
              {search ? `${filtered.length} 条搜索结果` : '对话记录'}
              <span />
            </div>
            {filtered.map((m, index) => (
              <div key={m.id}>
                {(index === 0 ||
                  new Date(m.timestamp).toDateString() !==
                    new Date(filtered[index - 1].timestamp).toDateString()) && (
                  <p className="day-label">
                    {new Date(m.timestamp).toLocaleDateString('zh-CN', {
                      month: 'long',
                      day: 'numeric',
                    })}
                  </p>
                )}
                <MessageItem
                  message={m}
                  data={data}
                  onRetryBot={onRetryBot}
                  draftScope={draftScope}
                  connected={connected}
                  onUiAction={onUiAction}
                  onNativeReply={onNativeReply}
                  onReply={(m) => {
                    setReply(m);
                    textarea.current?.focus();
                  }}
                />
              </div>
            ))}
            {search && !filtered.length && <div className="no-results">没有找到相关消息</div>}
          </div>
        )}
      </div>
      {!atBottom && messages.length > 0 && (
        <Button
          className="jump-button"
          variant="secondary"
          size="sm"
          onPress={() =>
            list.current?.scrollTo({ top: list.current.scrollHeight, behavior: 'smooth' })
          }
        >
          <ArrowDown size={14} />
          回到最新消息
        </Button>
      )}
      <div className="composer-area">
        {data.conversations?.some((c) => c.groupId === group.id) && (
          <p className="dialogue-indicator" role="status">
            {[
              ...new Set(
                data.conversations
                  .filter((c) => c.groupId === group.id)
                  .map((c) => data.bots.find((b) => b.id === c.botId)?.name),
              ),
            ]
              .filter(Boolean)
              .join('、')}{' '}
            正在处理消息…
          </p>
        )}
        <AnimatePresence>
          {reply && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="replying"
            >
              <Reply size={15} />
              <span>回复：{reply.content.slice(0, 85)}</span>
              <IconButton label="取消回复" onPress={() => setReply(null)}>
                <X size={15} />
              </IconButton>
            </motion.div>
          )}
        </AnimatePresence>
        {sendError && (
          <p className="send-error" role="alert">
            {sendError}
          </p>
        )}
        <div className={`composer ${!connected ? 'disconnected' : ''}`}>
          <AnimatePresence>
            {showMentions && (
              <motion.div
                initial={{ opacity: 0, y: 5 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 5 }}
                className="mention-menu"
              >
                <div className="mention-heading">
                  提及 Bot <kbd>Esc 关闭</kbd>
                </div>
                {suggestions.length ? (
                  suggestions.map((bot) => (
                    <button key={bot.id} onClick={() => mention(bot)}>
                      <BotAvatar bot={bot} size="small" />
                      <strong>{bot.name}</strong>

                      <small>{statusLabel[bot.status]}</small>
                    </button>
                  ))
                ) : (
                  <div className="mention-empty">
                    {bots.length ? '没有匹配的 Bot' : '请先添加群组成员'}
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
          <div className="composer-input">
            <div className="composer-highlights" ref={highlights} aria-hidden="true">
              <MentionText content={content} bots={bots} />
              {'\u200b'}
            </div>
            <textarea
              ref={textarea}
              aria-label="消息内容"
              value={content}
              maxLength={16000}
              onScroll={(e) => {
                if (highlights.current) {
                  highlights.current.scrollTop = e.currentTarget.scrollTop;
                  highlights.current.scrollLeft = e.currentTarget.scrollLeft;
                }
              }}
              onCompositionStart={() => {
                composing.current = true;
              }}
              onCompositionEnd={() => {
                composing.current = false;
              }}
              onBlur={() => {
                composing.current = false;
              }}
              onChange={(e) => {
                setContent(e.target.value);
                setMentionDismissed(false);
                pendingId.current = null;
                setSendError('');
              }}
              placeholder={
                connected
                  ? group.directBotId
                    ? `发送消息给 ${group.name}…`
                    : `发送消息，输入 @ 指定 Bot…`
                  : '连接恢复后可发送消息'
              }
              onKeyDown={(e) => {
                // Some native input methods clear isComposing before the confirmation Enter.
                // keyCode 229 also covers that confirmation without consuming the next normal Enter.
                if (composing.current || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229)
                  return;
                if (e.key === 'Escape') {
                  setMentionOpen(false);
                  setMentionDismissed(true);
                }
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  if (showMentions && suggestions.length) {
                    mention(suggestions[0]);
                  } else void send();
                }
              }}
              rows={2}
            />
          </div>
          <div className="composer-tools">
            <div>
              {!group.directBotId && (
                <IconButton
                  label="提及 Bot"
                  onPress={() => {
                    setMentionDismissed(false);
                    setMentionOpen((v) => !v);
                    textarea.current?.focus();
                  }}
                >
                  <AtSign size={18} />
                </IconButton>
              )}
              <span className="composer-mode">
                <span />
                {group.directBotId ? `发送给 ${group.name}` : '群组消息'}
              </span>
            </div>
            <Button
              isIconOnly
              className="send-button"
              aria-label="发送消息"
              isDisabled={!content.trim() || !connected || sending}
              isPending={sending}
              onPress={() => void send()}
            >
              <ArrowUp size={18} />
            </Button>
          </div>
        </div>
        <div className="composer-footer">
          <span>
            <CornerDownLeft size={11} /> Enter 发送 <i>·</i> Shift + Enter 换行
          </span>
        </div>
      </div>
    </>
  );
}
