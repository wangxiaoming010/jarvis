import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { agentEnvironment } from './codex.js';

// Restricted mode ignores user settings. Preserve only the CLI's explicitly
// configured authentication/model environment; never load hooks or execute helpers.
const keys = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'CLAUDE_CODE_OAUTH_TOKEN',
] as const;

export function claudeEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  directory = source.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'),
) {
  const env = agentEnvironment(source);
  try {
    const settings = JSON.parse(readFileSync(join(directory, 'settings.json'), 'utf8'));
    for (const key of keys)
      if (env[key] === undefined && typeof settings?.env?.[key] === 'string')
        env[key] = settings.env[key];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new Error('无法读取 Claude 认证配置，请检查本地 settings.json');
  }
  return env;
}
