import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { CloudStore, CloudError } from "../server/cloud-store.ts";
import { canonicalJson, MAX_PUBLICATION_BYTES, type Command, type DeviceCredential, type Publication, type TerminalReceipt } from "../shared/relay.ts";

const password = "test-password-not-a-real-credential";
const emptySnapshot: Publication["snapshot"] = {
  employees: [], conversations: [], messages: [], tasks: [], artifacts: [], memories: [], notices: [], rules: [],
  settings: { main: null, attention: null, attentionUseMain: true, maxWorkers: 2, codexModel: "" }, executors: [],
};
const employee: Command = {
  kind: "employee.create", input: { name: "云端测试", role: "测试", executor: "codex", attentionMode: "auto" },
};
function expectCode(code: string) {
  return (error: unknown) => error instanceof CloudError && error.code === code;
}
function syncInput(credential: DeviceCredential) {
  return { deviceId: credential.deviceId, generation: credential.generation, receipts: [] };
}
async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), "jarvis-cloud-store-"));
  let now = Date.parse("2026-11-05T00:00:00.000Z");
  let store = new CloudStore(dataDir, { now: () => now });
  return {
    dataDir, get store() { return store; }, now: () => now,
    advance: (ms: number) => { now += ms; },
    reopen: () => { store.close(); store = new CloudStore(dataDir, { now: () => now }); },
    cleanup: async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); },
  };
}

test("云端身份持久化、只存摘要、会话重启恢复、注销与过期", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.store.login(password), expectCode("NOT_INITIALIZED"));
    await f.store.initialize(password);
    await assert.rejects(f.store.initialize(password), expectCode("ALREADY_INITIALIZED"));
    const session = await f.store.login(password);
    assert.deepEqual(f.store.session(session.token), { csrf: session.csrf });
    assert.equal(f.store.verifyCsrf(session.token, session.csrf), true);
    assert.equal(f.store.verifyCsrf(session.token, "wrong"), false);
    const pairing = f.store.pairCode();
    const device = f.store.pair({ code: pairing.code });
    const bytes = await readFile(join(f.dataDir, "cloud.sqlite"));
    for (const value of [password, session.token, session.csrf, pairing.code, device.token])
      assert.equal(bytes.includes(Buffer.from(value)), false);
    assert.equal((await stat(f.dataDir)).mode & 0o777, 0o700);
    assert.equal((await stat(join(f.dataDir, "cloud.sqlite"))).mode & 0o777, 0o600);
    f.reopen();
    assert.deepEqual(f.store.session(session.token), { csrf: session.csrf });
    f.store.logout(session.token);
    f.reopen();
    assert.equal(f.store.session(session.token), null);
    const expired = await f.store.login(password);
    f.advance(12 * 60 * 60 * 1000);
    assert.equal(f.store.session(expired.token), null);
    assert.equal(f.store.session("malformed"), null);
  } finally { await f.cleanup(); }
});

test("scrypt 固定并发一、失败限流跨重启生效且窗口结束才恢复", async () => {
  const f = await fixture();
  try {
    await f.store.initialize(password);
    const first = f.store.login(password);
    await assert.rejects(f.store.login(password), expectCode("LOGIN_BUSY"));
    await first;
    for (let index = 0; index < 5; index++)
      await assert.rejects(f.store.login("a-different-test-password"), expectCode("INVALID_PASSWORD"));
    f.reopen();
    await assert.rejects(f.store.login(password), expectCode("LOGIN_LIMIT"));
    f.advance(60000);
    assert.ok((await f.store.login(password)).token);
    const before = f.store.pairCode();
    const old = f.store.pair({ code: before.code });
    const oldSession = await f.store.login(password);
    await f.store.resetPassword("replacement-test-password");
    assert.equal(f.store.session(oldSession.token), null);
    assert.throws(() => f.store.sync(old.token, syncInput(old)), expectCode("DEVICE_REJECTED"));
    await assert.rejects(f.store.login(password), expectCode("INVALID_PASSWORD"));
    assert.ok((await f.store.login("replacement-test-password")).token);
  } finally { await f.cleanup(); }
});

