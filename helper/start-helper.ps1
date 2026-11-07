# Keeps the Ring helper running: starts it, logs its output, and restarts it
# if it stops. Windows Task Scheduler runs this hidden when you log in.
# Logs go to helper\logs\helper.log (git-ignored).

$ErrorActionPreference = "Continue"
$here = $PSScriptRoot
$node = "C:\Program Files\nodejs\node.exe"
$logDir = Join-Path $here "logs"
$log = Join-Path $logDir "helper.log"
New-Item -ItemType Directory -Force $logDir | Out-Null

function Write-Log($msg) {
    Add-Content -Path $log -Encoding UTF8 -Value ("{0}  {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg)
}

Set-Location $here
while ($true) {
    # Keep the log small: start a fresh one once it passes 1 MB.
    if ((Test-Path $log) -and (Get-Item $log).Length -gt 1MB) {
        Move-Item $log "$log.old" -Force
    }
    Write-Log "starting helper"
    # Each line the helper prints (including errors) goes into the log with a timestamp.
    & $node --env-file=.env server.js 2>&1 | ForEach-Object { Write-Log "$_" }
    Write-Log "helper stopped (exit code $LASTEXITCODE); restarting in 15 seconds"
    Start-Sleep -Seconds 15
}
