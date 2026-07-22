[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidatePattern('^LAAA-Deploys/[A-Za-z0-9._-]+$')]
    [string]$Repository,

    [Parameter(Mandatory)]
    [ValidateSet('bov', 'om', 'marketing')]
    [string]$Deliverable,

    [string]$DefaultBranch = 'master',

    [switch]$Apply
)

$ErrorActionPreference = 'Stop'
$apiVersion = '2026-03-10'
$repoName = $Repository.Split('/', 2)[1]

gh auth status | Out-Null
$repo = gh api "repos/$Repository" --header "X-GitHub-Api-Version: $apiVersion" | ConvertFrom-Json
if (-not $repo) { throw "Repository not found: $Repository" }

$rulesets = gh api 'orgs/LAAA-Deploys/rulesets' --header "X-GitHub-Api-Version: $apiVersion" | ConvertFrom-Json
$governed = @($rulesets | Where-Object { $_.name -like 'LAAA marketing quality*' -and $_.enforcement -eq 'active' })
if ($governed.Count -eq 0) {
    throw 'No active LAAA marketing-quality organization ruleset exists. Stop before setting the marketing property.'
}

$plan = [ordered]@{
    repository = $Repository
    deliverable = $Deliverable
    defaultBranch = $DefaultBranch
    pagesSource = "${DefaultBranch}:/"
    ruleset = $governed.name
    apply = [bool]$Apply
}
$plan | ConvertTo-Json -Depth 4

if (-not $Apply) {
    Write-Output 'Preview only. Re-run with -Apply after Glen approves the repository bootstrap.'
    exit 0
}

$propertyPayload = @{
    properties = @(@{ property_name = 'laaa-deliverable'; value = $Deliverable })
} | ConvertTo-Json -Compress -Depth 4
$propertyPayload | gh api "repos/$Repository/properties/values" --method PATCH --input - --header "X-GitHub-Api-Version: $apiVersion" | Out-Null

gh api "repos/$Repository" --method PATCH -f "default_branch=$DefaultBranch" --header "X-GitHub-Api-Version: $apiVersion" | Out-Null

$pagesExists = $true
gh api "repos/$Repository/pages" --header "X-GitHub-Api-Version: $apiVersion" 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) { $pagesExists = $false }
$pagesMethod = if ($pagesExists) { 'PUT' } else { 'POST' }
gh api "repos/$Repository/pages" --method $pagesMethod -f 'build_type=legacy' -f "source[branch]=$DefaultBranch" -f 'source[path]=/' --header "X-GitHub-Api-Version: $apiVersion" | Out-Null

$properties = gh api "repos/$Repository/properties/values" --header "X-GitHub-Api-Version: $apiVersion" | ConvertFrom-Json
$page = gh api "repos/$Repository/pages" --header "X-GitHub-Api-Version: $apiVersion" | ConvertFrom-Json
$verified = gh api "repos/$Repository" --header "X-GitHub-Api-Version: $apiVersion" | ConvertFrom-Json

[ordered]@{
    repository = $Repository
    property = $properties | Where-Object property_name -eq 'laaa-deliverable'
    defaultBranch = $verified.default_branch
    pages = $page.source
    rulesetCount = $governed.Count
} | ConvertTo-Json -Depth 5
