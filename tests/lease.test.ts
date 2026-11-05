import test from "node:test";
import assert from "node:assert/strict";
import { ExecutionLease, LeaseExpiredError } from "../server/lease.ts";

const delay = (ms: number) => new Promise((done) => setTimeout(done, ms));

test("远程租约默认关闭，认证往返耗时从可用期限扣除", () => {
  let mono = 0, wall = 1000;
  const lease = new ExecutionLease({ monotonic: () => mono, wall: () => wall });
  assert.equal(lease.valid, false);
  assert.throws(() => lease.assertValid(), LeaseExpiredError);
  const start = lease.requestStarted();
  mono = 80; wall += 80;
  lease.renew(100, start);
  assert.equal(lease.valid, true);
  mono = 100; wall += 20;
  assert.equal(lease.valid, false);
  assert.throws(() => lease.renew(100, start), LeaseExpiredError);
});

test("到期定时器主动中断，不等待下一次轮询", async () => {
  const lease = new ExecutionLease();
  let lost = 0;
  lease.onLost(() => lost++);
  lease.renew(25, lease.requestStarted());
  await delay(50);
  assert.equal(lost, 1);
  assert.equal(lease.valid, false);
  lease.invalidate("DISCONNECTED");
  assert.equal(lost, 1);
});

test("续租替换旧定时器，过期后续租先失效旧运行", async () => {
  let mono = 10, wall = 1000;
  const lease = new ExecutionLease({ monotonic: () => mono, wall: () => wall });
  let lost = 0;
  lease.onLost(() => lost++);
  lease.renew(20, lease.requestStarted());
  lease.renew(1000, lease.requestStarted());
  await delay(40);
  assert.equal(lost, 0);
  mono += 1000; wall += 1000;
  lease.renew(1000, lease.requestStarted());
  assert.equal(lost, 1);
  assert.equal(lease.valid, true);
  lease.invalidate("TEST_FINISHED");
});

test("休眠墙钟前进使租约失效，墙钟回拨不能延长单调期限", () => {
  let mono = 10, wall = 1000;
  const lease = new ExecutionLease({ monotonic: () => mono, wall: () => wall });
  lease.renew(1000, lease.requestStarted());
  wall += 2000;
  assert.equal(lease.valid, false);
  lease.renew(1000, lease.requestStarted());
  wall -= 5000; mono += 1000;
  assert.equal(lease.valid, false);
});

test("请求过程中休眠的旧认证响应不能重新开闸", () => {
  let mono = 10, wall = 1000;
  const lease = new ExecutionLease({ monotonic: () => mono, wall: () => wall });
  const start = lease.requestStarted();
  wall += 10000;
  assert.throws(() => lease.renew(1000, start), LeaseExpiredError);
  assert.equal(lease.valid, false);
});
