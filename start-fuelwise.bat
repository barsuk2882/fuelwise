@echo off
chcp 65001 >nul
title FuelWise V3 — локальный сервер
cd /d "%~dp0"

if not exist "index.html" (
  echo Не найден index.html в папке проекта:
  echo %CD%
  pause
  exit /b 1
)

echo FuelWise V3 запускает локальный сервер на порту 8880.
echo После строки Serving HTTP откройте в этом же компьютере:
echo http://127.0.0.1:8880/
echo Не закрывайте это окно, пока пользуетесь приложением.
echo.

where python >nul 2>nul
if not errorlevel 1 (
  python -u -m http.server 8880 --bind 127.0.0.1
  goto server_stopped
)

where py >nul 2>nul
if not errorlevel 1 (
  py -3 -u -m http.server 8880 --bind 127.0.0.1
  goto server_stopped
)

echo Не найден Python 3. Установите Python 3 или запустите проект через локальный сервер.
pause
exit /b 1

:server_stopped
echo Сервер завершил работу. Проверьте сообщение Python выше.
pause
exit /b 1
