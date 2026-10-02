# Install the Claude Code patch on Windows.
#   1. Detect the node binary
#   2. Register a Scheduled Task that re-applies the patch every 10 minutes
#      (idempotent, with --self-update so the team repo fix propagates)
#   3. Run the patcher once now
#
# Run from a normal PowerShell (no admin needed):
#   powershell -ExecutionPolicy Bypass -File .\install.ps1
$ErrorActionPreference = 'Stop'

$repoDir  = $PSScriptRoot
$patcher  = Join-Path $repoDir 'patch.mjs'
$taskName = 'claude-code-patch'

# --- detect node ---
$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = (Get-Command node -ErrorAction SilentlyContinue).Source }
if (-not $node) {
  Write-Error 'node not found. Install Node.js (https://nodejs.org) and re-run.'
  exit 1
}

Write-Host "[install] repo dir : $repoDir"
Write-Host "[install] node bin : $node"

# --- register the scheduled task ---
# Two triggers: one that repeats every 10 min, one at logon, so the patch
# survives both extension updates and reboots. Runs as the current user.
$action = New-ScheduledTaskAction -Execute $node `
  -Argument "`"$patcher`" --self-update" -WorkingDirectory $repoDir

$repeat = New-ScheduledTaskTrigger -Once -At (Get-Date) `
  -RepetitionInterval (New-TimeSpan -Minutes 10)
$logon  = New-ScheduledTaskTrigger -AtLogOn

$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries -StartWhenAvailable

# -Force overwrites any previous registration (idempotent install).
Register-ScheduledTask -TaskName $taskName -Action $action `
  -Trigger @($repeat, $logon) -Settings $settings -Force | Out-Null
Write-Host "[install] scheduled task '$taskName' registered (every 10 min)"

# --- run once now so the patch is applied immediately ---
& $node $patcher

Write-Host ''
Write-Host 'Done. Reload Cursor/VS Code: Ctrl+Shift+P -> Developer: Reload Window'
Write-Host "Logs: $repoDir\patch.log (stdout) — task output is captured by Task Scheduler"
