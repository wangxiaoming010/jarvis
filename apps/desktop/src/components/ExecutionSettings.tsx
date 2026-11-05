import { useEffect, useState } from 'react';
import { Button } from '@heroui/react';
import type { ExecutionPermissionMode, ExecutionSettingsView } from '@openbot/shared';
import { ApiError, request, type Connection } from '../lib/client';

export function ExecutionSettings({
  connection,
  mutate,
}: {
  connection: Connection;
  mutate: <T>(path: string, body?: unknown, method?: string) => Promise<T>;
}) {
  const [settings, setSettings] = useState<ExecutionSettingsView | null>(null);
  const [mode, setMode] = useState<ExecutionPermissionMode>('auto');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setError('');
    setSettings(null);
    void request<ExecutionSettingsView>(connection, '/api/settings/execution')
      .then((value) => {
        if (cancelled) return;
        setSettings(value);
        setMode(value.mode);
      })
      .catch((e) => {
        if (!cancelled)
          setError(
            e instanceof ApiError && e.status === 404
              ? '重启应用后可加载执行权限设置，当前工作保持原模式。'
              : (e as Error).message,
          );
      });
    return () => {
      cancelled = true;
    };
  }, [connection.url, connection.token, reload]);
  async function save() {
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      const value = await mutate<ExecutionSettingsView>('/api/settings/execution', { mode });
      setSettings(value);
      setMode(value.mode);
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <section className="execution-settings" aria-label="执行权限设置">
      <h2>执行权限</h2>
      <p>所有 Bot 共用，保存后从下一次执行生效，正在进行的工作保持原模式。</p>
      {!settings ? (
        <>
          <p role={error ? 'alert' : 'status'}>{error || '正在读取执行权限…'}</p>
          {error && <Button onPress={() => setReload((v) => v + 1)}>重试读取执行权限</Button>}
        </>
      ) : (
        <>
          <label className="settings-field" htmlFor="execution-permission-mode">
            <span>权限模式</span>
            <div className="settings-select">
              <select
                id="execution-permission-mode"
                aria-label="权限模式"
                value={mode}
                onChange={(e) => {
                  setMode(e.target.value as ExecutionPermissionMode);
                  setSaved(false);
                }}
              >
                <option value="auto">自动模式（推荐）</option>
                <option value="manual">逐次确认</option>
              </select>
            </div>
          </label>
          <p>
            {mode === 'auto'
              ? '在明确的任务目录内，由执行工具自动审批日常操作，部分操作可能被拒绝或仍需确认。只读任务保持只读。'
              : '命令、文件修改等操作交由你逐次确认。'}
          </p>
          <p>
            自动审批会自行决定允许或拒绝，并非每个敏感操作都会再询问。不支持自动模式或任务目录不明确时，使用逐次确认。
          </p>
          {settings.providers.map((provider) => (
            <p key={`${provider.bridgeId}:${provider.provider}`}>
              <strong>
                {provider.provider === 'codex' ? 'Codex' : 'Claude Code'} · {provider.bridgeName}
              </strong>
              {'：'}
              {provider.reason || (provider.autoMode ? '支持自动模式' : '使用逐次确认')}
            </p>
          ))}
          {!settings.providers.length && <p>本地执行工具连接后显示支持情况。</p>}
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
          <div className="settings-save-row">
            <span role="status">{saved && '执行权限已保存'}</span>
            <Button className="accent-button" isPending={saving} onPress={() => void save()}>
              保存执行权限
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
