# 08:00 恢复「正常值」：只回滚临时高频窗口动过的那几组键，其余 config 原样保留。
# 由计划任务「小鱼-频率恢复」在 2026-10-29 08:00 触发，也可手动执行。
#   - 预演：powershell -File tools\restore-normal-freq.ps1 -DryRun
#   - 执行：powershell -File tools\restore-normal-freq.ps1
param([switch]$DryRun)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$log = Join-Path $root 'state\freq-restore.log'

function Write-Log($msg) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Add-Content -Path $log -Value $line -Encoding UTF8
  Write-Output $line
}

$args = @("$root\tools\restore-normal-freq.mjs")
if ($DryRun) { $args += '--dry-run' }

Write-Log "开始恢复临时窗口改动（DryRun=$DryRun）"
$out = & node @args 2>&1
foreach ($line in $out) { Write-Log "  $line" }

if ($DryRun) { Write-Log "预演结束，未写文件"; exit 0 }

# 重启桥接：杀掉当前进程，守护进程会在 15 秒内重新拉起。
$conn = Get-NetTCPConnection -LocalPort 3100 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($conn) {
  Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
  Write-Log "已停止桥接 pid=$($conn.OwningProcess)，等待守护进程重启"
} else {
  Write-Log "桥接当前未在监听 3100，跳过停止步骤"
}

# 删掉自己的计划任务，避免重复触发。
try { schtasks /Delete /TN "小鱼-频率恢复" /F | Out-Null; Write-Log "已删除计划任务" } catch {}
Write-Log "完成"