test("配对码随机单次、过期、持久限流及显式撤销代际隔离", async () => {
  const f = await fixture();
  try {
    const stale = f.store.pairCode();
    f.advance(5 * 60000);
    assert.throws(() => f.store.pair({ code: stale.code }), expectCode("PAIR_REJECTED"));
    for (let index = 0; index < 4; index++)
      assert.throws(() => f.store.pair({ code: "0".repeat(64) }), expectCode("PAIR_REJECTED"));
    f.reopen();
    assert.throws(() => f.store.pair({ code: stale.code }), expectCode("PAIR_LIMIT"));
    f.advance(60000);
    const pairing = f.store.pairCode();
    assert.match(pairing.code, /^[a-f0-9]{64}$/);
    assert.notEqual(pairing.code, stale.code);
    const old = f.store.pair({ code: pairing.code });
    assert.throws(() => f.store.pair({ code: pairing.code }), expectCode("PAIR_REJECTED"));
    assert.throws(() => f.store.pairCode(), expectCode("DEVICE_PAIRED"));
    const deliveredId = randomUUID();
    const queuedId = randomUUID();
    f.store.submit({ requestId: deliveredId, command: employee });
    f.store.sync(old.token, { ...syncInput(old), publication: { revision: 1, snapshot: emptySnapshot } });
    f.store.submit({ requestId: queuedId, command: employee });
    f.store.revoke();
    f.reopen();
    assert.throws(() => f.store.sync(old.token, syncInput(old)), expectCode("DEVICE_REJECTED"));
    const revoked = f.store.view();
    assert.equal(revoked.link.state, "revoked");
    assert.equal(revoked.snapshot, null);
    assert.equal(revoked.link.lastSyncedAt, null);
    assert.equal(revoked.receipts.find((r) => r.commandId === deliveredId)?.status, "unknown");
    assert.equal(revoked.receipts.find((r) => r.commandId === queuedId)?.status, "rejected");
    const fresh = f.store.pair({ code: f.store.pairCode().code });
    assert.ok(fresh.generation > old.generation);
    assert.equal(f.store.sync(fresh.token, syncInput(fresh)).command, null);
    assert.equal(f.store.submit({ requestId: deliveredId, command: employee }).status, "unknown");
    assert.throws(() => f.store.sync(fresh.token, { ...syncInput(old), publication: { revision: 2, snapshot: emptySnapshot } }), expectCode("DEVICE_REJECTED"));
  } finally { await f.cleanup(); }
});

test("命令相同 ID 幂等、异体冲突、unknown 释放取消队列与终态不可改", async () => {
  const f = await fixture();
  try {
    assert.throws(() => f.store.submit({ requestId: randomUUID(), command: employee }), expectCode("DEVICE_REQUIRED"));
    const device = f.store.pair({ code: f.store.pairCode().code });
    const firstId = randomUUID();
    const first = f.store.submit({ requestId: firstId, command: employee });
    assert.deepEqual(f.store.submit({ requestId: firstId, command: employee }), first);
    assert.throws(() => f.store.submit({ requestId: firstId, command: {
      ...employee, input: { ...employee.input, name: "不同内容" },
    } }), expectCode("COMMAND_CONFLICT"));
    const cancelId = randomUUID();
    f.store.submit({ requestId: cancelId, command: { kind: "task.action", id: randomUUID(), input: { action: "cancel", version: 1 } } });
    assert.throws(() => f.store.sync("0".repeat(64), syncInput(device)), expectCode("DEVICE_REJECTED"));
    const delivery = f.store.sync(device.token, syncInput(device)).command;
    assert.equal(delivery?.commandId, firstId);
    f.reopen();
    assert.deepEqual(f.store.sync(device.token, syncInput(device)).command, delivery);
    const unknown = { commandId: firstId, status: "unknown", code: "CRASH_WINDOW", updatedAt: new Date(f.now()).toISOString() } satisfies TerminalReceipt;
    const next = f.store.sync(device.token, { ...syncInput(device), receipts: [unknown] });
    assert.deepEqual(next.acknowledgedIds, [firstId]);
    assert.equal(next.command?.commandId, cancelId);
    assert.equal(f.store.sync(device.token, { ...syncInput(device), receipts: [unknown] }).command?.commandId, cancelId);
    assert.throws(() => f.store.sync(device.token, { ...syncInput(device), receipts: [{ commandId: firstId, status: "applied", updatedAt: unknown.updatedAt }] }), expectCode("RECEIPT_CONFLICT"));
    assert.equal(f.store.view().receipts.find((r) => r.commandId === firstId)?.status, "unknown");
    assert.throws(() => f.store.sync(device.token, { ...syncInput(device), receipts: [{ commandId: randomUUID(), status: "applied", updatedAt: unknown.updatedAt }] }), expectCode("RECEIPT_REJECTED"));
  } finally { await f.cleanup(); }
});

