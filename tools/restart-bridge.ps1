# 重新拉起桥接：杀旧实例 → 清锁 → 同步 DSH 端口 → 启动守护
# 用法：双击 restart-sync.bat，或 pwsh -File tools\restart-bridge.ps1
$ErrorActionPreference = 'Continue'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

Write-Host '[restart] 1/4 停止旧桥接实例 ...'
Get-CimInstance Win32_Process -Filter "name='node.exe'" |
    Where-Object { $_.CommandLine -match 'src[\\/]bridge\.js' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2

# 控制台端口 3100 的 EADDRINUSE 通常是「守护进程同时也在拉一个实例」造成的：
# 守护看到桥接被杀就立刻补一个，于是两个实例抢 3100，抢输的那个打一行 EADDRINUSE 后
# 因单实例锁退出。**这里只观察不杀**——上一版在这里连杀多个实例，反而跟守护对着干。
Write-Host '[restart] 1b/4 观察控制台端口 3100（只报告，不杀）...'
for ($i = 0; $i -lt 8; $i++) {
    $conns = Get-NetTCPConnection -LocalPort 3100 -State Listen -ErrorAction SilentlyContinue
    if (-not $conns) { break }
    Start-Sleep -Milliseconds 700
}
$still = Get-NetTCPConnection -LocalPort 3100 -State Listen -ErrorAction SilentlyContinue
if ($still) {
    foreach ($p in ($still.OwningProcess | Select-Object -Unique)) {
        Write-Host "  3100 仍由 pid $p 占用（多半是守护刚拉起的实例，属正常竞态）"
    }
}

Write-Host '[restart] 2/4 清理单实例锁 ...'
if (Test-Path 'state\bridge.lock') { Remove-Item 'state\bridge.lock' -Force }

Write-Host '[restart] 3/4 同步 DSH 端口 ...'
& pwsh -NoProfile -ExecutionPolicy Bypass -File 'tools\sync-dsh-port.ps1'
if ($LASTEXITCODE -ne 0) {
    Write-Host '[restart] 端口同步失败：先打开 DeepSeek Harness 再重试。' -ForegroundColor Red
    exit 1
}

Write-Host '[restart] 4/4 启动桥接（隐藏窗口，脱离当前进程树，DSH 重启不会带死它）...'
# 用 WMI 创建进程：父进程是 WmiPrvSE，不在调用方的 Job Object 里，DSH 退出时不会被一起收掉。
# 再套一层 wscript + hidden-launch.vbs：窗口隐藏，不会每次重启都弹一个刷屏的黑框。
$vbs = Join-Path $root 'tools\hidden-launch.vbs'
if (Test-Path $vbs) {
    $null = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
        CommandLine = "wscript.exe `"$vbs`" `"$root`""
    }
} else {
    # 兜底：没有 vbs 时仍然能启动，只是会弹窗口
    $null = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
        CommandLine = "cmd.exe /c `"cd /d $root && start.bat`""
    }
}
Write-Host '[restart] 已启动（后台运行）。日志在 state\bridge.log，出现「SnowLuma 已连接」即成功。'
