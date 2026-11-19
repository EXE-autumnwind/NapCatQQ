@echo off
rem NapCat update-source migration script (Windows)
rem
rem Why: the upstream repo NapNeko/NapCatQQ is archived, so the built-in
rem "check for updates" of older builds can never find a new version.
rem This script replaces the program files in the current install directory
rem with the latest release of the maintenance repo, after which the WebUI
rem checks updates / lists versions / shows temporary builds from that repo.
rem
rem Usage:
rem   migrate-update-source.bat [options]
rem     --dir <path>      NapCat install dir (default: script directory)
rem     --tag <vX.Y.Z>    target version (default: latest release)
rem     --mirror <url>    download mirror prefix, e.g. https://ghproxy.com/
rem     --dry-run         only list files that would be replaced
rem     -h, --help        show this help
rem
rem Kept untouched: config\ data\ logs\ temp\ cache\ and the three boot files
rem (NapCatWinBootMain.exe / NapCatWinBootHook.dll / quickLoginExample.bat)
setlocal EnableDelayedExpansion

set "REPO_OWNER=EXE-autumnwind"
set "REPO_NAME=NapCatQQ"
set "DIR=%~dp0"
set "TAG="
set "MIRROR="
set "DRY=0"

:parse
if "%~1"=="" goto :start
if /i "%~1"=="--dir" goto :arg_dir
if /i "%~1"=="--tag" goto :arg_tag
if /i "%~1"=="--mirror" goto :arg_mirror
if /i "%~1"=="--dry-run" goto :arg_dry
if /i "%~1"=="-h" goto :usage
if /i "%~1"=="--help" goto :usage
echo [migrate] unknown option: %~1
goto :usage

:arg_dir
set "DIR=%~2"
shift
shift
goto :parse

:arg_tag
set "TAG=%~2"
shift
shift
goto :parse

:arg_mirror
set "MIRROR=%~2"
shift
shift
goto :parse

:arg_dry
set "DRY=1"
shift
goto :parse

:usage
echo Usage: %~nx0 [--dir PATH] [--tag vX.Y.Z] [--mirror URL] [--dry-run]
exit /b 1

:start
rem normalize to an absolute path without trailing backslash (cmd chokes on "%X:~-1%"=="\")
for %%A in ("%DIR%") do set "DIR=%%~fA"
if not exist "%DIR%\napcat.mjs" (
  echo [migrate] error: %DIR% does not look like a NapCat directory ^(napcat.mjs not found^)
  exit /b 1
)

rem Same rule as the WebUI updater: napcat.cjs means Framework edition
set "ASSET=NapCat.Shell.zip"
set "EDITION=Shell"
if exist "%DIR%\napcat.cjs" (
  set "ASSET=NapCat.Framework.zip"
  set "EDITION=Framework"
)

if "%TAG%"=="" (
  echo [migrate] resolving latest release of %REPO_OWNER%/%REPO_NAME% ...
  for /f "usebackq delims=" %%i in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; (Invoke-RestMethod -Uri 'https://api.github.com/repos/%REPO_OWNER%/%REPO_NAME%/releases/latest' -Headers @{'User-Agent'='napcat-migrate'}).tag_name"`) do set "TAG=%%i"
)
if "%TAG%"=="" (
  echo [migrate] error: cannot resolve latest version ^(network or API rate limit^), use --tag
  exit /b 1
)

set "URL=https://github.com/%REPO_OWNER%/%REPO_NAME%/releases/download/%TAG%/%ASSET%"
rem Use delayed expansion here: %VAR:~n% inside a block gets mis-parsed by cmd
if not "%MIRROR%"=="" (
  if "!MIRROR:~-1!"=="/" set "MIRROR=!MIRROR:~0,-1!"
  set "URL=!MIRROR!/%URL%"
)
rem For self-hosted mirrors / offline debugging: override the full URL
if not "%NAPCAT_MIGRATE_URL%"=="" set "URL=%NAPCAT_MIGRATE_URL%"

set "TMP=%TEMP%\napcat-migrate-%RANDOM%%RANDOM%"
mkdir "%TMP%" 2>nul

echo [migrate] version: %TAG% ^(%EDITION% edition^)
echo [migrate] download: %URL%
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri '%URL%' -OutFile '%TMP%\%ASSET%' -UseBasicParsing"
if errorlevel 1 (
  echo [migrate] error: download failed
  goto :cleanup_fail
)

echo [migrate] extracting ...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -LiteralPath '%TMP%\%ASSET%' -DestinationPath '%TMP%\pkg' -Force"
if errorlevel 1 (
  echo [migrate] error: extraction failed
  goto :cleanup_fail
)

set "RC_OPTS=/E /R:1 /W:1 /XF NapCatWinBootMain.exe NapCatWinBootHook.dll quickLoginExample.bat /XD config data logs temp cache /NJH /NJS /NP"
if "%DRY%"=="1" (
  rem /L lists files without copying; keep the file list so the user sees what changes
  set "RC_OPTS=!RC_OPTS! /L"
) else (
  set "RC_OPTS=!RC_OPTS! /NFL /NDL"
)

echo [migrate] copying files ...
robocopy "%TMP%\pkg" "%DIR%" %RC_OPTS%
if errorlevel 8 (
  echo [migrate] error: copy failed ^(robocopy exit !ERRORLEVEL!^)
  goto :cleanup_fail
)

if "%DRY%"=="1" (
  echo [migrate] dry-run finished, nothing was written
) else (
  echo [migrate] done: program files replaced, config\ and data\ untouched
  echo [migrate] restart NapCat, then WebUI will check updates from %REPO_OWNER%/%REPO_NAME%
)
rmdir /s /q "%TMP%" 2>nul
exit /b 0

:cleanup_fail
rmdir /s /q "%TMP%" 2>nul
exit /b 1
