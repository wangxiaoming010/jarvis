import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ExecutionPermissionMode } from '@openbot/shared';

export const executionSettingsSchema = z.object({ mode: z.enum(['auto', 'manual']) }).strict();

/** Owner settings are separate from chat data and apply at the next dispatch. */
export class ExecutionSettings {
  private path: string;
  mode: ExecutionPermissionMode = 'auto';
  constructor(databasePath: string) {
    this.path = join(dirname(databasePath), 'execution-settings.json');
    if (existsSync(this.path)) {
      try {
        this.mode = executionSettingsSchema.parse(JSON.parse(readFileSync(this.path, 'utf8'))).mode;
      } catch {
        throw new Error('本地执行权限设置无法读取，请检查配置文件');
      }
    }
  }
  save(mode: ExecutionPermissionMode) {
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify({ mode }), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, this.path);
    this.mode = mode;
  }
}
