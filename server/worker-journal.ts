import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  canonicalJson, TerminalReceiptSchema, AddressedCommandSchema,
  type AddressedCommand, type TerminalReceipt, type Publication,
} from "../shared/relay.ts";
import type { Snapshot } from "../shared/domain.ts";

export class WorkerError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "WorkerError";
  }
}
const Entry = z.object({
  digest: z.string(), device_id: z.string(), generation: z.number(),
  state: z.enum(["started", "terminal"]), receipt: z.string().nullable(),
});

/** journal 只记录交付，不与 Workspace 冒充跨库 exactly-once 事务。 */
export class WorkerJournal {
  private readonly db: DatabaseSync;
  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const path = join(dataDir, "worker-journal.sqlite");
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS commands (
        command_id TEXT PRIMARY KEY, digest TEXT NOT NULL, device_id TEXT NOT NULL,
        generation INTEGER NOT NULL, state TEXT NOT NULL, receipt TEXT, acked INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS publication (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, digest TEXT NOT NULL);
      INSERT OR IGNORE INTO publication VALUES (1,0,'');`);
    // started 可能处于调用前或业务已提交后，重启只能报告未知，绝不自动重放。
    const pending = this.db.prepare("SELECT command_id FROM commands WHERE state='started'").all();
    const update = this.db.prepare("UPDATE commands SET state='terminal',receipt=? WHERE command_id=?");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of pending) {
        const id = z.object({ command_id: z.string() }).parse(row).command_id;
        update.run(JSON.stringify({ commandId: id, status: "unknown", code: "CRASH_WINDOW", updatedAt: new Date().toISOString() }), id);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      this.db.close();
      throw error;
    }
  }

  begin(input: AddressedCommand): TerminalReceipt | undefined {
    const command = AddressedCommandSchema.parse(input);
    const digest = createHash("sha256").update(canonicalJson(command.command)).digest("hex");
    if (digest !== command.digest) throw new WorkerError("COMMAND_DIGEST_MISMATCH");
    const row = this.db.prepare("SELECT * FROM commands WHERE command_id=?").get(command.commandId);
    if (row) {
      const entry = Entry.parse(row);
      if (entry.digest !== digest || entry.device_id !== command.deviceId || entry.generation !== command.generation)
        throw new WorkerError("COMMAND_ID_CONFLICT");
      if (entry.state === "started") throw new WorkerError("COMMAND_IN_PROGRESS");
      this.db.prepare("UPDATE commands SET acked=0 WHERE command_id=?").run(command.commandId);
      return TerminalReceiptSchema.parse(JSON.parse(entry.receipt!));
    }
    const { count } = z.object({ count: z.number() }).parse(this.db.prepare("SELECT COUNT(*) AS count FROM commands").get());
    if (count >= 10000) throw new WorkerError("JOURNAL_CAPACITY");
    this.db.prepare("INSERT INTO commands(command_id,digest,device_id,generation,state) VALUES (?,?,?,?,'started')")
      .run(command.commandId, digest, command.deviceId, command.generation);
    return undefined;
  }

  finish(receipt: TerminalReceipt): TerminalReceipt {
    const terminal = TerminalReceiptSchema.parse(receipt);
    const result = this.db.prepare("UPDATE commands SET state='terminal',receipt=?,acked=0 WHERE command_id=? AND state='started'")
      .run(JSON.stringify(terminal), terminal.commandId);
    if (result.changes !== 1) throw new WorkerError("JOURNAL_STATE_CONFLICT");
    return terminal;
  }

  receipts(credential: { deviceId: string; generation: number }): TerminalReceipt[] {
    return this.db.prepare("SELECT receipt FROM commands WHERE state='terminal' AND acked=0 AND device_id=? AND generation=? ORDER BY rowid LIMIT 100")
      .all(credential.deviceId, credential.generation)
      .map((row) => TerminalReceiptSchema.parse(JSON.parse(z.object({ receipt: z.string() }).parse(row).receipt)));
  }

  acknowledge(ids: string[], sent: TerminalReceipt[]): void {
    const allowed = new Set(sent.map((item) => item.commandId));
    if (ids.some((id) => !allowed.has(id))) throw new WorkerError("INVALID_ACK");
    const update = this.db.prepare("UPDATE commands SET acked=1 WHERE command_id=? AND state='terminal'");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const id of ids) update.run(id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  publication(snapshot: Snapshot): Publication {
    const digest = createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
    const previous = z.object({ revision: z.number().int(), digest: z.string() })
      .parse(this.db.prepare("SELECT revision,digest FROM publication WHERE id=1").get());
    const revision = previous.revision + Number(digest !== previous.digest);
    if (!Number.isSafeInteger(revision)) throw new WorkerError("REVISION_LIMIT");
    if (revision !== previous.revision)
      this.db.prepare("UPDATE publication SET revision=?,digest=? WHERE id=1").run(revision, digest);
    return { revision, snapshot };
  }

  close(): void { this.db.close(); }
}
