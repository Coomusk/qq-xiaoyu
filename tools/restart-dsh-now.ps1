# 只重启 DSH（不动 SnowLuma），用于让 MCP 工具描述等只在启动时加载的东西生效。
# 由 WMI 独立拉起（父进程是 WmiPrvSE），所以杀掉 DSH 不会连带杀掉本脚本。
# 用法：pwsh -NoProfile -ExecutionPolicy Bypass -File tools\restart-dsh-now.ps1
$ErrorActionPreference = 'Continue'
$root = Split-Path $PSScriptRoot -Parent
$log = Join-Path $root 'state\restart-dsh-now.log'
$report = Join-Path $root 'state\restart-dsh-report.txt'
$cfgPath = Join-Path $root 'config.json'
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
    $line = "[$(Get-Date -Format 'HH:mm:ss')] $m"
    try { Add-Content -Path $log -Value $line -Encoding UTF8 } catch {}
    try { Add-Content -Path $report -Value $line -Encoding UTF8 } catch {}
}
Set-Content -Path $report -Value "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] DSH 重启报告" -Encoding UTF8

Say '等待 10 秒，让当前回复先送达'
Start-Sleep -Seconds 10

Say '1/6 停止桥接'
Get-CimInstance Win32_Process -Filter "name='node.exe'" | Where-Object { $_.CommandLine -match 'src[\\/]bridge\.js' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Say '2/6 停止守护进程（否则它会把桥接又拉起来）'
Get-CimInstance Win32_Process -Filter "name='pwsh.exe'" | Where-Object { $_.CommandLine -like '*-File*guardian.ps1*' -and $_.CommandLine -notlike '*NoLogo*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Remove-Item (Join-Path $root 'state\guardian.pid') -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $root 'state\bridge.lock') -Force -ErrorAction SilentlyContinue

Say '3/6 关闭 DeepSeek Harness'
Get-Process | Where-Object { $_.ProcessName -like 'DeepSeek Harness*' } |
    ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 6

Say '4/6 重新启动 DeepSeek Harness'
$app = Resolve-DshApp
if ($app) { Start-Process -FilePath $app; Say "  已启动：$app" }
else { Say "  ❌ 找不到 $app" }

Say '5/6 等 DSH Web 端口就绪，并写回 config.dsh.baseUrl'
$port = $null
for ($i = 0; $i -lt 45; $i++) {
    Start-Sleep -Seconds 2
    $pids = (Get-Process | Where-Object { $_.ProcessName -like 'DeepSeek Harness*' }).Id
    if (-not $pids) { continue }
    $ports = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
        Where-Object { $pids -contains $_.OwningProcess -and $_.LocalAddress -eq '127.0.0.1' } |
        Select-Object -ExpandProperty LocalPort -Unique
    foreach ($p in $ports) {
        try { $null = Invoke-WebRequest "http://127.0.0.1:$p/" -TimeoutSec 3 -ErrorAction Stop; $port = $p; break }
        catch { if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -in 401,403) { $port = $p; break } }
    }
    if ($port) { break }
}
if ($port) {
    Say "  DSH Web 端口 = $port"
    try {
        $cfg = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $old = $cfg.dsh.baseUrl
        $cfg.dsh.baseUrl = "http://127.0.0.1:$port"
        ($cfg | ConvertTo-Json -Depth 20) | Set-Content -Path $cfgPath -Encoding UTF8
        Say "  config.dsh.baseUrl: $old -> $($cfg.dsh.baseUrl)"
    } catch { Say "  ⚠️ 写 config 失败：$($_.Exception.Message)" }
} else {
    Say '  ⚠️ 没等到 DSH 端口（守护进程稍后可能自己补）'
}

Say '6/6 启动守护进程（它会拉起桥接）'
$null = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine = ('pwsh.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $root 'tools\guardian.ps1') + '"')
}
Start-Sleep -Seconds 30

# ── 收尾核对 ──────────────────────────────────────────────────────────────
Say '—— 核对 ——'
foreach ($p in 3000, 3001, 3100, 5099) {
    $ok = [bool](Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue)
    Say "  端口 $p : $ok"
}
$gp = Get-Content (Join-Path $root 'state\guardian.pid') -ErrorAction SilentlyContinue
Say "  guardian.pid = $gp"
$cfgNow = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
Say "  config.dsh.baseUrl = $($cfgNow.dsh.baseUrl)"

# 会话是否重建（重置后 sessions.json 里两个群会消失，下次消息重新 bootstrap）
$sess = Get-Content (Join-Path $root 'state\sessions.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$keys = @($sess.sessions.PSObject.Properties.Name)
Say "  sessions.json 里的会话: $($keys -join ', ')"
Say '  说明：DSH 重启后原会话失效，桥接会退役并在下次消息时重建（群背景会重新注入）。'

# MCP 工具描述文件里是否还是旧文案（旧文案会重新生效说明改错了）
$mcp = Join-Path $root 'src\mcp-snowluma-safe.js'
$mcpText = Get-Content $mcp -Raw -Encoding UTF8
Say "  mcp 描述含『回复消息时不要调用本工具』: $($mcpText.Contains('回复消息时不要调用本工具'))"
Say "  mcp 描述含『timeoutMs=300000』: $($mcpText.Contains('timeoutMs=300000'))"
Say '========== 重启流程结束 =========='
