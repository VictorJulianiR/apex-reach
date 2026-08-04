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

if "%APEX_REACH_SHIM_DIR%"=="" (
  set "SHIM_DIR=%APPDATA%\npm"
) else (
  set "SHIM_DIR=%APEX_REACH_SHIM_DIR%"
)

if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%"
if not exist "%SHIM_DIR%" mkdir "%SHIM_DIR%"

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

> "%SHIM_DIR%\apex-reach.cmd" echo @echo off
>> "%SHIM_DIR%\apex-reach.cmd" echo node "%INSTALL_DIR%\dist\cli.js" %%*

call "%SHIM_DIR%\apex-reach.cmd" --version
if errorlevel 1 goto :failed

echo.
echo apex-reach installed successfully.
echo Command installed at:
echo   %SHIM_DIR%\apex-reach.cmd
echo.
echo Run:
echo   apex-reach C:\path\to\your\sfdx-project
where apex-reach >nul 2>nul
if errorlevel 1 (
  echo.
  echo If apex-reach is not recognized, run it using the full command path above.
)
echo.
exit /b 0

:failed
echo.
echo [ERROR] Installation failed.
exit /b 1
