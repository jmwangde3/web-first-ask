[CmdletBinding()]
param(
    [string]$Target = ".",
    [Parameter(Mandatory = $true)]
    [string]$Task,
    [ValidateRange(1, 20000)]
    [int]$Budget = 3000,
    [string]$KbRoot = "$HOME\.skills-manager\skills\handoff-kb",
    [string]$PythonLauncher = "py",
    [string[]]$Line
)

$ErrorActionPreference = "Stop"

$TargetPath = (Resolve-Path -LiteralPath $Target).Path
$ContextScript = Join-Path $KbRoot "scripts\kb-context.py"
if (-not (Test-Path -LiteralPath $ContextScript -PathType Leaf)) {
    throw "handoff-kb kb-context.py was not found: $ContextScript"
}

$BriefDirectory = Join-Path $TargetPath ".wfa"
$BriefPath = Join-Path $BriefDirectory "active-brief.md"
New-Item -ItemType Directory -Path $BriefDirectory -Force | Out-Null

$Arguments = @(
    $ContextScript,
    "--target", $TargetPath,
    "--task", $Task,
    "--budget", "$Budget",
    "--mode", "task"
)
foreach ($Item in $Line) {
    if (-not [string]::IsNullOrWhiteSpace($Item)) {
        $Arguments += @("--line", $Item)
    }
}

$Output = & $PythonLauncher @Arguments
$ExitCode = $LASTEXITCODE
if ($ExitCode -ne 0) {
    throw "handoff-kb kb-context.py failed with exit code $ExitCode. Existing active brief was not changed."
}

$Content = ($Output -join [Environment]::NewLine).Trim()
if ([string]::IsNullOrWhiteSpace($Content)) {
    throw "handoff-kb returned an empty brief. Existing active brief was not changed."
}

$Content += [Environment]::NewLine
$Encoding = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText($BriefPath, $Content, $Encoding)

Write-Host "ACTIVE_BRIEF_WRITTEN: $BriefPath"
Write-Host "Encoding: UTF-8 without BOM"
Write-Host "Budget: $Budget"
