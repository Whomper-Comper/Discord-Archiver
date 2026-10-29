param([string]$Destination)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$manifest = Get-Content -LiteralPath (Join-Path $projectRoot 'manifest.json') -Raw | ConvertFrom-Json
if (-not $Destination) { $Destination = Join-Path $projectRoot "artifacts/Discord-Archiver-$($manifest.version).zip" }
$packageParent = Split-Path -Parent ([System.IO.Path]::GetFullPath($Destination))
New-Item -ItemType Directory -Force -Path $packageParent | Out-Null
$files = @('manifest.json','popup.html','popup.js','inject.js','collector.js','workspace.html','workspace.css','workspace.js','archive-worker.js','storage.js','icons','wasm','README.md','CHANGELOG.md','LICENSE','AGENTS.md','CONTRIBUTING.md','docs')
$paths = $files | ForEach-Object {
    $path = Join-Path $projectRoot $_
    if (-not (Test-Path -LiteralPath $path)) { throw "Missing extension resource: $_" }
    $path
}
Compress-Archive -LiteralPath $paths -DestinationPath $Destination -Force
Write-Output ([System.IO.Path]::GetFullPath($Destination))
