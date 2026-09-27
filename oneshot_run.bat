@echo off
cd /d "%~dp0"

:: 1. 혹시 남아있을 기존 노드 서버 깔끔하게 정리
taskkill /F /IM node.exe 2>nul

echo 🚀 1. KOSPI 서버를 실행합니다...
start "KOSPI Server" cmd /k "node --watch krx_server.js"

echo ⏳ 2. 서버 대기 중 (2초)...
timeout /t 2 /nobreak > nul

echo 🌐 3. 브라우저 접속!
start http://localhost:3000/stock_management_system_krx.html