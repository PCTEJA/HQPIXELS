<#
.SYNOPSIS
  Proves the anti-double-allocation guarantee with real concurrent connections.

.DESCRIPTION
  Acceptance gates covered (see "Test and security acceptance gates" in the
  project brief):

    * Two parallel reservations cannot own the same cell.
    * A 100-request overlapping-claim test produces one valid owner per cell and
      NO partial reservations.

  How it achieves genuine simultaneity: every worker is a separate psql process
  that first sleeps until a shared wall-clock instant (T0), then immediately
  calls reserve_cells. So all N transactions contend inside the same few
  milliseconds rather than being serialised by process startup.

  Two scenarios run:
    A. Thundering herd  — all N workers claim the SAME rectangle.
                          Expect exactly 1 success, N-1 clean refusals.
    B. Overlapping chain — worker i claims (i, row, 2, 1), so every rectangle
                          overlaps its neighbour. Expect a valid subset to win
                          with no cell owned twice and no partial reservation.

  Invariants asserted afterwards, regardless of who won:
    1. no cell appears twice            (the PRIMARY KEY, verified)
    2. every holding reservation has exactly cell_count cell rows (atomicity)
    3. successes reported == reservations that actually hold cells
    4. no orphan cells and no orphan placements

.PARAMETER Workers
  Number of concurrent claimants per scenario. Default 100.
#>
param(
  [int]$Port = 55432,
  [string]$Database = 'hqpixels',
  [int]$Workers = 100,
  [switch]$SkipReset
)

$ErrorActionPreference = 'Stop'

$pgRoot = (Get-ChildItem 'C:\Program Files\PostgreSQL' -Directory -ErrorAction SilentlyContinue |
  Sort-Object Name -Descending | Select-Object -First 1).FullName
if (-not $pgRoot) { throw 'No PostgreSQL installation found.' }
$psql = Join-Path $pgRoot 'bin\psql.exe'
$repo = Split-Path -Parent $PSScriptRoot

$base = @('-h', '127.0.0.1', '-p', "$Port", '-U', 'postgres', '-d', $Database,
          '-X', '-q', '--no-psqlrc', '-A', '-t')

function Invoke-Sql([string]$sql) {
  $out = & $psql @base -c $sql 2>&1
  if ($LASTEXITCODE -ne 0) { throw ($out -join "`n") }
  return $out
}

