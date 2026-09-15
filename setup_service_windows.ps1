# ==============================================================================
# Antigravity Bridge (Node.js Edition) - Windows Service / Background Installer
# ==============================================================================
# Usage (PowerShell as Administrator or Standard User):
#   powershell -ExecutionPolicy Bypass -File .\setup_service_windows.ps1 install
#   powershell -ExecutionPolicy Bypass -File .\setup_service_windows.ps1 status
#   powershell -ExecutionPolicy Bypass -File .\setup_service_windows.ps1 start
#   powershell -ExecutionPolicy Bypass -File .\setup_service_windows.ps1 stop
#   powershell -ExecutionPolicy Bypass -File .\setup_service_windows.ps1 uninstall
# ==============================================================================

param(
    [ValidateSet("install", "start", "stop", "restart", "status", "uninstall")]
    [string]$Action = "install"
)

$TaskName = "AntigravityBridgeNode"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$NodePath = (Get-Command node -ErrorAction SilentlyContinue).Source

if (-not $NodePath) {
    Write-Host "[ERROR] Node.js is not found in your PATH. Please install Node.js (v18+) first." -ForegroundColor Red
    exit 1
}

$EntryPoint = Join-Path $ScriptDir "src\index.mjs"
$LogDir = Join-Path $env:USERPROFILE ".config\antigravity"
if (-not (Test-Path $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
}
$LogFile = Join-Path $LogDir "bridge-node.log"

function Install-Task {
    Write-Host "============================================================" -ForegroundColor Cyan
    Write-Host "🪟 Installing Antigravity Bridge Windows Background Task" -ForegroundColor Cyan
    Write-Host "============================================================" -ForegroundColor Cyan
    Write-Host "  Task Name:   $TaskName"
    Write-Host "  Node Binary: $NodePath"
    Write-Host "  Entry Point: $EntryPoint"
    Write-Host "  Log File:    $LogFile"
    Write-Host "============================================================"

    $VbsScript = Join-Path $ScriptDir "run_windows_hidden.vbs"
    $VbsContent = @"
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run """$NodePath"" ""$EntryPoint"" --port 8008 --host 127.0.0.1", 0, False
"@
    Set-Content -Path $VbsScript -Value $VbsContent -Encoding ASCII

    $TaskAction = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$VbsScript`"" -WorkingDirectory $ScriptDir
    $TaskTrigger = New-ScheduledTaskTrigger -AtLogOn
    $TaskSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit 0

    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

    Register-ScheduledTask -TaskName $TaskName -Action $TaskAction -Trigger $TaskTrigger -Settings $TaskSettings -Description "Antigravity Bridge REST API Server on Port 8008" | Out-Null

    Start-ScheduledTask -TaskName $TaskName
    Start-Sleep -Seconds 2

    Write-Host ""
    Write-Host "✅ Service registered and started in background!" -ForegroundColor Green
    Get-ServiceStatus
}

function Start-Task {
    Write-Host "[INFO] Starting $TaskName..."
    Start-ScheduledTask -TaskName $TaskName
    Start-Sleep -Seconds 2
    Get-ServiceStatus
}

function Stop-Task {
    Write-Host "[INFO] Stopping $TaskName..."
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Get-Process -Name "node" -ErrorAction SilentlyContinue | Where-Object {
        $_.CommandLine -like "*$EntryPoint*"
    } | Stop-Process -Force -ErrorAction SilentlyContinue
    Write-Host "✅ Stopped." -ForegroundColor Green
}

function Get-ServiceStatus {
    Write-Host "`n📊 Service Status:" -ForegroundColor Cyan
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($task) {
        Write-Host "   Task State: $($task.State)" -ForegroundColor Green
        Write-Host "   Health Check (Port 8008):"
        try {
            $resp = Invoke-RestMethod -Uri "http://127.0.0.1:8008/health" -TimeoutSec 3 -ErrorAction Stop
            Write-Host "   [OK] Server is Healthy: $($resp.service) (Profiles: $($resp.profiles.Count))" -ForegroundColor Green
        } catch {
            Write-Host "   [WARN] Server not responding yet on http://127.0.0.1:8008/health" -ForegroundColor Yellow
        }
    } else {
        Write-Host "   [WARN] Task '$TaskName' is not installed." -ForegroundColor Yellow
    }
}

function Uninstall-Task {
    Stop-Task
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    $VbsScript = Join-Path $ScriptDir "run_windows_hidden.vbs"
    if (Test-Path $VbsScript) {
        Remove-Item $VbsScript -Force -ErrorAction SilentlyContinue
    }
    Write-Host "✅ Task '$TaskName' has been uninstalled." -ForegroundColor Green
}

switch ($Action) {
    "install"   { Install-Task }
    "start"     { Start-Task }
    "stop"      { Stop-Task }
    "restart"   { Stop-Task; Start-Sleep -Seconds 1; Start-Task }
    "status"    { Get-ServiceStatus }
    "uninstall" { Uninstall-Task }
}
