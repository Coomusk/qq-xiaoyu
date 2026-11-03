# 上下文体积守护：会话上下文超过告警线时，写一条带冷却的告警日志。**只告警，不重置。**
#
# ⚠️ 为什么只告警（2026-10-29 14:5x 改）：
#   上一版会在超限时调 /api/session/reset 重置会话。但那个请求体只有 {key}，
#   而桥接 src/bridge.js 要求 confirm === true，所以**必然 409**。
#   失败不写冷却戳记 → 每 5 分钟重试一次，guardian.log 里 13:16/13:21/13:27… 全是这个。
#   每次失败前还先存档一次，学习本被刷到 11,261 字符（notes_read 只读前 6,000 字符），
#   把她手写的群友印象挤出了可读范围。
#
#   同时这违反了交接文档红线第 5 条：「自动脚本一律不许调用重置」。
#   会话重置只能由人在面板上点（面板会带 confirm: true）。所以这里彻底不发写请求。
#
# ⚠️ 阈值怎么来的（量出来的，不是估的）：
#   实测 group:4595**** 共 570 轮的分布：
#     最小 28k / 25% 38k / 中位 48k / 75% 81k / 最大 254k
#   私聊 private:3278**** 中位就有 180k（长期高位）。
#   本脚本的 $LIMIT 是**告警线**，不是清理线，取 260k（约等于历史峰值上沿）。
#
# ⚠️ 和 DSH 压缩的关系（重要，别混淆）：
#   真正的上下文压缩由 DSH 的 compaction-basic 插件负责（挂在 qq-chat-v2 preset 里，
#   auto 默认 true）。触发点是 min(W×0.8, W−O−65536)，取决于当轮模型的 contextWindow
#   和 maxTokens。以 rc/deepseek-flash（W=1,000,000 / O=384,000）为例约 550k。
#   这个触发点比本脚本的 260k 告警线高得多，所以「本脚本告警」≠「上下文有问题」，
#   只说明该会话的瞬时体积偏大，压缩还没轮到它。
#   → 本脚本只监控、只记录，不参与任何压缩或清理决策。
#
# ⚠️ 紧急停用：创建 state\context-guard.disabled 即可让它只统计不告警。
#
# 用法：
#   pwsh -File tools\context-guard.ps1              # 检查并在超线时告警（带冷却）
#   pwsh -File tools\context-guard.ps1 -DryRun      # 只报告不告警
#   pwsh -File tools\context-guard.ps1 -Nightly     # 兼容旧参数：等同常规检查
param([switch]$DryRun, [switch]$Nightly)

$ErrorActionPreference = 'Continue'
$root = Split-Path $PSScriptRoot -Parent
$log = Join-Path $root 'state\guardian.log'
$usageFile = Join-Path $root 'state\token-usage.jsonl'
$outFile = Join-Path $root 'state\context-usage.txt'
$disabledFlag = Join-Path $root 'state\context-guard.disabled'

$LIMIT = 260000          # 告警线（非清理线）；压缩由 DSH compaction-basic 负责，见文件头
$ALERT_COOLDOWN_MIN = 60 # 同一会话两次告警最小间隔，防刷屏

function Log($m) {
    $line = "[$(Get-Date -Format 'HH:mm:ss')] $m"
    try { Add-Content -Path $log -Value $line -Encoding UTF8 } catch {}
    Write-Host $line
}

if (-not (Test-Path $usageFile)) { Log '没有 token-usage.jsonl，跳过'; exit 0 }

# 每个会话最新一轮的上下文大小
$latest = @{}
foreach ($line in (Get-Content $usageFile -Tail 400 -ErrorAction SilentlyContinue)) {
    try { $o = $line | ConvertFrom-Json } catch { continue }
    if ($o.k -ne 'turn' -or -not $o.key -or $o.key -like 'internal:*') { continue }
    $b = $o.b
    if (-not $b) { continue }
    $tokens = [int]($b.cacheHit + $b.cacheMiss + $b.output)
    if (-not $latest.ContainsKey($o.key) -or $o.t -ge $latest[$o.key].t) {
        $latest[$o.key] = @{ t = $o.t; tokens = $tokens }
    }
}

# 只处理还活着的会话
$liveKeys = @{}
$sessFile = Join-Path $root 'state\sessions.json'
if (Test-Path $sessFile) {
    try {
        $sj = Get-Content $sessFile -Raw -Encoding UTF8 | ConvertFrom-Json
        foreach ($k in $sj.sessions.PSObject.Properties.Name) { $liveKeys[$k] = $true }
    } catch {}
}

# 用量报告（永远输出，便于面板/人工查看）
$rows = @("[$(Get-Date -Format 'MM-dd HH:mm')] 上下文用量（告警线 $([math]::Round($LIMIT/1000))k）")
foreach ($key in ($latest.Keys | Sort-Object)) {
    $size = $latest[$key].tokens
    $mark = if ($size -ge $LIMIT) { '  ← 超限' } else { '' }
    $rows += ("  {0,-24} {1,6}k tokens{2}" -f $key, [math]::Round($size / 1000), $mark)
}
if ($latest.Keys.Count -eq 0) { $rows += '  （没有可统计的会话）' }
try { Set-Content -Path $outFile -Value ($rows -join "`r`n") -Encoding UTF8 } catch {}

if (Test-Path $disabledFlag) {
    Log "上下文告警已停用（存在 state\context-guard.disabled），本次只统计"
    exit 0
}

$alerted = 0
$overLimit = 0
foreach ($key in @($latest.Keys)) {
    if (-not $liveKeys.ContainsKey($key)) { continue }
    $size = $latest[$key].tokens
    if ($size -lt $LIMIT) { continue }
    $overLimit++

    # 告警冷却：同一会话在冷却窗口内只记一条，避免 guardian 每 5 分钟刷屏
    $stampName = 'last-alert-' + ($key -replace '[:\\/]', '-') + '.txt'
    $stampFile = Join-Path (Join-Path $root 'state') $stampName
    if (Test-Path $stampFile) {
        try {
            $last = [datetime]::Parse((Get-Content $stampFile -Raw).Trim())
            if (((Get-Date) - $last).TotalMinutes -lt $ALERT_COOLDOWN_MIN) { continue }
        } catch {}
    }

    # 压缩触发点随模型变化，这里只作提示，不参与决策（见文件头「和 DSH 压缩的关系」）
    Log "上下文超限：$key = $([math]::Round($size / 1000))k / $([math]::Round($LIMIT / 1000))k（仅告警，不重置；压缩由 DSH compaction-basic 负责）"
    if ($DryRun) { $alerted++; continue }
    try { Set-Content -Path $stampFile -Value (Get-Date -Format 'o') -Encoding UTF8 } catch {}
    $alerted++
}

if ($overLimit -eq 0) { Log "所有会话都在 $([math]::Round($LIMIT/1000))k 以内" }
elseif ($alerted -eq 0) { Log "$overLimit 个会话超限（冷却中，本次不重复告警）" }
else { Log "$overLimit 个会话超限（本次告警 $alerted 个，仅监控不处理）" }
