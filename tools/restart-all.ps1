# 一键重启 DeepSeek Harness + 桥接（必须从 DSH 之外的窗口运行，否则会把自己杀掉）
# 用法：双击 重启全套.bat
$ErrorActionPreference = 'Continue'
$root = Split-Path $PSScriptRoot -Parent
$log  = Join-Path $root 'state\restart-all.log'
function Say($m) {
    $line = "[$(Get-Date -Format HH:mm:ss)] $m"
    Write-Host $line
    Add-Content -Path $log -Value $line -Encoding UTF8
}

Say '===== 一键重启开始 ====='

Say '1/4 关闭 DeepSeek Harness ...'
Get-Process | Where-Object { $_.ProcessName -like 'DeepSeek Harness*' } | ForEach-Object {
    Say "  kill $($_.ProcessName) PID=$($_.Id)"
    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 4

Say '2/4 重新启动 DeepSeek Harness ...'
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
$app = Resolve-DshApp
if (-not $app) {
    Say "  找不到 $app，请你手动打开 DSH 后双击 restart-sync.bat"
    exit 1
}
Start-Process -FilePath $app
Start-Sleep -Seconds 25

Say '3/4 等待 DSH Web 端口就绪 ...'
$ok = $false
for ($i = 0; $i -lt 24; $i++) {
    $procs = (Get-Process | Where-Object { $_.ProcessName -like 'DeepSeek Harness*' }).Id
    $ports = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
        Where-Object { $procs -contains $_.OwningProcess -and $_.LocalAddress -eq '127.0.0.1' } |
        Select-Object -ExpandProperty LocalPort -Unique
    foreach ($p in $ports) {
        try {
            $null = Invoke-WebRequest "http://127.0.0.1:$p/" -TimeoutSec 3 -ErrorAction Stop
            $ok = $true; break
        } catch {
            if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 401) { $ok = $true; break }
        }
    }
    if ($ok) { Say "  DSH Web 已就绪（端口 $p）"; break }
    Start-Sleep -Seconds 3
}
if (-not $ok) { Say '  DSH 端口没等到，可能还在启动；稍后手动双击 restart-sync.bat' }

Say '4/4 同步端口并重启桥接 ...'
& pwsh -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'tools\restart-bridge.ps1')
Say '===== 完成。看桥接窗口是否出现「SnowLuma 已连接」====='
