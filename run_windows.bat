@echo off
title Antigravity Bridge Server (Node.js Edition)
cd /d "%~dp0"

echo ============================================================
echo   Antigravity Bridge Server (Node.js Edition) - Windows
echo ============================================================
echo   Port: 8008
echo   Host: 127.0.0.1
echo ============================================================
echo.

node src\index.mjs --port 8008 --host 127.0.0.1
if errorlevel 1 (
    echo.
    echo [ERROR] Server exited with error.
    pause
)
