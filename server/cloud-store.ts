import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync, realpathSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  AddressedCommandSchema, CloudViewSchema, DeviceCredentialSchema,
  PairInputSchema, ReceiptSchema, SubmitSchema, SyncInputSchema,
  LEASE_MS, MAX_PUBLICATION_BYTES, canonicalJson,
  type CloudView, type DeviceCredential, type Receipt,
} from "../shared/relay.ts";
import { log } from "./log.ts";

const Hex = z.string().regex(/^[a-f0-9]{64}$/);
const Password = z.string().min(16).max(256);
const SESSION_MS = 12 * 60 * 60 * 1000;
const PAIR_MS = 5 * 60 * 1000;
const LIMIT_WINDOW_MS = 60 * 1000;
const AttemptSchema = z.object({ failures: z.number().int().nonnegative(), until: z.number() }).strict();
const StateSchema = z.object({
  identity: z.object({ salt: Hex, digest: z.string().regex(/^[a-f0-9]{128}$/) }).strict().nullable(),
  loginLimit: AttemptSchema,
  pairLimit: AttemptSchema,
  codeLimit: AttemptSchema,
  sessions: z.array(z.object({ digest: Hex, expiresAt: z.number() }).strict()).max(100),
  generation: z.number().int().nonnegative(),
  device: z.object({ deviceId: z.string().uuid(), digest: Hex }).strict().nullable(),
  pairing: z.object({ digest: Hex, expiresAt: z.number() }).strict().nullable(),
  lastSyncedAt: z.number().nullable(),
  lastAuthenticatedAt: z.number().nullable(),
  publication: SyncInputSchema.shape.publication.unwrap().nullable(),
  publicationDigest: Hex.nullable(),
}).strict();
type State = z.infer<typeof StateSchema>;
type Submit = z.infer<typeof SubmitSchema>;
type PairInput = z.infer<typeof PairInputSchema>;
type SyncInput = z.infer<typeof SyncInputSchema>;
const CommandRowSchema = z.object({ addressed: z.string(), receipt: z.string() });
type StoredCommand = {
  addressed: z.infer<typeof AddressedCommandSchema>;
  receipt: Receipt;
};

export class CloudError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}
function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function equal(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function csrfFor(token: string): string {
  return hash(`jarvis-cloud-csrf:${token}`);
}
function passwordDigest(password: string, salt: string): Promise<string> {
  return new Promise((resolveDigest, reject) => {
    scrypt(password, salt, 64, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error);
      else resolveDigest(key.toString("hex"));
    });
  });
}
function freshState(): State {
  return {
    identity: null, sessions: [], generation: 0, device: null, pairing: null,
    lastSyncedAt: null, lastAuthenticatedAt: null, publication: null, publicationDigest: null,
    loginLimit: { failures: 0, until: 0 },
    pairLimit: { failures: 0, until: 0 },
    codeLimit: { failures: 0, until: 0 },
  };
}
function activeLimit(limit: z.infer<typeof AttemptSchema>, now: number): boolean {
  return limit.failures >= 5 && limit.until > now;
}
function failedAttempt(limit: z.infer<typeof AttemptSchema>, now: number): void {
  if (limit.until <= now) {
    limit.failures = 0;
    limit.until = now + LIMIT_WINDOW_MS;
  }
  limit.failures++;
}
function decodeCommand(row: unknown): StoredCommand {
  const value = CommandRowSchema.parse(row);
  return {
    addressed: AddressedCommandSchema.parse(JSON.parse(value.addressed)),
    receipt: ReceiptSchema.parse(JSON.parse(value.receipt)),
  };
}

/** Cloud 只拥有身份、信箱与只读投影，不拥有任何 Workspace 执行入口。 */
export class CloudStore {
  readonly dataDir: string;
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private passwordBusy = false;

