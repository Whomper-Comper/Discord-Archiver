# Contributor and agent guide

This folder is the installable extension. Start with [README.md](README.md),
[CONTRIBUTING.md](CONTRIBUTING.md), and [architecture](docs/ARCHITECTURE.md).

## Ownership

- `popup.*`: extension entry, active-channel context, release check.
- `workspace.*`: source selection, settings, author selection, preview and downloads.
- `collector.js`: validated collection settings, sequential paging, pacing/retries,
  job locks and the self-contained Discord MAIN-world request function.
- `archive-worker.js`: serialized RPC, import staging, cancellation, WASM calls,
  bounded batches, OPFS exports and compression.
- `storage.js`: IndexedDB jobs/records/users, atomic checkpoints, paging/migrations.
- `rust/src/`: normalized schema, streaming parsers, cleaning and format encoders.
- `wasm/`: packaged web bindings/binary generated from Rust; `inject.js`: legacy overlay.
- `tests/`, `rust/tests/`, `scripts/`: verification, profiling, build/package helpers.

## Invariants

- Compact JSON is the sole initially selected export. Gzip, pretty JSON, media,
  compact reply quotations and HTML machine data are opt-in in the workspace.
- Keep Discord IDs as strings. Preserve case, newlines, identities and reply IDs;
  never invent missing IDs or timestamps. Cleaning must preserve reply links.
- Keep imports/exports incremental: roughly 256 KiB chunks, at most 100 storage
  records per page, bounded preview (three matches / 256 KiB). Never load an
  entire archive or concatenate all output in memory.
- Commit records, author counts and capture checkpoint atomically before fetching
  another page. Deduplicate only known channel/message pairs; preserve ID-less rows.
- Updates create a new staged combined job; preserve originals and partial/source
  metadata. Deduplicate only stable channel/message pairs, never author/text guesses.
- Cache schema changes must migrate existing jobs and records without deletion;
  test old-version fixtures and paginated reads, including name-only authors.
- Respect server Retry-After/rate limits, aborts and sequential requests. Do not
  introduce concurrent scraping to improve throughput.
- Tokens stay inside Discord MAIN. Never return/log/persist them or send them to
  the workspace worker, export metadata, settings or fixtures.
- Preserve accessible field IDs, pinned author selection and explicit user gestures
  for downloads. Render preview as text; escape HTML and allow only HTTP(S) links.
- Keep source and packaged WASM in sync after Rust changes. Both the wasm-bindgen crate
  and wasm-bindgen CLI are pinned to **0.2.129**. Do not hand-edit generated bindings.

## Commands (from this folder)

```powershell
npm ci
npm test
cargo test --locked --manifest-path rust/Cargo.toml
cargo fmt --manifest-path rust/Cargo.toml -- --check
cargo clippy --locked --manifest-path rust/Cargo.toml --all-targets -- -D warnings
node rust/tests/wasm.mjs
./scripts/build-wasm.ps1
node tests/browser-smoke.mjs
./scripts/package.ps1
```

Rebuilding needs `wasm32-unknown-unknown` and wasm-bindgen CLI 0.2.129; see
[CONTRIBUTING.md](CONTRIBUTING.md). End users need no toolchain.

| Change | Verification |
| --- | --- |
| Docs only | Check local links, commands and claims against source. |
| Collector/storage/worker | `npm test`; real browser smoke for disk/browser paths. |
| Workspace UI | `npm test`; browser smoke, keyboard and narrow-screen inspection. |
| Rust/schema/formats | Rust tests/fmt/clippy; rebuild WASM; Node WASM tests; browser smoke. |
| Packaging | Inspect ZIP contents and packaged WASM; load unpacked when possible. |
| Memory/streaming/storage performance | Scoped measurement first; 500 MB benchmark when the change warrants it. |

`TEST_HTTP=1` selects the secure-localhost browser fallback; `TEST_BROWSER` may
select an existing Chromium executable. Report fallback scope honestly: it does
not prove extension-origin behavior or live Discord/Firefox compatibility.
`npm run benchmark` is a heavy synthetic 500 MB run by default, not a routine
unit check. Record environment, counts and memory definitions with measurements.
