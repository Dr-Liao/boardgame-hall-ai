#!/bin/bash
# 免安装版启动器（协议 2），行为与 tools/windows/Launcher.cs 相同，目录布局与 current.ini 见 lib/install.js。
#   1. 按 current.ini 选择 app-* 与 runtime-* 目录；指针缺失或损坏时取最高版本，再回退到旧布局 app/runtime。
#   2. 子进程以 75 退出表示更新已就绪，重新读取 current.ini 后再启动。
#   3. 带 trial=1 的新版本非正常退出时，回滚到 previousApp / previousRuntime，并把版本记入 failed。
ROOT="$(cd "$(dirname "$0")" && pwd)"
POINTER="$ROOT/current.ini"
NODE_NAME="${BOARDGAME_NODE_NAME:-node}"

# Ctrl+C 结束大厅时直接退出，不把中断误判为新版本启动失败。
trap 'exit 130' INT

ini_get() {
  [ -f "$POINTER" ] && sed -n "s/^$1=//p" "$POINTER" | head -n 1 | tr -d '\r'
}
valid_app() { [ -n "$1" ] && [ -f "$ROOT/$1/portable.mjs" ]; }
valid_runtime() { [ -n "$1" ] && [ -f "$ROOT/$1/$NODE_NAME" ]; }

highest() {
  local prefix="$1" check="$2" dir name
  for dir in "$ROOT/$prefix"*; do
    [ -d "$dir" ] || continue
    name="$(basename "$dir")"
    case "$name" in *.partial) continue ;; esac
    "$check" "$name" || continue
    printf '%s\n' "${name#"$prefix"}"
  done | sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1 | sed "s/^/$prefix/"
}

resolve() {
  APP_DIR="$(ini_get app)"
  RUNTIME_DIR="$(ini_get runtime)"
  if valid_app "$APP_DIR" && valid_runtime "$RUNTIME_DIR"; then return 0; fi
  APP_DIR="$(highest app- valid_app)"
  if [ -z "$APP_DIR" ] && valid_app app; then APP_DIR=app; fi
  RUNTIME_DIR="$(highest runtime- valid_runtime)"
  if [ -z "$RUNTIME_DIR" ] && valid_runtime runtime; then RUNTIME_DIR=runtime; fi
  [ -n "$APP_DIR" ] && [ -n "$RUNTIME_DIR" ]
}

rollback() {
  [ "$(ini_get trial)" = "1" ] || return 1
  local app previous previous_runtime failed version
  app="$(ini_get app)"
  previous="$(ini_get previousApp)"
  previous_runtime="$(ini_get previousRuntime)"
  [ -n "$previous_runtime" ] || previous_runtime="$(ini_get runtime)"
  [ -n "$app" ] && valid_app "$previous" && valid_runtime "$previous_runtime" || return 1
  version="${app#app-}"
  failed="$(ini_get failed)"
  case ",$failed," in
    *",$version,"*) ;;
    *) failed="${failed:+$failed,}$version" ;;
  esac
  printf 'app=%s\nruntime=%s\nfailed=%s\n' "$previous" "$previous_runtime" "$failed" > "$POINTER.tmp" && mv -f "$POINTER.tmp" "$POINTER"
}

# Node 的 fetch 不读 macOS 系统代理，只认 HTTPS_PROXY 等环境变量，且要 NODE_USE_ENV_PROXY=1（Node 22.21+）才生效。
apply_system_proxy() {
  if [ -z "${HTTPS_PROXY:-}${https_proxy:-}${HTTP_PROXY:-}${http_proxy:-}" ] && command -v scutil >/dev/null 2>&1; then
    local address
    address="$(scutil --proxy 2>/dev/null | awk '
      $1 == "HTTPSEnable" { enabled = $3 } $1 == "HTTPSProxy" { host = $3 } $1 == "HTTPSPort" { port = $3 }
      END { if (enabled == "1" && host != "" && port != "") print "http://" host ":" port }')"
    if [ -n "$address" ]; then
      export HTTPS_PROXY="$address" HTTP_PROXY="$address"
      [ -n "${NO_PROXY:-}${no_proxy:-}" ] || export NO_PROXY="localhost,127.0.0.1,::1"
      echo "  使用系统代理：$address"
    fi
  fi
  [ -n "${NODE_USE_ENV_PROXY:-}" ] || export NODE_USE_ENV_PROXY=1
}
apply_system_proxy

restarts=0
rolled_back=0
while true; do
  if ! resolve; then
    echo "无法启动：找不到程序或运行时文件夹。请完整解压发布包，不要单独移动启动文件。"
    [ -t 0 ] && read -r -p "按回车关闭..."
    exit 1
  fi
  export DSH_HOME="$ROOT/user-data" BOARDGAME_INSTALL_ROOT="$ROOT" BOARDGAME_LAUNCHER=2
  (cd "$ROOT/$APP_DIR" && "$ROOT/$RUNTIME_DIR/$NODE_NAME" --disable-warning=UNDICI-EHPA portable.mjs)
  STATUS=$?
  if [ "$STATUS" -eq 75 ] && [ "$restarts" -lt 20 ]; then
    restarts=$((restarts + 1))
    continue
  fi
  if [ "$STATUS" -ne 0 ] && [ "$STATUS" -ne 75 ] && [ "$rolled_back" -eq 0 ] && rollback; then
    rolled_back=1
    echo
    echo "新版本启动失败，已自动回滚到上一版本，正在重新启动……"
    continue
  fi
  if [ "$STATUS" -ne 0 ]; then
    echo
    [ -t 0 ] && read -r -p "启动失败，请查看上方信息。按回车关闭..."
  fi
  exit "$STATUS"
done
