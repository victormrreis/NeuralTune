# Script de Instalação Segura do NeuralTune no Spicetify
# Autor: Victor Martins
$ErrorActionPreference = "Stop"

Write-Host "=== INSTALACAO DO NEURALTUNE NO SPICETIFY ===" -ForegroundColor Cyan

$projectDir = (Split-Path -Parent $PSScriptRoot)
$bundlePath = Join-Path $projectDir "dist\neuraltune.js"
$spicetifyExtDir = (Join-Path $env:APPDATA "spicetify\Extensions")
$targetFile = Join-Path $spicetifyExtDir "neuraltune.js"
$configFile = (Join-Path $env:APPDATA "spicetify\config-xpui.ini")
$backupFile = (Join-Path $env:APPDATA "spicetify\config-xpui.ini.neuraltune.bak")

# 1. Verifica se o build foi gerado
if (-not (Test-Path $bundlePath)) {
    Write-Host "Arquivo dist\neuraltune.js nao encontrado. Compilando..." -ForegroundColor Yellow
    Set-Location $projectDir
    node scripts/build.mjs
}

# 2. Backup da configuracao atual do Spicetify
if (Test-Path $configFile) {
    Copy-Item -Path $configFile -Destination $backupFile -Force
    Write-Host "[Segurança] Backup de config-xpui.ini salvo em: $backupFile" -ForegroundColor Green
}

# 3. Copia a extensao para o diretorio de extensoes do Spicetify
if (-not (Test-Path $spicetifyExtDir)) {
    New-Item -ItemType Directory -Path $spicetifyExtDir -Force | Out-Null
}

Copy-Item -Path $bundlePath -Destination $targetFile -Force
Write-Host "[Arquivo] Extensao copiada para: $targetFile" -ForegroundColor Green

# 4. Registra no Spicetify
Write-Host "[Spicetify] Registrando extensao neuraltune.js..." -ForegroundColor Cyan
spicetify config extensions neuraltune.js

Write-Host "[Spicetify] Aplicando modificacoes ao cliente Spotify..." -ForegroundColor Cyan
spicetify apply

Write-Host "=== INSTALACAO CONCLUIDA COM SUCESSO! ===" -ForegroundColor Green
Write-Host "Para reverter a qualquer momento, execute: powershell scripts/restore-backup.ps1" -ForegroundColor Yellow
