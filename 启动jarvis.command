#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
APP="$ROOT"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "$APP"
if ! command -v node >/dev/null 2>&1; then
  echo '[ERROR] 未找到 Node.js，请安装 22.18 或更新版本。'
  exit 1
fi
if [[ ! -x node_modules/.bin/tsx ]]; then
  echo '[ERROR] 依赖未安装完成，不能启动。'
  exit 1
fi
export HOST=127.0.0.1
export PORT=4310
export CLIENT_PORT=1420
export BRAIN_ENABLED=false
export DATABASE_PATH="$APP/.data/openbot.sqlite"
export OPENBOT_WORKERS_PER_BOT=1
export OPENBOT_WORKERS_PER_DEVICE=2
mkdir -p .data
chmod 700 .data
if [[ -x "$APP/.data/codex-wrapper" ]]; then
  export OPENBOT_CODEX_PATH="$APP/.data/codex-wrapper"
fi
# 首次运行使用逐次确认，不沿用上游默认的自动审批设置。
if [[ ! -e .data/execution-settings.json ]]; then
  (umask 077; printf '%s\n' '{"mode":"manual"}' > .data/execution-settings.json)
fi
if ! node -e 'const net=require("node:net"); Promise.all([4310,1420].map(port=>new Promise((resolve,reject)=>{const s=net.createServer();s.once("error",reject);s.listen(port,"127.0.0.1",()=>s.close(resolve));}))).catch(e=>{console.error("[ERROR] 端口已占用或无法监听："+e.message);process.exitCode=1;});'; then
  echo '[ERROR] 请先关闭已有服务，不会终止或接管其他进程。'
  exit 1
fi
echo '[INFO] 正在启动 jarvis。'
echo '[INFO] 浏览器地址 http://127.0.0.1:1420'
echo '[INFO] 关闭此终端或按 Control+C 停止服务。'
node "$APP/scripts/dev.mjs" &
SERVICE_PID=$!
cleanup() {
  trap - INT TERM HUP EXIT
  if kill -0 "$SERVICE_PID" 2>/dev/null; then
    echo '[INFO] 正在停止本次启动的服务。'
    kill -TERM "$SERVICE_PID"
    wait "$SERVICE_PID" || echo '[INFO] 服务已退出。'
  fi
}
trap cleanup INT TERM HUP EXIT
if [[ "${PRIVATE_BOT_NO_OPEN:-0}" != 1 ]]; then
  (
    for attempt in $(seq 1 90); do
      if curl --silent --fail --max-time 1 http://127.0.0.1:1420/ >/dev/null; then
        open 'http://127.0.0.1:1420'
        exit $?
      fi
      if ! kill -0 "$SERVICE_PID" 2>/dev/null; then exit 1; fi
      sleep 1
    done
    echo '[ERROR] 界面未及时就绪，请查看终端中的启动日志。'
    exit 1
  ) &
  OPENER_PID=$!
fi
wait "$SERVICE_PID"
