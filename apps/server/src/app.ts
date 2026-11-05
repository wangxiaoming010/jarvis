import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { timingSafeEqual } from 'node:crypto';
import { Runtime } from './runtime.js';
import { createCoordinatorModel, type CoordinatorModel } from './models/coordinator-model.js';
import { createAttentionModel, type AttentionModel } from './models/attention-model.js';
import { createMemoryCuratorModel, type MemoryCuratorModel } from './memory/memory-curator.js';
import { readBrainConfig, type BrainConfig } from './config.js';
import {
  ModelSettings,
  modelConnectionSchema,
  modelSettingsSchema,
} from './models/model-settings.js';
import { ExecutionSettings, executionSettingsSchema } from './models/execution-settings.js';
import { listProviderModels } from './models/model-providers.js';
import type { ActionEnvelope } from '@openbot/shared/ui/types';
import { z } from 'zod';
import { resolveMentions, type Message } from '@openbot/shared';
import {
  botSchema,
  botAvatarUpdateSchema,
  groupSchema,
  messageSchema,
  nativeRequestSchema,
  nativeReplySchema,
} from '@openbot/shared/schemas';
import type { WebSocket } from 'ws';
import { createStore } from './store.js';
import { removeGroup } from './bot/group-removal.js';
export async function createApp(options: {
  databasePath: string;
  token: string;
  logger?: boolean;
  clientOrigin?: string;
  bridgeToken?: string;
  coordinator?: CoordinatorModel;
  attention?: AttentionModel;
  memoryCuration?: { model: MemoryCuratorModel; delayMs?: number };
  modelConfig?: BrainConfig;
  workerLimits?: { perBot: number; perBridge: number };
  maxRounds?: number;
}) {
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 100_000 });
  const store = createStore(options.databasePath);
  const executionSettings = new ExecutionSettings(options.databasePath);
  const settings = new ModelSettings(
    options.databasePath,
    options.modelConfig ?? readBrainConfig({ BRAIN_ENABLED: 'false' }),
  );
  const configuredCoordinator: CoordinatorModel = async (messages, signal) => {
    const model = createCoordinatorModel(settings.current());
    if (!model) throw new Error('请先在设置中配置 Bot 的对话模型');
    return model(messages, signal);
  };
  const coordinator =
    options.coordinator ?? (settings.isConfigured() ? configuredCoordinator : undefined);
  const configuredAttention: AttentionModel = async (input, signal) => {
    const config = settings.current();
    const model = createAttentionModel({ ...config, model: config.attentionModel || config.model });
    if (!model) throw new Error('请先在设置中配置注意力模型');
    return model(input, signal);
  };
  const attention = options.attention ?? configuredAttention;
  // Curation is background upkeep: without a configured model it quietly records nothing.
  const configuredCuration: MemoryCuratorModel = async (input, signal) => {
    const config = settings.current();
    const model = createMemoryCuratorModel({
      ...config,
      model: config.attentionModel || config.model,
    });
    return model ? model(input, signal) : { memories: [] };
  };
  const memoryCuration = options.memoryCuration ?? { model: configuredCuration };
  const clients = new Set<WebSocket>();
  const validToken = (value: string, expected = options.token) => {
    const a = Buffer.from(value),
      b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const allowedOrigins = new Set([
    'http://127.0.0.1:1420',
    'http://localhost:1420',
    'tauri://localhost',
    'http://tauri.localhost',
    'https://tauri.localhost',
    ...(options.clientOrigin ? [options.clientOrigin] : []),
  ]);
  await app.register(cors, {
    origin: (origin, cb) => cb(null, !origin || allowedOrigins.has(origin)),
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  });
  await app.register(websocket, { options: { maxPayload: 262144 } });
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof z.ZodError)
      return reply.code(400).send({ error: error.issues[0]?.message ?? '输入无效' });
    const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
    req.log.error(error);
    return reply.code(statusCode).send({
      error: statusCode < 500 && error instanceof Error ? error.message : '服务暂时不可用',
    });
  });
  app.addHook('preHandler', async (req, reply) => {
    if (req.url === '/health' || req.url === '/events' || req.url === '/bridge') return;
    if (!validToken(req.headers.authorization?.replace(/^Bearer /, '') ?? ''))
      return reply.code(401).send({ error: '本地连接已失效，请重试连接' });
  });
  function broadcast() {
    store.changed();
    for (const ws of clients)
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'invalidate' }));
  }
  const runtime = new Runtime(
    store,
    broadcast,
    options.maxRounds,
    coordinator,
    options.workerLimits,
    attention,
    memoryCuration,
  );
  runtime.executionPermissionMode = executionSettings.mode;
  runtime.start();
  const fail = (statusCode: number, message: string) =>
    Object.assign(new Error(message), { statusCode });
  app.get('/health', async () => ({ status: 'ok', protocol: 1 }));
  app.get<{ Params: { id: string } }>('/api/goals/:id/status', async (req) => {
    const s = store.snapshot(),
      goal = s.goals?.find((g) => g.id === req.params.id);
    if (!goal) throw fail(404, '目标不存在');
    return {
      goal,
      tasks: s.tasks.filter((t) => t.goalId === goal.id),
      artifacts: s.artifacts?.filter((a) => a.goalId === goal.id),
    };
  });
  app.post<{ Params: { id: string } }>('/api/goals/:id/stop', async (req) =>
    runtime.stopGoal(req.params.id),
  );
  app.get('/api/snapshot', async () => ({
    ...store.snapshot(),
    bridges: runtime.bridges,
    brain: runtime.brainState,
    dialogue: {
      enabled: runtime.hasCoordinator,
      ...(runtime.hasCoordinator ? { mode: 'per-bot' } : {}),
    },
    model: {
      provider: settings.current().provider,
      name: settings.current().model,
      configured: settings.isConfigured(),
    },
    maxRounds: runtime.maxRounds,
  }));
  app.get('/api/settings/model', async () => settings.view());
  const executionView = () => ({
    mode: executionSettings.mode,
    providers: runtime.bridges.flatMap((bridge) =>
      bridge.providers.map((provider) => ({
        bridgeId: bridge.id,
        bridgeName: bridge.name,
        provider: provider.provider,
        autoMode: provider.autoMode === true,
        reason: provider.available
          ? (provider.autoModeReason ??
            (provider.autoMode ? undefined : '当前执行工具未报告自动模式支持，将逐次确认'))
          : provider.reason,
      })),
    ),
  });
  app.get('/api/settings/execution', async () => executionView());
  app.post('/api/settings/execution', async (req) => {
    const { mode } = executionSettingsSchema.parse(req.body);
    executionSettings.save(mode);
    runtime.executionPermissionMode = mode;
    broadcast();
    return executionView();
  });
  app.post('/api/settings/models', async (req) => ({
    models: await listProviderModels(settings.resolve(modelConnectionSchema.parse(req.body))),
  }));
  app.post('/api/settings/model', async (req) => {
    const body = modelSettingsSchema.parse(req.body);
    settings.resolve(body);
    if (
      !runtime.hasCoordinator &&
      store
        .snapshot()
        .tasks.some((t) => ['queued', 'running', 'cancelling', 'reviewing'].includes(t.status))
    )
      throw fail(409, '请先结束当前执行，再启用新的模型设置');
    const view = settings.save(body);
    runtime.enableCoordinator(configuredCoordinator);
    broadcast();
    return view;
  });
  app.get<{ Params: { id: string } }>('/api/tasks/:id/status', async (req) =>
    runtime.taskStatus(req.params.id),
  );
  app.post<{ Params: { id: string } }>('/api/messages/:id/retry', async (req) => {
    const body = z
      .object({ botId: z.string().min(1).optional() })
      .strict()
      .parse(req.body ?? {});
    return runtime.retryMessage(req.params.id, body.botId);
  });
  app.post<{ Params: { id: string } }>('/api/tasks/:id/change', async (req) => {
    const body = z
      .object({
        instruction: z.string().trim().min(1).max(16000),
        expectedVersion: z.number().int().positive(),
      })
      .strict()
      .parse(req.body);
    return runtime.changeTask(req.params.id, body.instruction, body.expectedVersion);
  });
  app.post<{ Params: { id: string } }>('/api/tasks/:id/stop', async (req) => {
    runtime.stopTask(req.params.id);
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/api/tasks/:id/resume', async (req) => {
    const body = z
      .object({
        instruction: z.string().trim().min(1).max(6000),
        expectedVersion: z.number().int().positive(),
      })
      .strict()
      .parse(req.body);
    return runtime.resumeTask(req.params.id, body.instruction, body.expectedVersion);
  });
  app.post<{ Params: { id: string } }>('/api/groups/:id/cards', async (req, reply) => {
    const body = z
      .object({
        botId: z.string(),
        document: z.unknown(),
        replyTo: z.string().nullable().default(null),
      })
      .strict()
      .parse(req.body);
    return reply
      .code(201)
      .send(runtime.ui.publish(req.params.id, body.botId, body.document, body.replyTo));
  });
  app.post<{ Params: { id: string } }>('/api/cards/:id/actions', async (req) => {
    const body = z
      .object({
        requestId: z.string().uuid(),
        context: z
          .object({
            threadId: z.string(),
            viewId: z.string(),
            revision: z.number().int().positive(),
          })
          .strict(),
        componentId: z.string().min(1).max(128),
        instanceId: z.string().min(1).max(2048),
        event: z.string().max(32),
        action: z.enum(['dispatch', 'submitForm']),
        params: z.record(z.string(), z.unknown()),
      })
      .strict()
      .parse(req.body);
    return runtime.ui.action(req.params.id, body as ActionEnvelope);
  });
  app.get('/events', { websocket: true }, (socket, req) => {
    if (req.headers.origin && !allowedOrigins.has(req.headers.origin)) {
      socket.close(1008, 'Origin rejected');
      return;
    }
    const timeout = setTimeout(() => socket.close(1008, 'Authentication required'), 5000);
    let authenticated = false;
    socket.on('message', (raw) => {
      if (
        (Array.isArray(raw) ? raw.reduce((n, b) => n + b.byteLength, 0) : raw.byteLength) > 4096
      ) {
        socket.close(1009);
        return;
      }
      try {
        const frame = JSON.parse(raw.toString());
        if (!authenticated) {
          if (
            frame.type !== 'auth' ||
            typeof frame.token !== 'string' ||
            !validToken(frame.token)
          ) {
            socket.close(1008, 'Unauthorized');
            return;
          }
          authenticated = true;
          clearTimeout(timeout);
          clients.add(socket);
          socket.send(JSON.stringify({ type: 'ready' }));
        }
      } catch {
        socket.close(1008, 'Invalid frame');
      }
    });
    socket.on('close', () => {
      clearTimeout(timeout);
      clients.delete(socket);
    });
    socket.on('error', () => {
      clearTimeout(timeout);
      clients.delete(socket);
    });
  });
  app.post('/api/groups', async (req, reply) => {
    const body = groupSchema.parse(req.body),
      s = store.snapshot();
    if (body.botIds.some((id) => !s.bots.some((b) => b.id === id))) throw fail(400, 'Bot 不存在');
    const id = store.id();
    store.db.transaction(() => {
      store.db
        .prepare('INSERT INTO groups VALUES(?,?,?,?)')
        .run(id, body.name, body.description, new Date().toISOString());
      for (const botId of new Set(body.botIds))
        store.db.prepare('INSERT INTO group_bots VALUES(?,?)').run(id, botId);
    })();
    broadcast();
    return reply.code(201).send({ id });
  });
  app.patch('/api/groups/:id', async (req) => {
    const { id } = req.params as { id: string };
    const body = groupSchema.parse(req.body),
      s = store.snapshot();
    if (!s.groups.some((g) => g.id === id)) throw fail(404, '群组不存在');
    if (s.groups.find((g) => g.id === id)?.directBotId) throw fail(409, '单独聊天不能修改成员');
    if (body.botIds.some((b) => !s.bots.some((x) => x.id === b))) throw fail(400, 'Bot 不存在');
    store.db.transaction(() => {
      store.db
        .prepare('UPDATE groups SET name=?,description=? WHERE id=?')
        .run(body.name, body.description, id);
      store.db.prepare('DELETE FROM group_bots WHERE group_id=?').run(id);
      for (const botId of new Set(body.botIds))
        store.db.prepare('INSERT INTO group_bots VALUES(?,?)').run(id, botId);
    })();
    broadcast();
    return { id };
  });
  app.delete<{ Params: { id: string } }>('/api/groups/:id', async (req) => {
    const result = removeGroup(store, req.params.id);
    broadcast();
    return result;
  });
  app.post('/api/bots', async (req, reply) => {
    const body = botSchema.extend({ bridgeId: z.string().min(1).optional() }).parse(req.body),
      s = store.snapshot();
    if (s.bots.some((b) => b.name.toLowerCase() === body.name.toLowerCase()))
      throw fail(409, 'Bot 名称已被使用');
    const bridgeId = runtime.creationBridge(body.provider, body.bridgeId);
    const id = store.id();
    store.db.transaction(() => {
      store.db
        .prepare('INSERT INTO bots VALUES(?,?,?,?,?,?,?,?)')
        .run(
          id,
          'user_local',
          body.name,
          body.description,
          body.provider,
          bridgeId ? 'idle' : 'offline',
          bridgeId,
          new Date().toISOString(),
        );
      if (body.avatar)
        store.db
          .prepare('INSERT INTO bot_avatars VALUES(?,?,?)')
          .run(id, body.avatar.type, body.avatar.value);
    })();
    broadcast();
    return reply.code(201).send({ id });
  });
  app.patch<{ Params: { id: string } }>('/api/bots/:id/avatar', async (req) => {
    const { avatar } = botAvatarUpdateSchema.parse(req.body);
    if (!store.db.prepare('SELECT id FROM bots WHERE id=?').get(req.params.id))
      throw fail(404, 'Bot 不存在');
    if (avatar)
      store.db
        .prepare(
          'INSERT INTO bot_avatars VALUES(?,?,?) ON CONFLICT(bot_id) DO UPDATE SET type=excluded.type,value=excluded.value',
        )
        .run(req.params.id, avatar.type, avatar.value);
    else store.db.prepare('DELETE FROM bot_avatars WHERE bot_id=?').run(req.params.id);
    broadcast();
    return { ok: true };
  });
  app.delete('/api/bots/:id', async (req) => {
    const { id } = req.params as { id: string };
    const bot = store.snapshot().bots.find((b) => b.id === id);
    if (!bot) throw fail(404, 'Bot 不存在');
    // Keep the durable identity and message attribution; removal is intentionally unsupported in stage 1.
    throw fail(409, '暂不支持删除 Bot，可将其移出群组。');
  });
  app.post<{ Params: { id: string } }>('/api/bots/:id/chat', async (req, reply) => {
    z.object({})
      .strict()
      .parse(req.body ?? {});
    const s = store.snapshot();
    const bot = s.bots.find((b) => b.id === req.params.id);
    if (!bot) throw fail(404, 'Bot 不存在');
    const existing = s.groups.find((g) => g.directBotId === bot.id);
    if (existing) return { id: existing.id };
    const id = store.id();
    store.db.transaction(() => {
      store.db
        .prepare('INSERT INTO groups VALUES(?,?,?,?)')
        .run(id, bot.name, `与 ${bot.name} 的单独聊天`, new Date().toISOString());
      store.db.prepare('INSERT INTO group_bots VALUES(?,?)').run(id, bot.id);
      store.db.prepare('INSERT INTO direct_chats VALUES(?,?)').run(id, bot.id);
    })();
    broadcast();
    return reply.code(201).send({ id });
  });
  app.post('/api/messages', async (req, reply) => {
    const body = messageSchema.parse(req.body),
      s = store.snapshot();
    const existing = s.messages.find((m) => m.id === body.id);
    if (existing) {
      if (
        existing.senderId !== s.user.id ||
        existing.groupId !== body.groupId ||
        existing.content !== body.content ||
        existing.replyTo !== body.replyTo
      )
        throw fail(409, '消息 ID 冲突');
      return existing;
    }
    const group = s.groups.find((g) => g.id === body.groupId);
    if (!group) throw fail(404, '群组不存在');
    if (body.replyTo && !s.messages.some((m) => m.id === body.replyTo && m.groupId === group.id))
      throw fail(400, '回复消息不属于当前群组');
    const mentions = resolveMentions(body.content, s.bots);
    if (mentions.some((id) => !group.botIds.includes(id)))
      throw fail(400, '提及的 Bot 尚未加入群组');
    if (body.mentions.some((id) => !mentions.includes(id))) throw fail(400, '提及与消息内容不一致');
    const message: Message = {
      id: body.id,
      groupId: group.id,
      senderId: s.user.id,
      senderType: 'human',
      content: body.content,
      mentions,
      replyTo: body.replyTo,
      timestamp: new Date().toISOString(),
      messageType: 'text',
      correlationId: store.id(),
    };
    store.db.transaction(() => {
      store.insertMessage(message);
      runtime.accept(message);
    })();
    broadcast();
    return reply.code(201).send(message);
  });
  app.post('/api/chains/:id/stop', async (req) => {
    runtime.stop((req.params as { id: string }).id);
    return { ok: true };
  });
  app.post('/api/approvals/:id', async (req) => {
    const { decision } = z.object({ decision: z.enum(['accept', 'decline']) }).parse(req.body);
    runtime.approve((req.params as { id: string }).id, decision);
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/api/native-requests/:id/reply', async (req) =>
    runtime.native.reply(req.params.id, nativeReplySchema.parse(req.body)),
  );
  app.patch('/api/bots/:id/execution', async (req) => {
    const body = botSchema
      .pick({ provider: true })
      .extend({ bridgeId: z.string().min(1).optional() })
      .strict()
      .parse(req.body);
    runtime.configureExecution((req.params as { id: string }).id, body.provider, body.bridgeId);
    return { ok: true };
  });
  app.post('/api/bots/:id/bind', async (req) => {
    const body = z
      .object({ bridgeId: z.string().min(1) })
      .strict()
      .parse(req.body);
    runtime.bind((req.params as { id: string }).id, body.bridgeId);
    return { ok: true };
  });
  app.get('/bridge', { websocket: true }, (socket, req) => {
    if (req.headers.origin) {
      socket.close(1008, 'Bridge must use a native client');
      return;
    }
    const hello = z.object({
      type: z.literal('hello'),
      token: z.string().max(512),
      id: z.string().uuid(),
      name: z.string().min(1).max(80),
      providers: z
        .array(
          z.object({
            provider: z.enum(['codex', 'claude-code']),
            version: z.string().max(80),
            available: z.boolean(),
            reason: z.string().max(200).optional(),
            autoMode: z.boolean().optional(),
            autoModeReason: z.string().max(200).optional(),
          }),
        )
        .max(8),
    });
    const eventSchema = z.object({
      type: z.enum([
        'session',
        'progress',
        'result',
        'approval',
        'activity',
        'started',
        'interaction',
        'interaction_resolved',
        'interaction_rejected',
        'heartbeat',
        'report',
      ]),
      taskId: z.string().uuid(),
      leaseId: z.string().uuid(),
      threadId: z.string().max(512).optional(),
      text: z.string().max(64000).optional(),
      report: z.string().max(4000).optional(),
      reportKind: z.enum(['progress', 'milestone', 'blocked']).optional(),
      status: z.enum(['completed', 'failed', 'cancelled']).optional(),
      error: z.string().max(1000).optional(),
      requestId: z.string().max(512).optional(),
      request: nativeRequestSchema.optional(),
      kind: z.enum(['command', 'file']).optional(),
      detail: z
        .object({
          command: z.string().max(8000).optional(),
          cwd: z.string().max(4096).optional(),
          reason: z.string().max(2000).optional(),
        })
        .optional(),
    });
    let bridgeId: string | undefined;
    let seen = Date.now();
    const authTimeout = setTimeout(() => socket.close(1008, 'Authentication required'), 5000);
    const heartbeat = setInterval(() => {
      if (Date.now() - seen > 20000) socket.terminate();
      else socket.ping();
    }, 5000);
    socket.on('pong', () => {
      seen = Date.now();
    });
    socket.on('message', (raw) => {
      try {
        const frame = JSON.parse(raw.toString());
        if (!bridgeId) {
          const info = hello.parse(frame);
          if (!options.bridgeToken || !validToken(info.token, options.bridgeToken)) {
            socket.close(1008, 'Unauthorized');
            return;
          }
          runtime.attach(
            { id: info.id, name: info.name, providers: info.providers },
            (command) => {
              if (socket.readyState !== 1) throw new Error('Bridge disconnected');
              socket.send(JSON.stringify(command));
            },
            () => socket.terminate(),
          );
          bridgeId = info.id;
          clearTimeout(authTimeout);
          socket.send(JSON.stringify({ type: 'ready' }));
        } else runtime.event(bridgeId, eventSchema.parse(frame));
      } catch {
        socket.close(1008, 'Invalid bridge frame or duplicate identity');
      }
    });
    socket.on('close', () => {
      clearTimeout(authTimeout);
      clearInterval(heartbeat);
      if (bridgeId) runtime.detach(bridgeId);
    });
    socket.on('error', () => socket.terminate());
  });
  app.addHook('onClose', async () => {
    await runtime.close();
    for (const ws of clients) ws.close(1001);
    store.db.close();
  });
  return { app, store, runtime };
}