if (-not $SkipReset) {
  Write-Host 'Resetting schema...'
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'pg-apply.ps1') `
      -Port $Port -Database $Database | Select-Object -Last 1
}

$workDir = Join-Path $env:TEMP 'hqpixels-concurrency'
if (Test-Path $workDir) { Remove-Item -Recurse -Force $workDir }
New-Item -ItemType Directory -Force $workDir | Out-Null

# --- fixtures: one verified buyer per worker ---------------------------------
Write-Host "Creating $Workers verified buyers..."
Invoke-Sql @"
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data)
select
  ('c0000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid,
  'load' || g || '@example.test',
  now(),
  jsonb_build_object('name', 'Load ' || g)
from generate_series(1, $Workers) g
on conflict (id) do nothing;
"@ | Out-Null

$profiles = [int](Invoke-Sql 'select count(*) from public.profiles' | Select-Object -First 1).Trim()
Write-Host "  profiles: $profiles"

function Start-Herd {
  param(
    [string]$Label,
    [scriptblock]$RectFor,   # takes worker index, returns @(x,y,w,h)
    [int]$LeadSeconds = 6
  )

  $t0 = (Get-Date).ToUniversalTime().AddSeconds($LeadSeconds).ToString('yyyy-MM-dd HH:mm:ss.fff')
  Write-Host ''
  Write-Host "--- Scenario $Label : $Workers concurrent claims, all firing at ${t0}Z ---"

  $procs = @()
  for ($i = 1; $i -le $Workers; $i++) {
    $rect = & $RectFor $i
    $owner = 'c0000000-0000-4000-8000-' + ($i.ToString().PadLeft(12, '0'))
    $cells = $rect[2] * $rect[3]
    $total = $cells * 1000

    $sqlFile = Join-Path $workDir "$Label-$i.sql"
    @"
-- Barrier: every worker wakes at the same instant so the claims genuinely race.
select pg_sleep(greatest(0, extract(epoch from (timestamptz '${t0}+00' - clock_timestamp()))));
select public.reserve_cells(
  '$owner'::uuid, $($rect[0]), $($rect[1]), $($rect[2]), $($rect[3]),
  1, $total, $total, '{}'::jsonb, 'v1', null
) ->> 'code' as code;
"@ | Set-Content -Path $sqlFile -Encoding utf8

    $outFile = Join-Path $workDir "$Label-$i.out"
    $procs += Start-Process -FilePath $psql `
      -ArgumentList (@('-h','127.0.0.1','-p',"$Port",'-U','postgres','-d',$Database,
                       '-X','-q','--no-psqlrc','-A','-t','-f',$sqlFile)) `
      -NoNewWindow -PassThru -RedirectStandardOutput $outFile `
      -RedirectStandardError (Join-Path $workDir "$Label-$i.err")
  }

  Write-Host "  launched $($procs.Count) processes; waiting..."
  # Poll rather than `Wait-Process -Timeout`: with ~100 handles that cmdlet
  # reports a spurious timeout on one process even when every worker has already
  # exited and written its result file.
  $deadline = (Get-Date).AddSeconds(300)
  while ((Get-Date) -lt $deadline) {
    $alive = @($procs | Where-Object { -not $_.HasExited })
    if ($alive.Count -eq 0) { break }
    Start-Sleep -Milliseconds 400
  }
  $stragglers = @($procs | Where-Object { -not $_.HasExited })
  if ($stragglers.Count -gt 0) {
    Write-Host "  WARNING: $($stragglers.Count) worker(s) did not exit; killing them" -ForegroundColor Yellow
    $stragglers | Stop-Process -Force -ErrorAction SilentlyContinue
    $script:failures++
  }

  # reserve_cells returns {ok:true} with no 'code' key on success, so an empty
  # line means success and a non-empty line is the refusal code.
  $success = 0
  $codes = @{}
  for ($i = 1; $i -le $Workers; $i++) {
    $raw = Get-Content (Join-Path $workDir "$Label-$i.out") -Raw -ErrorAction SilentlyContinue
    $line = if ($raw) { ($raw -split "`n" | Where-Object { $_.Trim() -ne '' } | Select-Object -Last 1) } else { $null }
    $code = if ($line) { $line.Trim() } else { '' }
    if ($code -eq '') {
      $success++
    } else {
      # Windows PowerShell 5.1 has no null-coalescing operator.
      if ($codes.ContainsKey($code)) { $codes[$code] = $codes[$code] + 1 } else { $codes[$code] = 1 }
    }
  }

  Write-Host "  successes : $success"
  foreach ($k in ($codes.Keys | Sort-Object)) { Write-Host "  refused   : $k x$($codes[$k])" }
  return $success
}

$failures = 0
function Assert-Db {
  param([string]$Name, [string]$Sql, [string]$Expected)
  $actual = (Invoke-Sql $Sql | Where-Object { $_.Trim() -ne '' } | Select-Object -First 1)
  if ($null -ne $actual) { $actual = $actual.Trim() }
  if ("$actual" -eq "$Expected") {
    Write-Host "  ok    $Name" -ForegroundColor Green
  } else {
    $script:failures++
    Write-Host "  FAIL  $Name (expected '$Expected', got '$actual')" -ForegroundColor Red
  }
}

# =============================================================================
# Scenario A — thundering herd on one rectangle
# =============================================================================
$successA = Start-Herd -Label 'A' -RectFor { param($i) @(0, 0, 2, 2) }

Write-Host ''
Write-Host 'Invariants after scenario A:'
if ($successA -eq 1) { Write-Host '  ok    exactly one claimant won' -ForegroundColor Green }
else { $failures++; Write-Host "  FAIL  expected exactly 1 winner, got $successA" -ForegroundColor Red }

