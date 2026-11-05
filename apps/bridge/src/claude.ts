import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { parse } from 'node:path';
import type { AgentJob, NativeReply, NativeRequestSpec } from '@openbot/shared';
import { claudeRequest, checkedReply } from './native.js';
import type { AgentCallbacks, AgentExecution, AgentResult } from './execution.js';
import { claudeEnvironment } from './claude-environment.js';
import { botInstructions } from './instructions.js';
import { buildTurnInput } from './prompt.js';
import { executionPolicy } from './auto-mode.js';

const safeError = (text: string) => text.replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 700);

/** One persisted Claude session per job; privileged tools wait for a host response. */
export class ClaudeExecution implements AgentExecution {
  private process?: ChildProcessWithoutNullStreams;
  private sessionId: string;
  private inputId = randomUUID();
  private cancelled = false;
  private initialized = false;
  private started = false;
  private exited = false;
  private exitPromise?: Promise<void>;
  private finish?: (result: AgentResult) => void;
  private messages = new Map<string, string>();
  private messageId = '';
  private progressTimer?: ReturnType<typeof setTimeout>;
  private terminateTimer?: ReturnType<typeof setTimeout>;
  private killTimer?: ReturnType<typeof setTimeout>;
  private interactions = new Map<
    string,
    { tool: string; input: Record<string, any>; spec: NativeRequestSpec }
  >();
  constructor(
    private executable: string,
    private job: AgentJob,
    private callbacks: AgentCallbacks,
    private options: { timeoutMs?: number; autoModeSupported?: boolean } = {},
  ) {
    this.sessionId = job.session?.threadId ?? randomUUID();
  }
  private text() {
    return [...this.messages.values()].join('\n\n').slice(0, 64000);
  }
  private signal(signal: NodeJS.Signals) {
    if (!this.process?.pid || this.exited) return;
    try {
      if (process.platform === 'win32') this.process.kill(signal);
      else process.kill(-this.process.pid, signal);
    } catch {}
  }
  private progress() {
    if (!this.progressTimer)
      this.progressTimer = setTimeout(() => {
        this.progressTimer = undefined;
        this.callbacks.progress(this.text());
      }, 250);
  }
  private acknowledge(frame: Record<string, any>) {
    if (
      !this.started &&
      this.initialized &&
      (frame.user_message_uuid === this.inputId ||
        frame.user_message_uuids?.includes(this.inputId) ||
        (frame.type === 'user' &&
          frame.uuid === this.inputId &&
          !frame.message?.content?.some?.((b: any) => b.type === 'tool_result')))
    ) {
      this.started = true;
      this.callbacks.started?.();
    }
  }
  private receive(frame: Record<string, any>) {
    // Subagent events are never treated as the owning bot's messages or results.
    if (frame.parent_tool_use_id) return;
    if (frame.session_id && frame.session_id !== this.sessionId)
      throw new Error('Claude 原会话未能正确恢复，未接受其他会话的输出');
    if (frame.type === 'system' && frame.subtype === 'init') {
      if (frame.session_id !== this.sessionId) throw new Error('Claude 未确认原会话');
      this.initialized = true;
      this.callbacks.session(this.sessionId);
      this.callbacks.activity?.('Claude 已连接，正在处理');
    }
    this.acknowledge(frame);
    if (frame.type === 'stream_event') {
      const event = frame.event;
      if (event?.type === 'message_start') this.messageId = event.message?.id ?? randomUUID();
      if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        this.messages.set(
          this.messageId,
          ((this.messages.get(this.messageId) ?? '') + event.delta.text).slice(0, 64000),
        );
        this.progress();
      }
    }
    if (frame.type === 'assistant' && Array.isArray(frame.message?.content)) {
      const blocks = frame.message.content as Record<string, any>[];
      const text = blocks
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('\n');
      this.messages.set(frame.message.id ?? this.messageId, text.slice(0, 64000));
      const tools = blocks.filter((b) => b.type === 'tool_use');
      if (tools.length)
        this.callbacks.activity?.(
          tools
            .map((t) =>
              t.name === 'Read'
                ? '正在读取文件'
                : t.name === 'Glob'
                  ? '正在查找文件'
                  : t.name === 'WebSearch'
                    ? '正在联网搜索'
                    : t.name === 'WebFetch'
                      ? '正在读取网页'
                      : t.name === 'Grep'
                        ? '正在搜索代码'
                        : '正在处理工具调用',
            )
            .join('；'),
          text ? text.slice(-4000) : undefined,
        );
      else if (text) this.callbacks.activity?.('Claude 正在整理答复', text.slice(-4000));
      this.progress();
    }
    if (frame.type === 'system' && frame.subtype === 'permission_denied')
      this.callbacks.activity?.('这项操作超出了当前只读范围');
    if (frame.type === 'control_request') {
      const request = frame.request,
        id = frame.request_id;
      if (
        !this.initialized ||
        typeof id !== 'string' ||
        request?.subtype !== 'can_use_tool' ||
        ![
          'Read',
          'Glob',
          'Grep',
          'WebSearch',
          'WebFetch',
          'Bash',
          'Edit',
          'Write',
          'AskUserQuestion',
        ].includes(request.tool_name) ||
        !this.callbacks.interaction ||
        this.cancelled
      ) {
        this.controlReply(id, { behavior: 'deny', message: '这项原生交互不可用或执行已停止。' });
        return;
      }
      if (this.interactions.has(id)) return;
      if (
        this.job.resourceMode === 'read' &&
        !['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'AskUserQuestion'].includes(
          request.tool_name,
        )
      ) {
        this.controlReply(id, {
          behavior: 'deny',
          message: '本次工作仅允许读取和提问，需要修改时应由 Bot 另行安排独占执行。',
        });
        return;
      }
      const input = structuredClone(request.input ?? {}),
        spec = claudeRequest(request.tool_name, input, request.decision_reason);
      this.interactions.set(id, { tool: request.tool_name, input, spec });
      this.callbacks.interaction(id, spec);
      this.callbacks.activity?.(spec.kind === 'question' ? '等待你的回答' : '等待你确认权限');
    }
    if (frame.type === 'control_cancel_request') {
      this.interactions.delete(frame.request_id);
      this.callbacks.interactionResolved?.(frame.request_id);
    }
    if (frame.type === 'result') {
      if (!this.initialized || frame.session_id !== this.sessionId)
        throw new Error('Claude 未确认本次执行会话');
      const success =
        frame.subtype === 'success' && frame.is_error === false && typeof frame.result === 'string';
      this.finish?.({
        status: success ? 'completed' : this.cancelled ? 'cancelled' : 'failed',
        text: typeof frame.result === 'string' ? frame.result.slice(0, 64000) : '',
        ...(!success && !this.cancelled
          ? {
              error:
                'Claude 执行失败：' +
                safeError(
                  Array.isArray(frame.errors)
                    ? frame.errors.join('；')
                    : String(frame.result || frame.subtype || '请检查本地登录与模型配置'),
                ),
            }
          : {}),
      });
      this.process?.stdin.end();
      for (const id of this.interactions.keys()) this.callbacks.interactionResolved?.(id);
      this.interactions.clear();
    }
  }
  async run(): Promise<AgentResult> {
    if (this.cancelled) return { status: 'cancelled', text: '' };
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const finished = new Promise<AgentResult>((resolve) => {
      this.finish = resolve;
    });
    try {
      const execution = executionPolicy(this.job, this.options.autoModeSupported);
      if (execution.reason) this.callbacks.activity?.(execution.reason);
      const args = [
        '-p',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--verbose',
        '--include-partial-messages',
        '--replay-user-messages',
        '--restricted',
        '--safe-mode',
        // Resource paths come from the conversation; the launch location is not a file boundary.
        // Manual permissions below still require approval for each command and write.
        ...(!execution.automatic ? ['--add-dir', parse(homedir()).root] : []),
        '--strict-mcp-config',
        '--mcp-config',
        '{"mcpServers":{}}',
        '--tools',
        this.job.resourceMode === 'read'
          ? 'Read,Glob,Grep,WebSearch,WebFetch,AskUserQuestion'
          : 'Read,Glob,Grep,WebSearch,WebFetch,Bash,Edit,Write,AskUserQuestion',
        '--allowedTools',
        'Read,Glob,Grep,WebSearch',
        '--permission-mode',
        execution.automatic ? 'auto' : 'manual',
        '--permission-prompts',
        'host',
        '--permission-prompt-tool',
        'stdio',
        '--settings',
        JSON.stringify({
          permissions: { ask: execution.automatic ? [] : ['Bash', 'Edit', 'Write', 'WebFetch'] },
        }),
        '--disable-slash-commands',
        '--system-prompt-snapshot',
        'off',
        '--append-system-prompt',
        botInstructions(this.job) +
          `\nOpenBot forwards your native AskUserQuestion and permission requests to the human in the group. Use AskUserQuestion for clarifying questions during work. ${execution.automatic ? 'Native auto mode reviews routine actions within the task directory. Native denials are authoritative; report the limitation and never bypass it by changing tools, encoding a command, or retrying in another mode.' : 'Bash, Edit and Write require the human to explicitly approve the exact operation before you proceed.'} Never claim a group message or a generated UI card itself granted permission. MCP, subagents and hooks remain unavailable.`,
        ...(this.job.session ? ['--resume', this.sessionId] : ['--session-id', this.sessionId]),
      ];
      const env = claudeEnvironment();
      delete env.CLAUDECODE;
      delete env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN;
      delete env.CLAUDE_CODE_FORWARD_SUBAGENT_TEXT;
      this.process = spawn(this.executable, args, {
        cwd: execution.directory ?? homedir(),
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
      this.exitPromise = new Promise((resolve) => {
        this.process!.once('error', () =>
          this.finish?.({
            status: this.cancelled ? 'cancelled' : 'failed',
            text: '',
            error: '无法启动 Claude Code，请检查可执行文件路径',
          }),
        );
        this.process!.once('close', (code) => {
          this.exited = true;
          this.finish?.({
            status: this.cancelled ? 'cancelled' : 'failed',
            text: '',
            error: this.cancelled
              ? undefined
              : `Claude 进程已退出（${code ?? 'signal'}），没有收到完整结果`,
          });
          resolve();
        });
      });
      this.process.stdin.on('error', () => {});
      this.process.stderr.resume();
      const lines = createInterface({ input: this.process.stdout });
      lines.on('line', (line) => {
        if (!line.trim()) return;
        try {
          if (line.length > 1_000_000) throw new Error('Claude 返回内容超过限制');
          this.receive(JSON.parse(line));
        } catch (error) {
          this.finish?.({
            status: 'failed',
            text: '',
            error:
              error instanceof SyntaxError ? 'Claude 返回了无效协议数据' : safeError(String(error)),
          });
        }
      });
      this.process.stdin.write(
        JSON.stringify({
          type: 'user',
          session_id: this.sessionId,
          uuid: this.inputId,
          parent_tool_use_id: null,
          message: { role: 'user', content: buildTurnInput(this.job) },
        }) + '\n',
      );
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
    } catch {
      return {
        status: this.cancelled ? 'cancelled' : 'failed',
        text: '',
        error: 'Claude 本地执行器异常',
      };
    } finally {
      clearTimeout(timeout);
      clearTimeout(this.progressTimer);
      await this.dispose();
    }
  }
  async cancel() {
    if (this.cancelled) return;
    this.cancelled = true;
    for (const id of this.interactions.keys()) {
      this.controlReply(id, { behavior: 'deny', message: '用户已停止本次执行。', interrupt: true });
      this.callbacks.interactionResolved?.(id);
    }
    this.interactions.clear();
    if (!this.process) return;
    this.signal('SIGINT');
    // Wait for real process exit before a new job can use this bot/session.
    if (!this.terminateTimer) this.terminateTimer = setTimeout(() => this.signal('SIGTERM'), 1200);
    if (!this.killTimer) this.killTimer = setTimeout(() => this.signal('SIGKILL'), 3200);
  }
  private controlReply(id: string, response: Record<string, unknown>) {
    if (this.process && !this.process.stdin.destroyed && !this.process.stdin.writableEnded) {
      this.process.stdin.write(
        JSON.stringify({
          type: 'control_response',
          response: { subtype: 'success', request_id: id, response },
        }) + '\n',
      );
      return true;
    }
    return false;
  }
  respond(id: string, raw: NativeReply) {
    const request = this.interactions.get(id);
    if (!request || this.cancelled) return false;
    const response = checkedReply(request.spec, raw);
    let delivered = false;
    if (response.decision === 'decline')
      delivered = this.controlReply(id, {
        behavior: 'deny',
        message: '用户拒绝了这次操作或暂不回答。',
      });
    else {
      const input = structuredClone(request.input);
      if (request.tool === 'AskUserQuestion')
        input.answers = Object.fromEntries(
          request.input.questions.map((q: any, i: number) => [
            q.question,
            response.answers![`question-${i}`].join(', '),
          ]),
        );
      delivered = this.controlReply(id, { behavior: 'allow', updatedInput: input });
    }
    this.interactions.delete(id);
    return delivered;
  }
  async dispose() {
    this.signal('SIGTERM');
    if (!this.killTimer) this.killTimer = setTimeout(() => this.signal('SIGKILL'), 2000);
    await this.exitPromise;
    clearTimeout(this.terminateTimer);
    clearTimeout(this.killTimer);
  }
}
