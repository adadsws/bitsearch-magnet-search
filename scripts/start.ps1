# Prepare the environment and run this project's WebUI in PowerShell.
param([int]$Port = 8766)
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)
$python = Join-Path (Get-Location) '.venv\Scripts\python.exe'
if (-not (Test-Path $python)) { py -3 -m venv .venv }
& $python -m pip install --disable-pip-version-check -r requirements.txt
if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed' }
$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($listener) { throw "Port $Port is occupied; choose another port." }
Start-Process "http://127.0.0.1:$Port/"
& $python -m magnet_search.webui --port $Port
