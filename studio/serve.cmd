@echo off
rem 小部件设计工具 · 本地服务器（必须用服务器打开：file:// 下创建不了 worker）
rem 用法：serve.cmd                  → 用主题快照（不必有 App 仓库）
rem       serve.cmd 8611 <App 仓库>  → 直读 App 仓库的 res/ 与组件库（改了立刻生效）
setlocal
set PORT=%~1
if "%PORT%"=="" set PORT=8611
set APP=%~2
set PY=
where python >nul 2>nul
if %errorlevel%==0 set PY=python
if not defined PY (
  where py >nul 2>nul
  if %errorlevel%==0 set PY=py
)
if not defined PY (
  echo [x] 没找到 python。可以改用: npx serve -l %PORT% .
  echo     注意 npx serve 也会缓存，改完代码记得硬刷新 Ctrl+F5
  pause
  goto :eof
)
start "" "http://127.0.0.1:%PORT%/studio/"
if "%APP%"=="" (
  %PY% "%~dp0serve.py" %PORT%
) else (
  %PY% "%~dp0serve.py" %PORT% --app "%APP%"
)
