import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type { BridgeCommand, AgentJob } from '@openbot/shared';
import { CodexExecution } from './codex.js';
import { ClaudeExecution } from './claude.js';
import { discoverProviders } from './providers.js';
import type { AgentExecution, AgentCallbacks } from './execution.js';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const state = process.env.OPENBOT_DATA_DIR ?? resolve(root, '.data');
mkdirSync(state, { recursive: true });
const identityPath = resolve(state, 'bridge-id');
const id = existsSync(identityPath) ? readFileSync(identityPath, 'utf8').trim() : randomUUID();
if (!existsSync(identityPath)) writeFileSync(identityPath, id, { mode: 0o600, flag: 'wx' });
const token =
  process.env.OPENBOT_BRIDGE_TOKEN ?? readFileSync(resolve(state, 'bridge-token'), 'utf8').trim();
const server = new URL(process.env.OPENBOT_SERVER_URL ?? 'http://127.0.0.1:4310');
if (
  !['http:', 'https:'].includes(server.protocol) ||
  (server.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(server.hostname))
)
  throw new Error('Bridge 只允许本地 HTTP 或远程 HTTPS');
server.pathname = '/bridge';
server.protocol = server.protocol === 'https:' ? 'wss:' : 'ws:';
const { executables, providers } = await discoverProviders();
const taskTimeoutMs = Number(process.env.OPENBOT_TASK_TIMEOUT_MS ?? 0);
if (!Number.isInteger(taskTimeoutMs) || taskTimeoutMs < 0 || taskTimeoutMs > 86400000)
  throw new Error('OPENBOT_TASK_TIMEOUT_MS 必须为 0 至 86400000；0 表示不限制总时长');
let socket: WebSocket | undefined;
let stopped = false;
let reconnect: ReturnType<typeof setTimeout> | undefined;
let delay = 500;
const active = new Map<
  string,
  { job: AgentJob; execution: AgentExecution; promise: Promise<void> }
>();
function send(frame: unknown) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
}
async function execute(job: AgentJob) {
  if (active.has(job.task.id)) {
    send({
      type: 'result',
      taskId: job.task.id,
      leaseId: job.leaseId,
      status: 'failed',
      error: '这项工作的前一次本地执行尚未结束',
      text: '',
    });
    return;
  }
  try {
    if (!providers.some((p) => p.provider === job.bot.provider && p.available))
      throw new Error('Provider 未安装或未登录');
  } catch {
    send({
      type: 'result',
      taskId: job.task.id,
      leaseId: job.leaseId,
      status: 'failed',
      error: '本地 Provider 不可用，请检查设备连接与原生配置',
      text: '',
    });
    return;
  }
  const base = { taskId: job.task.id, leaseId: job.leaseId };
  const callbacks: AgentCallbacks = {
    session: (threadId) => send({ type: 'session', ...base, threadId }),
    progress: (text) => send({ type: 'progress', ...base, text }),
    activity: (text, report) => send({ type: 'activity', ...base, text, report }),
    report: (kind, summary) => send({ type: 'report', ...base, reportKind: kind, report: summary }),
    started: () => send({ type: 'started', ...base }),
    approval: (requestId, kind, detail) =>
      send({ type: 'approval', ...base, requestId, kind, detail }),
    interaction: (requestId, request) => send({ type: 'interaction', ...base, requestId, request }),
    interactionResolved: (requestId) => send({ type: 'interaction_resolved', ...base, requestId }),
  };
  const Adapter = job.bot.provider === 'claude-code' ? ClaudeExecution : CodexExecution;
  const execution: AgentExecution = new Adapter(executables[job.bot.provider], job, callbacks, {
    timeoutMs: taskTimeoutMs,
    autoModeSupported:
      providers.find((provider) => provider.provider === job.bot.provider)?.autoMode === true,
  });
  const heartbeat = setInterval(() => send({ type: 'heartbeat', ...base }), 15000);
  heartbeat.unref();
  const promise = Promise.resolve()
    .then(async () => {
      const result = await execution.run();
      send({ type: 'result', ...base, ...result });
    })
    .catch(() =>
      send({ type: 'result', ...base, status: 'failed', error: '本地执行器异常', text: '' }),
    )
    .finally(() => {
      clearInterval(heartbeat);
      active.delete(job.task.id);
    });
  active.set(job.task.id, { job, execution, promise });
  await promise;
}
function connect() {
  if (stopped) return;
  socket = new WebSocket(server);
  const current = socket;
  current.on('open', () =>
    current.send(JSON.stringify({ type: 'hello', token, id, name: '本机 Bridge', providers })),
  );
  current.on('message', (raw) => {
    try {
      const frame = JSON.parse(raw.toString()) as BridgeCommand;
      if (frame.type === 'ready') {
        delay = 500;
        console.log(
          `OpenBot Bridge connected. ${providers.map((p) => `${p.provider}: ${p.available ? 'available' : 'unavailable'}`).join('; ')}.`,
        );
      } else if (frame.type === 'run') void execute(frame.job);
      else if (
        frame.type === 'cancel' ||
        frame.type === 'approval' ||
        frame.type === 'native_reply'
      ) {
        const running = [...active.values()].find(
          (v) => v.job.task.id === frame.taskId && v.job.leaseId === frame.leaseId,
        );
        if (running) {
          if (frame.type === 'cancel') void running.execution.cancel();
          else if (frame.type === 'native_reply') {
            if (!running.execution.respond?.(frame.requestId, frame.response))
              send({
                type: 'interaction_rejected',
                taskId: frame.taskId,
                leaseId: frame.leaseId,
                requestId: frame.requestId,
              });
          } else running.execution.approve?.(frame.requestId, frame.decision);
        } else if (frame.type === 'native_reply')
          send({
            type: 'interaction_rejected',
            taskId: frame.taskId,
            leaseId: frame.leaseId,
            requestId: frame.requestId,
          });
      }
    } catch {
      current.close(1008, 'Invalid server frame');
    }
  });
  current.on('error', () => {});
  current.on('close', async (code) => {
    for (const running of active.values()) void running.execution.cancel();
    await Promise.allSettled([...active.values()].map((v) => v.promise));
    if (stopped) return;
    if (code === 1008) {
      console.error('Bridge 认证或协议校验失败，请检查本地绑定令牌与版本。');
      stopped = true;
      return;
    }
    reconnect = setTimeout(connect, delay);
    delay = Math.min(delay * 2, 10000);
  });
}
connect();
async function stop() {
  if (stopped) return;
  stopped = true;
  clearTimeout(reconnect);
  for (const running of active.values()) void running.execution.cancel();
  await Promise.allSettled([...active.values()].map((v) => v.promise));
  socket?.close(1000);
  setTimeout(() => process.exit(0), 100).unref();
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void stop());

if (process.env.OPENBOT_PARENT_MANAGED === 'true') {
  process.stdin.resume();
  process.stdin.on('end', () => {
    if (stopped) process.exit(0);
    else void stop();
  });
}
