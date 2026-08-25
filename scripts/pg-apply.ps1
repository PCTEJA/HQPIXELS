<#
.SYNOPSIS
  Applies the shim + all migrations to an ALREADY RUNNING throwaway cluster.

.DESCRIPTION
  Companion to pg-verify.ps1 for iterating quickly: pg-verify.ps1 creates the
  cluster, this re-creates the database and replays every migration in order,
  printing one line per file. Exit code is the number of failures.

  Points only at a caller-supplied port. Never the default 5432 unless you ask
  for it explicitly, so it cannot clobber a real local database by accident.
#>
param(
  [int]$Port = 55432,
  [string]$Database = 'hqpixels',
  [switch]$Tests,
  [switch]$Verbose
)

$ErrorActionPreference = 'Continue'

$pgRoot = (Get-ChildItem 'C:\Program Files\PostgreSQL' -Directory -ErrorAction SilentlyContinue |
  Sort-Object Name -Descending | Select-Object -First 1).FullName
if (-not $pgRoot) { throw 'No PostgreSQL installation found.' }
$psql = Join-Path $pgRoot 'bin\psql.exe'
$repo = Split-Path -Parent $PSScriptRoot

$base = @('-h', '127.0.0.1', '-p', "$Port", '-U', 'postgres', '-X', '-q', '--no-psqlrc')

# DROP/CREATE DATABASE cannot run inside a transaction block, so they must be
# separate -c invocations (psql wraps multiple statements in one).
& $psql @base -d postgres -c "drop database if exists $Database" 2>&1 | Out-Null
& $psql @base -d postgres -c "create database $Database" 2>&1 | Out-Null

$db = $base + @('-d', $Database, '-v', 'ON_ERROR_STOP=1')
$failures = 0

function Invoke-SqlFile {
  param([string]$Path, [string]$Label)

  $out = & $psql @db -f $Path 2>&1
  $code = $LASTEXITCODE
  $errors = $out | Select-String -Pattern 'ERROR|FATAL' -SimpleMatch:$false

  if ($code -ne 0 -or $errors) {
    $script:failures++
    Write-Host "FAIL  $Label" -ForegroundColor Red
    $out | Select-String -Pattern 'ERROR|FATAL|LINE |HINT:|DETAIL:|CONTEXT:' |
      Select-Object -First 10 | ForEach-Object { Write-Host "      $_" }
  } else {
    Write-Host "ok    $Label" -ForegroundColor Green
    if ($Verbose) { $out | ForEach-Object { Write-Host "      $_" } }
  }
}

Invoke-SqlFile -Path (Join-Path $repo 'tests\db\supabase-shim.sql') -Label 'supabase-shim.sql'

foreach ($m in (Get-ChildItem (Join-Path $repo 'supabase\migrations') -Filter '*.sql' | Sort-Object Name)) {
  Invoke-SqlFile -Path $m.FullName -Label $m.Name
}

if ($Tests) {
  & $psql @base -d $Database -c 'create extension if not exists pgtap' 2>&1 | Out-Null
  $hasPgtap = ($LASTEXITCODE -eq 0)
  if (-not $hasPgtap) {
    Write-Host 'skip  pgTAP not available in this PostgreSQL install' -ForegroundColor Yellow
    Write-Host '      (Docker path: `pnpm db:test` runs the same files via the Supabase CLI)'
  } else {
    foreach ($t in (Get-ChildItem (Join-Path $repo 'supabase\tests') -Filter '*.sql' | Sort-Object Name)) {
      $out = & $psql @base -d $Database -f $t.FullName 2>&1
      $bad = $out | Select-String -Pattern '^not ok|ERROR|FATAL'
      if ($bad) {
        $failures++
        Write-Host "FAIL  $($t.Name)" -ForegroundColor Red
        $bad | Select-Object -First 25 | ForEach-Object { Write-Host "      $_" }
      } else {
        $okCount = ($out | Select-String -Pattern '^ok ').Count
        Write-Host "ok    $($t.Name)  ($okCount assertions)" -ForegroundColor Green
      }
    }
  }
}

Write-Host ''
if ($failures -eq 0) { Write-Host 'ALL GREEN' -ForegroundColor Green }
else { Write-Host "$failures failure(s)" -ForegroundColor Red }
exit $failures
