@echo off
REM ==========================================================================
REM Encoding note: keep this file UTF-8 (no BOM) + CRLF, for the same reason
REM as start.bat: cmd.exe mis-parses a UTF-8 batch file when the console code
REM page changes while it is reading the file. This ASCII-only header switches
REM the console to UTF-8 and re-runs the script in a NEW cmd process whose
REM parser starts in UTF-8 from the first byte. Keep the header ASCII-only.
REM ==========================================================================
REM cleanup-background-service.bat
REM
REM Stops Board Game Hall servers that were started in the background without
REM a console window, and cleans up stuck DSH background-job runners that
REM launched them. Such leftovers keep DSH showing "N background tasks running"
REM even though there is no cmd window to close.
REM
REM Usage: run /h, or double-click and follow the prompts.
REM ==========================================================================
if defined BG_SCRIPT_UTF8 goto main
setlocal
set "BG_SCRIPT_UTF8=1"
chcp 65001 >nul
"%COMSPEC%" /d /c call "%~f0" %*
set "BG_SCRIPT_RC=%errorlevel%"
exit /b %BG_SCRIPT_RC%

:main
@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul
title 清理后台运行的大厅服务
cd /d "%~dp0.."
set "ROOT=%CD%"
set "PORTS="
set "ASSUME_YES=0"
set "CHECK_ONLY=0"
set "FORCE=0"
set "NO_PAUSE=0"
set "RC=0"

