# 一键切换桥接运行模式（群友模式 ⇄ 手机遥控模式）
# 用法：
#   pwsh -File tools\switch-mode.ps1            # 只看当前模式
#   pwsh -File tools\switch-mode.ps1 reserved2      # 群友模式（群里自动接话）
#   pwsh -File tools\switch-mode.ps1 closed-agent   # 手机遥控 DSH（群里不说话）
param([string]$Mode = 'status')

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$cfg = Get-Content (Join-Path $root 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$port = if ($cfg.consolePort) { $cfg.consolePort } else { 3100 }
$tokenFile = Join-Path $root 'state\console-token'
$modeFile = Join-Path $root 'state\mode.json'

if (-not (Test-Path $tokenFile)) { Write-Host '找不到 state\console-token，桥接可能没启动过。' -ForegroundColor Red; exit 1 }
$token = (Get-Content $tokenFile -Raw).Trim()

$current = if (Test-Path $modeFile) { (Get-Content $modeFile -Raw | ConvertFrom-Json).mode } else { '?' }

$labels = @{
    'reserved2'    = '群友模式（群里自动接话，20% 概率）'
    'closed-agent' = '手机遥控模式（只回你私聊，给完整工具，群里不说话）'
    'chat'         = '普通聊天模式（白名单私聊/群，安全聊天）'
}

if ($Mode -eq 'status') {
    Write-Host "当前模式：$current — $($labels[$current])" -ForegroundColor Cyan
    exit 0
}

if ($Mode -notin @('reserved2', 'closed-agent', 'chat')) {
    Write-Host "未知模式：$Mode（可选 reserved2 / closed-agent / chat）" -ForegroundColor Red
    exit 1
}

$body = @{ mode = $Mode } | ConvertTo-Json -Compress
try {
    $resp = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/mode" -Method Post `
        -Headers @{ 'x-console-token' = $token } -ContentType 'application/json' -Body $body -TimeoutSec 15
} catch {
    Write-Host "切换失败：桥接控制台没响应（http://127.0.0.1:$port）。先确认桥接窗口还在。" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor DarkGray
    exit 1
}

if ($resp.ok -eq $false) { Write-Host "切换被拒绝：$($resp.error)" -ForegroundColor Red; exit 1 }
$now = if (Test-Path $modeFile) { (Get-Content $modeFile -Raw | ConvertFrom-Json).mode } else { $Mode }
Write-Host "已切换：$current → $now" -ForegroundColor Green
Write-Host "现在：$($labels[$now])" -ForegroundColor Cyan
Write-Host '（DSH 侧设置已同步写入，会话会自动重建，不用重启桥接）' -ForegroundColor DarkGray
