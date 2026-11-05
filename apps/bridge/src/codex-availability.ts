import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { agentEnvironment } from './codex.js';

type Availability = { available: boolean; reason?: string };

/** Ask the configured provider whether it requires OpenAI authentication.
 * `codex login status` only describes OpenAI login, not custom-provider readiness.
 * This handshake never starts a thread, invokes a model, or reads credentials.
 */
export function codexAvailability(
  executable: string,
  env: NodeJS.ProcessEnv,
  timeouts: number | { initializeMs?: number; accountMs?: number } = {},
): Promise<Availability> {
  return new Promise((resolve) => {
    // Stdio is the default transport, including on CLIs without the --stdio alias.
    const child = spawn(executable, ['app-server'], {
      cwd: homedir(),
      env: agentEnvironment(env),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let outcome: Availability | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let phase: 'initialize' | 'account' = 'initialize';
    const initializeMs = typeof timeouts === 'number' ? timeouts : (timeouts.initializeMs ?? 30000);
    const accountMs = typeof timeouts === 'number' ? timeouts : (timeouts.accountMs ?? 10000);
    let timer = setTimeout(() => timedOut(), initializeMs);
    function timedOut() {
      finish({
        available: false,
        reason:
          phase === 'initialize'
            ? 'Codex 启动握手超时，请检查本地 CLI 及其配置'
            : 'Codex 已启动，但读取账号状态超时，请检查本地 CLI 的账号配置',
      });
    }
    function finish(result: Availability) {
      if (outcome) return;
      outcome = result;
      clearTimeout(timer);
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
    }
    function send(message: unknown) {
      if (!child.stdin.destroyed) child.stdin.write(JSON.stringify(message) + '\n');
    }
    child.stderr.resume();
    child.stdin.on('error', () => finish({ available: false, reason: 'Codex 配置检查连接已关闭' }));
    child.once('error', () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve({ available: false, reason: '无法启动 Codex，请检查本地 CLI 路径' });
    });
    child.once('close', () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve(outcome ?? { available: false, reason: 'Codex 配置检查未返回完整结果' });
    });
    createInterface({ input: child.stdout }).on('line', (line) => {
      if (outcome) return;
      try {
        if (line.length > 1_000_000) throw new Error('Oversized frame');
        const message = JSON.parse(line);
        if (message.method && message.id !== undefined) {
          send({ id: message.id, error: { code: -32601, message: 'Read-only provider probe' } });
          return;
        }
        if (message.id !== 1 && message.id !== 2) return;
        if (message.id !== (phase === 'initialize' ? 1 : 2)) return;
        if (message.error) {
          finish({ available: false, reason: '无法检查 Codex 原生认证配置，请检查或更新 CLI' });
          return;
        }
        if (message.id === 1) {
          phase = 'account';
          clearTimeout(timer);
          timer = setTimeout(() => timedOut(), accountMs);
          send({ method: 'initialized', params: {} });
          send({ id: 2, method: 'account/read', params: { refreshToken: false } });
          return;
        }
        const account = message.result;
        if (
          account?.requiresOpenaiAuth === false ||
          (account?.requiresOpenaiAuth === true && account.account)
        )
          finish({ available: true });
        else if (account?.requiresOpenaiAuth === true)
          finish({
            available: false,
            reason: '当前 Codex Provider 需要 OpenAI 登录',
          });
        else finish({ available: false, reason: 'Codex 未返回有效的认证配置，请检查或更新 CLI' });
      } catch {
        finish({ available: false, reason: 'Codex 返回了无效的配置检查数据' });
      }
    });
    send({
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'openbot_provider_check', version: '1.0.0' },
        capabilities: { experimentalApi: true },
      },
    });
  });
}
