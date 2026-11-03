# 小鱼守护（-Once 单轮版，由计划任务每分钟触发一次）
#
# 为什么不再用常驻循环：常驻进程死了没人知道（2026-10-31 就死了 4 小时，害得 DSH 换端口后断链 90 分钟）。
# 改成「计划任务每分钟跑一轮、跑完就退」，没有常驻进程，也就没有"守护自己挂了"这件事。
#
# 每轮做五件事（对应已拍板的方案）：
#   1. DSH 在不在 / 端口变了没（按进程反查监听端口，不用端口白名单）
#   2. 桥接在不在 / 连没连上 DSH（问 /api/status 的 dshReady，不 grep 日志）
#   3. SnowLuma 实例数 == 1
#   4. 心跳（state\guardian.heartbeat），桥接启动时会检查它
#   5. 顺带定时活：群语料采集、上下文巡检（只告警，绝不清会话）
#
# 硬约束：
#   · 绝不碰 state\sessions.json、绝不清任何会话
#   · 重启桥接有 10 分钟冷却；她最近 30 秒有活动就这一轮跳过
#   · SnowLuma 多于 1 个只告警，不擅自杀
param([switch]$Once)

$ErrorActionPreference = 'Continue'
$root = Split-Path $PSScriptRoot -Parent
# SnowLuma 安装目录：config.json 的 snowluma.homeDir → 环境变量 SNOWLUMA_HOME → 仓库同级 SnowLuma/
function Resolve-SnowLumaHome {
    if ($script:SLHome) { return $script:SLHome }
    $c = $null
    try { $c = (Get-Content (Join-Path $root 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json).snowluma.homeDir } catch {}
    if ($c -and (Test-Path $c)) { $script:SLHome = (Resolve-Path $c).Path; return $script:SLHome }
    if ($env:SNOWLUMA_HOME -and (Test-Path $env:SNOWLUMA_HOME)) { $script:SLHome = (Resolve-Path $env:SNOWLUMA_HOME).Path; return $script:SLHome }
    $guess = Join-Path $root '..\SnowLuma'
    if (Test-Path $guess) { $script:SLHome = (Resolve-Path $guess).Path }
    return $script:SLHome
}
$logPath = Join-Path $root 'state\guardian.log'
$heartbeatPath = Join-Path $root 'state\guardian.heartbeat'
$cooldownPath = Join-Path $root 'state\guardian.cooldown.json'
$notReadyPath = Join-Path $root 'state\guardian.notready.json'
$dshMissingPath = Join-Path $root 'state\guardian.dshmissing.json'
$configPath = Join-Path $root 'config.json'
$lockPath = Join-Path $root 'state\bridge.lock'
$socialPath = Join-Path $root 'state\social-v2.json'
$alertsPath = Join-Path $root 'state\alerts.log'
$tokenPath = Join-Path $root 'state\console-token'
# 面板自愈的手动开关：文件**不存在 = 开**（默认自愈），存在 = 关（本轮完全不碰面板、也不写日志）。
$panelOffPath = Join-Path $root 'state\panel-guardian.off'
# SnowLuma「进程在但端口不在」的判定状态：记录第一次发现假活的时间，用来算宽限期。
$slStallPath = Join-Path $root 'state\guardian.snowluma-stall.json'
# QQ 客户端不在的状态：同一次缺失只告警一次，持续不在每 30 分钟提醒一次，恢复后删文件。
$qqMissingPath = Join-Path $root 'state\guardian.qq-missing.json'

$COOLDOWN_SEC = 600          # 桥接重启冷却：10 分钟
$SNOWLUMA_STALL_GRACE_SEC = 60  # 进程在、端口不在，持续超过这个秒数才判死重启（别误杀正在启动的）
$NOTREADY_SEC = 30           # 连续未就绪 30 秒才重启
$ACTIVE_SEC = 30             # 她最近 30 秒有活动就跳过重启
$DSH_MISSING_LOG_SEC = 600   # DSH 不在时每 10 分钟才记一行
$QQ_MISSING_LOG_SEC = 1800   # QQ 不在时每 30 分钟才提醒一行（首次立即告警）

function Log($m) {
    $line = "[$(Get-Date -Format 'HH:mm:ss')] $m"
    try { Add-Content -Path $logPath -Value $line -Encoding UTF8 } catch {}
    Write-Host $line
}
function Alert($m) {
    try { Add-Content -Path $alertsPath -Value "[$(Get-Date -Format 'MM-dd HH:mm:ss')] $m" -Encoding UTF8 } catch {}
    Log "⚠️ $m"
}
function Read-Json($path) {
    try { if (Test-Path $path) { return Get-Content $path -Raw -Encoding UTF8 | ConvertFrom-Json } } catch {}
    return $null
}
function Write-Json($path, $obj) {
    try { $obj | ConvertTo-Json -Depth 5 | Set-Content $path -Encoding UTF8 } catch {}
}

# ── 1. DSH：先拿进程，再按 pid 反查监听端口（不用端口白名单） ────────────────
# ⚡ 端口查询用原生 netstat，不用 Get-NetTCPConnection：
#    2026-11-02 实测 Get-NetTCPConnection 要 1355ms，netstat 只要 46ms（差 30 倍），
#    而守护每分钟跑一轮、每轮要查好几次。慢的直接后果是 DSH 换端口后第一轮可能拖到下一分钟
#    才发现（12:13:45 换端口、12:14:03 才写入），所以这里是耗时热点，值得改。
function Get-ListenPorts {
    # 返回 Hashtable：端口(Int) -> 拥有进程 pid
    $map = @{}
    try {
        $lines = & netstat.exe -ano -p TCP 2>$null
        foreach ($line in $lines) {
            if ($line -notmatch '^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$') { continue }
            $map[[int]$Matches[1]] = [int]$Matches[2]
        }
    } catch {}
    return $map
}
# ── 单轮快照：netstat 和进程表每轮各只取一次 ────────────────────────────────
# 2026-11-02 实测：每轮原本 netstat×3、Get-CimInstance Win32_Process×3，单轮 1661ms。
# 同一轮里这几份数据不会变（最多差几十毫秒，守护的判定都带秒级宽限），合并成一次足够。
$script:ListenCache = $null
$script:ProcCache = $null
function Get-ListenSnapshot {
    if ($null -eq $script:ListenCache) { $script:ListenCache = Get-ListenPorts }
    return $script:ListenCache
}
function Get-NodeProcs {
    # 一次拿全表，之后桥接 / SnowLuma 都从这份里筛
    if ($null -eq $script:ProcCache) {
        $script:ProcCache = @(Get-CimInstance Win32_Process -Filter "name='node.exe'" -ErrorAction SilentlyContinue)
    }
    return $script:ProcCache
}
function Test-PortListening([int]$Port) {
    return (Get-ListenSnapshot).ContainsKey($Port)
}
function Get-DshInfo {
    $procs = @(Get-Process | Where-Object { $_.ProcessName -like 'DeepSeek Harness*' })
    if (-not $procs.Count) { return $null }
    $pids = $procs.Id
    $listen = Get-ListenSnapshot
    $ports = @($listen.Keys | Where-Object { $pids -contains $listen[$_] } | Sort-Object)
    foreach ($port in $ports) {
        try {
            $null = Invoke-WebRequest "http://127.0.0.1:$port/" -TimeoutSec 3 -ErrorAction Stop
            return @{ Port = [int]$port; Pid = [int]$listen[$port] }
        } catch {
            if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -in 401, 403) {
                return @{ Port = [int]$port; Pid = [int]$listen[$port] }
            }
        }
    }
    return @{ Port = 0; Pid = [int]($procs | Select-Object -First 1).Id }
}

