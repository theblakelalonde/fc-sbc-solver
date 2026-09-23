@echo off
rem Starts the local SBC solver server used by the extension. Close this window to stop it.
cd /d "%~dp0solver-server"
.venv\Scripts\python -m sbc_solver.server
pause
