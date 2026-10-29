# Contributing

The checked-in extension can be loaded directly; installation needs no build tools.
For development, use a current Node.js supporting ES modules and the built-in test
runner, npm, and Rust. Run the commands below from this `extension-fork` folder.

```powershell
npm ci
npm test
cargo test --locked --manifest-path rust/Cargo.toml
cargo fmt --manifest-path rust/Cargo.toml -- --check
cargo clippy --locked --manifest-path rust/Cargo.toml --all-targets -- -D warnings
node rust/tests/wasm.mjs
```

JavaScript tests cover collection, IndexedDB and worker orchestration; their test
doubles do not replace real browser checks. The Node WASM test exercises the
**packaged** binary and bindings. After changing Rust, rebuild before running it:

```powershell
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.129 --locked
./scripts/build-wasm.ps1
node rust/tests/wasm.mjs
```

The wasm-bindgen crate and CLI must both be 0.2.129. The build script checks the CLI,
uses the locked release build, and generates web-target files into `wasm/`. Include
changed packaged bindings/binary with their Rust source; UI-only edits need no rebuild.

## Browser verification

```powershell
npx playwright install chromium
node tests/browser-smoke.mjs
```

The default smoke attempts an actual unpacked extension. To use an installed
Chromium-family executable, set `$env:TEST_BROWSER = 'C:/path/to/browser.exe'`.
If the extension test cannot launch in your environment, run the documented fallback:

```powershell
$env:TEST_HTTP = '1'
node tests/browser-smoke.mjs
Remove-Item Env:TEST_HTTP
```

This runs the workspace with its production content-security policy on secure
localhost and exercises real WASM, IndexedDB and OPFS. It does not exercise extension
permissions, Discord MAIN injection or live network collection. Record which mode
passed. Inspect `artifacts/browser-smoke/`, keyboard navigation, busy/cancel/error
states and narrow layouts for UI changes. Never use real account tokens in tests.

## Scope checks to the change

Use the [AGENTS verification matrix](AGENTS.md) and
[architecture](docs/ARCHITECTURE.md) to choose checks. Preserve cache migration,
author selection, message order and reply fidelity with representative fixtures.
For performance work, measure a small case first and compare the same input,
selected author and browser before/after. A heavier production-pipeline check is:

```powershell
$env:BENCHMARK_MB = '500'
npm run benchmark
Remove-Item Env:BENCHMARK_MB
```

The benchmark generates JSONL, imports and exports through the worker, validates
record counts and endpoint IDs, and writes artifacts plus `docs/benchmark-500mb.json`.
`BENCHMARK_MB` controls decimal megabytes; `KEEP_BENCHMARK_INPUT` retains generated
input. Allow disk space for input, IndexedDB, OPFS and output. Do not describe peak
WASM linear memory as total browser memory, or synthetic localhost as live Discord.

The scoped author-index comparison can run separately:

```powershell
node scripts/benchmark-author-index.mjs
```

It honors `TEST_BROWSER` and `AUTHOR_BENCHMARK_RECORDS` (default 10,000; range
100–100,000), then writes `docs/performance-author-index.json`. The recorded
[Edge measurement](docs/performance-author-index.json) compared three full scans
and indexed reads on the same v2 cache: 490.1 ms versus 5.5 ms median for 100 of
10,000 messages. The v1 migration took 7.8 seconds. This is storage-only synthetic
measurement; it excludes worker/WASM/OPFS and does not predict end-to-end speedups
or browser memory. Keep the migration wait caveat when documenting performance.

## Package

```powershell
./scripts/package.ps1
# Optional destination:
./scripts/package.ps1 -Destination ./artifacts/Discord-Archiver-local.zip
```

The script packages runtime files, icons, WASM, README, changelog, license,
AGENTS.md, this contributor guide and `docs/` using the manifest version. It
excludes development dependencies and tests. Inspect the
ZIP and ensure `manifest.json` sits at its root before sharing. Version changes
should agree across the manifest, package metadata and changelog. Keep claims about
verification limited to checks actually run; describe remaining browser limitations.
See [formats](docs/EXPORT_FORMATS.md) and [troubleshooting](docs/TROUBLESHOOTING.md)
when changing user-facing behavior.

## Continuous checks

`.github/workflows/checks.yml` runs on pushes and pull requests with Node.js 24.
It runs the JavaScript suite, Rust tests/formatting/Clippy, the packaged WASM test,
and the secure-localhost Playwright smoke test. The browser step uses production
CSP and disk storage but does not prove extension permissions or live Discord
collection. A workflow definition alone is not evidence of a passing remote run.
