# File: sysmon-install-elevated.ps1
# Elevated one-shot for win-sysmon enable (TASK-SYSMON-1): installs the Sysmon
# driver+service with the minimal DNS-only config and grants the user read
# access to the Sysmon event log via the documented "Event Log Readers" group
# (one time). The collector TASK is NOT registered here: every task registered
# from an elevated context on this machine is auto-disabled within ~0.5s by an
# endpoint policy agent (Enable-ScheduledTask Ready -> Disabled, verified in
# elevated context 2026-09-20; tasks registered non-elevated, like
# OsObserve-NetDnsPoll, survive). The outer non-elevated side registers the
# collector task exactly like the builtin one. Invoked via UAC
# (Start-Process -Verb RunAs) from governance-cli os-observe sysmon-enable;
# the guide presents the four supply-chain elements before elevation.
# Exit codes (also written to sysmon\elevated-result.txt -- Start-Process -Wait
# is unreliable for elevated children, so the outer side polls the result file):
# 0=ok, 10=driver install failed, 12=deployed files missing, 14=group grant failed.
param(
  # Paths passed explicitly by the caller (UAC with different admin credentials
  # would resolve a different USERPROFILE -- delta review finding 8).
  [string]$SysmonDir = (Join-Path $env:USERPROFILE '.zcode\os-observe\sysmon'),
  [string]$BinDir = (Join-Path $env:USERPROFILE '.zcode\os-observe\bin')
)
$ErrorActionPreference = 'Stop'
$bin = $BinDir
$sysmon = Join-Path $sysmonDir 'Sysmon64.exe'
$config = Join-Path $bin 'sysmon-config.xml'
$collector = Join-Path $bin 'collect-sysmon.ps1'
$result = Join-Path $sysmonDir 'elevated-result.txt'
function Finish([int]$code) {
  [System.IO.File]::WriteAllText($result, [string]$code)
  exit $code
}
if (-not (Test-Path $sysmon) -or -not (Test-Path $config) -or -not (Test-Path $collector)) { Finish 12 }
& $sysmon -accepteula -i $config
if ($LASTEXITCODE -ne 0) {
  # Idempotence: -i fails when Sysmon is already installed; reconfigure instead
  # (real-machine run 2026-09-20). A genuine failure fails both paths -> Finish 10.
  & $sysmon -accepteula -c $config
  if ($LASTEXITCODE -ne 0) { Finish 10 }
}
# One-time documented grant: Event Log Readers membership enables reading the
# Sysmon operational channel without elevation. Takes effect in NEW logon
# tokens (the outer note tells the user to relog). Idempotent-tolerant.
# Membership check is exact per-line (trimmed, case-insensitive) -- substring
# matching would confuse e.g. "wang" with "wangp" (delta review finding 4).
function Test-InGroup {
  (net localgroup 'Event Log Readers' 2>$null | ForEach-Object { $_.Trim() }) -icontains $env:USERNAME
}
$inGroup = Test-InGroup
if (-not $inGroup) {
  net localgroup 'Event Log Readers' $env:USERNAME /add | Out-Null
  $inGroup = Test-InGroup
  if (-not $inGroup) { Finish 14 }
}
# Clean up any task registered by earlier attempts (elevated-context registrations
# are policy-disabled on this machine and block the non-elevated re-registration
# with access denied; best effort, absence is fine).
try { Unregister-ScheduledTask -TaskName 'OsObserve-SysmonPoll' -Confirm:$false -ErrorAction SilentlyContinue } catch { }
Finish 0
