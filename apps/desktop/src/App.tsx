import { useEffect, useState } from 'react';
import { Button } from '@heroui/react';
import { AnimatePresence, motion } from 'motion/react';
import {
  Activity,
  ArrowUpRight,
  Bot as BotIcon,
  Hash,
  LoaderCircle,
  Menu,
  MessageSquare,
  MoreHorizontal,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  Search,
  Settings,
  Terminal,
  WifiOff,
  X,
} from 'lucide-react';
import type { Bot, Group } from '@openbot/shared';
import { resolveMentions, statusLabel } from '@openbot/shared';
import { useOpenBot } from './lib/useOpenBot';
import { BotAvatar, IconButton, Shortcut } from './components/Primitives';
import { BotAvatarDialog, BotDialog, BridgeDialog, GroupDialog } from './components/Dialogs';
import { Timeline } from './components/Timeline';
import { Overview } from './components/Overview';
import { ActivityView, BotsView, SearchDialog } from './components/Views';
import { SettingsView } from './components/SettingsView';
type View = 'group' | 'bots' | 'activity' | 'settings';
type ModalState =
  | { type: 'group'; group?: Group }
  | { type: 'bot' }
  | { type: 'avatar'; botId: string }
  | { type: 'bridge'; bot?: Bot }
  | { type: 'search' }
  | null;
