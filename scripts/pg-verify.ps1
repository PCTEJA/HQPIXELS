<#
.SYNOPSIS
  Applies every migration to a THROWAWAY PostgreSQL cluster and reports errors.

.DESCRIPTION
  Creates a brand-new cluster in a temp directory on a non-default port with
  trust auth, applies tests/db/supabase-shim.sql then supabase/migrations/*.sql
  in filename order, optionally runs the pgTAP suite, then stops and deletes the
  cluster.

  It never touches an existing PostgreSQL installation's data directory, never
  connects to the default port, and needs no password.

  Use this when Docker (and therefore `supabase db reset`) is unavailable.

.PARAMETER Port
  Port for the throwaway cluster. Default 55432.

.PARAMETER Keep
  Leave the cluster running afterwards so you can poke at it with psql.

.PARAMETER Tests
  Also run supabase/tests/*.sql (requires the pgtap extension to be available).
#>
param(
  [int]$Port = 55432,
  [switch]$Keep,
  [switch]$Tests
)

$ErrorActionPreference = 'Stop'

$pgBin = (Get-ChildItem 'C:\Program Files\PostgreSQL' -Directory -ErrorAction SilentlyContinue |
  Sort-Object Name -Descending | Select-Object -First 1).FullName
if (-not $pgBin) { throw 'No PostgreSQL installation found under C:\Program Files\PostgreSQL' }
$pgBin = Join-Path $pgBin 'bin'

$initdb = Join-Path $pgBin 'initdb.exe'
$pgctl  = Join-Path $pgBin 'pg_ctl.exe'
$psql   = Join-Path $pgBin 'psql.exe'

$repo    = Split-Path -Parent $PSScriptRoot
$dataDir = Join-Path $env:TEMP 'hqpixels-pgverify\data'
$logFile = Join-Path $env:TEMP 'hqpixels-pgverify\server.log'

Write-Host "PostgreSQL bin : $pgBin"
Write-Host "Cluster        : $dataDir (port $Port)"
Write-Host ''

# --- fresh cluster ------------------------------------------------------------
if (Test-Path (Split-Path $dataDir -Parent)) {
  & $pgctl -D $dataDir stop -m immediate 2>$null | Out-Null
  Remove-Item -Recurse -Force (Split-Path $dataDir -Parent) -ErrorAction SilentlyContinue
}
New-Item -ItemType Directory -Force (Split-Path $dataDir -Parent) | Out-Null

& $initdb -D $dataDir -U postgres --auth=trust --auth-host=trust -E UTF8 --no-locale |
  Out-Null
if ($LASTEXITCODE -ne 0) { throw 'initdb failed' }

& $pgctl -D $dataDir -l $logFile -o "-p $Port -c listen_addresses=127.0.0.1" -w start | Out-Null
if ($LASTEXITCODE -ne 0) { Get-Content $logFile -Tail 30; throw 'pg_ctl start failed' }

$stopped = $false
function Stop-Cluster {
  if ($script:stopped -or $Keep) { return }
  & $pgctl -D $dataDir stop -m fast -w 2>$null | Out-Null
  $script:stopped = $true
}

try {
  $env:PGPASSWORD = ''
  $common = @('-v', 'ON_ERROR_STOP=1', '-X', '-q', '--no-psqlrc',
              '-h', '127.0.0.1', '-p', "$Port", '-U', 'postgres')

  & $psql @common -d postgres -c 'create database hqpixels;' | Out-Null
  $db = @($common + @('-d', 'hqpixels'))

  $failures = 0

  Write-Host '--- shim -------------------------------------------------------'
  $out = & $psql @db -f (Join-Path $repo 'tests\db\supabase-shim.sql') 2>&1
  if ($LASTEXITCODE -ne 0) { $failures++; Write-Host "FAIL shim" -ForegroundColor Red; $out | Write-Host }
  else { Write-Host 'ok   supabase-shim.sql' -ForegroundColor Green }

  Write-Host ''
  Write-Host '--- migrations -------------------------------------------------'
  $migrations = Get-ChildItem (Join-Path $repo 'supabase\migrations') -Filter '*.sql' |
    Sort-Object Name
  foreach ($m in $migrations) {
    $out = & $psql @db -f $m.FullName 2>&1
    if ($LASTEXITCODE -ne 0) {
      $failures++
      Write-Host ("FAIL " + $m.Name) -ForegroundColor Red
      $out | Where-Object { $_ -match 'ERROR|LINE|HINT|DETAIL|CONTEXT' } |
        Select-Object -First 12 | Write-Host
    } else {
      Write-Host ('ok   ' + $m.Name) -ForegroundColor Green
    }
  }

  if ($Tests) {
    Write-Host ''
    Write-Host '--- pgTAP ------------------------------------------------------'
    & $psql @db -c 'create extension if not exists pgtap;' 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
      Write-Host 'skip pgTAP (extension unavailable in this PostgreSQL install)' -ForegroundColor Yellow
    } else {
      foreach ($t in (Get-ChildItem (Join-Path $repo 'supabase\tests') -Filter '*.sql' | Sort-Object Name)) {
        $out = & $psql @db -f $t.FullName 2>&1
        $bad = $out | Where-Object { $_ -match '^not ok|ERROR' }
        if ($LASTEXITCODE -ne 0 -or $bad) {
          $failures++
          Write-Host ('FAIL ' + $t.Name) -ForegroundColor Red
          $bad | Select-Object -First 20 | Write-Host
        } else {
          Write-Host ('ok   ' + $t.Name) -ForegroundColor Green
        }
      }
    }
  }

  Write-Host ''
  if ($failures -eq 0) {
    Write-Host 'ALL GREEN' -ForegroundColor Green
  } else {
    Write-Host "$failures file(s) failed" -ForegroundColor Red
  }

  if ($Keep) {
    Write-Host ''
    Write-Host "Cluster left running. Connect with:"
    Write-Host "  & '$psql' -h 127.0.0.1 -p $Port -U postgres -d hqpixels"
    Write-Host "Stop it with:"
    Write-Host "  & '$pgctl' -D '$dataDir' stop -m fast"
  }

  exit $failures
}
finally {
  Stop-Cluster
}
