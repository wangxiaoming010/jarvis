import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import type { AgentJob, NativeReply, NativeRequestSpec } from '@openbot/shared';
import { codexRequest, codexReply } from './native.js';
import { buildTurnInput } from './prompt.js';
import { botInstructions } from './instructions.js';
import { executionPolicy } from './auto-mode.js';
import type { AgentCallbacks, AgentResult } from './execution.js';
export type { AgentResult } from './execution.js';
type Rpc = {
  id?: string | number;
  method?: string;
  params?: Record<string, any>;
  result?: any;
  error?: { code?: number; message?: string };
};
export function agentEnvironment(source: NodeJS.ProcessEnv = process.env) {
  const env = { ...source };
  for (const key of Object.keys(env))
    if (/^(BRAIN_|DEEPSEEK_|OPENBOT_|VITE_OPENBOT_|CODEX_THREAD_ID$)/.test(key)) delete env[key];
  return env;
}
export class CodexExecution {
  private process?: ChildProcessWithoutNullStreams;
  private nextId = 0;
  private pending = new Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private approvals = new Map<string, string | number>();
  private interactions = new Map<
    string,
    { id: string | number; method: string; params: Record<string, any>; spec: NativeRequestSpec }
  >();
  private toolItems = new Map<string, Record<string, any>>();
  private threadId?: string;
  private turnId?: string;
  private cancelled = false;
  private disposed = false;
  private completed?: (result: AgentResult) => void;
  private output = new Map<string, { text: string; phase?: string }>();
  private progressTimer?: ReturnType<typeof setTimeout>;
  private exitPromise?: Promise<void>;
  private interruptTimer?: ReturnType<typeof setTimeout>;
  private activeItems = new Map<string, string>();
  constructor(
    private executable: string,
    private job: AgentJob,
    private callbacks: AgentCallbacks,
    private options: { timeoutMs?: number; autoModeSupported?: boolean } = {},
  ) {}
  private send(message: Rpc) {
    if (!this.process || this.process.stdin.destroyed) throw new Error('Codex 连接已关闭');
    this.process.stdin.write(JSON.stringify(message) + '\n');
  }
  private request(method: string, params: Record<string, unknown> = {}) {
    return new Promise<any>((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} 请求超时`));
      }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  private finalText() {
    const values = [...this.output.values()];
    const finals = values.filter((v) => v.phase === 'final_answer');
    return (finals.length ? finals : values.filter((v) => v.phase !== 'commentary'))
      .map((v) => v.text)
      .join('\n\n')
      .slice(0, 64000);
  }
  private progress() {
    if (!this.progressTimer)
      this.progressTimer = setTimeout(() => {
        this.progressTimer = undefined;
        this.callbacks.progress(
          [...this.output.values()]
            .map((v) => v.text)
            .join('\n\n')
            .slice(0, 64000),
        );
      }, 250);
  }
  private receive(message: Rpc) {
    if (message.method && message.id !== undefined) {
      const params = message.params ?? {};
      if (this.callbacks.interaction && !this.cancelled) {
        try {
          if (params.threadId !== this.threadId || (this.turnId && params.turnId !== this.turnId))
            throw new Error('原生请求不属于当前执行');
          const item = this.toolItems.get(params.itemId) ?? {};
          const spec = codexRequest(message.method, {
            ...params,
            command: params.command ?? item.command,
            cwd: params.cwd ?? item.cwd,
            changes: item.changes,
          });
          if (spec) {
            if (this.job.resourceMode === 'read' && spec.kind !== 'question') {
              this.send({
                id: message.id,
                result: codexReply(message.method, params, spec, { decision: 'decline' }),
              });
              return;
            }
            const key = String(message.id);
            if (this.interactions.has(key)) return;
            this.interactions.set(key, {
              id: message.id,
              method: message.method,
              params: structuredClone(params),
              spec,
            });
            this.callbacks.interaction(key, spec);
            return;
          }
        } catch {
          this.send({
            id: message.id,
            error: { code: -32602, message: 'Unsupported or invalid native request' },
          });
          return;
        }
      }
      const kind =
        message.method === 'item/commandExecution/requestApproval'
          ? 'command'
          : message.method === 'item/fileChange/requestApproval'
            ? 'file'
            : null;
      if (kind && !this.cancelled) {
        if (this.job.resourceMode === 'read') {
          this.send({ id: message.id, result: { decision: 'decline' } });
          return;
        }
        const key = String(message.id);
        this.approvals.set(key, message.id);
        this.callbacks.approval(key, kind, {
          ...(typeof params.command === 'string' ? { command: params.command.slice(0, 8000) } : {}),
          ...(typeof params.cwd === 'string' ? { cwd: params.cwd.slice(0, 4096) } : {}),
          ...(typeof params.reason === 'string' ? { reason: params.reason.slice(0, 2000) } : {}),
        });
      } else
        this.send({
          id: message.id,
          error: {
            code: -32601,
            message: 'This interaction is not supported or the task was cancelled.',
          },
        });
      return;
    }
    if (message.id !== undefined) {
      const id = Number(message.id),
        pending = this.pending.get(id);
      if (pending) {
        this.pending.delete(id);
        clearTimeout(pending.timer);
        if (message.error)
          pending.reject(
            new Error(
              (message.error.message ?? 'Codex 请求失败')
                .replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]')
                .slice(0, 700),
            ),
          );
        else pending.resolve(message.result);
      }
      return;
    }
    const p = message.params ?? {};
    if (p.threadId && this.threadId && p.threadId !== this.threadId) return;
    if (message.method === 'serverRequest/resolved') {
      const key = String(p.requestId);
      this.interactions.delete(key);
      this.approvals.delete(key);
      this.callbacks.interactionResolved?.(key);
      return;
    }
    if (message.method === 'item/agentMessage/delta') {
      const id = p.itemId ?? 'answer';
      const previous = this.output.get(id) ?? { text: '' };
      previous.text = (previous.text + (p.delta ?? '')).slice(0, 64000);
      this.output.set(id, previous);
      this.progress();
    }
    if (message.method === 'item/started' || message.method === 'item/completed') {
      const item = p.item;
      if (item?.id && ['commandExecution', 'fileChange'].includes(item.type))
        this.toolItems.set(item.id, item);
      if (item?.type === 'agentMessage') {
        const previous = this.output.get(item.id) ?? { text: '' };
        this.output.set(item.id, {
          text: typeof item.text === 'string' ? item.text.slice(0, 64000) : previous.text,
          phase: item.phase ?? previous.phase,
        });
        if (
          message.method === 'item/completed' &&
          item.phase === 'commentary' &&
          typeof item.text === 'string'
        )
          this.callbacks.activity?.(
            [...this.activeItems.values()].join('；') || '执行者正在处理任务',
            item.text.slice(-4000),
          );
      }
      const ended = message.method === 'item/completed';
      if (item?.id && ['commandExecution', 'fileChange'].includes(item.type)) {
        if (ended) this.activeItems.delete(item.id);
        else
          this.activeItems.set(
            item.id,
            item.type === 'commandExecution' ? '正在运行本地命令' : '正在处理文件变更',
          );
      }
      if (item?.type === 'commandExecution')
        this.callbacks.activity?.(
          this.activeItems.size
            ? [...this.activeItems.values()].join('；')
            : ended
              ? `本地命令已结束${typeof item.exitCode === 'number' ? `，退出码 ${item.exitCode}` : ''}`
              : '正在运行本地命令',
        );
      if (item?.type === 'fileChange')
        this.callbacks.activity?.(
          this.activeItems.size
            ? [...this.activeItems.values()].join('；')
            : ended
              ? '文件操作已返回结果'
              : '正在处理文件变更',
        );
      this.progress();
    }
    if (message.method === 'turn/completed') {
      for (const key of this.interactions.keys()) this.callbacks.interactionResolved?.(key);
      this.interactions.clear();
      const turn = p.turn;
      const status =
        turn?.status === 'completed'
          ? 'completed'
          : turn?.status === 'interrupted'
            ? 'cancelled'
            : 'failed';
      this.completed?.({
        status,
        text: this.finalText(),
        ...(status === 'failed'
          ? {
              error:
                'Codex 执行失败：' +
                String(turn?.error?.message ?? '请检查本地授权和模型配置')
                  .replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]')
                  .slice(0, 700),
            }
          : {}),
      });
    }
  }
  async run(): Promise<AgentResult> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const execution = executionPolicy(this.job, this.options.autoModeSupported);
      if (execution.reason) this.callbacks.activity?.(execution.reason);
      this.process = spawn(this.executable, ['app-server'], {
        cwd: homedir(),
        env: agentEnvironment(),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.exitPromise = new Promise((resolve) => {
        this.process!.once('error', () => {
          this.completed?.({
            status: this.cancelled ? 'cancelled' : 'failed',
            text: this.finalText(),
            error: '无法启动 Codex，请检查可执行文件路径',
          });
          for (const p of this.pending.values()) {
            clearTimeout(p.timer);
            p.reject(new Error('无法启动 Codex'));
          }
          this.pending.clear();
          resolve();
        });
        this.process!.once('exit', (code) => {
          for (const p of this.pending.values()) {
            clearTimeout(p.timer);
            p.reject(new Error('Codex 进程已退出'));
          }
          this.pending.clear();
          this.completed?.({
            status: this.cancelled ? 'cancelled' : 'failed',
            text: this.finalText(),
            error: `Codex 进程已退出（${code ?? 'signal'}）`,
          });
          resolve();
        });
      });
      this.process.stdin.on('error', () => {});
      this.process.stderr.resume();
      const lines = createInterface({ input: this.process.stdout });
      lines.on('line', (line) => {
        if (line.length > 1_000_000) {
          void this.cancel();
          return;
        }
        try {
          this.receive(JSON.parse(line));
        } catch {
          this.completed?.({
            status: 'failed',
            text: this.finalText(),
            error: 'Codex 返回了无效协议数据',
          });
        }
      });
      await this.request('initialize', {
        capabilities: { experimentalApi: true },
        clientInfo: {
          name: 'openbot_local_bridge',
          title: 'OpenBot Local Bridge',
          version: '1.0.0',
        },
      });
      this.send({ method: 'initialized', params: {} });
      if (this.cancelled) return { status: 'cancelled', text: '' };
      const policy = {
        sandbox: execution.automatic ? 'workspace-write' : 'read-only',
        approvalPolicy: 'on-request',
        approvalsReviewer: execution.automatic ? 'auto_review' : 'user',
      };
      const result = await this.request(this.job.session ? 'thread/resume' : 'thread/start', {
        ...policy,
        config: { web_search: 'live' },
        developerInstructions: botInstructions(this.job),
        ...(execution.directory ? { cwd: execution.directory } : {}),
        ...(this.job.session ? { threadId: this.job.session.threadId, excludeTurns: true } : {}),
      });
      if (this.job.session && result.thread.id !== this.job.session.threadId)
        throw new Error('原会话未能正确恢复，未向其他会话发送要求');
      this.threadId = result.thread.id;
      this.callbacks.session(this.threadId!);
      if (this.cancelled) return { status: 'cancelled', text: '' };
      const finished = new Promise<AgentResult>((resolve) => {
        this.completed = resolve;
      });
      const text = buildTurnInput(this.job);
      const started = await this.request('turn/start', {
        threadId: this.threadId,
        input: [{ type: 'text', text }],
        ...(execution.directory ? { cwd: execution.directory } : {}),
        approvalPolicy: 'on-request',
        approvalsReviewer: policy.approvalsReviewer,
        // Override persisted policy when resuming an older auto session in manual/read mode.
        sandboxPolicy: execution.automatic
          ? { type: 'workspaceWrite', writableRoots: [execution.directory!], networkAccess: false }
          : { type: 'readOnly' },
      });
      this.turnId = started.turn.id;
      this.callbacks.started?.();
      if (this.cancelled) void this.cancel();
      let timedOut = false;
      if (this.options.timeoutMs && this.options.timeoutMs > 0)
        timeout = setTimeout(() => {
          timedOut = true;
          void this.cancel();
        }, this.options.timeoutMs);
      const outcome = await finished;
      return timedOut && outcome.status !== 'completed'
        ? {
            ...outcome,
            status: 'failed',
            error: '处理超过了配置的时间限制，被自动中断，尚未完成。',
          }
        : outcome;
    } catch (error) {
      return {
        status: this.cancelled ? 'cancelled' : 'failed',
        text: this.finalText(),
        error: error instanceof Error ? error.message.slice(0, 1000) : 'Codex 执行失败',
      };
    } finally {
      clearTimeout(timeout);
      await this.dispose();
    }
  }
  approve(requestId: string, decision: 'accept' | 'decline') {
    const id = this.approvals.get(requestId);
    if (id === undefined || this.cancelled) return;
    this.approvals.delete(requestId);
    this.send({ id, result: { decision } });
  }
  respond(requestId: string, response: NativeReply) {
    const request = this.interactions.get(requestId);
    if (!request || this.cancelled) return false;
    const result = codexReply(request.method, request.params, request.spec, response);
    this.send({ id: request.id, result });
    this.interactions.delete(requestId);
    return true;
  }
  async cancel() {
    this.cancelled = true;
    for (const [key, request] of this.interactions) {
      try {
        this.send({
          id: request.id,
          result: codexReply(request.method, request.params, request.spec, { decision: 'decline' }),
        });
      } catch {}
      this.callbacks.interactionResolved?.(key);
    }
    this.interactions.clear();
    // Arm the fallback before sending RPC: a stalled interrupt response must not stall cancellation.
    if (!this.interruptTimer)
      this.interruptTimer = setTimeout(() => {
        this.completed?.({ status: 'cancelled', text: this.finalText() });
        void this.dispose();
      }, 3000);
    for (const [key, id] of this.approvals) {
      try {
        this.send({ id, result: { decision: 'cancel' } });
      } catch {}
      this.approvals.delete(key);
    }
    if (this.threadId && this.turnId) {
      void this.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }).catch(
        () => {},
      );
    } else {
      this.process?.kill('SIGTERM');
    }
  }
  async dispose() {
    if (this.disposed) return this.exitPromise;
    this.disposed = true;
    clearTimeout(this.progressTimer);
    clearTimeout(this.interruptTimer);
    this.process?.kill('SIGTERM');
    if (this.exitPromise) {
      const kill = setTimeout(() => this.process?.kill('SIGKILL'), 2000);
      await this.exitPromise;
      clearTimeout(kill);
    }
  }
}
