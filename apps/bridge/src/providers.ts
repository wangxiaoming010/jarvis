import { execFile } from 'node:child_process';
import type { BridgeInfo, Provider } from '@openbot/shared';
import { agentEnvironment } from './codex.js';
import { codexAvailability } from './codex-availability.js';
import { codexAutoMode } from './auto-mode.js';

export async function discoverProviders(
  env: NodeJS.ProcessEnv = process.env,
  options: { commandTimeoutMs?: number } = {},
) {
  const executables: Record<Provider, string> = {
    codex: env.OPENBOT_CODEX_PATH ?? 'codex',
    'claude-code': env.OPENBOT_CLAUDE_PATH ?? 'claude',
  };
  // Never block the event loop while the other provider is answering its handshake.
  const run = (provider: Provider, args: string[]) =>
    new Promise<{ stdout: string; ok: boolean; code?: string; timedOut: boolean }>((resolve) => {
      execFile(
        executables[provider],
        args,
        {
          encoding: 'utf8',
          timeout: options.commandTimeoutMs ?? 10000,
          killSignal: 'SIGKILL',
          maxBuffer: 262144,
          env: agentEnvironment(env),
        },
        (error, stdout) =>
          resolve({
            stdout,
            ok: !error,
            code: typeof error?.code === 'string' ? error.code : undefined,
            timedOut: error?.killed === true && error.signal === 'SIGKILL',
          }),
      );
    });
  const providers: BridgeInfo['providers'] = await Promise.all(
    (['codex', 'claude-code'] as const).map(async (provider) => {
      const name = provider === 'codex' ? 'Codex CLI' : 'Claude Code';
      const version = await run(provider, ['--version']);
      if (!version.ok)
        return {
          provider,
          version: version.code === 'ENOENT' ? 'not installed' : 'unknown',
          available: false,
          reason:
            version.code === 'ENOENT'
              ? `本机需安装 ${name}，并完成账号登录`
              : version.timedOut
                ? `${name} 版本检查超时，请检查本地 CLI 是否能正常启动`
                : version.code === 'EACCES' || version.code === 'EPERM'
                  ? `无法执行 ${name}，请检查本地 CLI 路径和文件执行权限`
                  : `${name} 版本检查失败，请检查本地 CLI 路径及安装是否完整`,
        };
      const versionText = version.stdout.trim().slice(0, 80);
      if (provider === 'codex') {
        const [availability, autoMode] = await Promise.all([
          codexAvailability(executables.codex, env),
          codexAutoMode(executables.codex, agentEnvironment(env)),
        ]);
        return {
          provider,
          version: versionText,
          ...availability,
          autoMode,
          ...(!autoMode
            ? {
                autoModeReason:
                  '当前 Codex CLI 不支持或无法验证自动审批，将逐次确认；可更新 CLI 后重启',
              }
            : {}),
        };
      }
      const auth = await run(provider, ['auth', 'status']);
      if (auth.timedOut)
        return {
          provider,
          version: versionText,
          available: false,
          reason: 'Claude Code 账号状态检查超时，请检查本地 CLI 是否能正常启动',
        };
      let authenticated = auth.ok;
      try {
        authenticated = authenticated && JSON.parse(auth.stdout).loggedIn === true;
      } catch {
        authenticated = false;
      }
      const help = await run(provider, ['--help']);
      if (help.timedOut)
        return {
          provider,
          version: versionText,
          available: false,
          reason: 'Claude Code 接口检查超时，请检查本地 CLI 是否能正常启动',
        };
      if (
        !help.ok ||
        ![
          '--restricted',
          '--safe-mode',
          '--permission-prompts',
          '--system-prompt-snapshot',
          '--replay-user-messages',
        ].every((flag) => help.stdout.includes(flag))
      )
        return {
          provider,
          version: versionText,
          available: false,
          reason: '请更新 Claude Code，当前版本不支持所需的受限执行接口',
        };
      return {
        provider,
        version: versionText,
        available: authenticated,
        autoMode: /--permission-mode\b[\s\S]*?["']auto["']/.test(help.stdout),
        ...(!/--permission-mode\b[\s\S]*?["']auto["']/.test(help.stdout)
          ? {
              autoModeReason:
                '当前 Claude Code 未报告 Auto 模式支持，将逐次确认；可更新 CLI 后重启',
            }
          : {}),
        ...(!authenticated ? { reason: 'Claude Code 尚未完成本机账号登录' } : {}),
      };
    }),
  );
  return { executables, providers };
}
