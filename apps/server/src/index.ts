import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { readBrainConfig, readWorkerLimits } from './config.js';
const root = fileURLToPath(new URL('../../../', import.meta.url));
if (existsSync(resolve(root, '.env'))) process.loadEnvFile(resolve(root, '.env'));
const brain = readBrainConfig();
const databasePath = resolve(root, process.env.DATABASE_PATH ?? '.data/openbot.sqlite');
mkdirSync(dirname(databasePath), { recursive: true });
const tokenPath = resolve(root, '.data/client-token');
mkdirSync(dirname(tokenPath), { recursive: true });
let token = process.env.OPENBOT_TOKEN;
if (!token) {
  token = existsSync(tokenPath)
    ? readFileSync(tokenPath, 'utf8').trim()
    : randomBytes(32).toString('hex');
  writeFileSync(tokenPath, token, { mode: 0o600 });
}
if (token.length < 24) throw new Error('OPENBOT_TOKEN 至少需要 24 个字符');
const bridgeTokenPath = resolve(root, '.data/bridge-token');
const bridgeToken =
  process.env.OPENBOT_BRIDGE_TOKEN ??
  (existsSync(bridgeTokenPath)
    ? readFileSync(bridgeTokenPath, 'utf8').trim()
    : randomBytes(32).toString('hex'));
if (bridgeToken.length < 24) throw new Error('OPENBOT_BRIDGE_TOKEN 至少需要24个字符');
if (!process.env.OPENBOT_BRIDGE_TOKEN) writeFileSync(bridgeTokenPath, bridgeToken, { mode: 0o600 });
const maxRounds = Number(process.env.OPENBOT_MAX_ROUNDS ?? 6);
if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 20)
  throw new Error('OPENBOT_MAX_ROUNDS 必须为1至20');
const host = process.env.HOST ?? '127.0.0.1';
if (!['127.0.0.1', 'localhost', '::1'].includes(host))
  throw new Error('本地参考服务仅允许绑定 loopback 地址');
const { app } = await createApp({
  databasePath,
  bridgeToken,
  modelConfig: brain,
  workerLimits: readWorkerLimits(),
  maxRounds,
  token,
  logger: true,
  clientOrigin: process.env.CLIENT_ORIGIN,
});
await app.listen({ host, port: Number(process.env.PORT ?? 4310) });
console.log(`OpenBot local service ready. Token file: ${tokenPath}`);
console.log(
  brain.enabled
    ? `Bot 对话模型已配置：${brain.provider} / ${brain.model}（独立协调已启用）`
    : 'Bot 对话模型未启用：未填写 DEEPSEEK_API_KEY 或 BRAIN_ENABLED=false',
);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
