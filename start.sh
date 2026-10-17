#!/usr/bin/env bash
# 一键打开桌游大厅
#   启动服务并自动打开浏览器；若已在运行则只打开浏览器。
# 用法：bash start.sh
#   端口/地址可用 BOARDGAME_PORT / BOARDGAME_HOST 覆盖。

set -u
cd "$(dirname "$0")"

PORT="${BOARDGAME_PORT:-8787}"
HOST="${BOARDGAME_HOST:-127.0.0.1}"
URL="http://${HOST}:${PORT}"

open_browser() {
  case "$(uname -s 2>/dev/null)" in
    Darwin) open "$URL" ;;
    Linux|FreeBSD)
      if command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL"; else echo "  请手动访问 ${URL}"; fi
      ;;
    *)  # Windows（Git Bash / MSYS）
      cmd //c start "" "$URL" 2>/dev/null || echo "  请手动访问 ${URL}"
      ;;
  esac
}

if ! command -v node >/dev/null 2>&1; then
  echo "❌ 未找到 Node.js，请先安装：https://nodejs.org"
  exit 1
fi

# 服务已在运行则只打开浏览器
if node -e "require('http').get('${URL}/', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))" 2>/dev/null; then
  echo "🎲 桌游大厅已在运行：${URL}"
  open_browser
else
  echo "🎲 正在启动桌游大厅：${URL}"
  exec node server.js
fi
