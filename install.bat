@echo off
setlocal

title apex-reach installer
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found in PATH.
  echo Install Node.js 20 or newer, then run this file again.
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm was not found in PATH.
  exit /b 1
)

for /f "tokens=*" %%v in ('node --version') do echo Using Node.js %%v

echo Installing build dependencies...
call npm ci
if errorlevel 1 goto :failed

echo Building apex-reach...
call npm run build
if errorlevel 1 goto :failed

if "%APEX_REACH_INSTALL_DIR%"=="" (
  set "INSTALL_DIR=%LOCALAPPDATA%\apex-reach"
) else (
  set "INSTALL_DIR=%APEX_REACH_INSTALL_DIR%"
)
set "BIN_DIR=%INSTALL_DIR%\bin"

if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%"
if not exist "%BIN_DIR%" mkdir "%BIN_DIR%"

echo Installing into %INSTALL_DIR%...
xcopy "%~dp0dist" "%INSTALL_DIR%\dist" /E /I /Y /Q >nul
copy /Y "%~dp0package.json" "%INSTALL_DIR%\package.json" >nul
copy /Y "%~dp0package-lock.json" "%INSTALL_DIR%\package-lock.json" >nul
copy /Y "%~dp0README.md" "%INSTALL_DIR%\README.md" >nul
copy /Y "%~dp0LICENSE" "%INSTALL_DIR%\LICENSE" >nul

pushd "%INSTALL_DIR%"
call npm ci --omit=dev
if errorlevel 1 (
  popd
  goto :failed
)
popd

> "%BIN_DIR%\apex-reach.cmd" echo @echo off
>> "%BIN_DIR%\apex-reach.cmd" echo node "%%~dp0..\dist\cli.js" %%*

if not "%APEX_REACH_SKIP_PATH%"=="1" (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$bin=[IO.Path]::GetFullPath('%BIN_DIR%'); $userPath=[Environment]::GetEnvironmentVariable('Path','User'); $parts=@($userPath -split ';' ^| Where-Object { $_ }); if ($parts -notcontains $bin) { [Environment]::SetEnvironmentVariable('Path', (($parts + $bin) -join ';'), 'User') }"
  if errorlevel 1 goto :failed
)

call "%BIN_DIR%\apex-reach.cmd" --version
if errorlevel 1 goto :failed

echo.
echo apex-reach installed successfully.
echo Open a new terminal and run:
echo   apex-reach C:\path\to\your\sfdx-project
echo.
exit /b 0

:failed
echo.
echo [ERROR] Installation failed.
exit /b 1
