# Renames *_js.txt files back to .js (app_js.txt -> app.js, sw_js.txt -> sw.js).
# Save this next to the files and run it, or pass the folder: .\rename-js.ps1 -Folder "C:\path\to\folder"
param(
    [string]$Folder = $PSScriptRoot
)
 
if (-not $Folder) { $Folder = (Get-Location).Path }
 
$files = Get-ChildItem -LiteralPath $Folder -Filter '*_js.txt' -File
if (-not $files) {
    Write-Host "No *_js.txt files found in $Folder"
    exit 0
}
 
foreach ($file in $files) {
    $newName = $file.Name -replace '_js\.txt$', '.js'
    Move-Item -LiteralPath $file.FullName -Destination (Join-Path $Folder $newName) -Force
    Write-Host "$($file.Name) -> $newName"
}
 