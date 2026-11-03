# 全量重启：DSH + SnowLuma 网关 + 守护进程 + 桥接
# 由 WMI 独立拉起（父进程是 WmiPrvSE），所以杀掉 DSH 不会连带杀掉本脚本。
# 用法：prowsh -File tools\restart-all-full.ps1
$ErrorActionPreference = 'Continue'
$root = Split-Path $PSScriptRoot -Parent
$log = Join-Path $root 'state\restart-full.log'
# DSH 安装路径：环境变量 DSH_APP_PATH → 常见安装位置；都找不到就返回 $null。
function Resolve-DshApp {
    if ($env:DSH_APP_PATH -and (Test-Path $env:DSH_APP_PATH)) { return $env:DSH_APP_PATH }
    $bases = @($env:ProgramFiles, ${env:ProgramFiles(x86)}, (Join-Path $env:LOCALAPPDATA 'Programs')) | Where-Object { $_ }
    foreach ($b in $bases) {
        $c = Join-Path $b 'deepseek\DeepSeek Harness.exe'
        if (Test-Path $c) { return $c }
    }
    return $null
}# SnowLuma 安装目录：config.json 的 snowluma.homeDir → 环境变量 SNOWLUMA_HOME → 仓库同级 SnowLuma/
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
function Say($m) {
    $line = "[$(Get-Date -Format 'HH:mm:ss')] $m"
    try { Add-Content -Path $log -Value $line -Encoding UTF8 } catch {}
}

Say '========== 全量重启开始 =========='
Say '等待 12 秒（让当前对话的回复先送达）'
Start-Sleep -Seconds 12

Say '1/6 停止桥接'
Get-CimInstance Win32_Process -Filter "name='node.exe'" | Where-Object { $_.CommandLine -match 'src[\\/]bridge\.js' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Say '2/6 停止守护进程'
Get-CimInstance Win32_Process -Filter "name='pwsh.exe'" | Where-Object { $_.CommandLine -like '*-File*guardian.ps1*' -and $_.CommandLine -notlike '*NoLogo*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Remove-Item (Join-Path $root 'state\guardian.pid') -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $root 'state\bridge.lock') -Force -ErrorAction SilentlyContinue

Say '3/6 停止 SnowLuma 网关'
$sl = Resolve-SnowLumaHome
Get-CimInstance Win32_Process -Filter "name='node.exe'" | Where-Object { $sl -and $_.ExecutablePath -and $_.ExecutablePath.StartsWith($sl, [StringComparison]::OrdinalIgnoreCase) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Get-CimInstance Win32_Process -Filter "name='cmd.exe'" | Where-Object { $_.CommandLine -match 'SnowLuma' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 3

Say '4/6 关闭并重新启动 DeepSeek Harness'
Get-Process | Where-Object { $_.ProcessName -like 'DeepSeek Harness*' } |
    ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 5
$app = Resolve-DshApp
if ($app) {
    Start-Process -FilePath $app
    Say '  DSH 已启动，等端口就绪'
} else {
    Say "  ❌ 找不到 $app"
}

Say '5/6 等 DSH Web 端口就绪'
$port = $null
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 2
    $pids = (Get-Process | Where-Object { $_.ProcessName -like 'DeepSeek Harness*' }).Id
    $ports = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
        Where-Object { $pids -contains $_.OwningProcess -and $_.LocalAddress -eq '127.0.0.1' } |
        Select-Object -ExpandProperty LocalPort -Unique
    foreach ($p in $ports) {
        try { $null = Invoke-WebRequest "http://127.0.0.1:$p/" -TimeoutSec 3 -ErrorAction Stop; $port = $p; break }
        catch { if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -in 401,403) { $port = $p; break } }
    }
    if ($port) { break }
}
if ($port) { Say "  DSH Web 端口 = $port" } else { Say '  ⚠️ 没等到 DSH 端口，后续会由守护进程自己补' }

Say '6/6 启动 SnowLuma → 守护进程（它会拉起桥接）'
$null = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine = ('cmd.exe /c "cd /d "' + (Resolve-SnowLumaHome) + '" && launcher.bat"')
}
Start-Sleep -Seconds 20
$null = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine = ('pwsh.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $root 'tools\guardian.ps1') + '"')
}
Start-Sleep -Seconds 25

# 收尾核对
$p3100 = $false; $p5099 = $false; $p3000 = $false
try { $p3100 = [bool](Get-NetTCPConnection -State Listen -LocalPort 3100 -ErrorAction SilentlyContinue) } catch {}
try { $p5099 = [bool](Get-NetTCPConnection -State Listen -LocalPort 5099 -ErrorAction SilentlyContinue) } catch {}
try { $p3000 = [bool](Get-NetTCPConnection -State Listen -LocalPort 3000 -ErrorAction SilentlyContinue) } catch {}
Say "收尾：桥接3100=$p3100 网关5099=$p5099 OneBot3000=$p3000"
Say '========== 全量重启结束 =========='
