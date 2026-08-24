[CmdletBinding()]
param(
  [switch]$Push,
  [string]$Remote = 'origin',
  [string]$Branch = 'main',
  [string]$RepositoryUrl = 'https://github.com/oldff032-oss/skyuesim.git',
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
$insideRepository = Test-Path -LiteralPath (Join-Path $projectRoot '.git') -PathType Container
if (-not $insideRepository) {
  Write-Host 'Preparing this extracted folder for GitHub...'
  & git init -b $Branch
  if ($LASTEXITCODE -ne 0) { throw 'Could not initialize Git in this folder.' }
  & git remote add $Remote $RepositoryUrl
  if ($LASTEXITCODE -ne 0) { throw 'Could not connect the GitHub repository.' }
  & git fetch $Remote $Branch
  if ($LASTEXITCODE -ne 0) { throw 'Could not download the current GitHub branch.' }
  & git reset "$Remote/$Branch"
  if ($LASTEXITCODE -ne 0) { throw 'Could not prepare the current GitHub history.' }
} else {
  $knownRemotes = @(& git remote)
  if ($knownRemotes -notcontains $Remote) {
    & git remote add $Remote $RepositoryUrl
    if ($LASTEXITCODE -ne 0) { throw 'Could not connect the GitHub repository.' }
  }
}
$currentBranch = (git branch --show-current).Trim()
if (-not $currentBranch) { & git switch -c $Branch; $currentBranch=$Branch }
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

git push --set-upstream $Remote $Branch
if ($LASTEXITCODE -ne 0) { throw 'Push failed.' }
Write-Host 'Push completed. Your connected Render/Netlify services can now deploy this revision.' -ForegroundColor Green
