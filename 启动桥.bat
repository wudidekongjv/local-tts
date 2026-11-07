@echo off
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [x] 没找到 node，先装 Node.js 再跑这个脚本
  pause
  exit /b 1
)

set BREEZE_BASE=http://127.0.0.1:9000
set BRIDGE_PORT=9001

echo [i] 本地桥启动中，转发的 WebUI 是 %BREEZE_BASE%
node bridge\breeze_bridge.mjs
pause
