import { test as base, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../apps/server/src/app';
import type { BrainConfig } from '../../apps/server/src/config';
import type { CoordinatorModel } from '../../apps/server/src/models/coordinator-model';

export const testModelConfig: BrainConfig = {
  provider: 'openai',
  baseUrl: 'https://example.invalid/v1',
  apiKey: 'isolated-browser-model-key',
  model: 'browser-test-model',
  enabled: true,
};

// Execution UI tests use a deterministic conversation model after setup.
export const executionModel: CoordinatorModel = async (messages) => {
  const { event } = JSON.parse(messages[1].content!);
  if (event.kind === 'completion') {
    if (messages.at(-1)?.role === 'tool')
      return { role: 'assistant', content: event.facts.resultPreview ?? '' };
    if (event.facts.status !== 'reviewing') return { role: 'assistant', content: '' };
    return {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: randomUUID(),
          type: 'function',
          function: {
            name: 'finish_task',
            arguments: JSON.stringify({
              taskId: event.taskId,
              verification: '已收到原生执行的回复。',
              evidence: [
                {
                  criterion: '原生执行返回回复',
                  source: 'result',
                  quote: event.facts.resultPreview,
                },
              ],
            }),
          },
        },
      ],
    };
  }
  if (messages.at(-1)?.role === 'tool') return { role: 'assistant', content: '' };
  if (event.kind !== 'message') return { role: 'assistant', content: '' };
  return {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: randomUUID(),
        type: 'function',
        function: {
          name: 'start_worker',
          arguments: JSON.stringify({
            goal: event.message.content,
            criteria: ['原生执行返回回复'],
          }),
        },
      },
    ],
  };
};

export const test = base.extend<{ workspace: { url: string; token: string } }>({
  workspace: [
    async ({ context }, use) => {
      const directory = mkdtempSync(join(tmpdir(), 'openbot-configured-browser-'));
      const token = randomUUID();
      const instance = await createApp({
        databasePath: join(directory, 'db.sqlite'),
        token,
        clientOrigin: 'http://127.0.0.1:1421',
        modelConfig: testModelConfig,
        attention: async () => ({ wake: false }),
        coordinator: async () => ({
          role: 'assistant',
          content: '暂时连不上本地，等连接恢复后再试',
        }),
      });
      try {
        await instance.app.listen({ host: '127.0.0.1', port: 0 });
        const url = `http://127.0.0.1:${(instance.app.server.address() as { port: number }).port}`;
        await context.addInitScript(
          ({ url, token }) => {
            localStorage.setItem('openbot.server', url);
            sessionStorage.setItem('openbot.token', token);
          },
          { url, token },
        );
        await use({ url, token });
      } finally {
        await instance.app.close();
        rmSync(directory, { recursive: true, force: true });
      }
    },
    { auto: true },
  ],
});

export { expect };
