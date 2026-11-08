# File: collect.ps1
# os-observation collector (ADR-029, R-M14-9): samples the established TCP table
# (with owning process name) and the DNS client cache, appending one JSON object
# per line to the dated raw file under ~\.zcode\os-observe\raw (consumed by the
# Node read-side pipeline; zero parsing/classification here -- keep it thin).
# Pure ASCII only: PS 5.1 parses BOM-less files as GBK on zh-CN hosts.
# Fail-open: any error exits 0 silently (a dead round is detectable via the
# stagnation hint on the surfacing side, never a crash loop).
# Retention: raw files older than 7 days are deleted each run.
$ErrorActionPreference = 'SilentlyContinue'
$rawDir = Join-Path $env:USERPROFILE '.zcode\os-observe\raw'
if (-not (Test-Path $rawDir)) { New-Item -ItemType Directory -Force -Path $rawDir | Out-Null }
$day = Get-Date -Format 'yyyyMMdd'
$file = Join-Path $rawDir ("samples-$day.jsonl")
$ts = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
$lines = New-Object System.Collections.Generic.List[string]
$procNames = @{}
foreach ($c in @(Get-NetTCPConnection -State Established)) {
  $ip = [string]$c.RemoteAddress
  if ($ip -eq '' -or $ip -eq '127.0.0.1' -or $ip -eq '::1' -or $ip -eq '0.0.0.0') { continue }
  $procId = [int]$c.OwningProcess   # note: $pid is a read-only automatic variable in PS
  if ($procId -le 4) { continue }
  if (-not $procNames.ContainsKey($procId)) {
    $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if ($null -ne $p) { $procNames[$procId] = $p.ProcessName } else { $procNames[$procId] = '' }
  }
  $o = @{ ts = $ts; kind = 'tcp'; ip = $ip; port = [int]$c.RemotePort; processName = $procNames[$procId] }
  $lines.Add(($o | ConvertTo-Json -Compress))
}
foreach ($e in @(Get-DnsClientCache)) {
  $t = [int]$e.Type    # 1=A 5=CNAME 28=AAAA (A/AAAA feed the ip->domain join; CNAME kept for audit)
  if ($t -ne 1 -and $t -ne 5 -and $t -ne 28) { continue }
  $entry = [string]$e.Entry
  $data = [string]$e.Data
  if ($entry -eq '' -or $data -eq '') { continue }
  $o = @{ ts = $ts; kind = 'dns'; domain = $entry; data = $data; qtype = $t }
  $lines.Add(($o | ConvertTo-Json -Compress))
}
if ($lines.Count -gt 0) {
  [System.IO.File]::AppendAllLines($file, $lines)   # UTF-8 no BOM (PS5.1 Out-File utf8 writes a BOM that corrupts the first JSON line)
}
Get-ChildItem -Path $rawDir -Filter 'samples-*.jsonl' -ErrorAction SilentlyContinue |
  Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-7) } |
  Remove-Item -Force -ErrorAction SilentlyContinue
exit 0
