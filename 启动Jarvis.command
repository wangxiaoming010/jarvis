#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "需要 Node.js 22.18 或以上版本。此源码开发版尚未打包运行环境。"
  exit 1
fi
node -e 'const [major,minor]=process.versions.node.split(".").map(Number); if(major<22||(major===22&&minor<18)){process.stderr.write("需要 Node.js 22.18 或以上版本。\n");process.exit(1)}'
if [[ ! -d node_modules ]]; then npm ci; fi
npm run build
export JARVIS_OPEN=1
exec npm start