test("未投递按 TTL 过期，已投递即使过期也保留原 ID 给 journal 裁决", async () => {
  const f = await fixture();
  try {
    const device = f.store.pair({ code: f.store.pairCode().code });
    const queuedId = randomUUID();
    f.store.submit({ requestId: queuedId, command: { kind: "task.action", id: randomUUID(), input: { action: "approve", version: 1 } } });
    f.advance(120000);
    assert.equal(f.store.sync(device.token, syncInput(device)).command, null);
    assert.equal(f.store.view().receipts[0].status, "expired");
    const deliveredId = randomUUID();
    f.store.submit({ requestId: deliveredId, command: employee });
    const delivered = f.store.sync(device.token, syncInput(device)).command;
    f.advance(24 * 60 * 60 * 1000 + 1);
    assert.deepEqual(f.store.sync(device.token, syncInput(device)).command, delivered);
    assert.equal(f.store.view().receipts[0].status, "delivered");
  } finally { await f.cleanup(); }
});

test("快照版本单调、同版本同 hash 幂等、超限及凭据 canary 拒绝且原子回滚", async () => {
  const f = await fixture();
  try {
    const device = f.store.pair({ code: f.store.pairCode().code });
    f.store.sync(device.token, syncInput(device));
    assert.equal(f.store.view().link.state, "online");
    assert.equal(f.store.view().link.lastSyncedAt, null);
    const publication = { revision: 2, snapshot: structuredClone(emptySnapshot) };
    f.store.sync(device.token, { ...syncInput(device), publication });
    const publishedAt = f.store.view().link.lastSyncedAt;
    f.advance(1000);
    f.store.sync(device.token, syncInput(device));
    assert.equal(f.store.view().link.lastSyncedAt, publishedAt);
    f.store.sync(device.token, { ...syncInput(device), publication });
    assert.throws(() => f.store.sync(device.token, { ...syncInput(device), publication: { ...publication, revision: 1 } }), expectCode("REVISION_CONFLICT"));
    const changed = structuredClone(publication);
    changed.snapshot.settings.maxWorkers = 3;
    assert.throws(() => f.store.sync(device.token, { ...syncInput(device), publication: changed }), expectCode("REVISION_CONFLICT"));
    const canary = structuredClone(publication);
    canary.revision++;
    canary.snapshot.messages.push({ id: randomUUID(), conversationId: randomUUID(), authorId: "test", content: device.token, mentions: [], createdAt: new Date(f.now()).toISOString() });
    assert.throws(() => f.store.sync(device.token, { ...syncInput(device), publication: canary }), expectCode("SENSITIVE_PUBLICATION"));
    const oversized = structuredClone(canary);
    oversized.snapshot.messages[0].content = "x".repeat(MAX_PUBLICATION_BYTES);
    assert.throws(() => f.store.sync(device.token, { ...syncInput(device), publication: oversized }), expectCode("PUBLICATION_TOO_LARGE"));
    assert.deepEqual(f.store.view().snapshot, publication.snapshot);
    const id = randomUUID();
    f.store.submit({ requestId: id, command: employee });
    f.store.sync(device.token, syncInput(device));
    assert.throws(() => f.store.sync(device.token, { ...syncInput(device),
      receipts: [{ commandId: id, status: "applied", updatedAt: new Date(f.now()).toISOString() }], publication: canary,
    }), expectCode("SENSITIVE_PUBLICATION"));
    assert.equal(f.store.view().receipts[0].status, "delivered");
    f.advance(15000);
    assert.equal(f.store.view().link.state, "offline");
    f.reopen();
    assert.deepEqual(f.store.view().snapshot, publication.snapshot);
  } finally { await f.cleanup(); }
});

test("快照 4 MiB 边界完整接受，超一字节显式拒绝且不截断", async () => {
  const f = await fixture();
  try {
    const device = f.store.pair({ code: f.store.pairCode().code });
    const publication: Publication = { revision: 1, snapshot: structuredClone(emptySnapshot) };
    publication.snapshot.messages.push({ id: randomUUID(), conversationId: randomUUID(), authorId: "test", content: "", mentions: [], createdAt: new Date(f.now()).toISOString() });
    const overhead = Buffer.byteLength(canonicalJson(publication));
    publication.snapshot.messages[0].content = "x".repeat(MAX_PUBLICATION_BYTES - overhead);
    assert.equal(Buffer.byteLength(canonicalJson(publication)), MAX_PUBLICATION_BYTES);
    f.store.sync(device.token, { ...syncInput(device), publication });
    assert.equal(f.store.view().snapshot?.messages[0].content.length, MAX_PUBLICATION_BYTES - overhead);
    publication.snapshot.messages[0].content += "x";
    assert.throws(() => f.store.sync(device.token, { ...syncInput(device), publication }), expectCode("PUBLICATION_TOO_LARGE"));
    assert.equal(f.store.view().snapshot?.messages[0].content.length, MAX_PUBLICATION_BYTES - overhead);
  } finally { await f.cleanup(); }
});

