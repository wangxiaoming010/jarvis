import { randomUUID } from 'node:crypto';
import type { Store } from '../store.js';

type Memory = {
  id: string;
  key: string;
  content: string;
  scope: 'bot' | 'group';
  groupId: string | null;
  sourceMessageId: string | null;
  updatedAt: string;
  provenance: string;
  importance: number;
  expiresAt: string | null;
  kind: MemoryKind;
};
/** A preference is a lasting human instruction about how to work; a fact is a historical observation. */
export type MemoryKind = 'fact' | 'preference';
export type MemoryInput = {
  key: string;
  content: string;
  kind?: MemoryKind;
  scope?: 'bot' | 'group';
  provenance?: 'user' | 'inference' | 'worker';
  importance?: number;
  expiresAt?: string | null;
  replacesId?: string;
};
const visible = `bot_id=? AND state='active' AND (expires_at IS NULL OR expires_at>?) AND (scope='bot' OR group_id IN (SELECT group_id FROM group_bots WHERE bot_id=? AND (? IS NULL OR group_id=?)))`;
const select =
  'SELECT id,key,content,scope,group_id AS groupId,source_message_id AS sourceMessageId,updated_at AS updatedAt,provenance,importance,expires_at AS expiresAt,kind FROM bot_memory';
export function memoryTerms(query: string) {
  const tokens = query.toLowerCase().match(/[a-z0-9_-]{2,}|[\p{Script=Han}]+/gu) ?? [];
  return [
    ...new Set(
      tokens.flatMap((t) =>
        /\p{Script=Han}/u.test(t) && t.length > 2
          ? Array.from({ length: t.length - 1 }, (_, i) => t.slice(i, i + 2))
          : [t],
      ),
    ),
  ].slice(0, 32);
}

/** Scoped recall, explicit provenance and reversible corrections, without another database. */
export class BotMemory {
  constructor(private store: Store) {}
  recall(botId: string, groupId: string | undefined, query = '', limit = 20) {
    const rows = this.store.db
      .prepare(`${select} WHERE ${visible} ORDER BY updated_at DESC`)
      .all(botId, new Date().toISOString(), botId, groupId ?? null, groupId ?? null) as Memory[];
    const words = memoryTerms(query);
    return rows
      .map((m, i) => {
        const haystack = `${m.key} ${m.content}`.toLowerCase();
        const matches = words.reduce((n, t) => n + (haystack.includes(t) ? 1 : 0), 0);
        return { m, score: matches * 10 + m.importance * 2 + 1 / (i + 1), matches };
      })
      .filter((r) => !words.length || r.matches > 0 || r.m.importance >= 3)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.min(limit, 40))
      .map((r) => r.m);
  }
  /** Standing preferences apply in every conversation, so they bypass relevance ranking. */
  preferences(botId: string, limit = 16) {
    return this.store.db
      .prepare(
        `${select} WHERE ${visible} AND kind='preference' ORDER BY importance DESC, updated_at DESC LIMIT ?`,
      )
      .all(botId, new Date().toISOString(), botId, null, null, limit) as Memory[];
  }
  /** Curated writes come from background review and must never undo a later correction or deletion. */
  save(
    botId: string,
    groupId: string,
    sourceId: string,
    input: MemoryInput,
    options: { curated?: boolean } = {},
  ) {
    const source = this.store
      .snapshot()
      .messages.find((m) => m.id === sourceId && m.groupId === groupId);
    if (!source) throw new Error('记忆来源不可用');
    const provenance = input.provenance ?? 'inference';
    if (provenance === 'user' && source.senderType !== 'human')
      throw new Error('不能把同事或执行者的说法记成用户亲口告知');
    if (input.expiresAt && !Number.isFinite(Date.parse(input.expiresAt)))
      throw new Error('记忆有效期无效');
    const scope = input.scope ?? 'bot';
    const targetGroup = scope === 'bot' ? null : groupId;
    const key = input.key.normalize('NFKC').trim().toLowerCase();
    return this.store.db.transaction(() => {
      const old = input.replacesId
        ? (this.store.db
            .prepare(`${select} WHERE id=? AND bot_id=? AND scope=? AND group_id IS ?`)
            .get(input.replacesId, botId, scope, targetGroup) as Memory | undefined)
        : (this.store.db
            .prepare(
              `${select} WHERE bot_id=? AND scope=? AND group_id IS ? AND (key=? OR (content=? AND state='active')) ORDER BY updated_at DESC LIMIT 1`,
            )
            .get(botId, scope, targetGroup, key, input.content) as Memory | undefined);
      if (input.replacesId && !old) throw new Error('只能更正属于自己且范围相同的记忆');
      if (options.curated && old && old.updatedAt >= source.timestamp)
        throw new Error('这条记忆在来源消息之后已被更正或删除，不再自动改写');
      if (
        old?.provenance === 'user' &&
        input.provenance !== 'user' &&
        old.content !== input.content &&
        !input.replacesId
      )
        throw new Error('新推断与用户明确事实冲突，请核实后明确更正或另存推断');
      const kept =
        old && old.content === input.content && input.provenance === undefined
          ? old.provenance
          : provenance;
      const kind = input.kind ?? old?.kind ?? 'fact';
      if (kind === 'preference' && kept !== 'user') throw new Error('长期偏好只能来自用户亲口表达');
      const id = old?.id ?? randomUUID();
      if (old) {
        this.store.db
          .prepare('INSERT INTO bot_memory_revisions VALUES(?,?,?,?,?,?,?)')
          .run(
            randomUUID(),
            id,
            old.content,
            old.sourceMessageId,
            old.provenance,
            'superseded',
            new Date().toISOString(),
          );
        this.store.db
          .prepare(
            "UPDATE bot_memory SET content=?,source_message_id=?,updated_at=?,provenance=?,importance=?,expires_at=?,kind=?,state='active' WHERE id=?",
          )
          .run(
            input.content,
            sourceId,
            new Date().toISOString(),
            kept,
            input.importance ?? old.importance,
            input.expiresAt === undefined ? old.expiresAt : input.expiresAt,
            kind,
            id,
          );
      } else {
        this.store.db
          .prepare(
            'INSERT INTO bot_memory(id,bot_id,group_id,scope,key,content,source_message_id,updated_at,provenance,importance,expires_at,kind) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
          )
          .run(
            id,
            botId,
            targetGroup,
            scope,
            key,
            input.content,
            sourceId,
            new Date().toISOString(),
            provenance,
            input.importance ?? 1,
            input.expiresAt ?? null,
            kind,
          );
      }
      return { saved: true, memoryId: id, corrected: Boolean(old) };
    })();
  }
  forget(botId: string, groupId: string | undefined, id: string) {
    const memory = this.store.db
      .prepare(
        `${select} WHERE id=? AND bot_id=? AND (scope='bot' OR group_id IN (SELECT group_id FROM group_bots WHERE bot_id=? AND (? IS NULL OR group_id=?)))`,
      )
      .get(id, botId, botId, groupId ?? null, groupId ?? null) as Memory | undefined;
    if (!memory) throw new Error('记忆不存在或不属于当前范围');
    this.store.db
      .prepare('INSERT INTO bot_memory_revisions VALUES(?,?,?,?,?,?,?)')
      .run(
        randomUUID(),
        id,
        memory.content,
        memory.sourceMessageId,
        memory.provenance,
        'forgotten',
        new Date().toISOString(),
      );
    this.store.db
      .prepare("UPDATE bot_memory SET state='forgotten',updated_at=? WHERE id=?")
      .run(new Date().toISOString(), id);
    return { forgotten: true };
  }
}
