import React, { useEffect, useState } from "react";
import type { CloudView, Receipt } from "../shared/relay";
import type { WorkbenchClient } from "./client";

const receiptNames: Record<Receipt["status"], string> = {
  queued: "待 Mac 接收",
  delivered: "已投递，等待应用回执",
  applied: "Mac 已应用",
  rejected: "Mac 拒绝",
  unknown: "结果不明，需核实",
  expired: "已过期，未应用",
};
const linkNames = {
  unpaired: "尚未配对",
  online: "Mac 已连接",
  offline: "Mac 离线",
  revoked: "连接已撤销",
};
export function CloudPanel({
  view,
  unavailable,
  client,
  refresh,
  onLogout,
}: {
  view: CloudView;
  unavailable: string;
  client: WorkbenchClient;
  refresh: () => Promise<void>;
  onLogout: () => void;
}) {
  const [pair, setPair] = useState<{ code: string; expiresAt: string } | null>(
    null,
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (view.link.state === "online" || view.link.state === "offline")
      setPair(null);
  }, [view.link.state]);
  const perform = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action();
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "连接操作失败");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="cloud-panel" aria-label="云端连接与回执">
      <div className="cloud-heading">
        <div>
          <strong>
            {unavailable ? "云端连接中断" : linkNames[view.link.state]}
          </strong>
          <p>
            {!unavailable && view.link.state === "online"
              ? "云端派单 · Mac 专用目录执行"
              : "当前不能确认 Mac 执行状态。离线时只保存派单，不生成新回复。"}
            {view.link.lastSyncedAt && (
              <>
                {" "}
                最后同步{" "}
                {new Date(view.link.lastSyncedAt).toLocaleString("zh-CN")}
              </>
            )}
          </p>
        </div>
        <div className="actions">
          {view.link.state === "unpaired" || view.link.state === "revoked" ? (
            <button
              disabled={busy}
              onClick={() =>
                void perform(async () => setPair(await client.pair()))
              }
            >
              生成 Mac 配对码
            </button>
          ) : (
            <button
              disabled={busy}
              onClick={() => {
                if (
                  window.confirm(
                    "撤销后停止派单，并在 Mac 察觉断线或租约到期后尝试中断执行。不能保证已发出的请求立即停止。确认撤销？",
                  )
                )
                  void perform(() => client.revoke());
              }}
            >
              撤销 Mac 连接
            </button>
          )}
          <button
            disabled={busy}
            onClick={() =>
              void perform(async () => {
                await client.logout();
                onLogout();
              })
            }
          >
            退出登录
          </button>
        </div>
      </div>
      {unavailable && (
        <p className="warning" role="alert">
          无法连接云端，以下仅为上次同步，不能确认当前执行状态。{unavailable}
        </p>
      )}
      {error && (
        <div className="alert" role="alert">
          {error}
        </div>
      )}
      {pair && (
        <div className="pair-code">
          <label>
            一次性配对码
            <input
              aria-label="一次性配对码"
              readOnly
              value={pair.code}
              autoComplete="off"
            />
          </label>
          <p>
            在 Mac 运行 <code>npm run worker:pair</code>{" "}
            后粘贴。请勿分享或提交。有效期至{" "}
            {new Date(pair.expiresAt).toLocaleTimeString("zh-CN")}。
          </p>
        </div>
      )}
      {view.receipts.some((receipt) => receipt.status === "unknown") && (
        <p className="warning" role="alert">
          有操作结果不明。系统不会自动重放，请先在 Mac
          核实业务状态和旧进程。重新提交会产生新操作，可能重复已有结果。
        </p>
      )}
      {view.receipts.length > 0 && (
        <details className="receipts">
          <summary>
            派单回执 ·{" "}
            {
              view.receipts.filter(
                (r) => r.status === "queued" || r.status === "delivered",
              ).length
            }{" "}
            项等待确认
          </summary>
          <p>
            “Mac
            已应用”只确认业务操作已应用，不代表任务已完成或取消已生效。请查看任务状态。
          </p>
          <ul>
            {view.receipts.map((receipt) => (
              <li key={receipt.commandId}>
                <code>{receipt.commandId.slice(0, 8)}</code>
                <strong>{receiptNames[receipt.status]}</strong>
                {"code" in receipt && <span>{receipt.code}</span>}
                <time>
                  {new Date(receipt.updatedAt).toLocaleTimeString("zh-CN")}
                </time>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