REM ---- parse arguments ----------------------------------------------------
for %%A in (%*) do (
  set "ARG=%%~A"
  if /i "!ARG!"=="/y" (
    set "ASSUME_YES=1"
  ) else if /i "!ARG!"=="-y" (
    set "ASSUME_YES=1"
  ) else if /i "!ARG!"=="/yes" (
    set "ASSUME_YES=1"
  ) else if /i "!ARG!"=="/check" (
    set "CHECK_ONLY=1"
  ) else if /i "!ARG!"=="--check" (
    set "CHECK_ONLY=1"
  ) else if /i "!ARG!"=="/force" (
    set "FORCE=1"
  ) else if /i "!ARG!"=="-f" (
    set "FORCE=1"
  ) else if /i "!ARG!"=="/nopause" (
    set "NO_PAUSE=1"
  ) else if /i "!ARG!"=="/h" (
    goto :usage
  ) else if /i "!ARG!"=="/help" (
    goto :usage
  ) else (
    echo(!ARG!|findstr /r "^[0-9][0-9]*$" >nul
    if errorlevel 1 (
      echo [错误] 无法识别的参数：!ARG!
      echo        用 /h 查看用法。
      set "RC=2"
      goto :finish
    ) else (
      if defined PORTS (
        set "PORTS=!PORTS! !ARG!"
      ) else (
        set "PORTS=!ARG!"
      )
    )
  )
)
if not defined PORTS set "PORTS=8787 8788"

echo.
echo ==============================================================
echo   清理后台运行的大厅服务
echo ==============================================================
echo   项目目录 : !ROOT!
echo   检查端口 : !PORTS!
echo.

where powershell >nul 2>nul
if errorlevel 1 (
  echo [错误] 找不到 PowerShell，本脚本需要 Windows PowerShell 来识别进程。
  set "RC=2"
  goto :finish
)

REM ---- build the port array literal used by the PowerShell probes ----------
set "PORTLIST="
for %%P in (!PORTS!) do (
  if defined PORTLIST (
    set "PORTLIST=!PORTLIST!,%%P"
  ) else (
    set "PORTLIST=%%P"
  )
)
set "PORTLIST=@(!PORTLIST!)"

REM Lists every listener on the requested ports as: port|pid|name|flag|cmdline
REM flag=OK means the owner is node.exe running server.js (the hall server).
set "PSDETECT=$ports=!PORTLIST!; Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $ports -contains $_.LocalPort } | Sort-Object LocalPort,OwningProcess -Unique | ForEach-Object { $op=$_.OwningProcess; $proc=Get-CimInstance Win32_Process -Filter ('ProcessId=' + $op) -ErrorAction SilentlyContinue; $n=if($proc){$proc.Name}else{'?'}; $c=if($proc){[string]$proc.CommandLine}else{''}; $f=if($n -eq 'node.exe' -and $c -match 'server\.js'){'OK'}else{'OTHER'}; $c=$c -replace '\|','/'; $c=$c.Replace([string][char]33,''); if($c.Length -gt 120){$c=$c.Substring(0,120)}; ('{0}|{1}|{2}|{3}|{4}' -f $_.LocalPort,$op,$n,$f,$c) }"

REM Lists stuck background-job runners (node runner.js) that launched a hidden
REM hall server as: pid|cmdline
set "PSSTALE=Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'dsh-subprocess-local' -and $_.CommandLine -match 'runner\.js' -and ($_.CommandLine -match 'hall-server-restart' -or $_.CommandLine -match 'BOARDGAME_NO_OPEN') } | ForEach-Object { $c=[string]$_.CommandLine; $c=$c -replace '\|','/'; $c=$c.Replace([string][char]33,''); if($c.Length -gt 120){$c=$c.Substring(0,120)}; ('{0}|{1}' -f $_.ProcessId,$c) }"

REM ---- scan ---------------------------------------------------------------
call :detect verbose
if "!D_ANY!"=="0" (
  echo   没有发现监听目标端口的大厅服务进程。
  echo.
)

call :detect_stale verbose
if "!S_COUNT!"=="0" (
  echo   没有发现卡住的 DSH 后台任务 runner。
  echo.
)

set "NEED=0"
if not "!D_COUNT!"=="0" set "NEED=1"
if not "!S_COUNT!"=="0" set "NEED=1"
if "!NEED!"=="0" (
  echo   [完成] 后台没有需要清理的大厅服务。
  set "RC=0"
  goto :finish
)

echo --------------------------------------------------------------
echo   即将结束：大厅服务 !D_COUNT! 个，残留后台任务 runner !S_COUNT! 个。
echo --------------------------------------------------------------
echo.
if "!CHECK_ONLY!"=="1" (
  echo   [检查模式] 未结束任何进程。去掉 /check 重新运行即可清理。
  set "RC=0"
  goto :finish
)
if "!ASSUME_YES!"=="0" (
  set "ANS="
  set /p "ANS=  确认结束以上进程？输入 Y 回车确认，直接回车取消："
  if /i not "!ANS!"=="y" (
    echo   已取消，未做任何修改。
    set "RC=0"
    goto :finish
  )
)

REM ---- kill ---------------------------------------------------------------
echo.
set "KILLED=0"
set "FAILED=0"
for %%P in (!D_TARGETS! !S_TARGETS!) do (
  if not "%%P"=="" (
    taskkill /PID %%P /F >nul 2>nul
    if errorlevel 1 (
      echo   [警告] PID %%P 结束失败，可能已经自行退出。
      set /a FAILED+=1
    ) else (
      echo   [已结束] PID %%P
      set /a KILLED+=1
    )
  )
)

echo.
echo   等待端口释放...
set "WAIT=0"
:wait_ports
ping -n 2 127.0.0.1 >nul 2>nul
call :detect quiet
if "!D_COUNT!"=="0" goto :ports_released
set /a WAIT+=1
if !WAIT! lss 5 goto :wait_ports
:ports_released
call :detect_stale quiet

echo.
if "!D_COUNT!"=="0" (
  echo   [结果] 目标端口已全部释放。
) else (
  echo   [结果] 仍有 !D_COUNT! 个目标端口被占用，可能进程拒绝退出或权限不足。
)
if not "!S_COUNT!"=="0" (
  echo   [结果] 仍有 !S_COUNT! 个卡住的 DSH 后台任务 runner。
)

set "ALLDONE=1"
if not "!D_COUNT!"=="0" set "ALLDONE=0"
if not "!S_COUNT!"=="0" set "ALLDONE=0"
echo.
if "!ALLDONE!"=="1" (
  echo   清理完成。若 DSH 会话原本显示「后台任务运行中」，该任务会在几秒内结算并消失；
  echo   若仍显示，回到对应会话等一两秒或刷新页面即可。
  echo.
  echo   重新启动大厅：双击项目根目录的 start.bat，会得到一个可以用窗口关闭的 cmd。
  echo   尽量不要把大厅作为 DSH 后台任务启动：后台任务要等它启动的服务退出才会结算。
  set "RC=0"
) else (
  echo   部分进程没有清理干净。可在任务管理器「详细信息」里按上面的 PID 手动结束。
  set "RC=1"
)
goto :finish

REM ==========================================================================
REM Helpers
REM ==========================================================================
:finish
if not "!NO_PAUSE!"=="1" (
  echo.
  echo 按任意键退出...
  pause >nul
)
exit /b !RC!

:usage
echo.
echo 用法：双击运行，或在命令行调用：
echo   cleanup-background-service.bat [端口...] [选项]
echo.
echo 作用：
echo   结束在后台（无窗口）运行、让 DSH 一直显示「N 个后台任务运行中」的桌游大厅服务，
echo   并顺带清理卡住的后台任务 runner。
echo.
echo 选项：
echo   /y        跳过确认，直接结束进程
echo   /check    只检查并列出，不结束任何进程
echo   /force    端口被其他程序占用时也强制结束（默认跳过非大厅进程）
echo   /nopause  结束后不等待按键（用于脚本或自动化）
echo   /h /help  显示本帮助
echo.
echo 端口：默认检查 8787 和 8788（8788 是 tools\dual-start.bat 的访客实例），
echo       也可以传数字参数覆盖，例如：cleanup-background-service.bat 8787 /y
set "RC=0"
goto :finish

REM ---- probe listeners, set D_COUNT / D_TARGETS / D_ANY -------------------
REM %1 = verbose to print findings, quiet to stay silent
:detect
set "D_COUNT=0"
set "D_TARGETS="
set "D_ANY=0"
for /f "tokens=1,2,3,4* delims=|" %%A in ('powershell -NoProfile -ExecutionPolicy Bypass -Command "!PSDETECT!"') do (
  set "D_ANY=1"
  if /i "%%D"=="OK" (
    set /a D_COUNT+=1
    set "D_TARGETS=!D_TARGETS! %%B"
    if /i "%~1"=="verbose" (
      echo   [发现] 端口 %%A   PID %%B
      echo          进程: %%C
      echo          命令行: %%E
    )
  ) else (
    if "!FORCE!"=="1" (
      set /a D_COUNT+=1
      set "D_TARGETS=!D_TARGETS! %%B"
      if /i "%~1"=="verbose" (
        echo   [强制] 端口 %%A   PID %%B   进程 %%C
        echo          命令行: %%E
        echo          注意：命令行不含 server.js，/force 仍会结束它。
      )
    ) else (
      if /i "%~1"=="verbose" (
        echo   [跳过] 端口 %%A 被 %%C（PID %%B）占用，不像大厅服务；加 /force 可强制结束。
      )
    )
  )
)
goto :eof

REM ---- probe stuck DSH background-job runners, set S_COUNT / S_TARGETS -----
REM %1 = verbose to print findings, quiet to stay silent
:detect_stale
set "S_COUNT=0"
set "S_TARGETS="
for /f "tokens=1,2* delims=|" %%A in ('powershell -NoProfile -ExecutionPolicy Bypass -Command "!PSSTALE!"') do (
  set /a S_COUNT+=1
  set "S_TARGETS=!S_TARGETS! %%A"
  if /i "%~1"=="verbose" (
    echo   [残留后台任务] PID %%A
    echo          命令行: %%B
  )
)
goto :eof
