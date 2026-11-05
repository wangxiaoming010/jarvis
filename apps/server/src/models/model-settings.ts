import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ModelProvider, ModelSettingsView } from '@openbot/shared';
import type { BrainConfig } from '../config.js';
import { modelProviders, normalizeModelUrl } from './model-providers.js';

const credential = z
  .string()
  .trim()
  .min(1, '请填写 API Key')
  .max(8192, 'API Key 过长，请检查是否误填了其他内容')
  .regex(/^[\x21-\x7e]+$/, 'API Key 格式无效');
export const modelConnectionSchema = z
  .object({
    provider: z.enum([
      'deepseek',
      'openai',
      'anthropic',
      'gemini',
      'qwen',
      'moonshot',
      'zhipu',
      'compatible',
    ]),
    baseUrl: z.string().min(1, '请填写 API 地址').max(2048, 'API 地址过长'),
    apiKey: credential.optional(),
  })
  .strict();
export const modelSettingsSchema = modelConnectionSchema.extend({
  model: z.string().trim().min(1, '请选择或填写模型').max(256, '模型 ID 不能超过 256 个字符'),
  attentionModel: z.string().trim().max(256, '注意力模型 ID 不能超过 256 个字符').optional(),
});
type ConnectionInput = z.infer<typeof modelConnectionSchema>;
type StoredConnection = { baseUrl: string; apiKey: string; model: string; attentionModel?: string };
const storedSchema = z.object({
  version: z.literal(1),
  active: modelConnectionSchema.shape.provider,
  connections: z.record(
    z.string(),
    z.object({
      baseUrl: z.string(),
      apiKey: credential,
      model: z.string().min(1).max(256),
      attentionModel: z.string().max(256).optional(),
    }),
  ),
});

/** Credentials remain server-side in an owner-only file and never enter the snapshot. */
export class ModelSettings {
  private path: string;
  private connections: Partial<Record<ModelProvider, StoredConnection>> = {};
  private active: ModelProvider;
  private saved = false;
  constructor(
    databasePath: string,
    private fallback: BrainConfig,
  ) {
    this.path = join(dirname(databasePath), 'model-settings.json');
    this.active = fallback.provider;
    if (existsSync(this.path)) {
      try {
        const stored = storedSchema.parse(JSON.parse(readFileSync(this.path, 'utf8')));
        for (const preset of modelProviders) {
          const config = stored.connections[preset.id];
          if (config)
            this.connections[preset.id] = { ...config, baseUrl: normalizeModelUrl(config.baseUrl) };
        }
        this.active = stored.active;
        if (!this.connections[this.active]) throw new Error('missing active connection');
        this.saved = true;
        chmodSync(this.path, 0o600);
      } catch {
        throw new Error('本地模型设置无法读取，请检查配置文件');
      }
    }
  }
  private connection(id: ModelProvider): StoredConnection | undefined {
    return (
      this.connections[id] ??
      (id === this.fallback.provider && this.fallback.apiKey
        ? {
            baseUrl: this.fallback.baseUrl,
            apiKey: this.fallback.apiKey,
            model: this.fallback.model,
            attentionModel: this.fallback.attentionModel,
          }
        : undefined)
    );
  }
  current(): BrainConfig {
    const connection = this.connection(this.active);
    if (!this.saved) return { ...this.fallback };
    return {
      provider: this.active,
      baseUrl: connection!.baseUrl,
      model: connection!.model,
      attentionModel: connection!.attentionModel ?? '',
      apiKey: connection!.apiKey,
      enabled: true,
    };
  }
  isConfigured(): boolean {
    const config = this.current();
    return Boolean(
      config.enabled && config.apiKey?.trim() && config.baseUrl.trim() && config.model.trim(),
    );
  }
  view(): ModelSettingsView {
    const config = this.current();
    return {
      provider: config.provider,
      baseUrl: config.baseUrl,
      model: config.apiKey ? config.model : '',
      attentionModel: config.apiKey ? (config.attentionModel ?? '') : '',
      hasKey: Boolean(config.apiKey),
      enabled: this.isConfigured(),
      providers: modelProviders.map((p) => ({
        id: p.id,
        name: p.name,
        baseUrl: this.connection(p.id)?.baseUrl ?? p.baseUrl,
        model: this.connection(p.id)?.model ?? '',
        attentionModel: this.connection(p.id)?.attentionModel ?? '',
        hasKey: Boolean(this.connection(p.id)?.apiKey),
      })),
    };
  }
  resolve(input: ConnectionInput): BrainConfig {
    const baseUrl = normalizeModelUrl(input.baseUrl);
    const saved = this.connection(input.provider);
    const apiKey = input.apiKey ?? (saved?.baseUrl === baseUrl ? saved.apiKey : undefined);
    if (!apiKey) throw Object.assign(new Error('请为该服务地址填写 API Key'), { statusCode: 400 });
    return { provider: input.provider, baseUrl, apiKey, model: saved?.model ?? '', enabled: true };
  }
  save(input: z.infer<typeof modelSettingsSchema>) {
    const connection = this.resolve(input);
    const connections = {
      ...this.connections,
      [input.provider]: {
        baseUrl: connection.baseUrl,
        apiKey: connection.apiKey!,
        model: input.model,
        attentionModel:
          input.attentionModel ?? this.connection(input.provider)?.attentionModel ?? '',
      },
    };
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: 1, active: input.provider, connections }), {
      mode: 0o600,
      flag: 'wx',
    });
    renameSync(temporary, this.path);
    this.connections = connections;
    this.active = input.provider;
    this.saved = true;
    return this.view();
  }
}
