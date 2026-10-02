# Uninstall on Windows: remove the scheduled task and restore the original
# Claude Code extension files from their .bak.original backups.
#   powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
$ErrorActionPreference = 'Stop'

$taskName = 'claude-code-patch'

Write-Host "[uninstall] removing scheduled task '$taskName'"
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

Write-Host '[uninstall] restoring original Claude Code extension files'
$roots = @(
  (Join-Path $env:USERPROFILE '.cursor\extensions'),
  (Join-Path $env:USERPROFILE '.vscode\extensions'),
  (Join-Path $env:USERPROFILE '.vscode-insiders\extensions')
)
foreach ($root in $roots) {
  if (-not (Test-Path $root)) { continue }
  Get-ChildItem -Path $root -Filter 'anthropic.claude-code-*' -Directory | ForEach-Object {
    foreach ($rel in @('extension.js', 'webview\index.js')) {
      $file   = Join-Path $_.FullName $rel
      $backup = "$file.bak.original"
      if (Test-Path $backup) {
        Copy-Item $backup $file -Force
        Write-Host "  restored: $file"
      }
    }
  }
}

Write-Host ''
Write-Host 'Uninstalled. Reload Cursor/VS Code to pick up the original extension.'
