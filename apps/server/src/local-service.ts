import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createApp } from './app.js';
import { readBrainConfig, readWorkerLimits } from './config.js';

export interface LocalConnection {
  url: string;
  token: string;
}

function credential(directory: string, name: string) {
  const path = join(directory, name);
  if (!existsSync(path))
    writeFileSync(path, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
  chmodSync(path, 0o600);
  const token = readFileSync(path, 'utf8').trim();
  if (token.length < 24) throw new Error('本地连接凭据无效');
  return token;
}

export async function startLocalService(directory: string, env: NodeJS.ProcessEnv = process.env) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lockPath = join(directory, 'desktop.lock');
  let lock: number;
  try {
    lock = openSync(lockPath, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const owner = Number(readFileSync(lockPath, 'utf8'));
    if (!Number.isInteger(owner) || owner <= 0) throw new Error('本地服务锁无效，请重新打开应用');
    try {
      process.kill(owner, 0);
      throw new Error('OpenBot 已在运行，请使用已打开的窗口');
    } catch (check) {
      if ((check as NodeJS.ErrnoException).code !== 'ESRCH') throw check;
    }
    rmSync(lockPath);
    lock = openSync(lockPath, 'wx', 0o600);
  }
  writeFileSync(lock, String(process.pid));
  const release = () => {
    closeSync(lock);
    rmSync(lockPath, { force: true });
  };
  let instance: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    const token = credential(directory, 'client-token');
    const bridgeToken = credential(directory, 'bridge-token');
    const brain = readBrainConfig(env);
    const maxRounds = Number(env.OPENBOT_MAX_ROUNDS ?? 6);
    if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 20)
      throw new Error('协作轮次配置无效');
    instance = await createApp({
      databasePath: join(directory, 'openbot.sqlite'),
      token,
      bridgeToken,
      modelConfig: brain,
      workerLimits: readWorkerLimits(env),
      maxRounds,
    });
    const connectionPath = join(directory, 'local-connection.json');
    let port = 0;
    try {
      const previous = JSON.parse(readFileSync(connectionPath, 'utf8')) as LocalConnection;
      const url = new URL(previous.url);
      if (url.protocol === 'http:' && url.hostname === '127.0.0.1') port = Number(url.port);
    } catch {
      /* First launch uses an available loopback port. */
    }
    try {
      await instance.app.listen({ host: '127.0.0.1', port });
    } catch (error) {
      if (!port || (error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
      await instance.app.listen({ host: '127.0.0.1', port: 0 });
    }
    const address = instance.app.server.address();
    if (!address || typeof address === 'string') throw new Error('本地服务启动失败');
    const connection = { url: `http://127.0.0.1:${address.port}`, token };
    writeFileSync(connectionPath, JSON.stringify(connection), { mode: 0o600 });
    chmodSync(connectionPath, 0o600);
    let closing = false;
    return {
      connection,
      bridgeToken,
      instance,
      async close() {
        if (closing) return;
        closing = true;
        try {
          await instance!.app.close();
        } finally {
          release();
        }
      },
    };
  } catch (error) {
    try {
      await instance?.app.close();
    } finally {
      release();
    }
    throw error;
  }
}
