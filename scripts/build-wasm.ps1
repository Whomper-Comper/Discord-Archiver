param(
    [string]$WasmBindgen = 'wasm-bindgen'
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$localTools = Join-Path (Split-Path -Parent $projectRoot) '.tools'
if (Test-Path (Join-Path $localTools 'cargo/bin/cargo.exe')) {
    $env:CARGO_HOME = Join-Path $localTools 'cargo'
    $env:RUSTUP_HOME = Join-Path $localTools 'rustup'
    $env:PATH = "$env:CARGO_HOME/bin;$env:PATH"
}
if (Test-Path 'C:/msys64/mingw64/bin') {
    $env:PATH = "C:/msys64/mingw64/bin;$env:PATH"
}
if ($WasmBindgen -eq 'wasm-bindgen') {
    $bundledBindgen = Join-Path $localTools 'wasm-bindgen-0.2.129-x86_64-pc-windows-msvc/wasm-bindgen.exe'
    if (Test-Path $bundledBindgen) { $WasmBindgen = $bundledBindgen }
}
$version = & $WasmBindgen --version
if ($LASTEXITCODE -ne 0 -or $version -ne 'wasm-bindgen 0.2.129') {
    throw 'Install wasm-bindgen-cli 0.2.129 (cargo install wasm-bindgen-cli --version 0.2.129 --locked).'
}
& cargo build --locked --manifest-path (Join-Path $projectRoot 'rust/Cargo.toml') --target wasm32-unknown-unknown --release
if ($LASTEXITCODE -ne 0) { throw 'Rust/WASM build failed. Install the target with rustup target add wasm32-unknown-unknown.' }
& $WasmBindgen (Join-Path $projectRoot 'rust/target/wasm32-unknown-unknown/release/archive_engine.wasm') --target web --out-dir (Join-Path $projectRoot 'wasm') --out-name archive_engine
if ($LASTEXITCODE -ne 0) { throw 'WASM bindings generation failed.' }
Write-Output 'Built wasm/archive_engine.js and wasm/archive_engine_bg.wasm.'
