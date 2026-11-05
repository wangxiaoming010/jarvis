// No model calls: verify the shipped runtime outside the repository with no system Node in PATH.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const temporary = await mkdtemp(join(tmpdir(), 'openbot-shipped-'));
const runtime = join(temporary, 'runtime');
const data = join(temporary, 'data');
let host;
let output = '';
async function start() {
  const child = spawn(
    join(runtime, 'bin', process.platform === 'win32' ? 'node.exe' : 'node'),
    [join(runtime, 'host.mjs')],
    {
      cwd: temporary,
      env: {
        ...process.env,
        PATH: process.platform === 'win32' ? process.env.SystemRoot : '/usr/bin:/bin',
        NODE_OPTIONS: '',
        NODE_PATH: '',
        BRAIN_ENABLED: 'false',
        DEEPSEEK_API_KEY: '',
        OPENBOT_DATA_DIR: data,
        OPENBOT_CODEX_PATH: join(temporary, 'no-codex'),
        OPENBOT_CLAUDE_PATH: join(temporary, 'no-claude'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  host = child;
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  const connection = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Embedded startup timeout')), 15000);
    createInterface({ input: child.stdout }).once('line', (line) => {
      clearTimeout(timer);
      resolve(JSON.parse(line));
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Embedded host exited ${code}: ${output}`));
    });
  });
  return connection;
}
async function stop() {
  if (!host || host.exitCode !== null) return;
  const child = host;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.stdin.end();
  const force = setTimeout(() => child.kill('SIGKILL'), 10000);
  const code = await exited;
  clearTimeout(force);
  assert.equal(code, 0, 'Host must close cleanly on parent EOF');
  host = undefined;
}
try {
  await cp(
    process.env.OPENBOT_RUNTIME_DIR ??
      fileURLToPath(new URL('../../apps/desktop/src-tauri/runtime', import.meta.url)),
    runtime,
    { recursive: true },
  );
  let connection = await start();
  const api = async (path, body) => {
    const response = await fetch(connection.url + path, {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${connection.token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    assert(response.ok, `API ${path} failed: ${response.status}`);
    return response.json();
  };
  let snapshot;
  for (let attempt = 0; attempt < 50; attempt++) {
    snapshot = await api('/api/snapshot');
    if (snapshot.bridges.length) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(snapshot.bridges.length, 1, 'Embedded Bridge must connect automatically');
  assert(snapshot.bridges[0].providers.every((provider) => !provider.available));
  const bot = await api('/api/bots', { name: 'EmbeddedBot', provider: 'codex' });
  const chat = await api(`/api/bots/${bot.id}/chat`, {});
  await api('/api/messages', {
    id: crypto.randomUUID(),
    groupId: chat.id,
    content: 'Persistent embedded message',
  });
  const original = connection;
  await stop();
  await assert.rejects(
    fetch(original.url + '/health'),
    'Closing the host must stop its HTTP service',
  );
  connection = await start();
  assert.deepEqual(
    connection,
    original,
    'Reopen must keep stable local connection and credentials',
  );
  snapshot = await api('/api/snapshot');
  assert.equal(snapshot.bots[0].id, bot.id);
  assert(snapshot.messages.some((message) => message.content === 'Persistent embedded message'));
  assert(!output.includes(connection.token), 'Credentials must never enter diagnostics');
  const lock = JSON.parse(await readFile(join(data, 'local-connection.json'), 'utf8'));
  assert.equal(lock.url, connection.url);
  await stop();
  console.log(
    'Embedded package verified: independent startup, automatic Bridge, private credentials, durable chat, clean exit and reopen.',
  );
} finally {
  if (host) {
    host.stdin.end();
    host.kill('SIGTERM');
  }
  await rm(temporary, { recursive: true, force: true });
}
