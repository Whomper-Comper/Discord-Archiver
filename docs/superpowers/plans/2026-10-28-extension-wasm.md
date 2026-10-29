# Rust/WASM Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Tasks use checkboxes for progress.

**Goal:** Ship browser-integrated Rust exports and stable disk-backed collection/import/export for 500 MB archives.
**Architecture:** Packaged Rust/WASM worker transforms bounded batches; IndexedDB persists records/checkpoints; OPFS streams exports; an extension workspace controls capture/import, users, and formats.
**Tech Stack:** Rust/wasm-bindgen, JavaScript modules, Web Workers, IndexedDB, OPFS, Manifest V3, Node tests.
**Spec:** `docs/superpowers/specs/2026-10-28-extension-wasm-design.md`

**Approved refinement, 2026-10-29:** user requested compact machine-readable AI
exports rather than doubled full-detail files, optional decodable compression,
batch/speed/HTML-quality settings, and a parse/organize mode. Implemented via
compact/compact-cleaned formats, shared legend, streaming gzip encode/decode,
compact-only defaults, optional media/reply/machine-data fields, and visible HTML
attributes. The existing file import workflow is explicitly labeled parse/organize.

## Global Constraints

- Never buffer a whole archive or output in memory; bounded messages/chunks and backpressure.
- Tokens never leave the Discord page or enter extension storage/logs.
- One history request in flight; honor rate-limit headers and Retry-After.
- IDs remain strings. User selection uses stable IDs; legacy missing data is reported, never guessed.
- Bundled WASM only; no remote executable code or unsafe-eval.
- Commit built WASM, its glue, source and reproducible build instructions.

## Review Focus

- 500 MB streams must produce correct row counts without memory proportional to file size.
- Cancellation/quota errors must preserve committed collection progress and never expose partial imports as complete.
- Chunk boundaries inside escaped strings, HTML tags, nested JSON, and Unicode must not corrupt messages.
- Popup closure must not stop collection; explicit resume uses original settings and committed cursor.
- CSV formulas, HTML text/URLs, duplicate IDs, and partial archive metadata must stay safe and unambiguous.

### Task 1: Rust streaming engine (parallel owner)

Files: `rust/**`, `wasm/**`, `scripts/build-wasm.ps1`.
Interfaces: exact ABI in `docs/extension-interfaces.md`.

- [x] Write failing Rust tests for incremental JSON/JSONL/HTML imports, legacy grouping, normalizing API records, full/cleaned/raw/JSONL/CSV/text/HTML exports, filters, escaping, bounded records, and truncation.
- [x] Implement `ArchiveImporter`, `ArchiveExporter`, `normalize_batch`; run native tests and wasm32 release build.
- [x] Generate web-target bindings at `wasm/archive_engine.js` and `wasm/archive_engine_bg.wasm`; verify Node can initialize the real WASM.
- [x] Report tests, limits, and build commands; do not touch frontend/storage files.

### Task 2: Disk-backed worker (parallel owner)

Files: `storage.js`, `archive-worker.js`, `tests/storage.test.mjs`, `tests/worker.test.mjs`.
Interfaces: exact RPC/ABI in `docs/extension-interfaces.md`.

- [x] Write failing storage tests for atomic append/checkpoints, deduplication, stable order, user counts, import staging, deletion, and bounded reads.
- [x] Implement IndexedDB persistence and worker operations with cancellation and backpressure.
- [x] Stream imports through Rust and exports into OPFS; return File handles instead of output strings; report quotas/errors.
- [x] Verify with fake-indexeddb and bounded in-memory file-system test doubles; parent runs real browser/WASM integration.

### Task 3: Workspace, collector and packaging (parent owner)

Files: `collector.js`, `workspace.{html,css,js}`, `popup.{html,js}`, `manifest.json`, `package.json`, tests, docs.

- [x] Write failing collector tests for limits, date bounds, header pacing, retries, stop/auth errors, and resume checkpoints.
- [x] Implement per-page MAIN-world fetch with request timeout and isolated settings; never return tokens.
- [x] Add workspace controls, saved presets, recovery selection, progress, user search, format preview, split exports, and download links.
- [x] Open workspace from popup and preserve quick HTML route; update fork links, version and CSP/permissions.

### Task 4: Integration, 500 MB verification, review and delivery

Files: `tests/wasm.test.mjs`, `tests/browser/**`, `scripts/benchmark.mjs`, docs, generated WASM.

- [x] Run native Rust and JavaScript tests, actual WASM roundtrips, and browser IndexedDB/OPFS workflow.
- [x] Generate and process a 500 MB fixture with measured record counts, output validation, memory and elapsed time; report actual scope and limits.
- [x] Run fresh independent review, reproduce/fix important findings, rerun required checks.
- [x] Commit the branch and attempt pushing it to the user's fork; do not merge or publish a release.

## Execution

User approved this design and said to use judgment on implementation. Run Tasks 1 and 2 in parallel with fixed interfaces while parent implements Task 3. Review their distinct outputs, then integrate and verify Task 4. This is an isolated clone on `feat/rust-wasm-streaming-exports`, separate from the previous desktop project.