export default function App() {
  const { data, status, error, setError, connection, retry, mutate } = useOpenBot();
  const [view, setView] = useState<View>('group');
  const [groupId, setGroupId] = useState(() => localStorage.getItem('openbot.group') ?? '');
  const [modal, setModal] = useState<ModalState>(null);
  const [overview, setOverview] = useState(() => window.innerWidth > 1050);
  const [sidebar, setSidebar] = useState(false);
  const [groupSearch, setGroupSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const group = data?.groups.find((g) => g.id === groupId) ?? data?.groups[0];
  const directBot = data?.bots.find((bot) => bot.id === group?.directBotId);
  const connected = status === 'connected';
  const needsModelSetup = Boolean(data && !data.model?.configured);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setModal((m) => (m?.type === 'search' ? null : { type: 'search' }));
      }
      if (e.key === 'Escape') setSidebar(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(''), 6000);
    return () => clearTimeout(timer);
  }, [error, setError]);
  function selectGroup(id: string, query = '') {
    setGroupId(id);
    localStorage.setItem('openbot.group', id);
    setView('group');
    setGroupSearch(query);
    setSearchOpen(Boolean(query));
    setSidebar(false);
  }
  function configureModel() {
    setModal(null);
    setView('settings');
    setSidebar(false);
  }
  function requireModel() {
    if (!data) return false;
    if (!data.model?.configured) {
      configureModel();
      return false;
    }
    return true;
  }
  function createGroup(group?: Group) {
    if (!requireModel()) return;
    setModal({ type: 'group', group });
  }
  function createBot() {
    if (!requireModel()) return;
    setModal({ type: 'bot' });
  }
  function showBridge(bot?: Bot) {
    if (!requireModel()) return;
    setModal({ type: 'bridge', bot });
  }
  async function openChat(bot: Bot) {
    if (!requireModel()) return;
    try {
      const chat = await mutate<{ id: string }>(`/api/bots/${bot.id}/chat`, {});
      selectGroup(chat.id);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function send(content: string, replyTo: string | null, id: string) {
    if (!group || !data || !requireModel()) return;
    await mutate('/api/messages', {
      id,
      groupId: group.id,
      content,
      mentions: resolveMentions(content, data.bots),
      replyTo,
    });
  }
  async function stopChain(id: string) {
    try {
      await mutate(`/api/chains/${id}/stop`, {});
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function stopGoal(id: string) {
    try {
      await mutate(`/api/goals/${id}/stop`, {});
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function retryMessage(id: string, botId: string) {
    if (!requireModel()) return;
    try {
      await mutate(`/api/messages/${id}/retry`, { botId });
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const connectionText = {
    connecting: '正在连接',
    connected: '协作服务已连接',
    reconnecting: '正在重新连接',
    offline: '协作服务未连接',
    unauthorized: '正在恢复本地连接',
  }[status];
  return (
    <div className="desktop-app">
      <header className="titlebar" data-tauri-drag-region />
      <div className="app-body">
        {sidebar && <div className="sidebar-scrim" onClick={() => setSidebar(false)} />}
        <aside className={`sidebar ${sidebar ? 'mobile-open' : ''}`}>
          <div className="brand">
            <span className="brand-logo">
              <BotIcon size={24} strokeWidth={2} />
            </span>
            <strong>Personal OpenBot Group</strong>
          </div>
          <button
            className="search-launch"
            onClick={() => setModal({ type: 'search' })}
            disabled={!data}
          >
            <Search size={15} />
            <span>搜索</span>
            <Shortcut />
          </button>
          <div className="sidebar-section-head">
            <span>协作群组</span>
            <IconButton label="创建群组" onPress={() => createGroup()}>
              <Plus size={15} />
            </IconButton>
          </div>
          <div className="group-list">
            {data?.groups
              .filter((g) => !g.directBotId)
              .map((g) => (
                <button
                  key={g.id}
                  className={view === 'group' && group?.id === g.id ? 'selected' : ''}
                  onClick={() => selectGroup(g.id)}
                >
                  <Hash size={16} />
                  <span>{g.name}</span>
                  {view === 'group' && group?.id === g.id && <motion.i layoutId="group-active" />}
                </button>
              ))}
            {!data && (
              <div className="sidebar-loading">
                <span />
                <span />
              </div>
            )}
            <button className="new-group" onClick={() => createGroup()}>
              <Plus size={15} />
              创建群组
            </button>
          </div>
          <div className="sidebar-bot-section">
            <div className="sidebar-section-head">
              <button
                className="sidebar-section-title"
                aria-label="管理 Bot"
                onClick={() => {
                  setView('bots');
                  setSidebar(false);
                }}
              >
                我的 Bot
              </button>
              <IconButton label="创建 Bot" onPress={createBot}>
                <Plus size={15} />
              </IconButton>
            </div>
            {data?.bots.length ? (
              <div className="sidebar-bots">
                {data.bots.slice(0, 4).map((bot) => (
                  <button
                    key={bot.id}
                    className={view === 'group' && directBot?.id === bot.id ? 'selected' : ''}
                    aria-label={`与 ${bot.name} 单独聊天`}
                    onClick={() => void openChat(bot)}
                  >
                    <BotAvatar bot={bot} size="small" />
                    <span>{bot.name}</span>
                    <small>{statusLabel[bot.status]}</small>
                  </button>
                ))}
                {data.bots.length > 4 && (
                  <button onClick={() => setView('bots')}>
                    查看全部 {data.bots.length} 位 Bot
                    <ArrowUpRight size={13} />
                  </button>
                )}
              </div>
            ) : (
              <button className="sidebar-bot-empty" onClick={createBot}>
                <span>
                  <BotIcon size={19} />
                </span>
                <div>
                  还没有 Bot
                  <small>
                    创建 Bot
                    <ArrowUpRight size={11} />
                  </small>
                </div>
              </button>
            )}
          </div>
          <nav className="main-nav activity-nav" aria-label="活动">
            <button
              className={view === 'activity' ? 'active' : ''}
              onClick={() => {
                setView('activity');
                setSidebar(false);
              }}
            >
              <Activity size={17} />
              <span>活动记录</span>
            </button>
          </nav>
          <div className="sidebar-bottom">
            <button className="bridge-widget" onClick={() => showBridge()}>
              <span className="bridge-widget-icon">
                <Terminal size={18} />
              </span>
              <div>
                <strong>本地执行</strong>
                <small>
                  <i className={connected && data?.bridges?.length ? 'online' : ''} />
                  {!connected ? '状态待确认' : data?.bridges?.length ? '已连接' : '未连接'}
                </small>
              </div>
              <ArrowUpRight size={14} />
            </button>
            <button
              aria-label="设置"
              className={`user-bar settings-launch ${view === 'settings' ? 'active' : ''}`}
              onClick={() => {
                setView('settings');
                setSidebar(false);
              }}
            >
              <Settings size={20} />
              <div>
                <strong>设置</strong>
                <small>模型与 API Key</small>
              </div>
            </button>
          </div>
        </aside>
        <main className="main-panel">
          <div className="main-header">
            <div className="main-header-title">
              <IconButton
                label="打开侧栏"
                onPress={() => setSidebar((v) => !v)}
                className="mobile-menu"
              >
                <Menu size={19} />
              </IconButton>
              {view === 'group' ? (
                <>
                  <span className="header-group-icon">
                    {group?.directBotId ? <MessageSquare size={19} /> : <Hash size={19} />}
                  </span>
                  <div>
                    <h2>{group?.name ?? 'Personal OpenBot Group'}</h2>
                    {(directBot || group?.description) && (
                      <p>
                        {directBot
                          ? `本地执行：${statusLabel[directBot.status]}`
                          : group?.description}
                      </p>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <span className="header-group-icon">
                    {view === 'bots' ? (
                      <BotIcon size={19} />
                    ) : view === 'settings' ? (
                      <Settings size={19} />
                    ) : (
                      <Activity size={19} />
                    )}
                  </span>
                  <div>
                    <h2>
                      {view === 'bots' ? '我的 Bot' : view === 'settings' ? '设置' : '活动记录'}
                    </h2>
                  </div>
                </>
              )}
            </div>
            <div className="header-actions">
              {view === 'group' && group && (
                <>
                  <span className="member-pill">
                    <span className="mini-human">我</span>
                    {group && group.botIds.length > 0 && (
                      <span className="mini-bot">
                        <BotIcon size={12} />
                      </span>
                    )}
                    <small>
                      {group?.directBotId
                        ? '单独聊天'
                        : `${1 + (group?.botIds.length ?? 0)} 位成员`}
                    </small>
                  </span>
                  <span className="header-divider" />
                  <IconButton
                    label={group?.directBotId ? '搜索聊天消息' : '搜索群组消息'}
                    onPress={() => setSearchOpen((v) => !v)}
                  >
                    <Search size={17} />
                  </IconButton>
                  <IconButton
                    label={overview ? '收起协作概览' : '显示协作概览'}
                    onPress={() => setOverview((v) => !v)}
                  >
                    {overview ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}
                  </IconButton>
                  {directBot ? (
                    <IconButton label="查看执行状态" onPress={() => showBridge(directBot)}>
                      <Terminal size={19} />
                    </IconButton>
                  ) : (
                    <IconButton label="群组设置" onPress={() => group && createGroup(group)}>
                      <MoreHorizontal size={19} />
                    </IconButton>
                  )}
                </>
              )}
            </div>
          </div>
          {status !== 'connected' && (
            <div
              className={`connection-banner ${status === 'unauthorized' ? 'auth' : ''}`}
              role="status"
            >
              {['connecting', 'reconnecting'].includes(status) ? (
                <LoaderCircle size={14} className="spin" />
              ) : (
                <WifiOff size={14} />
              )}
              <span>
                {connectionText}
                {data ? '，历史记录仍可查看。' : '，连接后即可开始协作。'}
              </span>
              <button onClick={retry}>
                重试连接
                <ArrowUpRight size={12} />
              </button>
            </div>
          )}
          {searchOpen && view === 'group' && (
            <div className="group-search">
              <Search size={16} />
              <input
                autoFocus
                aria-label={group?.directBotId ? '搜索聊天消息内容' : '搜索群组消息内容'}
                value={groupSearch}
                onChange={(e) => setGroupSearch(e.target.value)}
                placeholder={group?.directBotId ? '搜索当前聊天的消息…' : '搜索当前群组的消息…'}
              />
              <IconButton
                label="关闭消息搜索"
                onPress={() => {
                  setSearchOpen(false);
                  setGroupSearch('');
                }}
              >
                <X size={15} />
              </IconButton>
            </div>
          )}
          <div className="content-body">
            {data ? (
              <>
                <div className="center-content">
                  <AnimatePresence mode="wait">
                    <motion.div
                      key={view}
                      className="view-container"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.13 }}
                    >
                      {needsModelSetup && view !== 'settings' ? (
                        <div className="workspace-empty model-setup-welcome">
                          <span className="workspace-empty-icon">
                            <Settings size={38} strokeWidth={1.4} />
                          </span>
                          <h1>先配置对话模型</h1>
                          <p>
                            Bot 需要对话模型才能理解消息和协作。配置完成后，即可创建
                            Bot、群组并开始聊天。
                          </p>
                          <ol className="model-setup-steps" aria-label="开始使用步骤">
                            <li aria-current="step">配置对话模型</li>
                            <li>创建 Bot</li>
                            <li>开始聊天与协作</li>
                          </ol>
                          <Button className="accent-button" onPress={configureModel}>
                            <Settings size={16} />
                            配置对话模型
                          </Button>
                        </div>
                      ) : view === 'group' && group ? (
                        <Timeline
                          key={`${connection.url}:${group.id}`}
                          draftScope={connection.url}
                          data={data}
                          group={group}
                          onBot={createBot}
                          onMembers={() => createGroup(group)}
                          onSend={send}
                          onRetryBot={retryMessage}
                          onUiAction={async (messageId, action) => {
                            await mutate(`/api/cards/${messageId}/actions`, action);
                          }}
                          onNativeReply={async (id, response) => {
                            await mutate(`/api/native-requests/${id}/reply`, response);
                          }}
                          connected={connected}
                          search={groupSearch}
                        />
                      ) : view === 'bots' ? (
                        <BotsView
                          data={data}
                          onCreate={createBot}
                          onBridge={showBridge}
                          onAvatar={(bot) => setModal({ type: 'avatar', botId: bot.id })}
                          onChat={(bot) => void openChat(bot)}
                        />
                      ) : view === 'activity' ? (
                        <ActivityView data={data} onGroup={selectGroup} />
                      ) : view === 'settings' ? (
                        <SettingsView
                          connection={connection}
                          mutate={mutate}
                          setupRequired={needsModelSetup}
                          onCreateBot={data.bots.length === 0 ? createBot : undefined}
                        />
                      ) : (
                        <div className="workspace-empty">
                          <span className="workspace-empty-icon">
                            <BotIcon size={38} strokeWidth={1.4} />
                          </span>
                          <h1>开始使用 Personal OpenBot Group</h1>
                          <p>创建 Bot 开始聊天，也可以创建群组。</p>
                          <div className="workspace-empty-actions">
                            <Button className="accent-button" onPress={createBot}>
                              <Plus size={16} />
                              创建 Bot
                            </Button>
                            <Button variant="secondary" onPress={() => createGroup()}>
                              <Hash size={16} />
                              创建群组
                            </Button>
                          </div>
                        </div>
                      )}
                    </motion.div>
                  </AnimatePresence>
                </div>
                {!needsModelSetup && view === 'group' && overview && group && (
                  <Overview
                    data={data}
                    group={group}
                    onMembers={() => createGroup(group)}
                    onBridge={showBridge}
                    onBot={createBot}
                    onStop={(id) => void stopChain(id)}
                    onStopGoal={stopGoal}
                    onGroup={selectGroup}
                    onApprove={async (id, decision) => {
                      try {
                        await mutate(`/api/approvals/${id}`, { decision });
                      } catch (e) {
                        setError((e as Error).message);
                      }
                    }}
                  />
                )}
              </>
            ) : (
              <div className="disconnected-view">
                <span className="disconnected-logo">
                  <BotIcon size={43} strokeWidth={1.4} />
                </span>

                <h1>
                  {status === 'connecting' ? '正在连接 Personal OpenBot Group' : '无法连接本地服务'}
                </h1>
                <p>请重试连接；若仍无法连接，请重新打开应用。</p>
                <Button className="accent-button" onPress={retry}>
                  <ArrowUpRight size={16} />
                  重试连接
                </Button>
              </div>
            )}
          </div>
          <footer className="statusbar">
            <button onClick={retry} disabled={connected}>
              <i className={connected ? 'online' : 'offline'} />
              {connectionText}
            </button>
            <div>
              <span>Personal OpenBot Group</span>
            </div>
          </footer>
        </main>
      </div>
      <AnimatePresence>
        {error && (
          <motion.div
            role="alert"
            className="toast-error"
            initial={{ opacity: 0, y: 15 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 15 }}
          >
            {error}
            <IconButton label="关闭通知" onPress={() => setError('')}>
              <X size={15} />
            </IconButton>
          </motion.div>
        )}
      </AnimatePresence>
      {!needsModelSetup && data && modal?.type === 'group' && (
        <GroupDialog
          key={modal.group?.id ?? 'new'}
          group={modal.group}
          bots={data?.bots ?? []}
          onClose={() => setModal(null)}
          onSave={selectGroup}
          onDeleted={(id) => {
            sessionStorage.removeItem(`openbot.draft.${connection.url}.${id}`);
            if (group?.id === id) selectGroup(data?.groups.find((g) => g.id !== id)?.id ?? '');
          }}
          mutate={mutate}
        />
      )}{' '}
      {!needsModelSetup && data && modal?.type === 'bot' && (
        <BotDialog data={data} onClose={() => setModal(null)} onSave={() => {}} mutate={mutate} />
      )}{' '}
      {data && modal?.type === 'avatar' && data.bots.some((bot) => bot.id === modal.botId) && (
        <BotAvatarDialog
          key={modal.botId}
          bot={data.bots.find((bot) => bot.id === modal.botId)!}
          mutate={mutate}
          onClose={() => setModal(null)}
        />
      )}
      {!needsModelSetup && data && modal?.type === 'bridge' && (
        <BridgeDialog
          bot={data?.bots.find((b) => b.id === modal.bot?.id)}
          data={data}
          mutate={mutate}
          onClose={() => setModal(null)}
        />
      )}{' '}
      {modal?.type === 'search' && data && (
        <SearchDialog
          data={data}
          onClose={() => setModal(null)}
          onGroup={selectGroup}
          onBot={(bot) => void openChat(bot)}
        />
      )}
    </div>
  );
}
