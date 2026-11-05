import type { ModelProvider } from '@openbot/shared';
import { modelProviders, normalizeModelUrl } from './models/model-providers.js';

export interface BrainConfig {
  provider: ModelProvider;
  baseUrl: string;
  model: string;
  attentionModel?: string;
  apiKey: string | undefined;
  enabled: boolean;
}

/** Server-only configuration. Never include this object in API responses or logs. */
export function readBrainConfig(env: NodeJS.ProcessEnv = process.env): BrainConfig {
  const provider = env.BRAIN_PROVIDER?.trim() || 'deepseek';
  const preset = modelProviders.find((p) => p.id === provider);
  if (!preset) throw new Error('BRAIN_PROVIDER 不受支持');
  const baseUrl = normalizeModelUrl(env.BRAIN_BASE_URL?.trim() || preset.baseUrl);

  const enabled = env.BRAIN_ENABLED?.trim().toLowerCase() || 'true';
  if (!['true', 'false'].includes(enabled)) throw new Error('BRAIN_ENABLED 必须为 true 或 false');

  const apiKey = env.BRAIN_API_KEY?.trim() || env[preset.keyVariable]?.trim() || undefined;
  return {
    provider: preset.id,
    baseUrl,
    model: env.BRAIN_MODEL?.trim() || (preset.id === 'deepseek' ? 'deepseek-flash' : ''),
    attentionModel: env.ATTENTION_MODEL?.trim() || '',
    apiKey,
    enabled: enabled === 'true' && Boolean(apiKey),
  };
}

export function readWorkerLimits(env: NodeJS.ProcessEnv = process.env) {
  const perBot = Number(env.OPENBOT_WORKERS_PER_BOT ?? 2);
  const perBridge = Number(env.OPENBOT_WORKERS_PER_DEVICE ?? 4);
  if (
    !Number.isInteger(perBot) ||
    perBot < 1 ||
    perBot > 8 ||
    !Number.isInteger(perBridge) ||
    perBridge < 1 ||
    perBridge > 16
  )
    throw new Error('执行并发配置无效：每位 Bot 1–8 个，每台设备 1–16 个');
  return { perBot, perBridge };
}
