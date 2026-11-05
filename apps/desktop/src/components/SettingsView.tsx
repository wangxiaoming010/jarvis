import { useEffect, useState } from 'react';
import { Button } from '@heroui/react';
import {
  Check,
  ChevronDown,
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  RefreshCw,
  Sparkles,
} from 'lucide-react';
import type { AvailableModel, ModelProvider, ModelSettingsView } from '@openbot/shared';
import { request, type Connection } from '../lib/client';
import { ExecutionSettings } from './ExecutionSettings';

type Mutate = <T>(path: string, body?: unknown, method?: string) => Promise<T>;

export function SettingsView({
  connection,
  mutate,
  setupRequired = false,
  onCreateBot,
}: {
  connection: Connection;
  mutate: Mutate;
  setupRequired?: boolean;
  onCreateBot?: () => void;
}) {
  const [settings, setSettings] = useState<ModelSettingsView | null>(null);
  const [provider, setProvider] = useState<ModelProvider>('deepseek');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [visible, setVisible] = useState(false);
  const [model, setModel] = useState('');
  const [attentionModel, setAttentionModel] = useState('');
  const [attentionManual, setAttentionManual] = useState(false);
  const [models, setModels] = useState<AvailableModel[]>([]);
  const [manual, setManual] = useState(false);
  const [loading, setLoading] = useState(false);
  const [modelError, setModelError] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [saving, setSaving] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [reload, setReload] = useState(0);
  const preset = settings?.providers.find((p) => p.id === provider);
  const supportsAttention = settings?.attentionModel !== undefined;
  const savedKey = Boolean(preset?.hasKey && preset.baseUrl === baseUrl.replace(/\/+$/, ''));

  useEffect(() => {
    let cancelled = false;
    setError('');
    void request<ModelSettingsView>(connection, '/api/settings/model')
      .then((value) => {
        if (cancelled) return;
        setSettings(value);
        setProvider(value.provider);
        setBaseUrl(value.baseUrl);
        setModel(value.model);
        setAttentionModel(value.attentionModel ?? '');
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [connection.url, connection.token, reload]);

  useEffect(() => {
    let cancelled = false;
    setLoading(false);
    if (!settings || !baseUrl.trim() || (!apiKey.trim() && !savedKey)) return;
    if (apiKey && apiKey.trim().length < 8 && !refresh) return;
    const timer = setTimeout(() => {
      setLoading(true);
      setModelError('');
      void request<{ models: AvailableModel[] }>(
        connection,
        '/api/settings/models',
        {
          provider,
          baseUrl: baseUrl.trim(),
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        },
        'POST',
        20000,
      )
        .then((value) => {
          if (!cancelled) setModels(value.models);
        })
        .catch((e) => {
          if (!cancelled) {
            setModels([]);
            setModelError((e as Error).message);
          }
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 650);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [connection.url, connection.token, provider, baseUrl, apiKey, savedKey, settings, refresh]);

  function chooseProvider(value: ModelProvider) {
    const option = settings!.providers.find((p) => p.id === value)!;
    setProvider(value);
    setBaseUrl(option.baseUrl);
    setModel(option.model);
    setAttentionModel(option.attentionModel ?? '');
    setAttentionManual(false);
    setApiKey('');
    setModels([]);
    setModelError('');
    setError('');
    setSuccess(false);
    setManual(false);
    setVisible(false);
    setRefresh(0);
  }
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError('');
    setSuccess(false);
    try {
      const value = await mutate<ModelSettingsView>('/api/settings/model', {
        provider,
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        ...(supportsAttention ? { attentionModel: attentionModel.trim() } : {}),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      });
      setSettings(value);
      setBaseUrl(value.baseUrl);
      setModel(value.model);
      setAttentionModel(value.attentionModel ?? '');
      setApiKey('');
      setVisible(false);
      setSuccess(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (!settings)
    return (
      <div className="page-view settings-view">
        <p role={error ? 'alert' : 'status'}>{error || '正在读取设置…'}</p>
        {error && <Button onPress={() => setReload((v) => v + 1)}>重试</Button>}
      </div>
    );
  const activeProvider = settings.providers.find((p) => p.id === settings.provider);
  return (
    <section className="page-view settings-view">
      <div className="settings-heading">
        <span className="settings-heading-icon">
          <Sparkles size={23} />
        </span>
        <div>
          <h1>对话模型</h1>
          <p>所有 Bot 共用此模型配置。</p>
        </div>
      </div>
      {setupRequired && !settings.enabled && (
        <p className="inline-note" role="status">
          请先填写 API Key、选择对话模型并保存，再创建 Bot 和群组，开始聊天与协作。
        </p>
      )}
      <div className={`model-current ${settings.enabled ? 'configured' : ''}`}>
        <span className="model-status-dot" />
        <div>
          <strong>{settings.enabled ? '已配置' : '尚未配置'}</strong>
          <span>
            {settings.enabled
              ? `${activeProvider?.name} / ${settings.model}`
              : '填写 API Key 并选择模型。'}
          </span>
        </div>
        {settings.enabled && <Check size={17} />}
      </div>
      <form className="model-settings-form" onSubmit={save} onChange={() => setSuccess(false)}>
        <label className="settings-field" htmlFor="model-provider">
          <span>模型服务</span>
          <div className="settings-select">
            <select
              id="model-provider"
              aria-label="模型服务"
              value={provider}
              onChange={(e) => chooseProvider(e.target.value as ModelProvider)}
            >
              {settings.providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <ChevronDown size={15} />
          </div>
        </label>
        <label className="settings-field" htmlFor="model-api-key">
          <span>
            API Key{' '}
            {savedKey && (
              <small className="key-saved">
                <Check size={12} />
                已保存在本机
              </small>
            )}
          </span>
          <div className="settings-key-input">
            <KeyRound size={16} />
            <input
              id="model-api-key"
              aria-label="API Key"
              type={visible ? 'text' : 'password'}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={savedKey ? '留空沿用已保存的 Key' : '填写服务商提供的 API Key'}
              autoComplete="off"
              spellCheck={false}
            />
            <button
              type="button"
              aria-label={visible ? '隐藏 API Key' : '显示 API Key'}
              onClick={() => setVisible((v) => !v)}
            >
              {visible ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
          <small>Key 保存在本机，请求时发送给填写的 API 地址。</small>
        </label>
        <label className="settings-field" htmlFor="model-base-url">
          <span>API 地址</span>
          <input
            id="model-base-url"
            aria-label="API 地址"
            type="url"
            value={baseUrl}
            onChange={(e) => {
              setBaseUrl(e.target.value);
              setModels([]);
              setModelError('');
            }}
            autoComplete="off"
            spellCheck={false}
            required
          />
          <small>
            {provider === 'compatible'
              ? '填写 API 根地址，通常以 /v1 结尾。'
              : '更改地址后需重新填写 API Key。'}
          </small>
        </label>
        <div className="settings-field">
          <div className="settings-model-label">
            <label htmlFor={manual ? 'model-id' : 'model-select'}>选择模型</label>
            <button
              type="button"
              className="settings-text-button"
              onClick={() => setRefresh((v) => v + 1)}
              disabled={loading || (!apiKey.trim() && !savedKey)}
            >
              {loading ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={13} />}
              {loading ? '正在获取' : '刷新列表'}
            </button>
          </div>
          {manual ? (
            <input
              id="model-id"
              aria-label="模型 ID"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="填写服务商提供的完整模型 ID"
              autoComplete="off"
              spellCheck={false}
            />
          ) : (
            <div className="settings-select">
              <select
                id="model-select"
                aria-label="选择模型"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                disabled={loading || (!models.length && !model)}
              >
                <option value="">
                  {loading
                    ? '正在获取模型…'
                    : models.length
                      ? '请选择模型'
                      : apiKey.trim() || savedKey
                        ? '暂无模型，请刷新或手动填写'
                        : '填写 API Key 后自动获取'}
                </option>
                {model && !models.some((m) => m.id === model) && (
                  <option value={model}>{model}</option>
                )}
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
              <ChevronDown size={15} />
            </div>
          )}
          {modelError && (
            <p className="settings-inline-error" role="alert">
              {modelError}
            </p>
          )}
          <div className="settings-model-help">
            <small>
              {models.length
                ? `已获取 ${models.length} 个模型`
                : '支持工具调用的模型才能安排任务。'}
            </small>
            <button
              type="button"
              className="settings-text-button"
              onClick={() => setManual((v) => !v)}
            >
              {manual ? '从列表选择' : '手动填写模型 ID'}
            </button>
          </div>
        </div>
        {supportsAttention && (
          <div className="settings-field">
            <div className="settings-model-label">
              <label htmlFor={attentionManual ? 'attention-model-id' : 'attention-model-select'}>
                注意力模型
              </label>
            </div>
            {attentionManual ? (
              <input
                id="attention-model-id"
                aria-label="注意力模型 ID"
                value={attentionModel}
                onChange={(e) => setAttentionModel(e.target.value)}
                placeholder="留空则使用对话模型"
                autoComplete="off"
                spellCheck={false}
              />
            ) : (
              <div className="settings-select">
                <select
                  id="attention-model-select"
                  aria-label="注意力模型"
                  value={attentionModel}
                  onChange={(e) => setAttentionModel(e.target.value)}
                  disabled={loading}
                >
                  <option value="">跟随对话模型</option>
                  {attentionModel && !models.some((m) => m.id === attentionModel) && (
                    <option value={attentionModel}>{attentionModel}</option>
                  )}
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
                <ChevronDown size={15} />
              </div>
            )}
            <div className="settings-model-help">
              <small>判断是否参与群聊；私聊和直接提及无需判断。</small>
              <button
                type="button"
                className="settings-text-button"
                onClick={() => setAttentionManual((v) => !v)}
              >
                {attentionManual ? '从列表选择注意力模型' : '手动填写注意力模型 ID'}
              </button>
            </div>
          </div>
        )}
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        <div className="settings-save-row">
          <span role="status">
            {success && (
              <>
                <Check size={15} />
                已保存
              </>
            )}
          </span>
          <Button
            type="submit"
            className="accent-button"
            isPending={saving}
            isDisabled={!model.trim() || (!apiKey.trim() && !savedKey) || !baseUrl.trim()}
          >
            保存设置
          </Button>
        </div>
      </form>
      <ExecutionSettings connection={connection} mutate={mutate} />
      {settings.enabled && onCreateBot && (
        <div className="model-setup-next">
          <p>对话模型已就绪，接下来创建你的第一位 Bot。</p>
          <Button className="accent-button" onPress={onCreateBot}>
            创建 Bot
          </Button>
        </div>
      )}
    </section>
  );
}