Assert-Db 'exactly 4 cells are held' 'select count(*) from public.pixel_cells' '4'
Assert-Db 'exactly one reservation holds cells' `
  'select count(distinct reservation_id) from public.pixel_cells' '1'
Assert-Db 'no cell is owned twice' `
  'select count(*) from (select cell_x, cell_y from public.pixel_cells group by 1,2 having count(*) > 1) d' '0'
Assert-Db 'no partial reservation exists' @'
select count(*) from public.reservations r
where r.state in ('draft','reserved','ready_for_checkout','checkout_created','paid_pending_review','active')
  and (select count(*) from public.pixel_cells c where c.reservation_id = r.id) <> r.cell_count
'@ '0'
Assert-Db 'losers left no reservation row behind' `
  'select count(*) from public.reservations' '1'
Assert-Db 'losers left no placement row behind' `
  'select count(*) from public.placements' '1'

# =============================================================================
# Scenario B — overlapping chain
# =============================================================================
# Worker i claims (i-1, 5, 2, 1). Neighbouring rectangles share a cell, so at
# most every other worker can win. The point is not *which* ones win — it is
# that the outcome is always internally consistent.
$maxB = [Math]::Min($Workers, 99)
$successB = Start-Herd -Label 'B' -RectFor { param($i) @((($i - 1) % $maxB), 5, 2, 1) }

Write-Host ''
Write-Host 'Invariants after scenario B:'
Assert-Db 'no cell is owned twice' `
  'select count(*) from (select cell_x, cell_y from public.pixel_cells group by 1,2 having count(*) > 1) d' '0'
Assert-Db 'no partial reservation exists' @'
select count(*) from public.reservations r
where r.state in ('draft','reserved','ready_for_checkout','checkout_created','paid_pending_review','active')
  and (select count(*) from public.pixel_cells c where c.reservation_id = r.id) <> r.cell_count
'@ '0'
Assert-Db 'every held cell lies inside its reservation rectangle' @'
select count(*) from public.pixel_cells c
join public.reservations r on r.id = c.reservation_id
where c.cell_x < r.cell_x or c.cell_x >= r.cell_x + r.cell_w
   or c.cell_y < r.cell_y or c.cell_y >= r.cell_y + r.cell_h
'@ '0'
Assert-Db 'every held cell has the reservation owner' @'
select count(*) from public.pixel_cells c
join public.reservations r on r.id = c.reservation_id
where c.owner_id <> r.owner_id
'@ '0'
Assert-Db 'no orphan cells' `
  'select count(*) from public.pixel_cells c left join public.reservations r on r.id = c.reservation_id where r.id is null' '0'

$reservedB = [int]((Invoke-Sql 'select count(distinct reservation_id) from public.pixel_cells' |
  Where-Object { $_.Trim() -ne '' } | Select-Object -First 1).Trim())
Write-Host "  reservations holding cells after B: $reservedB (scenario A contributed 1)"
if ($reservedB -eq ($successA + $successB)) {
  Write-Host '  ok    reported successes match reservations that hold cells' -ForegroundColor Green
} else {
  $failures++
  Write-Host "  FAIL  reported successes ($($successA + $successB)) != reservations holding cells ($reservedB)" `
    -ForegroundColor Red
}

# Overlapping chain of width 2: a maximum independent set over 1..maxB rectangles
# is ceil(maxB/2). Winning fewer is legal (contention), winning more is not.
$upper = [Math]::Ceiling($maxB / 2)
if ($successB -le $upper -and $successB -ge 1) {
  Write-Host "  ok    winner count $successB is within the feasible range 1..$upper" -ForegroundColor Green
} else {
  $failures++
  Write-Host "  FAIL  winner count $successB outside feasible range 1..$upper" -ForegroundColor Red
}

Write-Host ''
if ($failures -eq 0) {
  Write-Host "CONCURRENCY: ALL GREEN ($Workers workers x 2 scenarios)" -ForegroundColor Green
} else {
  Write-Host "CONCURRENCY: $failures assertion(s) failed" -ForegroundColor Red
}
exit $failures
