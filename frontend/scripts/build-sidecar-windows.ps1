# build-sidecar-windows.ps1
# Build the netstacks-agent sidecar for Windows
$ErrorActionPreference = "Stop"

Write-Host "Building netstacks-agent sidecar for Windows..." -ForegroundColor Cyan

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$AgentDir = Join-Path $ScriptDir "..\..\..\agent"

Push-Location $AgentDir

try {
    # Build release binary
    Write-Host "Running cargo build --release..." -ForegroundColor Yellow
    cargo build --release

    if ($LASTEXITCODE -ne 0) {
        throw "Cargo build failed with exit code $LASTEXITCODE"
    }

    $BinaryPath = Join-Path $AgentDir "target\release\netstacks-agent.exe"

    if (Test-Path $BinaryPath) {
        $FileInfo = Get-Item $BinaryPath
        Write-Host ""
        Write-Host "Sidecar build complete!" -ForegroundColor Green
        Write-Host "Binary: $BinaryPath"
        Write-Host "Size: $([math]::Round($FileInfo.Length / 1MB, 2)) MB"
    } else {
        throw "Build succeeded but binary not found at: $BinaryPath"
    }
}
finally {
    Pop-Location
}
