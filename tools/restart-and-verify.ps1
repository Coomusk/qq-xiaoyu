# 重启 DSH + 桥接，然后自动核四项并落盘（脱离 DSH 进程树运行，DSH 被杀不会带走本脚本）
# 用法（必须脱离进程树启动，否则会把自己杀掉）：
#   Invoke-CimMethod Win32_Process -MethodName Create -Arguments @{ CommandLine = 'pwsh -NoProfile -ExecutionPolicy Bypass -File "<仓库路径>\tools\restart-and-verify.ps1"' }
# 结果写到 state\restart-verify.log
$ErrorActionPreference = 'Continue'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root
$log = Join-Path $root 'state\restart-verify.log'
# DSH 安装路径：环境变量 DSH_APP_PATH → 常见安装位置；都找不到就返回 $null。
function Resolve-DshApp {
    if ($env:DSH_APP_PATH -and (Test-Path $env:DSH_APP_PATH)) { return $env:DSH_APP_PATH }
    $bases = @($env:ProgramFiles, ${env:ProgramFiles(x86)}, (Join-Path $env:LOCALAPPDATA 'Programs')) | Where-Object { $_ }
    foreach ($b in $bases) {
        $c = Join-Path $b 'deepseek\DeepSeek Harness.exe'
        if (Test-Path $c) { return $c }
    }
    return $null
}
function Say($m) {
    $line = "[$(Get-Date -Format 'MM-dd HH:mm:ss')] $m"
    Add-Content -Path $log -Value $line -Encoding UTF8
}

Say '================ 重启 + 验证 开始 ================'

# 起法说明（2026-10-31 实测）：从 DSH 内部用 WMI 创建进程**逃不掉**——DSH 回合结束时
# 连那条 sleep 都被一起收掉了（日志只留下前两行，DSH 进程没换）。已验证可行的起法：
#   schtasks /create /tn 小鱼-重启DSH /tr "pwsh -NoProfile -ExecutionPolicy Bypass -File ...\restart-and-verify.ps1" /sc once /st <时间> /f
#   schtasks /run /tn 小鱼-重启DSH
# 计划任务的父进程是 svchost（Task Scheduler），实测 self→svchost→services，与 DSH 无关。
$parent = (Get-CimInstance Win32_Process -Filter "ProcessId=$PID").ParentProcessId
$pp = Get-CimInstance Win32_Process -Filter "ProcessId=$parent" -ErrorAction SilentlyContinue
Say "本脚本 PID=$PID 父进程=$(if($pp){$pp.Name}else{'?'})#$parent（计划任务应为 svchost）"
if ($pp -and $pp.Name -match 'DeepSeek') {
    Say '⚠️ 父进程是 DeepSeek Harness：没有脱离进程树，DSH 一关本脚本会一起死。中止。'
    Say '================ 中止 ================'
    exit 1
}

# ── 重启前基线 ─────────────────────────────────────────────
$before = @{}
if (Test-Path 'state\sessions.json') {
    $s = (Get-Content 'state\sessions.json' -Raw -Encoding UTF8 | ConvertFrom-Json).sessions
    foreach ($k in $s.PSObject.Properties.Name) { $before[$k] = $s.$k }
    Say "重启前会话：$(($before.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join '  ')"
}
$bridgePid = (Get-CimInstance Win32_Process -Filter "name='node.exe'" | Where-Object { $_.CommandLine -match 'src[\\/]bridge\.js' } | Select-Object -First 1).ProcessId
$mcpPids = (Get-CimInstance Win32_Process -Filter "name='node.exe'" | Where-Object { $_.CommandLine -match 'mcp-snowluma-safe' } | ForEach-Object { "$($_.ProcessId)@$($_.CreationDate)" }) -join ','
Say "重启前桥接 pid=$bridgePid ；MCP 进程=$mcpPids"
$logFrom = (Get-Item 'state\bridge.log' -ErrorAction SilentlyContinue).Length

# ── 执行重启全套 ───────────────────────────────────────────
Say '调用 tools\restart-all.ps1（关 DSH → 重启 → 等端口 → 同步端口并拉起桥接）'
& pwsh -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'tools\restart-all.ps1')

