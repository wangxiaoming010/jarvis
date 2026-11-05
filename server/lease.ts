import { performance } from "node:perf_hooks";
import { log } from "./log.ts";

export interface LeaseRequestStart {
  monotonic: number;
  wall: number;
}
export class LeaseExpiredError extends Error {
  readonly code = "LEASE_REQUIRED";
  constructor() {
    super("云端连接租约无效，已禁止启动新的外部调用。");
    this.name = "LeaseExpiredError";
  }
}

/** 单调时钟决定有效期；墙钟只用于保守识别系统休眠，不能延长租约。 */
export class ExecutionLease {
  private deadline = 0;
  private wallDeadline = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private listeners = new Set<() => void>();
  constructor(private readonly clock = {
    monotonic: () => performance.now(),
    wall: () => Date.now(),
  }) {}

  requestStarted(): LeaseRequestStart {
    return { monotonic: this.clock.monotonic(), wall: this.clock.wall() };
  }

  get valid(): boolean {
    if (this.deadline && (this.clock.monotonic() >= this.deadline ||
        this.clock.wall() >= this.wallDeadline)) this.invalidate("EXPIRED");
    return this.deadline > 0;
  }

  renew(leaseMs: number, started: LeaseRequestStart): void {
    if (!Number.isFinite(leaseMs) || leaseMs <= 0 || leaseMs > 30000)
      throw new LeaseExpiredError();
    // 认证请求的往返耗时也属于租约，慢响应不能复活已经过期的授权。
    const remaining = Math.min(
      started.monotonic + leaseMs - this.clock.monotonic(),
      started.wall + leaseMs - this.clock.wall(),
    );
    const wasValid = this.valid;
    if (remaining <= 0) {
      this.invalidate("STALE_RESPONSE");
      throw new LeaseExpiredError();
    }
    this.deadline = this.clock.monotonic() + remaining;
    this.wallDeadline = this.clock.wall() + remaining;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.invalidate("EXPIRED"), remaining);
    this.timer.unref();
    if (!wasValid) log("info", "worker.lease_acquired");
  }

  assertValid(signal?: AbortSignal): void {
    if (!this.valid || signal?.aborted) throw new LeaseExpiredError();
  }

  onLost(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  invalidate(reason: string): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.deadline) return;
    this.deadline = 0;
    this.wallDeadline = 0;
    log("info", "worker.lease_lost", { reason });
    for (const listener of this.listeners) {
      try { listener(); }
      catch { log("error", "worker.lease_interrupt_failed"); }
    }
  }
}
