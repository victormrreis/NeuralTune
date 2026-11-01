# Script de Restauração e Reversão Segura do NeuralTune
# Autor: Victor Martins
$ErrorActionPreference = "Stop"

Write-Host "=== RESTAURACAO / DESINSTALACAO DO NEURALTUNE ===" -ForegroundColor Yellow

$configFile = (Join-Path $env:APPDATA "spicetify\config-xpui.ini")
$backupFile = (Join-Path $env:APPDATA "spicetify\config-xpui.ini.neuraltune.bak")
$installedExt = (Join-Path $env:APPDATA "spicetify\Extensions\neuraltune.js")

# 1. Remove da configuracao do Spicetify
Write-Host "[Spicetify] Desativando extensao neuraltune.js..." -ForegroundColor Cyan
spicetify config extensions neuraltune.js-

# 2. Restaura o backup do config-xpui.ini se existir
if (Test-Path $backupFile) {
    Copy-Item -Path $backupFile -Destination $configFile -Force
    Write-Host "[Segurança] Configuracao anterior restaurada a partir de: $backupFile" -ForegroundColor Green
}

# 3. Aplica ao Spotify
Write-Host "[Spicetify] Reaplicando configuracao original ao Spotify..." -ForegroundColor Cyan
spicetify apply

Write-Host "=== NEURALTUNE DESATIVADO E AMBIENTE RESTAURADO COM SUCESSO! ===" -ForegroundColor Green
