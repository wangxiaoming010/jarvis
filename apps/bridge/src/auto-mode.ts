import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { realpathSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, parse } from 'node:path';
import type { AgentJob } from '@openbot/shared';

/** Inspect the local protocol schema without starting a session or a model. */
export async function codexAutoMode(executable: string, env: NodeJS.ProcessEnv) {
  const directory = await mkdtemp(join(tmpdir(), 'openbot-codex-capabilities-'));
  try {
    await new Promise<void>((resolve, reject) => {
      execFile(
        executable,
        ['app-server', 'generate-json-schema', '--experimental', '--out', directory],
        { env, timeout: 10000, killSignal: 'SIGKILL', maxBuffer: 262144 },
        (error) => (error ? reject(error) : resolve()),
      );
    });
    const schema = JSON.parse(
      await readFile(join(directory, 'v2', 'ThreadStartParams.json'), 'utf8'),
    );
    return (
      schema.properties?.approvalsReviewer !== undefined &&
      schema.definitions?.ApprovalsReviewer?.enum?.includes('auto_review') === true
    );
  } catch {
    return false;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Never silently make the user's home or filesystem root a writable workspace. */
export function executionPolicy(job: AgentJob, autoModeSupported = false) {
  const path = job.task.execution?.workspace?.path ?? job.executionDirectory;
  let directory: string | undefined;
  if (path) {
    if (!isAbsolute(path)) throw new Error('任务目录必须是完整路径');
    try {
      directory = realpathSync(path);
      if (!statSync(directory).isDirectory()) throw new Error('not a directory');
    } catch {
      throw new Error('任务目录已不可用，请确认目录后重新执行');
    }
  }
  const scoped =
    directory && directory !== parse(directory).root && directory !== realpathSync(homedir());
  const automatic =
    job.permissionMode === 'auto' && autoModeSupported && !!scoped && job.resourceMode !== 'read';
  const reason =
    job.permissionMode !== 'auto' || job.resourceMode === 'read'
      ? undefined
      : !autoModeSupported
        ? '当前执行工具不支持自动模式，本次改为逐次确认'
        : !scoped
          ? '本次任务尚未明确工作目录，暂按逐次确认执行'
          : undefined;
  return { automatic, directory, reason };
}
