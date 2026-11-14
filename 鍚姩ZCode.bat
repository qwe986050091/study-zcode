@echo off
setlocal
set "PATH=D:\program\ZCodeEnv\node;%PATH%"
set "COREPACK_ENABLE_PROJECT_SPEC=0"
set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
set "ELECTRON_CACHE=D:\program\ZCodeEnv\electron-cache"
set "npm_config_store_dir=D:\program\ZCodeEnv\pnpm-store"
cd /d "%~dp0"
call pnpm dev:desktop