  constructor(dataDir: string, options: { now?: () => number } = {}) {
    mkdirSync(resolve(dataDir), { recursive: true, mode: 0o700 });
    this.dataDir = realpathSync(resolve(dataDir));
    chmodSync(this.dataDir, 0o700);
    this.now = options.now ?? Date.now;
    const path = join(this.dataDir, "cloud.sqlite");
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`
      PRAGMA busy_timeout=5000;
      PRAGMA journal_mode=DELETE;
      PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS cloud_state (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cloud_commands (
        seq INTEGER PRIMARY KEY, command_id TEXT UNIQUE NOT NULL,
        device_id TEXT NOT NULL, generation INTEGER NOT NULL,
        digest TEXT NOT NULL, addressed TEXT NOT NULL, receipt TEXT NOT NULL,
        status TEXT NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS cloud_pending ON cloud_commands(device_id,generation,status,seq);
    `);
    this.db.prepare("INSERT OR IGNORE INTO cloud_state(id,data) VALUES(1,?)")
      .run(JSON.stringify(freshState()));
    this.read();
  }

  private read(): State {
    const row = z.object({ data: z.string() }).parse(
      this.db.prepare("SELECT data FROM cloud_state WHERE id=1").get(),
    );
    return StateSchema.parse(JSON.parse(row.data));
  }
  private transaction<T>(change: (state: State) => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const state = this.read();
      const result = change(state);
      this.db.prepare("UPDATE cloud_state SET data=? WHERE id=1")
        .run(JSON.stringify(StateSchema.parse(state)));
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private async setPassword(password: string, reset: boolean): Promise<void> {
    Password.parse(password);
    if (this.passwordBusy)
      throw new CloudError(429, "LOGIN_BUSY", "身份验证忙，请稍后再试。");
    this.passwordBusy = true;
    try {
      if (!reset && this.read().identity)
        throw new CloudError(409, "ALREADY_INITIALIZED", "云端身份已初始化。");
      const salt = randomBytes(32).toString("hex");
      const digest = await passwordDigest(password, salt);
      this.transaction((state) => {
        if (!reset && state.identity)
          throw new CloudError(409, "ALREADY_INITIALIZED", "云端身份已初始化。");
        if (reset) this.revokeState(state);
        state.identity = { salt, digest };
        state.sessions = [];
        state.loginLimit = { failures: 0, until: 0 };
      });
      log("info", reset ? "cloud.identity_reset" : "cloud.identity_initialized");
    } finally {
      this.passwordBusy = false;
    }
  }
  initialize(password: string): Promise<void> {
    return this.setPassword(password, false);
  }
  resetPassword(password: string): Promise<void> {
    return this.setPassword(password, true);
  }
  async login(password: string): Promise<{ token: string; csrf: string }> {
    Password.parse(password);
    if (this.passwordBusy)
      throw new CloudError(429, "LOGIN_BUSY", "身份验证忙，请稍后再试。");
    const state = this.read();
    if (!state.identity)
      throw new CloudError(503, "NOT_INITIALIZED", "请先在云端终端初始化身份。");
    if (activeLimit(state.loginLimit, this.now()))
      throw new CloudError(429, "LOGIN_LIMIT", "尝试过多，请稍后再试。");
    const identity = state.identity;
    this.passwordBusy = true;
    try {
      const digest = await passwordDigest(password, identity.salt);
      if (!equal(digest, identity.digest)) {
        this.transaction((current) => failedAttempt(current.loginLimit, this.now()));
        log("info", "cloud.login_rejected");
        throw new CloudError(401, "INVALID_PASSWORD", "登录凭据无效。");
      }
      const token = randomBytes(32).toString("hex");
      this.transaction((current) => {
        if (!current.identity || !equal(current.identity.digest, identity.digest))
          throw new CloudError(401, "INVALID_PASSWORD", "登录凭据已失效。");
        current.sessions = current.sessions.filter((session) => session.expiresAt > this.now());
        if (current.sessions.length >= 100)
          throw new CloudError(429, "SESSION_LIMIT", "登录会话过多，请先退出其他会话。");
        current.sessions.push({ digest: hash(token), expiresAt: this.now() + SESSION_MS });
        current.loginLimit = { failures: 0, until: 0 };
      });
      log("info", "cloud.session_created");
      return { token, csrf: csrfFor(token) };
    } finally {
      this.passwordBusy = false;
    }
  }
  session(token: string): { csrf: string } | null {
    if (!Hex.safeParse(token).success) return null;
    const digest = hash(token);
    const session = this.read().sessions.find((item) => equal(item.digest, digest));
    return session && session.expiresAt > this.now() ? { csrf: csrfFor(token) } : null;
  }
  verifyCsrf(token: string, csrf: string): boolean {
    const session = this.session(token);
    return session !== null && equal(session.csrf, csrf);
  }
  logout(token: string): void {
    const digest = hash(token);
    this.transaction((state) => {
      state.sessions = state.sessions.filter((session) => !equal(session.digest, digest));
    });
    log("info", "cloud.session_revoked");
  }
  pairCode(): { code: string; expiresAt: string } {
    const code = randomBytes(32).toString("hex");
    const expiresAt = this.now() + PAIR_MS;
    this.transaction((state) => {
      if (state.device)
        throw new CloudError(409, "DEVICE_PAIRED", "请先明确撤销现有设备。");
      if (activeLimit(state.codeLimit, this.now()))
        throw new CloudError(429, "PAIR_LIMIT", "配对操作过多，请稍后再试。");
      failedAttempt(state.codeLimit, this.now());
      state.pairing = { digest: hash(code), expiresAt };
    });
    log("info", "cloud.pairing_created");
    return { code, expiresAt: new Date(expiresAt).toISOString() };
  }
  pair(raw: PairInput): DeviceCredential {
    const input = PairInputSchema.parse(raw);
    const token = randomBytes(32).toString("hex");
    // 失败计数也必须提交，不能与认证失败一起回滚。
    const result = this.transaction((state): DeviceCredential | null => {
      if (activeLimit(state.pairLimit, this.now()))
        throw new CloudError(429, "PAIR_LIMIT", "配对尝试过多，请稍后再试。");
      if (state.device || !state.pairing || state.pairing.expiresAt <= this.now() ||
          !equal(state.pairing.digest, hash(input.code))) {
        failedAttempt(state.pairLimit, this.now());
        return null;
      }
      state.generation++;
      const deviceId = randomUUID();
      state.device = { deviceId, digest: hash(token) };
      state.pairing = null;
      state.pairLimit = { failures: 0, until: 0 };
      state.lastSyncedAt = null;
      state.lastAuthenticatedAt = null;
      state.publication = null;
      state.publicationDigest = null;
      return DeviceCredentialSchema.parse({ deviceId, generation: state.generation, token });
    });
    if (!result) throw new CloudError(401, "PAIR_REJECTED", "配对码无效、已使用或已过期。");
    log("info", "cloud.device_paired", { generation: result.generation });
    return result;
  }
  private setReceipt(commandId: string, receipt: Receipt): void {
    this.db.prepare("UPDATE cloud_commands SET receipt=?,status=? WHERE command_id=?")
      .run(JSON.stringify(receipt), receipt.status, commandId);
  }
  private revokeState(state: State): void {
    const rows = this.db.prepare("SELECT addressed,receipt FROM cloud_commands WHERE status IN ('queued','delivered')").all();
    for (const row of rows) {
      const command = decodeCommand(row);
      const updatedAt = new Date(this.now()).toISOString();
      // 已投递不能断言没有应用，只能保留不确定回执。
      this.setReceipt(command.addressed.commandId, command.receipt.status === "queued"
        ? { commandId: command.addressed.commandId, status: "rejected", code: "DEVICE_REVOKED", updatedAt }
        : { commandId: command.addressed.commandId, status: "unknown", code: "CRASH_WINDOW", updatedAt });
    }
    state.generation++;
    state.device = null;
    state.pairing = null;
    state.lastSyncedAt = null;
    state.lastAuthenticatedAt = null;
    state.publication = null;
    state.publicationDigest = null;
  }
  revoke(): void {
    this.transaction((state) => this.revokeState(state));
    log("info", "cloud.device_revoked");
  }
  private expireQueued(): void {
    const rows = this.db.prepare("SELECT addressed,receipt FROM cloud_commands WHERE status='queued' AND expires_at<=?").all(this.now());
    for (const row of rows) {
      const command = decodeCommand(row);
      this.setReceipt(command.addressed.commandId, {
        commandId: command.addressed.commandId, status: "expired", updatedAt: new Date(this.now()).toISOString(),
      });
    }
  }
  submit(raw: Submit): Receipt {
    const input = SubmitSchema.parse(raw);
    const digest = hash(canonicalJson(input.command));
    const receipt = this.transaction((state) => {
      this.expireQueued();
      const existing = this.db.prepare("SELECT addressed,receipt FROM cloud_commands WHERE command_id=?").get(input.requestId);
      if (existing) {
        const command = decodeCommand(existing);
        if (!equal(command.addressed.digest, digest))
          throw new CloudError(409, "COMMAND_CONFLICT", "同一请求编号不能对应不同操作。");
        return command.receipt;
      }
      if (!state.device)
        throw new CloudError(409, "DEVICE_REQUIRED", "请先配对 Mac 执行端。");
      const count = (sql: string) => z.object({ count: z.number() }).parse(this.db.prepare(sql).get()).count;
      if (count("SELECT COUNT(*) AS count FROM cloud_commands") >= 10000)
        throw new CloudError(409, "TOMBSTONE_LIMIT", "命令去重记录已满，拒绝新增以保留安全重试记录。");
      if (count("SELECT COUNT(*) AS count FROM cloud_commands WHERE status IN ('queued','delivered')") >= 100)
        throw new CloudError(429, "MAILBOX_FULL", "待消费命令已满，请等待 Mac 同步。");
      const ttl = input.command.kind === "task.action" && input.command.input.action === "approve"
        ? 2 * 60 * 1000 : 24 * 60 * 60 * 1000;
      const expires = this.now() + ttl;
      const addressed = AddressedCommandSchema.parse({
        commandId: input.requestId, deviceId: state.device.deviceId, generation: state.generation,
        digest, expiresAt: new Date(expires).toISOString(), command: input.command,
      });
      const receipt: Receipt = {
        commandId: input.requestId, status: "queued", updatedAt: new Date(this.now()).toISOString(), expiresAt: addressed.expiresAt,
      };
      this.db.prepare(`INSERT INTO cloud_commands(command_id,device_id,generation,digest,addressed,receipt,status,expires_at)
        VALUES(?,?,?,?,?,?,?,?)`).run(input.requestId, state.device.deviceId, state.generation, digest,
          JSON.stringify(addressed), JSON.stringify(receipt), receipt.status, expires);
      return receipt;
    });
    log("info", "cloud.command_received", { commandId: input.requestId, status: receipt.status });
    return receipt;
  }
  sync(token: string, raw: SyncInput) {
    const input = SyncInputSchema.parse(raw);
    if (input.publication && Buffer.byteLength(canonicalJson(input.publication)) > MAX_PUBLICATION_BYTES)
      throw new CloudError(413, "PUBLICATION_TOO_LARGE", "同步快照超出大小上限。");
    return this.transaction((state) => {
      if (!Hex.safeParse(token).success || !state.device ||
          !equal(state.device.digest, hash(token)) || state.device.deviceId !== input.deviceId ||
          state.generation !== input.generation)
        throw new CloudError(401, "DEVICE_REJECTED", "设备凭据已失效，请在 Mac 重新配对。");
      const acknowledgedIds: string[] = [];
      for (const receipt of input.receipts) {
        const row = this.db.prepare("SELECT addressed,receipt FROM cloud_commands WHERE command_id=?").get(receipt.commandId);
        if (!row) throw new CloudError(409, "RECEIPT_REJECTED", "回执不属于当前设备的已投递命令。");
        const command = decodeCommand(row);
        if (command.addressed.deviceId !== input.deviceId || command.addressed.generation !== input.generation ||
            command.receipt.status === "queued")
          throw new CloudError(409, "RECEIPT_REJECTED", "回执不属于当前设备的已投递命令。");
        if (command.receipt.status !== "delivered" && canonicalJson(command.receipt) !== canonicalJson(receipt))
          throw new CloudError(409, "RECEIPT_CONFLICT", "命令终态不能被覆盖。");
        this.setReceipt(receipt.commandId, receipt);
        acknowledgedIds.push(receipt.commandId);
      }
      if (input.publication) {
        const serialized = canonicalJson(input.publication);
        if (serialized.includes(token))
          throw new CloudError(400, "SENSITIVE_PUBLICATION", "快照包含执行端凭据，已拒绝同步。");
        const digest = hash(serialized);
        if (state.publication && (input.publication.revision < state.publication.revision ||
            (input.publication.revision === state.publication.revision && digest !== state.publicationDigest)))
          throw new CloudError(409, "REVISION_CONFLICT", "快照版本回退或同版本内容发生变化。");
        state.publication = input.publication;
        state.publicationDigest = digest;
        state.lastSyncedAt = this.now();
      }
      this.expireQueued();
      const row = this.db.prepare(`SELECT addressed,receipt FROM cloud_commands
        WHERE device_id=? AND generation=? AND status IN ('queued','delivered') ORDER BY seq LIMIT 1`)
        .get(input.deviceId, input.generation);
      const command = row ? decodeCommand(row).addressed : null;
      if (command) this.setReceipt(command.commandId, {
        commandId: command.commandId, status: "delivered", expiresAt: command.expiresAt,
        updatedAt: new Date(this.now()).toISOString(),
      });
      state.lastAuthenticatedAt = this.now();
      return { leaseMs: LEASE_MS, acknowledgedIds, command };
    });
  }
  view(): CloudView {
    return this.transaction((state) => {
      this.expireQueued();
      const receipts = this.db.prepare("SELECT addressed,receipt FROM cloud_commands ORDER BY seq DESC LIMIT 100").all()
        .map((row) => decodeCommand(row).receipt);
      return CloudViewSchema.parse({
        snapshot: state.publication?.snapshot ?? null,
        link: {
          state: state.device
            ? state.lastAuthenticatedAt !== null && this.now() - state.lastAuthenticatedAt < LEASE_MS ? "online" : "offline"
            : state.generation > 0 ? "revoked" : "unpaired",
          lastSyncedAt: state.lastSyncedAt === null ? null : new Date(state.lastSyncedAt).toISOString(),
          deviceId: state.device?.deviceId ?? null, generation: state.generation,
        },
        receipts,
      });
    });
  }
  close(): void {
    this.db.close();
  }
}
