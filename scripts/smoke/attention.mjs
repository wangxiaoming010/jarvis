// Opt-in semantic checks against the configured model; never writes real chat or task data.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { readBrainConfig } from '../../apps/server/src/config.ts';
import { ModelSettings } from '../../apps/server/src/models/model-settings.ts';
import { createAttentionModel } from '../../apps/server/src/models/attention-model.ts';

if (!process.argv.includes('--live'))
  throw new Error('请传入 --live，使用已配置的注意力模型进行真实判断验证');
if (existsSync('.env')) process.loadEnvFile('.env');
const settings = new ModelSettings(
  resolve(process.env.DATABASE_PATH ?? '.data/openbot.sqlite'),
  readBrainConfig(),
);
const config = settings.current();
const attention = createAttentionModel({ ...config, model: config.attentionModel || config.model });
if (!attention) throw new Error('请先配置模型');
const members = [
  { id: 'bb', name: 'BB', role: '互联网产品经理' },
  { id: 'dev', name: 'DEV', role: '万能资深开发' },
];
const actor = (id) => ({
  id,
  type: id === 'owner' ? 'human' : 'bot',
  name: id === 'owner' ? '我' : id.toUpperCase(),
});
const message = (id, sender, content) => ({
  id,
  actor: actor(sender),
  content,
  replyTo: null,
  mentions: [],
});
const cases = [
  { content: '大家好', prior: '我们刚加入这个群。', expected: [true, true], social: true },
  { content: '各位早上好', prior: '今天开始讨论。', expected: [true, true], social: true },
  { content: 'BB你好', prior: '我们刚加入这个群。', expected: [true, false], social: true },
  { content: '谢谢大家', prior: '问题已经解决。', expected: [true, true], social: true },
  { content: '你好！', sender: 'bb', prior: '大家好', expected: [false, false], social: true },
  { content: 'BB继续吧', prior: '我会继续调研竞品。', expected: [true, false] },
  {
    content: 'A',
    prior: '方案 A 先做用户访谈，方案 B 直接做原型，你选哪个？',
    expected: [true, false],
  },
  {
    content: '你有互联网搜索能力，相信自己',
    prior: '我暂时没有互联网搜索能力，无法查询竞品。',
    expected: [true, false],
  },
  { content: '查了吗', prior: '我来调研竞品并核实信息。', expected: [true, false] },
  { content: '？', prior: '我来调研竞品并核实信息。', expected: [true, false] },
  { content: '所有人都记住，我叫小林', prior: '我来调研竞品。', expected: [true, true] },
  { content: '得先琢磨琢磨', prior: '你先考虑产品方向，确定后再继续。', expected: [false, false] },
];
const selectedCases = process.argv.includes('--social-only')
  ? cases.filter((c) => c.social)
  : process.argv.includes('--work-only')
    ? cases.filter((c) => !c.social)
    : cases;
let failures = 0;
let checked = 0;
for (const item of selectedCases) {
  const current = message('current', item.sender ?? 'owner', item.content);
  const decisions = await Promise.all(
    members.map(async (bot) => {
      const input = {
        bot,
        group: { id: 'isolated-semantic-fixture', name: '测试场景', members },
        message: current,
        replyTarget: null,
        recentMessages: [
          message('request', 'owner', 'BB，帮我调研竞品'),
          message('previous', 'bb', item.prior),
          current,
        ],
        tasks: [{ id: 'research', ownerBotId: 'bb', goal: '竞品调研', status: 'running' }],
      };
      try {
        return (await attention(input, AbortSignal.timeout(20000))).wake;
      } catch (error) {
        return {
          error: /^(?:注意力模型|请在设置|模型服务请求失败)/.test(error.message)
            ? error.message.slice(0, 200)
            : '模型连接或响应失败',
        };
      }
    }),
  );
  const passed = decisions.every((value, i) => value === item.expected[i]);
  checked++;
  if (!passed) failures++;
  console.log(
    JSON.stringify({ content: item.content, expected: item.expected, actual: decisions, passed }),
  );
  if (decisions.some((value) => typeof value !== 'boolean')) break;
}
console.log(JSON.stringify({ cases: selectedCases.length, checked, failures }));
if (failures) process.exitCode = 1;
