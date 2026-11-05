import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeEnvironment } from '../../apps/bridge/src/claude-environment';

const directories: string[] = [];
function config(settings?: unknown) {
  const directory = mkdtempSync(join(tmpdir(), 'openbot-claude-auth-'));
  directories.push(directory);
  if (settings !== undefined)
    writeFileSync(join(directory, 'settings.json'), JSON.stringify(settings));
  return directory;
}
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

it('preserves configured provider authentication without importing executable customizations or platform credentials', () => {
  const directory = config({
    apiKeyHelper: 'must-never-run',
    hooks: { startup: 'must-never-run' },
    env: {
      ANTHROPIC_AUTH_TOKEN: 'fixture-token',
      ANTHROPIC_BASE_URL: 'https://provider.invalid',
      ANTHROPIC_MODEL: 'fixture-model',
      NODE_OPTIONS: '--require unsafe-hook',
      DEEPSEEK_API_KEY: 'must-not-pass',
    },
  });
  const env = claudeEnvironment(
    { PATH: '/usr/bin', OPENBOT_TOKEN: 'must-not-pass', DEEPSEEK_API_KEY: 'must-not-pass' },
    directory,
  );
  expect(env).toEqual({
    PATH: '/usr/bin',
    ANTHROPIC_AUTH_TOKEN: 'fixture-token',
    ANTHROPIC_BASE_URL: 'https://provider.invalid',
    ANTHROPIC_MODEL: 'fixture-model',
  });
});

it('keeps explicit process authentication ahead of user settings', () => {
  const directory = config({
    env: { ANTHROPIC_AUTH_TOKEN: 'settings-token', ANTHROPIC_MODEL: 'settings-model' },
  });
  expect(
    claudeEnvironment({ ANTHROPIC_AUTH_TOKEN: 'process-token', ANTHROPIC_MODEL: '' }, directory),
  ).toMatchObject({ ANTHROPIC_AUTH_TOKEN: 'process-token', ANTHROPIC_MODEL: '' });
});

it('supports native login without a settings file and never exposes malformed credential contents', () => {
  const directory = config();
  expect(claudeEnvironment({ PATH: '/usr/bin' }, directory)).toEqual({ PATH: '/usr/bin' });
  writeFileSync(join(directory, 'settings.json'), '{ malformed-private-token');
  expect(() => claudeEnvironment({}, directory)).toThrow('无法读取 Claude 认证配置');
  try {
    claudeEnvironment({}, directory);
  } catch (error) {
    expect(String(error)).not.toContain('malformed-private-token');
  }
});
