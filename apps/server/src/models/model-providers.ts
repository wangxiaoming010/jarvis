import type { AvailableModel, ModelProvider } from '@openbot/shared';
import type { BrainConfig } from '../config.js';

export const modelProviders: {
  id: ModelProvider;
  name: string;
  baseUrl: string;
  keyVariable: string;
}[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    keyVariable: 'DEEPSEEK_API_KEY',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    keyVariable: 'OPENAI_API_KEY',
  },
  {
    id: 'anthropic',
    name: 'Anthropic · Claude',
    baseUrl: 'https://api.anthropic.com/v1',
    keyVariable: 'ANTHROPIC_API_KEY',
  },
  {
    id: 'gemini',
    name: 'Google · Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyVariable: 'GEMINI_API_KEY',
  },
  {
    id: 'qwen',
    name: '通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    keyVariable: 'DASHSCOPE_API_KEY',
  },
  {
    id: 'moonshot',
    name: 'Moonshot · Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    keyVariable: 'MOONSHOT_API_KEY',
  },
  {
    id: 'zhipu',
    name: '智谱 · GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    keyVariable: 'ZHIPU_API_KEY',
  },
  {
    id: 'compatible',
    name: '其他 OpenAI 兼容服务',
    baseUrl: 'https://api.openai.com/v1',
    keyVariable: 'BRAIN_API_KEY',
  },
];

export function normalizeModelUrl(raw: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw Object.assign(new Error('请输入有效的模型 API 地址'), { statusCode: 400 });
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    throw Object.assign(new Error('模型 API 地址必须使用 HTTPS，且不能包含密钥、查询参数或片段'), {
      statusCode: 400,
    });
  return url.href.replace(/\/+$/, '');
}

export function providerHeaders(config: BrainConfig): Record<string, string> {
  return config.provider === 'anthropic'
    ? {
        'x-api-key': config.apiKey!,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      }
    : { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' };
}

export function upstreamError(status: number) {
  const detail =
    status === 401 || status === 403
      ? '请检查 API Key 和账号权限'
      : status === 429
        ? '请求受限或额度不足，请稍后重试'
        : '请检查服务地址或稍后重试';
  return Object.assign(new Error(`模型服务请求失败（HTTP ${status}），${detail}`), {
    statusCode: 502,
  });
}

export async function listProviderModels(
  config: BrainConfig,
  signal?: AbortSignal,
): Promise<AvailableModel[]> {
  const models = new Map<string, AvailableModel>();
  let after: string | undefined;
  const timeout = AbortSignal.timeout(15000);
  do {
    const url = new URL(config.baseUrl + '/models');
    if (config.provider === 'anthropic') {
      url.searchParams.set('limit', '100');
      if (after) url.searchParams.set('after_id', after);
    }
    let response: Response;
    try {
      response = await fetch(url, {
        headers: providerHeaders(config),
        redirect: 'error',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch {
      throw Object.assign(new Error('暂时无法获取模型列表，请检查服务地址和网络'), {
        statusCode: 502,
      });
    }
    if (!response.ok) throw upstreamError(response.status);
    const payload = (await response.json().catch(() => null)) as {
      data?: { id?: unknown; display_name?: unknown }[];
      has_more?: boolean;
      last_id?: string;
    } | null;
    if (!payload || !Array.isArray(payload.data))
      throw Object.assign(new Error('该服务未返回兼容的模型列表，可手动填写模型 ID'), {
        statusCode: 502,
      });
    for (const entry of payload.data) {
      if (typeof entry.id !== 'string' || !entry.id || entry.id.length > 256) continue;
      if (
        /(?:embedding|whisper|tts|dall-e|moderation|transcri|realtime|^sora|^image|^imagen|^veo)/i.test(
          entry.id,
        )
      )
        continue;
      models.set(entry.id, {
        id: entry.id,
        name: typeof entry.display_name === 'string' ? entry.display_name.slice(0, 256) : entry.id,
      });
    }
    const next = config.provider === 'anthropic' && payload.has_more ? payload.last_id : undefined;
    if (next === after) break;
    after = next;
  } while (after && models.size < 1000);
  if (!models.size)
    throw Object.assign(new Error('该账号没有返回可用的对话模型，可检查权限或手动填写模型 ID'), {
      statusCode: 502,
    });
  return [...models.values()].sort((a, b) => a.id.localeCompare(b.id));
}
