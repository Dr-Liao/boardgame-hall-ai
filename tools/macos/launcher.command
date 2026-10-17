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

restarts=0
rolled_back=0
while true; do
  if ! resolve; then
    echo "无法启动：找不到程序或运行时文件夹。请完整解压发布包，不要单独移动启动文件。"
    [ -t 0 ] && read -r -p "按回车关闭..."
    exit 1
  fi
  export DSH_HOME="$ROOT/user-data" BOARDGAME_INSTALL_ROOT="$ROOT" BOARDGAME_LAUNCHER=2
  (cd "$ROOT/$APP_DIR" && "$ROOT/$RUNTIME_DIR/$NODE_NAME" portable.mjs)
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
