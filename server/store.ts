import { DatabaseSync } from "node:sqlite";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import { SnapshotSchema, ModelConfigSchema, Id } from "../shared/domain.ts";

const InboxSchema = z.object({
  id: Id,
  employeeId: Id,
  messageId: Id,
  state: z.enum(["pending", "processing", "done", "failed"]),
  createdAt: z.string(),
});
export const StateSchema = SnapshotSchema.omit({ executors: true }).extend({
  inbox: z.array(InboxSchema),
  secretsDigest: z.string().nullable().default(null),
  ruleTaskLinks: z.array(z.object({ ruleId: Id, taskId: Id })).default([]),
});
export type State = z.infer<typeof StateSchema>;
const SecretsSchema = z.object({
  main: ModelConfigSchema.extend({ apiKey: z.string() }).nullable(),
  attention: ModelConfigSchema.extend({ apiKey: z.string() }).nullable(),
});
export type Secrets = z.infer<typeof SecretsSchema>;
export function secretsDigest(secrets: Secrets): string {
  return createHash("sha256")
    .update(JSON.stringify(SecretsSchema.parse(secrets)))
    .digest("hex");
}

function emptyState(): State {
  return {
    secretsDigest: null,
    ruleTaskLinks: [],
    employees: [],
    conversations: [],
    messages: [],
    tasks: [],
    artifacts: [],
    memories: [],
    notices: [],
    rules: [],
    inbox: [],
    settings: {
      main: null,
      attention: null,
      attentionUseMain: true,
      maxWorkers: 2,
      codexModel: "",
    },
  };
}

/** SQLite 是业务状态唯一写入点，事务同时提交任务、消息与通知。 */
export class Store {
  readonly dataDir: string;
  private readonly db: DatabaseSync;
  private readonly secretPath: string;
  constructor(dataDir: string) {
    this.dataDir = resolve(dataDir);
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    this.dataDir = realpathSync(this.dataDir);
    chmodSync(this.dataDir, 0o700);
    const dbPath = join(this.dataDir, "workspace.sqlite");
    this.db = new DatabaseSync(dbPath);
    chmodSync(dbPath, 0o600);
    this.db.exec(
      "PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS workspace (id INTEGER PRIMARY KEY CHECK (id=1), data TEXT NOT NULL);",
    );
    this.db
      .prepare("INSERT OR IGNORE INTO workspace (id,data) VALUES (1,?)")
      .run(JSON.stringify(StateSchema.parse(emptyState())));
    this.secretPath = join(this.dataDir, "secrets.json");
    if (existsSync(this.secretPath)) chmodSync(this.secretPath, 0o600);
    this.read();
  }
  read(): State {
    const row = this.db.prepare("SELECT data FROM workspace WHERE id=1").get();
    return StateSchema.parse(
      JSON.parse(z.object({ data: z.string() }).parse(row).data),
    );
  }
  transaction<T>(change: (state: State) => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const state = this.read();
      const result = change(state);
      this.db
        .prepare("UPDATE workspace SET data=? WHERE id=1")
        .run(JSON.stringify(StateSchema.parse(state)));
      this.db.exec("COMMIT");
      return structuredClone(result);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  secrets(): Secrets {
    return existsSync(this.secretPath)
      ? SecretsSchema.parse(JSON.parse(readFileSync(this.secretPath, "utf8")))
      : { main: null, attention: null };
  }
  saveSecrets(secrets: Secrets): void {
    const temp = `${this.secretPath}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(SecretsSchema.parse(secrets)), {
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temp, this.secretPath);
    chmodSync(this.secretPath, 0o600);
  }
  close(): void {
    this.db.close();
  }
}
