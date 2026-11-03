# guardian-bench.ps1 —— 小鱼守护单轮耗时基准
#
# 用法：
#   pwsh -File tools\guardian-bench.ps1
#   pwsh -File tools\guardian-bench.ps1 -Rounds 20
#
# 做什么：连跑 N 轮 `tools\guardian.ps1 -Once`，统计每轮耗时与中位数。
# 判定线：中位 <= 1000ms 达标（绿），> 1000ms 偏慢（黄），> 1500ms 需要查（红）。
# 基线参考：2026-11-02 优化后实测中位约 940ms（优化前 1661ms）。
#
# 计时口径（重要）：
#   每轮都是**另起一个 pwsh 进程**跑 -Once，和计划任务里的真实调用方式一致，
#   所以「每轮总耗时」天然包含 pwsh 解释器启动（约 340ms）。
#   为了能看清守护脚本本身花多少，本脚本会额外单独测一次解释器启动开销，
#   并给出「脚本本体估算中位 = 总中位 - 启动开销」。
#
# 副作用：
#   · 只读运行，不改配置、不动任务、不杀进程、不重启任何服务。
#   · -Once 会刷新 state\guardian.heartbeat —— 跑完心跳会变成「刚刚」，
#     这只是让面板显示更「新」，不影响任何功能（守护本来就每分钟刷一次）。
#
# 注意：不要用 Windows PowerShell 5.1 跑（脚本里有中文与 pwsh 参数约定），用 pwsh 7。

param(
    [int]$Rounds = 10,
    [string]$Guardian = ''
)

$ErrorActionPreference = 'Stop'

if ($Rounds -lt 1) { throw '-Rounds 必须 >= 1' }

$root = Split-Path $PSScriptRoot -Parent
if (-not $Guardian) { $Guardian = Join-Path $PSScriptRoot 'guardian.ps1' }
if (-not (Test-Path $Guardian)) { throw "找不到 guardian.ps1：$Guardian" }

$pwshExe = Join-Path $PSHOME 'pwsh.exe'
if (-not (Test-Path $pwshExe)) { $pwshExe = 'pwsh' }

function Get-Median([double[]]$Values) {
    if (-not $Values -or $Values.Count -eq 0) { return 0 }
    $s = @($Values | Sort-Object)
    $n = $s.Count
    if ($n % 2 -eq 1) { return [double]$s[[int][math]::Floor($n / 2)] }
    return ([double]$s[$n / 2 - 1] + [double]$s[$n / 2]) / 2
}

function Format-Ms([double]$Ms) { return '{0:N0}ms' -f $Ms }

Write-Host ''
Write-Host '守护单轮耗时基准' -ForegroundColor Cyan
Write-Host ("  脚本 = {0}" -f $Guardian)
Write-Host ("  轮数 = {0}（另有 1 轮预热，不计入统计）" -f $Rounds)
Write-Host '  口径 = 每轮另起 pwsh 进程跑 -Once，含解释器启动'
Write-Host ''

# ── 预热：第一轮常因文件系统缓存、模块冷启动偏慢，不计入统计 ────────────────
$null = & $pwshExe -NoProfile -ExecutionPolicy Bypass -File $Guardian -Once 2>&1

# ── 解释器启动开销：空脚本跑 3 次取中位，用来把「每轮总耗时」拆开 ────────────
$startup = @()
for ($i = 0; $i -lt 3; $i++) {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $null = & $pwshExe -NoProfile -Command 'exit 0' 2>&1
    $sw.Stop()
    $startup += $sw.Elapsed.TotalMilliseconds
}
$startupMs = Get-Median $startup

# ── 主测量 ──────────────────────────────────────────────────────────────────
$times = New-Object System.Collections.Generic.List[double]
for ($i = 1; $i -le $Rounds; $i++) {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $null = & $pwshExe -NoProfile -ExecutionPolicy Bypass -File $Guardian -Once 2>&1
    $sw.Stop()
    $ms = $sw.Elapsed.TotalMilliseconds
    $times.Add($ms)
    Write-Host ("  第 {0,2}/{1} 轮：{2}" -f $i, $Rounds, (Format-Ms $ms))
}

$arr = $times.ToArray()
$median = Get-Median $arr
$min = ($arr | Measure-Object -Minimum).Minimum
$max = ($arr | Measure-Object -Maximum).Maximum
$avg = ($arr | Measure-Object -Average).Average
$bodyEstimate = $median - $startupMs

# ── 判定 ────────────────────────────────────────────────────────────────────
if ($median -le 1000) {
    $verdict = '达标（<= 1000ms）'
    $color = 'Green'
} elseif ($median -le 1500) {
    $verdict = '偏慢（> 1000ms，建议看日志）'
    $color = 'Yellow'
} else {
    $verdict = '过慢（> 1500ms，需要查）'
    $color = 'Red'
}

Write-Host ''
Write-Host '── 结果 ──────────────────────────────────────────────' -ForegroundColor Cyan
Write-Host ("  中位  {0}" -f (Format-Ms $median)) -ForegroundColor $color -NoNewline
Write-Host ("   {0}" -f $verdict) -ForegroundColor $color
Write-Host ("  最小  {0}" -f (Format-Ms $min))
Write-Host ("  最大  {0}" -f (Format-Ms $max))
Write-Host ("  平均  {0}" -f (Format-Ms $avg))
Write-Host ''
Write-Host ("  其中 pwsh 解释器启动开销（每轮都付）：{0}" -f (Format-Ms $startupMs)) -ForegroundColor DarkGray
Write-Host ("  守护脚本本体估算中位：{0}" -f (Format-Ms $bodyEstimate)) -ForegroundColor DarkGray
Write-Host ''
Write-Host '  判定线：中位 <= 1000ms 绿（达标）｜> 1000ms 黄｜> 1500ms 红' -ForegroundColor DarkGray
Write-Host '  基线：2026-11-02 优化后约 940ms（优化前 1661ms）' -ForegroundColor DarkGray
Write-Host ''
Write-Host '  提示：本轮跑完 state\guardian.heartbeat 已被刷新为「刚刚」，' -ForegroundColor DarkGray
Write-Host '        面板显示会更「新」，不影响任何功能（守护本来就每分钟刷一次）。' -ForegroundColor DarkGray
Write-Host ''

# 退出码：达标 0，偏慢 1，过慢 2（便于脚本化对比）
if ($median -le 1000) { exit 0 } elseif ($median -le 1500) { exit 1 } else { exit 2 }