test("信箱最多 100 待消费，tombstone 达 10000 显式拒绝且已有 ID 仍可重试", async () => {
  const f = await fixture();
  try {
    const device = f.store.pair({ code: f.store.pairCode().code });
    const ids: string[] = [];
    for (let index = 0; index < 100; index++) {
      const requestId = randomUUID();
      ids.push(requestId);
      f.store.submit({ requestId, command: employee });
    }
    assert.throws(() => f.store.submit({ requestId: randomUUID(), command: employee }), expectCode("MAILBOX_FULL"));
    assert.equal(f.store.view().receipts.length, 100);
    const delivered = f.store.sync(device.token, syncInput(device)).command;
    assert.equal(delivered?.commandId, ids[0]);
    f.store.sync(device.token, { ...syncInput(device), receipts: [{ commandId: ids[0], status: "applied", updatedAt: new Date(f.now()).toISOString() }] });
    f.store.submit({ requestId: randomUUID(), command: employee });
    f.store.revoke();
    f.reopen();
    const db = new DatabaseSync(join(f.dataDir, "cloud.sqlite"));
    const source = db.prepare("SELECT * FROM cloud_commands LIMIT 1").get();
    assert.ok(source);
    db.exec("BEGIN");
    const insert = db.prepare(`INSERT INTO cloud_commands(command_id,device_id,generation,digest,addressed,receipt,status,expires_at)
      VALUES(?,?,?,?,?,?,?,?)`);
    for (let index = 101; index < 10000; index++) {
      const id = randomUUID();
      insert.run(id, device.deviceId, device.generation, String(source.digest), String(source.addressed),
        JSON.stringify({ commandId: id, status: "applied", updatedAt: new Date(f.now()).toISOString() }), "applied", f.now());
    }
    db.exec("COMMIT");
    db.close();
    const fresh = f.store.pair({ code: f.store.pairCode().code });
    assert.ok(fresh.token);
    assert.throws(() => f.store.submit({ requestId: randomUUID(), command: employee }), expectCode("TOMBSTONE_LIMIT"));
    assert.equal(f.store.submit({ requestId: ids[0], command: employee }).status, "applied");
  } finally { await f.cleanup(); }
});

test("云端提交后硬退出不伪造成功，投递与终态跨进程崩溃持久保留", async () => {
  const f = await fixture();
  try {
    const device = f.store.pair({ code: f.store.pairCode().code });
    const id = randomUUID();
    f.store.submit({ requestId: id, command: employee });
    const childCode = `
      import { readFileSync } from 'node:fs';
      import { CloudStore } from ${JSON.stringify(new URL("../server/cloud-store.ts", import.meta.url).href)};
      const {dir,token,input,now}=JSON.parse(readFileSync(0,'utf8'));
      const store=new CloudStore(dir,{now:()=>now});
      store.sync(token,input);
      process.exit(23);
    `;
    const crash = (receipts: unknown[]) => spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", childCode], {
      input: JSON.stringify({ dir: f.dataDir, token: device.token, input: { ...syncInput(device), receipts }, now: f.now() }), encoding: "utf8",
    });
    assert.equal(crash([]).status, 23);
    f.reopen();
    assert.equal(f.store.view().receipts[0].status, "delivered");
    assert.equal(f.store.sync(device.token, syncInput(device)).command?.commandId, id);
    const receipt = { commandId: id, status: "applied", updatedAt: new Date(f.now()).toISOString() } satisfies TerminalReceipt;
    assert.equal(crash([receipt]).status, 23);
    f.reopen();
    assert.equal(f.store.view().receipts[0].status, "applied");
    assert.deepEqual(f.store.sync(device.token, { ...syncInput(device), receipts: [receipt] }), { leaseMs: 15000, acknowledgedIds: [id], command: null });
    assert.equal(canonicalJson({ b: 2, a: 1 }), canonicalJson({ a: 1, b: 2 }));
  } finally { await f.cleanup(); }
});