function Get-CfgPort {
    $c = Read-Json $configPath
    if ($c -and "$($c.dsh.baseUrl)" -match ':(\d+)$') { return [int]$Matches[1] }
    return 0
}
function Set-CfgPort([int]$Port) {
    $raw = Get-Content $configPath -Raw -Encoding UTF8
    $new = $raw -replace '"baseUrl":\s*"http://127\.0\.0\.1:\d+"', "`"baseUrl`": `"http://127.0.0.1:$Port`""
    if ($new -ne $raw) { Set-Content $configPath $new -NoNewline -Encoding UTF8; return $true }
    return $false
}

# ── 2. 桥接进程 / 状态接口 ──────────────────────────────────────────────────
function Test-PanelPort {
    # 面板固定 3210（面板自己认 PANEL_PORT，但守护只认这个约定值）
    return (Get-ListenSnapshot).ContainsKey(3210)
}
function Get-BridgeProcs {
    @(Get-NodeProcs | Where-Object { $_.CommandLine -match 'src[\\/]bridge\.js' })
}
function Get-BridgeStatus {
    $tok = ''
    try { $tok = (Get-Content $tokenPath -Raw).Trim() } catch {}
    if (-not $tok) { return $null }
    try {
        return Invoke-RestMethod 'http://127.0.0.1:3100/api/status' -Headers @{ 'x-console-token' = $tok } -TimeoutSec 5
    } catch { return $null }
}

