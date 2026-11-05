import { spawn } from 'node:child_process';
import { readFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
if (existsSync(new URL('../.env', import.meta.url)))
  process.loadEnvFile(new URL('../.env', import.meta.url));
const testing = process.argv.includes('--test');
const native = process.argv.includes('--native');
const directory = testing ? await mkdtemp(join(tmpdir(), 'openbot-e2e-')) : null;
const serverPort = testing ? 4311 : Number(process.env.PORT ?? 4310);
const clientPort = testing ? 1421 : Number(process.env.CLIENT_PORT ?? 1420);
const serviceUrl = `http://127.0.0.1:${serverPort}`;
const accessToken = testing ? randomBytes(32).toString('hex') : process.env.OPENBOT_TOKEN;
const env = {
  ...process.env,
  PORT: String(serverPort),
  CLIENT_PORT: String(clientPort),
  CLIENT_ORIGIN: `http://127.0.0.1:${clientPort}`,
  VITE_SERVER_URL: serviceUrl,
  ...(accessToken ? { OPENBOT_TOKEN: accessToken } : {}),
  ...(directory
    ? {
        DATABASE_PATH: join(directory, 'openbot.sqlite'),
        BRAIN_ENABLED: 'false',
        DEEPSEEK_API_KEY: '',
        OPENBOT_BRIDGE_TOKEN: randomBytes(32).toString('hex'),
      }
    : {}),
};
const children = [];
let closing = false;
function launch(args, extraEnv = {}) {
  const child = spawn('npm', args, {
    cwd: root,
    stdio: 'inherit',
    detached: process.platform !== 'win32',
    env: { ...env, ...extraEnv },
  });
  children.push(child);
  child.on('exit', (code) => {
    void stop(code ?? 0);
  });
  return child;
}
async function stop(code = 0) {
  if (closing) return;
  closing = true;
  for (const c of children) {
    try {
      if (process.platform === 'win32') c.kill('SIGTERM');
      else if (c.pid) process.kill(-c.pid, 'SIGTERM');
    } catch {}
  }
  setTimeout(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
    process.exit(code);
  }, 700);
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void stop());
// Never silently attach to a different process already listening on our service port.
let occupied = false;
try {
  await fetch(`${serviceUrl}/health`, { signal: AbortSignal.timeout(500) });
  occupied = true;
} catch {}
if (occupied) {
  console.error(`${serviceUrl} 已被占用，请停止已有服务，或设置另一个 PORT。`);
  await stop(1);
} else {
  // Desktop tasks must not be interrupted when server source files change.
  launch(['run', native ? 'start' : 'dev', '-w', '@openbot/server']);
  let ready = false;
  for (let attempt = 0; attempt < 80 && !closing; attempt++) {
    try {
      const r = await fetch(`${serviceUrl}/health`);
      if (r.ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!ready) {
    if (!closing) {
      console.error('本地服务启动失败');
      await stop(1);
    }
  } else if (!closing) {
    // A fresh source checkout has no bundled runtime. Tauri still resolves this
    // resource directory in development; the source server above owns execution.
    if (native)
      await mkdir(new URL('../apps/desktop/src-tauri/runtime/', import.meta.url), {
        recursive: true,
      });
    const token =
      accessToken ??
      (await readFile(new URL('../.data/client-token', import.meta.url), 'utf8')).trim();
    if (!testing && process.env.OPENBOT_BRIDGE_AUTOSTART !== 'false')
      launch(['run', 'start', '-w', '@openbot/bridge'], {
        OPENBOT_SERVER_URL: serviceUrl,
        DEEPSEEK_API_KEY: '',
      });
    launch(
      native
        ? ['run', 'tauri', '-w', '@openbot/desktop', '--', 'dev']
        : ['run', 'dev', '-w', '@openbot/desktop'],
      {
        PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}`,
        VITE_OPENBOT_TOKEN: token,
        DEEPSEEK_API_KEY: '',
        OPENBOT_BRIDGE_TOKEN: '',
      },
    );
  }
}
