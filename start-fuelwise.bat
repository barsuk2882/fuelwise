@echo off
setlocal
chcp 65001 >nul
title FuelWise V5 — локальный сервер
cd /d "%~dp0" || exit /b 1

python -V >nul 2>nul
if not errorlevel 1 (
  python -u serve_fuelwise.py
) else (
  py -3 -V >nul 2>nul
  if errorlevel 1 goto no_python
  py -3 -u serve_fuelwise.py
)
if not errorlevel 1 exit /b 0
goto failed

:no_python
echo Для запуска FuelWise V5 нужен Python 3.
:failed
pause
exit /b 1
