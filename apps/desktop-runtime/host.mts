import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, openSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startLocalService } from '../server/src/local-service.js';

const resources = dirname(fileURLToPath(import.meta.url));
const directory = process.env.OPENBOT_DATA_DIR;
if (!directory) throw new Error('缺少本地数据位置');
const configuration = join(directory, 'config.env');
if (existsSync(configuration)) process.loadEnvFile(configuration);
process.env.OPENBOT_MIGRATIONS_DIR = join(resources, 'migrations');
process.env.OPENBOT_UI_CONTRACT_DIR = join(resources, 'ui-contract');
const bins = [
  join(resources, 'bin'),
  ...(process.env.PATH ?? '').split(delimiter),
  join(homedir(), '.local/bin'),
  join(homedir(), '.npm-global/bin'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
];
process.env.PATH = [...new Set(bins.filter(Boolean))].join(delimiter);
if (process.platform === 'darwin' && !process.env.OPENBOT_CODEX_PATH) {
  const candidates = [
    '/Applications/Codex.app/Contents/Resources/codex',
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
  ];
  // Prefer an explicitly installed CLI in PATH, then an app's bundled CLI.
  if (!bins.some((bin) => existsSync(join(bin, 'codex'))))
    process.env.OPENBOT_CODEX_PATH = candidates.find((path) => existsSync(path));
}
const service = await startLocalService(directory);
let bridge: ChildProcess | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let stopping = false;
let retries = 0;
const log = openSync(join(directory, 'bridge.log'), 'a', 0o600);
function launchBridge() {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OPENBOT_SERVER_URL: service.connection.url,
    OPENBOT_BRIDGE_TOKEN: service.bridgeToken,
    OPENBOT_DATA_DIR: directory,
    OPENBOT_PARENT_MANAGED: 'true',
  };
  for (const key of Object.keys(env))
    if (/^(DEEPSEEK_|BRAIN_|VITE_|OPENBOT_TOKEN$)/.test(key)) delete env[key];
  bridge = spawn(process.execPath, [join(resources, 'bridge.mjs')], {
    cwd: directory,
    env,
    stdio: ['pipe', log, log],
  });
  const started = Date.now();
  bridge.on('error', () => {});
  bridge.on('exit', () => {
    if (stopping) return;
    retries = Date.now() - started > 30000 ? 0 : retries + 1;
    timer = setTimeout(launchBridge, Math.min(1000 * 2 ** Math.min(retries, 5), 30000));
  });
}
if (process.env.OPENBOT_DESKTOP_BRIDGE !== 'false') launchBridge();
// This line is consumed by native IPC, never shown in the UI or written to a log.
process.stdout.write(JSON.stringify(service.connection) + '\n');
async function stop() {
  if (stopping) return;
  stopping = true;
  clearTimeout(timer);
  const timeout = setTimeout(() => process.exit(1), 7000);
  if (bridge && bridge.exitCode === null && bridge.signalCode === null) {
    const child = bridge;
    await new Promise<void>((resolve) => {
      const force = setTimeout(() => child.kill('SIGKILL'), 4500);
      child.once('exit', () => {
        clearTimeout(force);
        resolve();
      });
      child.kill('SIGTERM');
    });
  }
  await service.close();
  closeSync(log);
  clearTimeout(timeout);
  process.exit(0);
}
process.stdin.resume();
process.stdin.on('end', () => void stop());
process.stdin.on('data', () => void stop());
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => void stop());
