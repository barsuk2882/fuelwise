@echo off
setlocal
set "PROJECT_DIR=%~dp0"
set "APP_URL=http://localhost:8876/"

if not exist "%PROJECT_DIR%index.html" (
  echo Не найден index.html в папке:
  echo %PROJECT_DIR%
  pause
  exit /b 1
)

rem Порт и кэш V3 отделены от исходной версии приложения.
call :check_v3
if not errorlevel 1 goto open_app
if errorlevel 2 (
  echo Порт 8876 занят другим приложением. Закройте его и запустите BAT снова.
  pause
  exit /b 1
)

where python >nul 2>nul
if not errorlevel 1 (
  start "FuelWise V3 — сервер" /D "%PROJECT_DIR%" cmd /k python -m http.server 8876 --bind 127.0.0.1
) else (
  where py >nul 2>nul
  if not errorlevel 1 (
    start "FuelWise V3 — сервер" /D "%PROJECT_DIR%" cmd /k py -3 -m http.server 8876 --bind 127.0.0.1
  ) else (
    echo Не найден Python 3. Установите Python 3 или запустите проект вручную через локальный сервер.
    pause
    exit /b 1
  )
)

echo Ожидаю запуска локального сервера...
for /l %%i in (1,1,15) do (
  timeout /t 1 /nobreak >nul
  call :check_v3
  if not errorlevel 1 goto open_app
)

echo Сервер не ответил. Проверьте открытое окно «FuelWise V3 — сервер» на наличие ошибки.
echo Если порт занят, закройте другое приложение на порту 8876 и запустите BAT снова.
pause
exit /b 1

:open_app
echo Сервер FuelWise V2 работает.
echo Адрес: %APP_URL%
start "" "%APP_URL%"
endlocal
exit /b 0

:check_v3
powershell -NoProfile -Command "$r=[Net.HttpWebRequest]::Create('http://127.0.0.1:8876/');$r.Proxy=$null;$r.Timeout=1200;try{$s=$r.GetResponse();$t=(New-Object IO.StreamReader($s.GetResponseStream())).ReadToEnd();$s.Close();if($t -match '<title>FuelWise'){exit 0};exit 2}catch{exit 1}" >nul 2>nul
exit /b %errorlevel%
