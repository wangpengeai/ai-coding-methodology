# File: collect-sysmon.ps1
# os-observation win-sysmon sampler (TASK-SYSMON-1, R-M14-9): reads Sysmon
# operational log DnsQuery events (Event ID 22) since the watermark and appends
# one JSON line per event to the dated raw file (kind='dnsq'; process name from
# Image basename -- path never stored, FR-tg-16 privacy whitelist). The Node
# read-side pipeline classifies; zero parsing/classification here. Pure ASCII
# only (PS 5.1 parses BOM-less files as GBK on zh-CN hosts). Fail-open: any
# error exits 0 silently (a dead round is detectable via the stagnation hint,
# never a crash loop). Watermark: raw\sysmon-cursor.txt holds the NEWEST consumed
# event time (UTC ISO). Each run walks ASCENDING page by page -- window
# (watermark, upper], page <=500, upper advanced by windowSec (10 min, halved on
# saturation) -- and advances the cursor to the upper bound of every page it fully
# consumed, so a partial run (page cap, read failure) neither loses events nor
# re-emits a consumed prefix. The old per-row assignment left the cursor on the
# OLDEST emitted row, so every run re-read and re-emitted the same window
# (TASK-SYSMON-REPLAY-1 experiment: 49 of 50 appended rows were replays, ~98%).
# First run (no cursor) starts from now-10min (no full-log backfill).
# Fixed 5-minute cadence (independent of the builtin pollMinutes config; the
# stagnation hint reads raw mtime across all samples either way).
# Host processes that host CIM/WMI providers: a DnsQuery logged with their Image is
# attributed to the HOST, not to the client that asked for it -- and os-observe's own
# Get-DnsClientCache (CIM) makes the host re-issue the cached names, i.e. the collector
# observing itself (2026-09-29 TASK-DEBTFIX-1: 368,866/510,952 dnsq rows; a single manual
# Get-DnsClientCache produced 135 same-attributed events within 15s). Those rows are not
# ingested; the events stay in the Sysmon log for audit. PowerShell -contains on a string
# array is case-insensitive.
$HOST_ATTRIBUTION_HOSTS = @('wmiprvse.exe')
$ErrorActionPreference = 'SilentlyContinue'
$root = Join-Path $env:USERPROFILE '.zcode\os-observe'
$rawDir = Join-Path $root 'raw'
if (-not (Test-Path $rawDir)) { New-Item -ItemType Directory -Force -Path $rawDir | Out-Null }
$cursorFile = Join-Path $rawDir 'sysmon-cursor.txt'
$start = (Get-Date).ToUniversalTime().AddMinutes(-10).ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
if (Test-Path $cursorFile) { $c = Get-Content $cursorFile -ErrorAction SilentlyContinue; if ($c) { $start = [string]$c } }
# corrupt/truncated cursor (e.g. process killed mid-write) => fall back to now-10min; a
# NaN watermark would freeze the backend forever (review 2026-09-29 F4)
try { [void][datetime]::Parse($start) } catch { $start = (Get-Date).ToUniversalTime().AddMinutes(-10).ToString('yyyy-MM-ddTHH:mm:ss.fffZ') }
$lines = New-Object System.Collections.Generic.List[string]
$watermark = $start    # events <= $watermark are consumed (advances page by page)
$nowEnd = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
$windowSec = 600       # page window (10 min); halved when a window saturates the cap
$pageCount = 0
$stalled = $false
while ($pageCount -lt 40 -and -not $stalled) {
  $upper = ([datetime]::Parse($watermark).ToUniversalTime().AddSeconds($windowSec)).ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  if ($upper -gt $nowEnd) { $upper = $nowEnd }
  # ascending window (watermark, upper]; BARE > and <= -- XML entities are invalid here
  # (plan-review empirical, 2026-09-29 PS 5.1.26100.9444: "&gt;" => "The specified query is invalid"; bare ">" OK)
  $xpath = "*[System[EventID=22 and TimeCreated[@SystemTime>'$watermark'] and TimeCreated[@SystemTime<='$upper']]]"
  $events = @()
  try { $events = @(Get-WinEvent -LogName 'Microsoft-Windows-Sysmon/Operational' -FilterXPath $xpath -MaxEvents 500 -ErrorAction Stop) }
  catch {
    # PS 5.1 THROWS on zero matches ("No events were found that match the specified
    # selection criteria"): that is an EMPTY window (advance the watermark), NOT a read
    # failure. Only genuine failures freeze the watermark (read failure != empty window).
    # (review 2026-09-29 F1: treating empty as failure froze the backend forever once any
    #  >=10 min quiet window occurred -> silent permanent loss)
    if (-not ($_.FullyQualifiedErrorId -like 'NoMatchingEventsFound*')) { break }
  }
  if ($events.Count -ge 500) {
    # saturated window: shrink and retry WITHOUT advancing (never lose events)
    if ($windowSec -le 1) { $stalled = $true; break }
    $windowSec = [int]([math]::Max(1, $windowSec / 2))
    continue
  }
  foreach ($e in $events) {
    $utc = $e.TimeCreated.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  # name-based extraction: field order varies across Sysmon versions (15.x puts
  # RuleName first, Image last) -- never rely on property position (stage-gate fix)
  $d = @{}
  try {
    $x = [xml]$e.ToXml()
    foreach ($n in $x.Event.EventData.Data) { $d[$n.Name] = [string]$n.'#text' }
  } catch { continue }
  $image = $d['Image']
  $queryName = $d['QueryName']
  $queryResults = $d['QueryResults']
  if (-not $queryName) { continue }
  $procName = ''
  if ($image -ne '') { $procName = [System.IO.Path]::GetFileName($image) }
  # Provider-host attribution filter (TASK-DEBTFIX-1): skip rows attributed to the WMI/CIM
  # provider host. This skip must not advance the watermark (same shape as the
  # missing-QueryName skip): the watermark advances only per fully-consumed page.
  if ($HOST_ATTRIBUTION_HOSTS -contains $procName) { continue }
  # QueryResults real-world forms (per observed Sysmon 15.x events): bare
  # addresses 'ip;ip;', v6-mapped '::ffff:ip;', or a 'type:  N' RR header
  # (1=A 5=CNAME 28=AAAA) followed by 'name;ip;'. data keeps the first
  # address-looking token; qtype prefers the RR header. Informational only
  # (findings consume domain/processName, not data/qtype).
  $data = ''
  $qtype = 0
  $rr = 0
  foreach ($tok in @($queryResults -split ';')) {
    $t = $tok.Trim()
    if ($t -eq '') { continue }
    if ($t -match '^type:\s*(\d+)') { $rr = [int]$Matches[1]; continue }
    if ($data -eq '' -and $t -match '^[0-9a-fA-F.:]+$' -and $t -match '\d') { $data = $t }
  }
  if ($rr -gt 0) { $qtype = $rr }
  elseif ($data -ne '') { $qtype = 1 }
  $o = @{ ts = $utc; kind = 'dnsq'; domain = $queryName; data = $data; qtype = $qtype; processName = $procName }
  $lines.Add(($o | ConvertTo-Json -Compress))
  }
  $watermark = $upper          # per-page advance: loss-free and replay-free
  $pageCount += 1
  if ($upper -eq $nowEnd) { break }
  if ($windowSec -lt 600) { $windowSec = 600 }   # healed after a bisect
}
$day = Get-Date -Format 'yyyyMMdd'
$file = Join-Path $rawDir ("samples-$day.jsonl")
if ($lines.Count -gt 0) { [System.IO.File]::AppendAllLines($file, $lines) }
if ($watermark -ne $start) { [System.IO.File]::WriteAllText($cursorFile, $watermark) }
Get-ChildItem -Path $rawDir -Filter 'samples-*.jsonl' -ErrorAction SilentlyContinue |
  Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-7) } |
  Remove-Item -Force -ErrorAction SilentlyContinue
exit 0
