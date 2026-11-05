import { randomInt } from 'node:crypto';
import type { Message } from '@openbot/shared';
import type { Store } from '../store.js';

export interface ResponseOrder {
  weight: number;
  advisory: true;
  participants: {
    id: string;
    name: string;
    weight: number;
    status: 'waiting' | 'considering' | 'replied' | 'silent' | 'failed';
  }[];
}

/** Random timing hints per message, never an exclusive speaking lock. */
export class MessageAttention {
  constructor(
    private store: Store,
    private random: (max: number) => number = randomInt,
  ) {}
  prepare(message: Message) {
    if (
      this.store.db
        .prepare('SELECT 1 FROM message_attention_order WHERE message_id=? LIMIT 1')
        .get(message.id)
    )
      return;
    const group = this.store.snapshot().groups.find((g) => g.id === message.groupId);
    if (!group) return;
    const recipients = (group.directBotId ? [group.directBotId] : group.botIds).filter(
      (id) => id !== message.senderId,
    );
    for (let index = recipients.length - 1; index > 0; index--) {
      const other = this.random(index + 1);
      [recipients[index], recipients[other]] = [recipients[other], recipients[index]];
    }
    this.store.db.transaction(() => {
      let eligibleAt = Date.now();
      recipients.forEach((id, index) => {
        if (index) eligibleAt += 200 + this.random(201);
        this.store.db
          .prepare(
            'INSERT INTO message_attention_order(message_id,bot_id,weight,eligible_at) VALUES(?,?,?,?)',
          )
          .run(message.id, id, index + 1, eligibleAt);
      });
    })();
  }
  eligibleAt(messageId: string, botId: string) {
    const own = this.store.db
      .prepare(
        'SELECT eligible_at,started_at FROM message_attention_order WHERE message_id=? AND bot_id=?',
      )
      .get(messageId, botId) as { eligible_at: number; started_at: number | null } | undefined;
    if (!own) return;
    if (own.started_at !== null) return own.eligible_at;
    // Overdue slots after restart or a busy event loop must still start at different times.
    const latest = (
      this.store.db
        .prepare('SELECT MAX(started_at) AS latest FROM message_attention_order WHERE message_id=?')
        .get(messageId) as { latest: number | null }
    ).latest;
    return Math.max(own.eligible_at, latest === null ? 0 : latest + 200);
  }
  started(messageId: string, botId: string) {
    this.store.db
      .prepare(
        'UPDATE message_attention_order SET started_at=? WHERE message_id=? AND bot_id=? AND started_at IS NULL',
      )
      .run(Date.now(), messageId, botId);
  }
  view(messageId: string, botId: string): ResponseOrder | undefined {
    const rows = this.store.db
      .prepare(
        `SELECT o.bot_id AS id,b.name,o.weight,i.status,
          EXISTS(SELECT 1 FROM messages m WHERE m.reply_to=o.message_id
            AND m.sender_id=o.bot_id AND m.sender_type='bot' AND m.timestamp<=?) AS replied
         FROM message_attention_order o JOIN bots b ON b.id=o.bot_id
         LEFT JOIN dialogue_inbox i ON i.source_message_id=o.message_id AND i.bot_id=o.bot_id
         WHERE o.message_id=? ORDER BY o.weight`,
      )
      .all(new Date().toISOString(), messageId) as {
      id: string;
      name: string;
      weight: number;
      status: string | null;
      replied: number;
    }[];
    const own = rows.find((row) => row.id === botId);
    if (!own) return;
    return {
      weight: own.weight,
      advisory: true,
      participants: rows.map((row) => ({
        id: row.id,
        name: row.name,
        weight: row.weight,
        status: row.replied
          ? 'replied'
          : row.status === 'processing'
            ? 'considering'
            : row.status === 'failed'
              ? 'failed'
              : ['delivered', 'ignored', 'discarded'].includes(row.status ?? '')
                ? 'silent'
                : 'waiting',
      })),
    };
  }
}