# ── 兜底：DSH 没起来就再拉，最多 3 次 ──────────────────────
$app = Resolve-DshApp
for ($try = 1; $try -le 3; $try++) {
    $dsh = @(Get-Process | Where-Object { $_.ProcessName -like 'DeepSeek Harness*' })
    if ($dsh.Count) { Say "DSH 进程在（$($dsh.Count) 个，pid $($dsh[0].Id)），第 $try 次检查"; break }
    Say "⚠️ 没看到 DSH 进程，第 $try 次尝试重新拉起 $app"
    if ($app) { Start-Process -FilePath $app } else { Say "  找不到 DSH 可执行文件：请设置环境变量 DSH_APP_PATH" }
    Start-Sleep -Seconds 25
}

# ── 等桥接起来 ─────────────────────────────────────────────
Say '等待桥接启动（最多 180 秒）'
$ready = $false
for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 3
    $tail = Get-Content 'state\bridge.log' -Tail 40 -Encoding UTF8 -ErrorAction SilentlyContinue
    if ($tail -match '桥接已启动') { $ready = $true; break }
}
Say "桥接已启动：$ready"

# ── 核 1：表情工具是否上线 ─────────────────────────────────
Say '--- 核 ① 工具清单（全新进程 tools/list；注册期过滤，只能这样验） ---'
$probe = & node (Join-Path $root 'tools\mcp-tool-probe.mjs') 'qq_list_stickers' 2>&1
Say ($probe -join ' / ')
$newMcp = (Get-CimInstance Win32_Process -Filter "name='node.exe'" | Where-Object { $_.CommandLine -match 'mcp-snowluma-safe' } | ForEach-Object { "$($_.ProcessId)@$($_.CreationDate)" }) -join ','
Say "重启后 MCP 进程=$newMcp"

# ── 核 2：事件流 0 帧 / 自愈 ───────────────────────────────
Say '--- 核 ② 事件流（看重启后新增日志里有没有 0 帧 / 自愈） ---'
if ((Test-Path 'state\bridge.log') -and $logFrom -ge 0) {
    $all = Get-Content 'state\bridge.log' -Encoding UTF8 -ErrorAction SilentlyContinue
    $recent = $all | Select-Object -Last 200
    $zero = @($recent | Where-Object { $_ -match '0 帧|一帧都没收到|DSH 事件流已结束' })
    $heal = @($recent | Where-Object { $_ -match '自愈|重放 follow|退避' })
    Say "近 200 行里 0 帧类=$($zero.Count) 条；自愈类=$($heal.Count) 条"
    if ($zero.Count) { $zero | Select-Object -First 5 | ForEach-Object { Say "  0帧> $_" } }
    if ($heal.Count) { $heal | Select-Object -First 5 | ForEach-Object { Say "  自愈> $_" } }
    Say '近 20 行：'
    $recent | Select-Object -Last 20 | ForEach-Object { Say "  > $_" }
}

# ── 核 3：会话是否沿用 ─────────────────────────────────────
Say '--- 核 ③ 会话是否沿用（sessionId 变了=重建，群背景会重新注入） ---'
if (Test-Path 'state\sessions.json') {
    $s2 = (Get-Content 'state\sessions.json' -Raw -Encoding UTF8 | ConvertFrom-Json).sessions
    foreach ($k in $s2.PSObject.Properties.Name) {
        $old = $before[$k]
        $now = $s2.$k
        $same = if ($old -eq $now) { '沿用' } elseif (-not $old) { '新增' } else { '重建' }
        Say "  $k : $now → $same"
    }
}

# ── 核 4：新提示词实测 ─────────────────────────────────────
Say '--- 核 ④ 新唤醒提示词实测（重启后若已有新唤醒，用真实原文；没有标待自然消息） ---'
$scId = ''
if (Test-Path 'state\sessions.json') {
    $cur = (Get-Content 'state\sessions.json' -Raw -Encoding UTF8 | ConvertFrom-Json).sessions
    $firstGroup = $cur.PSObject.Properties.Name | Where-Object { $_ -like 'group:*' } | Select-Object -First 1
    $scId = if ($firstGroup) { [string]$cur.$firstGroup } else { '' }
    if ($scId -like 'session-*') { $scId = $scId.Substring(8) }
}
Say "（$firstGroup → 会话 $scId）"
if ($scId) {
    $rep2 = & node (Join-Path $root 'tools\wake-prompt-report.mjs') $scId 1 2>&1
    ($rep2 | Select-Object -Last 30) | ForEach-Object { Say "  $_" }
} else {
    Say '  没有会话映射，跳过（待下次自然唤醒再核）'
}

Say '================ 重启 + 验证 结束 ================'
