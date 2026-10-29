# Workspace Polish and Maintainability Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development for isolated tasks and fresh review. User delegated choices with "do something like polish UI or optimize" and requested documentation/AGENTS.md; prior "use your judgment" remains applicable. Execute without another design permission round.

**Goal:** Improve workspace usability and selected-author performance, then document the project for users and future contributors.
**Architecture:** Keep existing Rust/WASM format contracts. Add an IndexedDB author/order index with backward-compatible migration; improve the HTML/CSS/JS workspace around the same worker RPC. Document real interfaces and measured limits.
**Tech Stack:** Existing JavaScript/IndexedDB/OPFS/Rust/WASM; native browser controls; Node/Playwright tests.
**Spec:** Approved extension design and compact refinement in `docs/extension-interfaces.md`; this plan refines presentation, performance and maintenance rather than replacing the architecture.

**Added user requirement:** Update an HTML/JSON archive with more messages and retain compatibility with original-extension HTML. Implement file/cache combining and newer-message collection using known IDs. Every update creates a new staging copy; original caches and input files remain available. Keep ID-less rows and warn about possible legacy overlap. Preserve partial/source metadata through Rust imports and exports. Source order remains base then incoming; no guessed timestamps or fuzzy deduplication.

## Global constraints

- Compact JSON remains the sole default export; no loss of text, identities or reply links.
- Continue bounded-memory processing and disk-backed exports. Preserve existing cached jobs during migrations.
- Server pacing/Retry-After takes precedence. Tokens remain in Discord MAIN.
- Existing automation and accessible field IDs stay usable. No external UI dependencies or remote code.
- Commit/package built WASM as needed only if Rust changes. UI/docs changes do not require a Rust rebuild.

## Review focus

- Old database records must appear in indexed author reads after migration.
- Selected-user order, counts and exports must match full scans, including name-only identities.
- Switching source modes or searching users must not alter the selected archive/author silently.
- Busy/cancel/error states must stay keyboard-accessible and understandable at narrow widths.
- Docs and AGENTS instructions must reflect actual commands and avoid unsupported guarantees.

### Task 1: Selected-author storage index (parallel owner)

**Files:** `storage.js`, `archive-worker.js`, storage/worker tests, optional scoped benchmark helper.
**Interface:** `readPage(jobId,{after,limit,userKey})` accepts an optional stable author key. Worker preview/export passes options.user_key while Rust still applies the final filter.

- [x] Profile/read current implementation and write failing tests for sparse-user reads, source order, old-cache migration and mixed/missing IDs.
- [x] Add author/order index and bounded transactional migration/backfill. New appends maintain the index atomically.
- [x] Use indexed pages for user-specific preview/export; validate page continuation and cancellation.
- [x] Run tests and report measured read/timing improvement without promising browser-independent speedups.

### Task 2: Documentation and agent guidance (parallel owner)

**Files:** `AGENTS.md`, `CONTRIBUTING.md`, `docs/ARCHITECTURE.md`, `docs/EXPORT_FORMATS.md`, `docs/TROUBLESHOOTING.md`, README links.

- [x] Read real source, tests and build/package scripts.
- [x] Explain setup, module ownership, streaming bounds, schema/fidelity, profiling, build/testing, packaging and known browser limitations.
- [x] Add concise AGENTS instructions protecting compact defaults, IDs/replies, token privacy, pacing and cache migrations; avoid blanket approval/process requirements.
- [x] Check all local documentation links and commands against the repository.

### Task 3: Workspace UI polish (parent owner)

**Files:** `workspace.html`, `workspace.css`, `workspace.js`, optional pure UI state helper/tests, browser smoke.

- [x] Add clear collect/import source modes, accessible mode switching and helpful empty states.
- [x] Improve spacing/format cards, live archive summary, progress/elapsed feedback and download controls; support narrow layouts.
- [x] Preserve filters/settings and existing IDs/RPCs. Keep previews capped; avoid rendering source HTML.
- [x] Add copy-preview/download-all controls only with explicit UI gestures and visible size/count information.
- [x] Verify keyboard focus, desktop/mobile screenshots and real import/export/gzip flow in the available test browser.

### Task 3b: Archive updates

- [x] Add bounded `updateInfo`, `combine`, and `merge` RPCs; stage new copies and clean staging on failure/cancel. Check sources did not change while copying.
- [x] Deduplicate known channel/message pairs, preserve ID-less rows, source order, and mixed/unknown channel identities. Report counts and warnings.
- [x] Preserve optional source/partial metadata through Rust importer finish, rebuild WASM, and test original HTML/modern JSON/HTML roundtrips.
- [x] Add file/cache combining controls and newer-message collection using a stored numeric-ID boundary. Pause/resume uses original settings; completed captures can retry combining.
- [x] Test duplicate overlap, unknown IDs/channels, cancellation/failure, concurrent source mutation, partial caps, and browser integration with synthetic newer pages.

### Task 4: Integration and delivery

- [x] Review independently; fix important regressions with reproductions.
- [x] Run JavaScript tests, Rust/WASM checks appropriate to actual changes, and browser smoke. Run a scoped performance comparison; rerun the 500 MB pipeline only if storage changes justify it.
- [x] Add lightweight CI for the established checks if it can be kept reproducible.
- [ ] Update version/changelog, rebuild installable ZIP, commit and push the existing feature branch. No main merge or store publication.

## Verification record

- JavaScript: 66/66 tests; Rust: 25/25 plus fmt/strict Clippy.
- Packaged WASM: 10 formats, 6 HTML cases, provenance roundtrips and 100,000-record bounded stream.
- Actual MV3 extension in system Edge plus secure-localhost/CSP smoke: imports, filtering, gzip, file/cache merges, synthetic newer-message collection, keyboard and 390px layout.
- Synthetic 500,006,376-byte JSONL: all 59,688 records revalidated, 494,754,707-byte compact output, 46.7/34.5/13.5 s import/export/validation, 3.3 MiB WASM; sampled browser working-set total ~655 MiB. No live Discord or Firefox verification.
- Sparse-author Edge storage benchmark: 10,099→100 cursor visits, 490.1→5.5 ms median, identical selection/order fingerprint. Separate scoped measurement, not a whole-pipeline speedup claim.
- Independent review reproduced and fixed concurrent source deletion/append/status changes during merging. Both source counts and metadata are rechecked before publishing a combined cache.
- Eight user documents / 26 local file links and code fences checked. Version 2.1.0 ZIP inspected: 34 entries, all required runtime/WASM/docs present.
