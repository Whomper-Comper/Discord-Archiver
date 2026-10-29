# Changelog

All notable changes to Discord Archiver are documented here.

---

## [2.0.0] - 2026-10-29

### Added

- Full archive workspace with packaged Rust/WebAssembly processing, disk-backed IndexedDB caches, streamed OPFS exports, previews, and saved collection/export preferences.
- Sequential collection with pacing profiles, custom intervals/timeouts/retries, UTC date bounds, message/user ID filters, fetched-message caps, pause, and explicit resume from committed checkpoints using original settings.
- Streaming imports of saved HTML, JSON, JSONL/NDJSON, and gzip; staged imports reject malformed or truncated input and retain existing good archives.
- Compact and compact cleaned JSON with one shared legend and short record keys for AI analysis; optional full/cleaned JSON, JSONL, message-only JSON, CSV, text, and offline HTML.
- Author search/selection, output splitting, compact/standard/rich HTML quality, optional exact embedded HTML records, reply quotations, media links, pretty JSON, and streamed gzip.
- Explicit cache deletion and prepared-export cleanup, source/build instructions, automated JavaScript/Rust/WASM checks, and a real-worker 500 MB benchmark with recorded scope and memory measurements.

### Changed

- Compact minified JSON is the only initial export choice. Media links, reply quotations, HTML machine data, and gzip are opt-in.
- Packaged WASM assets allow installation without Rust or Node.js. The update check now uses this fork's releases.
- Retained the original Quick HTML JavaScript overlay as a small-export compatibility route; workspace large-file processing uses the new worker pipeline.

### Verification scope

- Synthetic 500,006,376-byte input: 59,688 records imported and revalidated, with a 494,754,674-byte compact export. Import/export/validation took 38.8/34.7/14.0 seconds; peak WASM memory was 3.3 MiB and sampled browser working sets totaled about 432 MiB.
- Measured using real WASM, IndexedDB, and OPFS on secure localhost in Chromium. Live Discord, Firefox, and extension-origin performance remain unverified; the extension-origin Chrome for Testing launch hit a Windows SideBySide error. See README and `docs/benchmark-500mb.json` for limits.

---

## [1.2.0] - 2026-03-24

### Fixed
- **Infinite loop on API errors** — HTTP 401, 403, and 500 responses from Discord now break the scrape loop cleanly with an error message, instead of looping forever on an error object
- **Large archive crash** — replaced `allMessages.push(...msgs)` spread with `concat()` to avoid hitting the JS engine's argument limit on big channels
- **Fragile channel ID extraction** — `pathname` is now used instead of `href` so query strings and URL hashes no longer corrupt the channel ID
- **Double-injection** — clicking Export while a scrape is already running now no-ops silently instead of starting a second parallel scrape
- **XSS in exported HTML** — usernames, display names, channel names, attachment filenames, embed fields, and reply snippets are now HTML-escaped, preventing injection in the output file
- **Firefox popup broken** — removed a `Content-Security-Policy` meta tag that was blocking the GitHub API fetch and crashing the popup script on load

### Added
- **Highlighted search** — matching text is highlighted in amber as you type; results load progressively in async chunks so the browser never freezes
- **Search minimum threshold** — search only activates at 3+ characters, preventing sluggish single-character passes over large archives
- **Version number in popup** — current version is displayed below the extension title
- **Auto-update check** — popup checks GitHub Releases on open and shows a green badge linking to the release page if a newer version is available
- **Privacy notice** — "All processing is local — no data leaves your browser" displayed in the popup footer
- **Non-image attachments** — files (PDFs, ZIPs, etc.) now render as styled download links instead of being silently dropped
- **Video attachments** — video files render with an inline `<video controls>` player
- **Embeds** — rich embeds (link previews, bot messages, announcements) now render with provider, author, title, description, thumbnail, image, and accent color
- **Reply context** — messages that reply to another message show a quoted snippet of the original above the content
- **Complete markdown** — added strikethrough (`~~`), underline (`__`), spoilers (`||`, click to reveal), blockquotes (`>`), channel mentions, role mentions, and custom/animated emoji
- **Datestamped filenames** — exports are saved as `archive_channelname_YYYY-MM-DD.html` so multiple exports don't overwrite each other
- **Archive timestamp** — the exported file header shows when the archive was created
- **Orphaned date separator hiding** — date headers whose messages are all filtered out now hide themselves during search

### Changed
- **HTML generation performance** — replaced `+=` string concatenation in the message loop with array `push()` + `join()`, significantly faster on large archives
- **Overlay styles** — moved from a single inline style string to `Object.assign()` for readability
- **`localStorage` token fallback removed** — this code path has been non-functional since 2020 and was misleading; removed with an explanatory comment
- **Popup button re-enables on permission error** — previously the Export button stayed disabled after a failed injection; it now re-enables so the user can retry after granting permission

---

## [1.1.0] - 2026-03-24

### Added
- Firefox support via Manifest V3
- Stop & Save button on the scrape overlay
- Randomized request jitter (500–800ms) to reduce detection risk
- Rate-limit (429) detection and automatic retry

### Changed
- Rebuilt from scratch for MV3 compatibility (Chrome, Edge, Brave, Firefox)

---

## [1.0.0] - Initial release

- Basic Discord channel export to HTML
- Date navigation sidebar
- Offline search
