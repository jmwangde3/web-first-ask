#requires -Version 5.1
<#
.SYNOPSIS
  Tray icon for the web-first-ask Broker. Read-only: it never becomes a second
  source of truth and never stops running turns.

.DESCRIPTION
  Polls GET /status every 2 seconds and shows a tooltip. Closing the tray does
  not stop the Broker; running turns continue.

  The script needs WinForms, which is loaded through Add-Type. Some hardened
  environments block that. Run with -SelfTest to check capability first:
  it prints whether WinForms can be loaded and exits without showing an icon.

.PARAMETER BrokerHome
  Broker data directory. Defaults to %LOCALAPPDATA%\web-first-ask. Pass the same
  value as WFA_HOME when the CLI uses an override.

.PARAMETER SelfTest
  Only probe WinForms availability, then exit.

.PARAMETER IntervalMs
  Status polling interval. Default 2000.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File wfa-tray.ps1 -SelfTest

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File wfa-tray.ps1
#>
param(
  [string]$BrokerHome = (Join-Path $env:LOCALAPPDATA "web-first-ask"),
  [switch]$SelfTest,
  [int]$IntervalMs = 2000
)

$ErrorActionPreference = "Stop"

function Test-WinForms {
  try {
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
    Add-Type -AssemblyName System.Drawing -ErrorAction Stop
    return [System.Windows.Forms.NotifyIcon] -ne $null
  } catch {
    return $false
  }
}

function Read-BrokerRecord {
  param([string]$HomeDir)
  $path = Join-Path $HomeDir "broker.json"
  if (-not (Test-Path $path)) { return $null }
  try {
    return Get-Content -Raw -Encoding UTF8 $path | ConvertFrom-Json
  } catch {
    return $null
  }
}

function Get-BrokerStatus {
  param($Record)
  if (-not $Record) { return $null }
  try {
    $headers = @{ "x-wfa-token" = $Record.token }
    $uri = "http://127.0.0.1:$($Record.port)/status"
    return Invoke-RestMethod -Uri $uri -Headers $headers -TimeoutSec 3 -ErrorAction Stop
  } catch {
    return $null
  }
}

function Format-Summary {
  param($Status, $Record)
  if (-not $Status) {
    return @{ Text = "wfa broker: offline"; Detail = "No broker.json or broker not reachable." }
  }
  $running = @($Status.turns | Where-Object { $_.state -eq "running" }).Count
  $queued = @($Status.turns | Where-Object { $_.state -eq "queued" }).Count
  $needs = @($Status.turns | Where-Object { $_.state -eq "needs_human" }).Count
  $text = "wfa: $running running, $queued queued"
  if ($needs -gt 0) { $text += ", $needs needs attention" }
  $detail = "pid=$($Record.pid) port=$($Record.port) mode=$($Record.mode)`n" +
            "chrome=" + $(if ($Status.chrome) { "pid=$($Status.chrome.pid) port=$($Status.chrome.port)" } else { "none" })
  return @{ Text = $text; Detail = $detail }
}

if ($SelfTest) {
  $ok = Test-WinForms
  if ($ok) {
    Write-Output "selftest: ok (WinForms available)"
    exit 0
  }
  Write-Output "selftest: failed (WinForms blocked; tray is unavailable in this environment)"
  Write-Output "fallback: use 'wfa cdp status --json' or a terminal watcher"
  exit 3
}

if (-not (Test-WinForms)) {
  Write-Error "WinForms is unavailable here. Run with -SelfTest for details. Falling back is not automatic."
  exit 3
}

$mutex = New-Object System.Threading.Mutex($false, "Global\web-first-ask-tray")
if (-not $mutex.WaitOne(0)) {
  Write-Output "tray: already running"
  exit 0
}

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = [System.Drawing.SystemIcons]::Application
$notify.Text = "wfa: starting"
$notify.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$itemStatus = $menu.Items.Add("Status: ...")
$itemStatus.Enabled = $false
$menu.Items.Add("-") | Out-Null
$itemRefresh = $menu.Items.Add("Refresh now")
$itemQuit = $menu.Items.Add("Exit tray (broker keeps running)")
$notify.ContextMenuStrip = $menu

$script:lastRecord = $null

function Update-Tray {
  $record = Read-BrokerRecord -HomeDir $BrokerHome
  $script:lastRecord = $record
  $status = Get-BrokerStatus -Record $record
  $summary = Format-Summary -Status $status -Record $record
  $notify.Text = $summary.Text
  $itemStatus.Text = $summary.Text
  $itemStatus.ToolTipText = $summary.Detail
}

Update-Tray

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = [Math]::Max(500, $IntervalMs)
$timer.Add_Tick({ Update-Tray })
$timer.Start()

$itemRefresh.Add_Click({ Update-Tray })
$itemQuit.Add_Click({
  $timer.Stop()
  $notify.Visible = $false
  $notify.Dispose()
  [System.Windows.Forms.Application]::Exit()
})
$notify.Add_DoubleClick({
  try {
    $wfa = Join-Path $PSScriptRoot "..\bin\wfa.js"
    Start-Process -FilePath "node" -ArgumentList @($wfa, "cdp", "status", "--json") -WindowStyle Minimized
  } catch {
    # Status stays visible in the tooltip; double-click is a convenience only.
  }
})

[System.Windows.Forms.Application]::Run()

$timer.Stop()
if ($notify.Visible) { $notify.Visible = $false }
$notify.Dispose()
try { $mutex.ReleaseMutex() } catch { }
$mutex.Dispose()
