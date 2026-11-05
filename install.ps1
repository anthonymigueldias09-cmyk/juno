# JUNO - instalador Windows (PowerShell)
$ErrorActionPreference = "Stop"
Write-Host "==============================================" -ForegroundColor Cyan
Write-Host "  JUNO - instalador Windows (PowerShell)"      -ForegroundColor Cyan
Write-Host "==============================================" -ForegroundColor Cyan

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "[ERRO] Node.js nao encontrado. Instale em https://nodejs.org" -ForegroundColor Red
  exit 1
}

Set-Location $PSScriptRoot

Write-Host "[1/3] Instalando via npm (global)..." -ForegroundColor Yellow
npm install -g . --no-fund --no-audit
if ($LASTEXITCODE -ne 0) {
  Write-Host "[AVISO] npm global falhou, tentando no perfil do usuario..." -ForegroundColor Yellow
  npm install -g . --prefix "$env:USERPROFILE\.npm-global" --no-fund --no-audit
}

Write-Host "[2/3] Shim em $env:USERPROFILE\.local\bin ..." -ForegroundColor Yellow
$shimDir = "$env:USERPROFILE\.local\bin"
New-Item -ItemType Directory -Force -Path $shimDir | Out-Null
Copy-Item "$PSScriptRoot\bin\juno-shim.cmd" "$shimDir\juno.cmd" -Force -ErrorAction SilentlyContinue
Copy-Item "$PSScriptRoot\bin\juno-shim.cmd" "$shimDir\juno.ps1" -Force -ErrorAction SilentlyContinue

Write-Host "[3/3] Verificando..." -ForegroundColor Yellow
if (-not (Get-Command juno -ErrorAction SilentlyContinue)) {
  Write-Host "[AVISO] 'juno' nao esta no PATH deste terminal. Abra um novo terminal." -ForegroundColor Yellow
  Write-Host "        Se ainda nao aparecer, adicione ao PATH: $shimDir"
}

Write-Host ""
Write-Host "Instalado! Comandos:" -ForegroundColor Green
Write-Host "  juno              - abre o painel no navegador"
Write-Host "  juno claude       - Claude Code sem login (keys do painel)"
Write-Host "  juno key groq gsk_xxx - salva uma key"
Write-Host "  juno commit 'msg' - commita e envia pro GitHub"
Write-Host ""
juno status
