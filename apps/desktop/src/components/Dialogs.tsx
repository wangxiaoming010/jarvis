import { useState } from 'react';
import { Button } from '@heroui/react';
import {
  ArrowRight,
  Check,
  Bot as BotIcon,
  ChevronRight,
  Info,
  Network,
  ShieldCheck,
  Terminal,
  Trash2,
} from 'lucide-react';
import type { Bot, BotAvatarSpec, Group, Provider, Snapshot } from '@openbot/shared';
import { providerLabel } from '@openbot/shared';
import { botAvatarSchema } from '@openbot/shared/schemas';
import { BotAvatar, Dialog, Field } from './Primitives';
import { AvatarEditor } from './AvatarEditor';
import { ExecutionToolPicker } from './ExecutionToolPicker';
type Mutate = <T>(path: string, body?: unknown, method?: string) => Promise<T>;
export function GroupDialog({
  group,
  bots,
  onClose,
  onSave,
  onDeleted,
  mutate,
}: {
  group?: Group;
  bots: Bot[];
  onClose: () => void;
  onSave: (id: string) => void;
  onDeleted: (id: string) => void;
  mutate: Mutate;
}) {
  const [name, setName] = useState(group?.name ?? '');
  const [description, setDescription] = useState(group?.description ?? '');
  const [selected, setSelected] = useState<string[]>(group?.botIds ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  async function remove() {
    if (!group || busy) return;
    setBusy(true);
    setError('');
    try {
      await mutate(`/api/groups/${group.id}`, undefined, 'DELETE');
      onDeleted(group.id);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await mutate<{ id: string }>(
        group ? `/api/groups/${group.id}` : '/api/groups',
        { name, description, botIds: selected },
        group ? 'PATCH' : 'POST',
      );
      onSave(result.id);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onClose={() => {
        if (!busy) onClose();
      }}
      title={confirmDelete ? '删除群组' : group ? '群组设置' : '创建群组'}
      subtitle={confirmDelete ? `确定删除「${group?.name}」？` : undefined}
    >
      {confirmDelete ? (
        <div className="dialog-form">
          <p className="group-delete-description">
            该群组的聊天记录、任务记录和群内记忆将永久删除。Bot 及各自的长期记忆会保留。
          </p>
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
          <div className="dialog-actions">
            <Button
              variant="tertiary"
              isDisabled={busy}
              onPress={() => {
                setConfirmDelete(false);
                setError('');
              }}
            >
              返回
            </Button>
            <Button variant="danger" isPending={busy} onPress={() => void remove()}>
              确认删除
            </Button>
          </div>
        </div>
      ) : (
        <form onSubmit={submit} className="dialog-form">
          <Field
            label="群组名称"
            value={name}
            onChange={setName}
            placeholder="例如：产品实验室"
            required
          />
          <Field
            label="群组描述"
            value={description}
            onChange={setDescription}
            placeholder="可选，例如：推进产品上线"
            multiline
          />
          <div className="form-section-label">
            邀请 Bot <span>可稍后添加</span>
          </div>
          {bots.length ? (
            <div className="bot-pick-list">
              {bots.map((bot) => (
                <button
                  type="button"
                  key={bot.id}
                  className={`bot-pick ${selected.includes(bot.id) ? 'selected' : ''}`}
                  onClick={() =>
                    setSelected((s) =>
                      s.includes(bot.id) ? s.filter((id) => id !== bot.id) : [...s, bot.id],
                    )
                  }
                >
                  <BotAvatar bot={bot} />
                  <div>
                    <strong>{bot.name}</strong>
                    {bot.description && <small>{bot.description}</small>}
                  </div>
                  <span className="check-box">
                    {selected.includes(bot.id) && <Check size={13} />}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <div className="inline-note">
              <BotIcon size={18} />
              <span>还没有 Bot，可在创建后添加。</span>
            </div>
          )}
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
          <div className="dialog-actions">
            {group && !group.directBotId && (
              <Button
                type="button"
                variant="danger-soft"
                className="group-delete-button"
                isDisabled={busy}
                onPress={() => {
                  setConfirmDelete(true);
                  setError('');
                }}
              >
                <Trash2 size={15} />
                删除群组
              </Button>
            )}
            <Button variant="tertiary" onPress={onClose}>
              取消
            </Button>
            <Button
              type="submit"
              isPending={busy}
              isDisabled={!name.trim()}
              className="accent-button"
            >
              {group ? '保存更改' : '创建群组'}
              <ArrowRight size={16} />
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
export function BotDialog({
  onClose,
  onSave,
  mutate,
  data,
}: {
  onClose: () => void;
  onSave: () => void;
  mutate: Mutate;
  data: Snapshot | null;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [provider, setProvider] = useState<Provider>('codex');
  const [avatar, setAvatar] = useState<BotAvatarSpec | null>(null);
  const [avatarLoading, setAvatarLoading] = useState(false);
  const [selected, setSelected] = useState('');
  const available = (data?.bridges ?? []).filter((bridge) =>
    bridge.providers.some((p) => p.provider === provider && p.available),
  );
  const selectedBridge =
    available.find((bridge) => bridge.id === selected)?.id ??
    (available.length === 1 ? available[0].id : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!data?.model?.configured) {
      setError('请先在设置中配置对话模型，再创建 Bot。');
      return;
    }
    if (busy || avatarLoading || (avatar && !botAvatarSchema.safeParse(avatar).success)) return;
    setBusy(true);
    setError('');
    try {
      await mutate('/api/bots', {
        name,
        description,
        provider,
        avatar,
        ...(selectedBridge ? { bridgeId: selectedBridge } : {}),
      });
      onSave();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onClose={() => {
        if (!busy && !avatarLoading) onClose();
      }}
      title="创建 Bot"
    >
      <form onSubmit={submit} className="dialog-form">
        <AvatarEditor
          value={avatar}
          onChange={setAvatar}
          name={name || 'Bot'}
          provider={provider}
          onBusyChange={setAvatarLoading}
          disabled={busy}
          presentation="popover"
        />
        <Field
          label="Bot 名称"
          value={name}
          onChange={setName}
          placeholder="例如：Alice"
          required
        />
        <Field
          label="职责描述"
          value={description}
          onChange={setDescription}
          placeholder="例如：负责架构设计与代码审查"
          multiline
        />
        <ExecutionToolPicker
          value={provider}
          onChange={(value) => {
            setProvider(value);
            setSelected('');
          }}
          disabled={busy || avatarLoading}
        />
        {!data?.model?.configured && (
          <div className="inline-note">
            <Info size={18} />
            <span>尚未配置对话模型，请在设置中配置。</span>
          </div>
        )}
        {available.length > 1 && (
          <label className="form-section-label">
            运行设备
            <select
              aria-label="运行设备"
              value={selectedBridge}
              onChange={(e) => setSelected(e.target.value)}
            >
              <option value="" disabled>
                选择运行设备
              </option>
              {available.map((bridge) => (
                <option key={bridge.id} value={bridge.id}>
                  {bridge.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="inline-note">
          <ShieldCheck size={18} />
          <span>
            {available.length
              ? '本地执行已就绪，创建后自动连接。'
              : `${providerLabel[provider]} 暂不可用。使用本地执行需在本机安装 ${provider === 'codex' ? 'Codex CLI' : 'Claude Code'} 并完成账号登录。可以先创建 Bot，工具就绪后执行。`}
          </span>
        </div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <Button variant="tertiary" onPress={onClose} isDisabled={busy || avatarLoading}>
            取消
          </Button>
          <Button
            type="submit"
            isPending={busy}
            isDisabled={
              !data?.model?.configured ||
              !name.trim() ||
              (available.length > 1 && !selectedBridge) ||
              avatarLoading ||
              Boolean(avatar && !botAvatarSchema.safeParse(avatar).success)
            }
            className="accent-button"
          >
            创建 Bot
            <ArrowRight size={16} />
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
export function BotAvatarDialog({
  bot,
  onClose,
  mutate,
}: {
  bot: Bot;
  onClose: () => void;
  mutate: Mutate;
}) {
  const [avatar, setAvatar] = useState<BotAvatarSpec | null>(bot.avatar ?? null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const valid = !avatar || botAvatarSchema.safeParse(avatar).success;
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!valid || loading || saving) return;
    setSaving(true);
    setError('');
    try {
      await mutate(`/api/bots/${bot.id}/avatar`, { avatar }, 'PATCH');
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <Dialog
      open
      onClose={() => {
        if (!saving && !loading) onClose();
      }}
      title={`修改 ${bot.name} 的头像`}
    >
      <form className="dialog-form" onSubmit={save}>
        <AvatarEditor
          value={avatar}
          onChange={setAvatar}
          name={bot.name}
          provider={bot.provider}
          onBusyChange={setLoading}
          disabled={saving}
        />
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <Button variant="tertiary" onPress={onClose} isDisabled={saving || loading}>
            取消
          </Button>
          <Button
            type="submit"
            className="accent-button"
            isPending={saving}
            isDisabled={!valid || loading}
          >
            保存头像
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
export function BridgeDialog({
  onClose,
  bot,
  data,
  mutate,
}: {
  onClose: () => void;
  bot?: Bot;
  data: Snapshot | null;
  mutate: Mutate;
}) {
  const bridges = data?.bridges ?? [];
  const [provider, setProvider] = useState<Provider>(bot?.provider ?? 'codex');
  const [selected, setSelected] = useState(bot?.bridgeId ?? bridges[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function bind(e: React.FormEvent) {
    e.preventDefault();
    if (!bot) return;
    setBusy(true);
    setError('');
    try {
      await mutate(
        `/api/bots/${bot.id}/execution`,
        {
          provider,
          ...(selectedBridge ? { bridgeId: selectedBridge } : {}),
        },
        'PATCH',
      );
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const capable = bridges.filter((b) =>
    b.providers.some((p) => p.provider === provider && p.available),
  );
  const selectedBridge = capable.find((b) => b.id === selected)?.id ?? capable[0]?.id ?? '';
  return (
    <Dialog open onClose={onClose} title={bot ? `${bot.name} 的执行状态` : '本地执行状态'}>
      <div className="bridge-visual">
        <span>
          <Terminal size={25} />
        </span>
        <i />
        <span className="bridge-logo">
          <BotIcon size={27} />
        </span>
        <i />
        <span>
          <Network size={25} />
        </span>
      </div>
      <div className="inline-note">
        <ShieldCheck size={18} />
        <span>
          支持读取和搜索文件、联网检索；实际可用性取决于所选工具、模型服务和网络。修改文件或运行命令时，遵循本机工具的权限设置。
        </span>
      </div>
      <div className="bridge-list">
        {bridges.length ? (
          bridges.map((bridge) => (
            <div className="binding-details" key={bridge.id}>
              <div>
                <span>设备</span>
                <strong>{bridge.name}</strong>
              </div>
              <div>
                <span>执行能力</span>
                <strong>{bridge.providers.some((p) => p.available) ? '已就绪' : '不可用'}</strong>
                {!bridge.providers.some((p) => p.available) && (
                  <small>本机需安装 Codex CLI 或 Claude Code，并完成对应账号登录。</small>
                )}
              </div>
              {bridge.providers.map((p) => (
                <div key={p.provider}>
                  <span>{providerLabel[p.provider]}</span>
                  <strong>{p.available ? '已就绪' : '不可用'}</strong>
                  {!p.available && p.reason && <small>{p.reason}</small>}
                </div>
              ))}
            </div>
          ))
        ) : (
          <div className="help-block">
            <Terminal size={18} />
            <div>
              <strong>本地执行未连接</strong>
              <p>本机需安装 Codex CLI 或 Claude Code，并完成对应账号登录。</p>
            </div>
          </div>
        )}
      </div>
      {bot && (
        <form onSubmit={bind} className="dialog-form">
          <label className="form-section-label">
            执行工具
            <select
              aria-label="执行工具"
              value={provider}
              onChange={(e) => {
                setProvider(e.target.value as Provider);
                setSelected('');
              }}
            >
              {Object.entries(providerLabel).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          {capable.length > 0 ? (
            <label className="form-section-label">
              运行设备
              <select
                aria-label="运行设备"
                value={selectedBridge}
                onChange={(e) => setSelected(e.target.value)}
              >
                {capable.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <p className="inline-note">
              {providerLabel[provider]} 暂不可用。本机需安装{' '}
              {provider === 'codex' ? 'Codex CLI' : 'Claude Code'} 并完成账号登录。
            </p>
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="dialog-actions">
            <Button variant="tertiary" onPress={onClose}>
              取消
            </Button>
            <Button type="submit" className="accent-button" isPending={busy}>
              保存执行设置
              <ArrowRight size={16} />
            </Button>
          </div>
        </form>
      )}
      {!bot && (
        <div className="dialog-actions">
          <Button className="accent-button" onPress={onClose}>
            关闭
            <ChevronRight size={16} />
          </Button>
        </div>
      )}
    </Dialog>
  );
}