# ── 3. SnowLuma：数实例个数 ────────────────────────────────────────────────
function Get-SnowLumaProcs {
    $sl = Resolve-SnowLumaHome
    @(Get-NodeProcs | Where-Object { $sl -and $_.ExecutablePath -and $_.ExecutablePath.StartsWith($sl, [StringComparison]::OrdinalIgnoreCase) })
}
# SnowLuma 的 OneBot 端口（3000 HTTP / 3001 WS）。**进程活着不等于它在工作**：
# 2026-11-02 08:23 守护按进程判断，拉起的 SnowLuma 卡在「hook process enumeration timed out」，
# 3000/3001 一直没监听，而进程好好地活着 → 守护认为正常，4 小时没人发现，她一直发不出消息。
# 所以判活必须看端口。
function Test-SnowLumaPort {
    $listen = Get-ListenSnapshot
    return @{ Http = $listen.ContainsKey(3000); Ws = $listen.ContainsKey(3001) }
}
function Start-SnowLuma {
    $sl = Resolve-SnowLumaHome
    if (-not $sl) { Log 'SnowLuma 目录未找到：请配置 config.json 的 snowluma.homeDir 或环境变量 SNOWLUMA_HOME'; return }
    Log 'SnowLuma 未运行 → 启动'
    Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', 'launcher.bat' -WorkingDirectory $sl -WindowStyle Hidden
}
function Restart-SnowLuma($reason) {
    Log "SnowLuma $reason → 杀掉重启"
    foreach ($p in Get-SnowLumaProcs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 2
    Start-SnowLuma
}

function Start-Bridge {
    # 为什么不用 Start-Process 直接起：计划任务在**任务实例结束时会回收它拉起的子进程树**。
    # 2026-11-01 00:13 实测：guardian 每分钟都打了「桥接未运行 → 启动」，
    # wscript→vbs→cmd→node 这条链一个都没活下来，服务断了 18 分钟。
    # 正解：桥接由**独立任务** `小鱼-桥接` 承载（任务活着=桥接活着，不会被回收），
    # guardian 只负责 schtasks /run 触发它。
    # 与 start.bat 的分工：桥接**进程死亡**由 start.bat 的 :loop 自愈（5 秒后重启）；
    # guardian 只处理 start.bat 救不了的两种：① DSH 端口漂移 ② 进程活着但连不上 DSH
    # （2026-10-31 21:41 断 90 分钟就是后者——进程没死，:loop 没机会出手）。
    Log '桥接未运行 → 触发计划任务「小鱼-桥接」'
    if (Test-Path $lockPath) { Remove-Item $lockPath -Force -ErrorAction SilentlyContinue }
    $null = & schtasks.exe /run /tn '小鱼-桥接' 2>&1
    if ($LASTEXITCODE -ne 0) {
        Log "计划任务「小鱼-桥接」触发失败（退出码 $LASTEXITCODE），退回 vbs 直起"
        $vbs = Join-Path $root 'tools\hidden-launch.vbs'
        if (Test-Path $vbs) {
            Start-Process -FilePath 'wscript.exe' -ArgumentList @("`"$vbs`"", "`"$root`"") -WindowStyle Hidden
        } else {
            Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', 'start.bat' -WorkingDirectory $root -WindowStyle Hidden
        }
    }
}
function Stop-Bridge {
    foreach ($p in Get-BridgeProcs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 2
    if (Test-Path $lockPath) { Remove-Item $lockPath -Force -ErrorAction SilentlyContinue }
}

# ── 重启前的两道闸：冷却 + 她是不是正在说话 ─────────────────────────────────
function Test-Cooldown {
    $cd = Read-Json $cooldownPath
    if (-not $cd) { return $true }
    $at = 0
    try { $at = [int64]$cd.at } catch {}
    if (-not $at) { return $true }
    $age = ([DateTimeOffset]::UtcNow.ToUnixTimeSeconds()) - $at
    if ($age -lt $COOLDOWN_SEC) {
        Log ("桥接重启冷却中（还差 {0} 秒），本轮只记录不动手" -f ($COOLDOWN_SEC - $age))
        return $false
    }
    return $true
}
function Set-Cooldown {
    Write-Json $cooldownPath @{ at = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds(); when = (Get-Date -Format 's') }
}
function Test-Idle {
    $s = Read-Json $socialPath
    if (-not $s) { return $true }
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $last = 0
    try {
        foreach ($p in $s.conversations.PSObject.Properties) {
            $v = $p.Value
            foreach ($f in 'lastActionAt', 'lastIncomingAt') {
                $t = 0; try { $t = [int64]$v.$f } catch {}
                if ($t -gt $last) { $last = $t }
            }
        }
    } catch {}
    if (-not $last) { return $true }
    $ageSec = ($now - $last) / 1000
    if ($ageSec -lt $ACTIVE_SEC) {
        Log ("她 {0:N0} 秒前还在动，本轮不重启桥接（下一分钟再看）" -f $ageSec)
        return $false
    }
    return $true
}
function Restart-BridgeSafely($reason, [switch]$IgnoreIdle) {
    if (-not (Test-Cooldown)) { return $false }
    # 未就绪超过 120 秒时不再等她空闲：那会儿她本来就收发不了，重启反而是在救她。
    if (-not $IgnoreIdle -and -not (Test-Idle)) { return $false }
    Log "重启桥接：$reason"
    Stop-Bridge
    Start-Bridge
    Set-Cooldown
    return $true
}

# ── 单实例锁：上一轮没跑完就退出（计划任务重叠时不会撞） ────────────────────
$lockFile = Join-Path $root 'state\guardian.lock'
if (-not $Once) {
    Log '常驻模式已停用：请用计划任务每分钟调用 -Once（详见本文件头注释）'
    exit 0
}
try {
    $fs = [System.IO.File]::Open($lockFile, 'OpenOrCreate', 'ReadWrite', 'None')
} catch {
    exit 0
}

$script:lastBridgeStart = [DateTime]::MinValue

try {
    Set-Content -Path $heartbeatPath -Value (Get-Date -Format 's') -Encoding UTF8
    $changed = @()
    $nowSec = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()

    # ── DSH ────────────────────────────────────────────────────────────────
    $dsh = Get-DshInfo
    if (-not $dsh) {
        $miss = Read-Json $dshMissingPath
        if (-not $miss) {
            Log 'DSH 未运行（只记日志、不自动拉起；之后每 10 分钟记一行）'
            Write-Json $dshMissingPath @{ since = $nowSec; lastLog = $nowSec }
        } elseif (($nowSec - [int64]$miss.lastLog) -ge $DSH_MISSING_LOG_SEC) {
            $mins = [Math]::Round(($nowSec - [int64]$miss.since) / 60)
            Log "DSH 仍未运行（已 $mins 分钟）"
            Write-Json $dshMissingPath @{ since = [int64]$miss.since; lastLog = $nowSec }
        }
    } else {
        if (Test-Path $dshMissingPath) { Remove-Item $dshMissingPath -Force -ErrorAction SilentlyContinue }
        $cfgPort = Get-CfgPort
        # 写 config 是纯文本修正、不影响正在生成的那条回复，所以**不受空闲/冷却限制**——
        # 2026-11-01 00:02 实测踩过：把写 config 也塞进空闲闸门，她一直在聊，config 就永远修不上。
        if ($dsh.Port -and $cfgPort -ne $dsh.Port) {
            if (Set-CfgPort $dsh.Port) {
                Log "DSH 端口变化 $cfgPort → $($dsh.Port)，已写入 config.json"
                $changed += "port:$($dsh.Port)"
            }
            # 桥接要重启才读新端口；这一步才需要冷却 + 空闲判断（下面 not-ready 分支会处理）。
            if ((Test-Path $notReadyPath) -eq $false) {
                Write-Json $notReadyPath @{ since = $nowSec }
            }
        }
    }

    # ── 桥接 ───────────────────────────────────────────────────────────────
    # ⚡ 先问状态接口（实测 8ms），只有接口不通时才去查进程表（WMI 约 300ms）。
    # 这省掉的是每轮必付的 300ms——而守护每分钟跑一轮，绝大多数时间桥接都是好好的。
    $st = Get-BridgeStatus
    if ($null -ne $st) {
        # 接口通了 == 桥接进程活着（且能响应），不用再看进程表
        $ready = ($st.dshReady -eq $true)
        if ($ready) {
            if (Test-Path $notReadyPath) { Remove-Item $notReadyPath -Force -ErrorAction SilentlyContinue }
        } else {
            $nr = Read-Json $notReadyPath
            if (-not $nr) {
                Write-Json $notReadyPath @{ since = $nowSec }
                Log '桥接报未就绪（dshReady=false 或状态接口不通），开始计时'
            } elseif (($nowSec - [int64]$nr.since) -ge $NOTREADY_SEC) {
                $notReadyAge = $nowSec - [int64]$nr.since
                Log ("桥接已连续 {0} 秒未就绪" -f $notReadyAge)
                # <120 秒：她可能正在回话，等一个空闲窗口；≥120 秒：她本来就收发不了，直接重启救回来。
                $force = $notReadyAge -ge 120
                if (Restart-BridgeSafely "桥接未就绪超过 ${notReadyAge} 秒" -IgnoreIdle:$force) {
                    Remove-Item $notReadyPath -Force -ErrorAction SilentlyContinue
                }
            }
        }
    } else {
        # 状态接口不通：可能是进程没了，也可能是进程活着但卡住。这时才去查进程表区分。
        $bridges = Get-BridgeProcs
        if ($bridges.Count -eq 0) {
            if (((Get-Date) - $script:lastBridgeStart).TotalSeconds -ge 20) {
                $script:lastBridgeStart = Get-Date
                Start-Bridge
            }
        } else {
            # 进程在但接口不通 = 卡死。和「未就绪」走同一套计时 + 冷却，别每轮都重启。
            $nr = Read-Json $notReadyPath
            if (-not $nr) {
                Write-Json $notReadyPath @{ since = $nowSec }
                Log '桥接进程在但状态接口不通，开始计时'
            } elseif (($nowSec - [int64]$nr.since) -ge $NOTREADY_SEC) {
                $notReadyAge = $nowSec - [int64]$nr.since
                Log ("桥接进程在但状态接口不通已 {0} 秒" -f $notReadyAge)
                $force = $notReadyAge -ge 120
                if (Restart-BridgeSafely "桥接状态接口不通超过 ${notReadyAge} 秒" -IgnoreIdle:$force) {
                    Remove-Item $notReadyPath -Force -ErrorAction SilentlyContinue
                }
            }
        }
    }
    # ── 面板 3210（默认自愈，可用 state\panel-guardian.off 手动关掉）────────
    # 判定用「3210 有没有在监听」，不看进程名——面板和桥接都是 node，靠名字会误判。
    # 硬规矩：这里只负责「没有就起」，**永远不许杀面板**；用户想关就关开关再自己关进程。
    if (-not (Test-Path $panelOffPath)) {
        if (-not (Test-PanelPort)) {
            Log '面板未运行 → 启动'
            $vbs = Join-Path $root 'tools\panel-hidden.vbs'
            try {
                if (Test-Path $vbs) {
                    Start-Process -FilePath 'wscript.exe' -ArgumentList @("`"$vbs`"") -WindowStyle Hidden
                } else {
                    Start-Process -FilePath 'node' -ArgumentList 'tools\panel\server.mjs' -WorkingDirectory $root -WindowStyle Hidden
                }
                Start-Sleep -Seconds 2
                if (-not (Test-PanelPort)) { Log '面板启动失败：2 秒后 3210 仍未监听' }
            } catch {
                Log "面板启动失败：$($_.Exception.Message)"
            }
        }
    }

    # ── QQ 客户端 ──────────────────────────────────────────────────────────
    # QQ 不在 = SnowLuma 注入不到 QQ = 3000/3001 永远不会起 = 她收发不了消息。
    # 2026-11-02 上午就是这样断了 4 小时（QQ 没开，守护只看到 SnowLuma 进程活着）。
    # ⚠️ 只告警、**绝不自动拉起 QQ**：那涉及登录态，用户没授权。
    # 降噪：同一次「QQ 不在」只写一次，持续不在每 30 分钟再提醒一次，恢复后重置。
    $qqProcs = @(Get-Process -Name QQ -ErrorAction SilentlyContinue)
    if ($qqProcs.Count -eq 0) {
        $qs = Read-Json $qqMissingPath
        if (-not $qs) {
            $msg = 'QQ 客户端未运行（SnowLuma 无法注入，3000/3001 不会起）'
            Alert $msg
            Write-Json $qqMissingPath @{ since = $nowSec; lastLog = $nowSec }
        } elseif (($nowSec - [int64]$qs.lastLog) -ge $QQ_MISSING_LOG_SEC) {
            $mins = [Math]::Round(($nowSec - [int64]$qs.since) / 60)
            Log ("QQ 未运行（已 {0} 分钟）；SnowLuma 注入不到 QQ，3000/3001 起不来。不会自动启动 QQ。" -f $mins)
            Write-Json $qqMissingPath @{ since = [int64]$qs.since; lastLog = $nowSec }
        }
    } elseif (Test-Path $qqMissingPath) {
        Remove-Item $qqMissingPath -Force -ErrorAction SilentlyContinue
        Log 'QQ 已恢复运行'
    }

    # ── SnowLuma ───────────────────────────────────────────────────────────
    # 判活 = 端口在不在，不是进程在不在（假活见 Test-SnowLumaPort 的注释）。
    # ⚡ 端口都对 = 健康，**连进程表都不查**（省 300ms）。只有端口不对时才去看进程：
    #    进程没了 → 起；进程在 → 走 60 秒宽限期，超时才杀。
    $slPorts = Test-SnowLumaPort
    if ($slPorts.Http -and $slPorts.Ws) {
        if (Test-Path $slStallPath) { Remove-Item $slStallPath -Force -ErrorAction SilentlyContinue }
    } else {
        $sl = Get-SnowLumaProcs
        if ($sl.Count -eq 0) {
            Start-SnowLuma
            if (Test-Path $slStallPath) { Remove-Item $slStallPath -Force -ErrorAction SilentlyContinue }
        } elseif ($sl.Count -gt 1) {
            Alert ("SnowLuma 有 {0} 个实例（pid {1}），疑似重复启动；只告警不擅自杀" -f $sl.Count, (($sl | ForEach-Object { $_.ProcessId }) -join ','))
        } else {
            $pid0 = [int]$sl[0].ProcessId
            $st = Read-Json $slStallPath
            if (-not $st -or [int]$st.pid -ne $pid0) {
                # 换了新进程（刚被拉起）→ 重新计时，别拿上一个进程的假活时间误杀
                Write-Json $slStallPath @{ pid = $pid0; since = $nowSec }
                Log ("SnowLuma 进程在但端口未起（3000={0} 3001={1}），观察 {2} 秒宽限期" -f $slPorts.Http, $slPorts.Ws, $SNOWLUMA_STALL_GRACE_SEC)
            } elseif (($nowSec - [int64]$st.since) -ge $SNOWLUMA_STALL_GRACE_SEC) {
                Restart-SnowLuma ("假活超过 $($nowSec - [int64]$st.since) 秒：进程 pid $pid0 在但 3000/3001 没监听")
                Remove-Item $slStallPath -Force -ErrorAction SilentlyContinue
            }
        }
    }

    if ($changed.Count) { Log ("本轮改动：" + ($changed -join ' ')) }
} catch {
    Log "本轮检查出错：$($_.Exception.Message)"
} finally {
    try { $fs.Close() } catch {}
}
