[CmdletBinding()]
param(
  [switch]$Push,
  [string]$Remote = 'origin',
  [string]$Branch = 'main',
  [string]$CommitMessage = 'Deploy consolidated Signal eSIM platform'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $projectRoot

if (-not (Test-Path -LiteralPath 'package-lock.json')) { throw 'package-lock.json not found.' }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js is not installed.' }
if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { throw 'npm is not installed.' }

Write-Host 'Installing locked dependencies...'
& npm.cmd ci
if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }

Write-Host 'Running syntax and security checks...'
& npm.cmd run check
if ($LASTEXITCODE -ne 0) { throw 'Verification failed. Nothing was deployed.' }

if (-not $Push) {
  Write-Host 'Verification passed. Run .\deploy.ps1 -Push to commit and push the deploy.' -ForegroundColor Green
  exit 0
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'Git is not installed.' }
$currentBranch = (git branch --show-current).Trim()
if ($currentBranch -ne $Branch) { throw "Current branch is '$currentBranch'; expected '$Branch'." }

git add --all
if ($LASTEXITCODE -ne 0) { throw 'Could not stage files.' }
$staged = git diff --cached --name-only
if ($staged) {
  git commit -m $CommitMessage
  if ($LASTEXITCODE -ne 0) { throw 'Commit failed.' }
} else {
  Write-Host 'No uncommitted changes; pushing the current commit.'
}

git push $Remote $Branch
if ($LASTEXITCODE -ne 0) { throw 'Push failed.' }
Write-Host 'Push completed. Your connected Render/Netlify services can now deploy this revision.' -ForegroundColor Green
