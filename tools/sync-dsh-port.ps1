# 同步 DSH 实际监听端口到 config.json 的 dsh.baseUrl
# 用法: powershell -ExecutionPolicy Bypass -File tools\sync-dsh-port.ps1
# 背景: DeepSeek Harness 每次重启会换一个随机本地端口，桥接的 baseUrl 写死就会连不上。
$ErrorActionPreference = 'Stop'
$cfgPath = Join-Path $PSScriptRoot '..\config.json' | Resolve-Path

$pids = (Get-Process | Where-Object { $_.ProcessName -like 'DeepSeek*' }).Id
if (-not $pids) { Write-Error 'DSH 进程没在跑，先启动 DeepSeek Harness'; exit 1 }

$ports = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $pids -contains $_.OwningProcess -and $_.LocalAddress -eq '127.0.0.1' } |
    Select-Object -ExpandProperty LocalPort -Unique

$found = $null
foreach ($port in $ports) {
    # DSH 根路径正常回 401（需要鉴权），401/200 都说明是它在服务
    try {
        $null = Invoke-WebRequest "http://127.0.0.1:$port/" -TimeoutSec 5 -ErrorAction Stop
        $found = $port; break
    } catch {
        $code = $null
        if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
        if ($code -eq 401 -or $code -eq 403) { $found = $port; break }
    }
}
if (-not $found) { Write-Error "找到 DSH 监听端口 [$($ports -join ', ')]，但没有一个像 DSH Web（预期 401/200）"; exit 1 }

$cfg = Get-Content $cfgPath -Raw -Encoding UTF8
$new = $cfg -replace '"baseUrl":\s*"http://127\.0\.0\.1:\d+"', "`"baseUrl`": `"http://127.0.0.1:$found`""
if ($new -ne $cfg) {
    Set-Content $cfgPath $new -NoNewline -Encoding UTF8
    Write-Host "[sync] dsh.baseUrl -> http://127.0.0.1:$found  (已写入 config.json)"
} else {
    Write-Host "[sync] dsh.baseUrl 已是 http://127.0.0.1:$found，无需改动"
}
