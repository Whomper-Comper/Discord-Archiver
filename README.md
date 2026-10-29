# Discord Archiver 2.1

[Whomper-Comper's fork](https://github.com/Whomper-Comper/Discord-Archiver) adds a local archive workspace powered by packaged Rust/WebAssembly. Collect a Discord channel or parse an existing archive, choose authors, preview results, and prepare downloads. Large imports and exports use a worker, IndexedDB, and the browser's private file system (OPFS).

## Install

Download or clone this fork. The extension folder must contain `manifest.json`, `workspace.html`, `wasm/archive_engine.js`, and `wasm/archive_engine_bg.wasm`. The generated WASM files are included; **installing and using the extension does not require Rust, Node.js, or a build step**.

For Chrome, Edge, or Brave:

1. Extract the download and open `chrome://extensions/` (or your browser's extensions page).
2. Enable **Developer mode**, choose **Load unpacked**, and select the folder containing `manifest.json`.
3. Open your Discord channel and grant the extension site access when the browser requests it.

For Firefox, open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**, and select that `manifest.json`. Temporary add-ons must be loaded again after restarting Firefox. The package retains Manifest V3/Firefox settings, but this version's workspace has not been verified in Firefox. It requires IndexedDB, OPFS, module workers, WebAssembly, and Web Locks; missing features produce an error rather than an in-memory fallback.

## Collect or import

Open a Discord channel, click the extension icon, and choose **Open archive workspace**. Keep the Discord tab and workspace open during collection. You can also open the workspace to import a local file without collecting anything.

| Setting | Meaning |
| --- | --- |
| Messages per page | 1–100; default 100. Requests run sequentially. |
| Maximum fetched messages | `0` means all available history within the other bounds. Counts scanned messages, including authors excluded by a filter. |
| Pacing profile | Adaptive: 0 ms minimum; Balanced: 500 ms; Gentle: 1,200 ms. Server rate limits take precedence. |
| Custom pacing | Minimum interval 0–60,000 ms; request timeout 1,000–120,000 ms; 0–10 consecutive retries. Balanced defaults: 30,000 ms and 5 retries. Gentle uses 60,000 ms. |
| Dates | UTC, from-date inclusive and before-date exclusive; dates must be in 2015 or later. |
| Start before message ID | Optional Discord message ID; collection proceeds toward older messages. |
| Only store these user IDs | Optional comma/space-separated IDs. Filtering still scans history and does not reduce page requests. |

Use **Pause / cancel** to interrupt collection, waits, imports, or exports. Collection commits each page before fetching the next. Closing the workspace leaves committed capture batches recoverable; it does not continue collecting in the background. Choose the cached job and explicitly **Resume collection** from its original channel. Resume uses that job's original settings and cursor, even if the form has changed. Last-used collection and export preferences are saved locally.

Import saved `.html`/`.htm`, `.json`, `.jsonl`, or `.ndjson` files. JSON supports API arrays, full documents with a `messages` array, and compact exports. Gzip files such as `.json.gz` and `.jsonl.gz` are decoded while importing when the browser supports `DecompressionStream`. Failed or cancelled imports discard their staging job; interrupted imports left after a restart can be selected for deletion, but cannot be exported as complete.

Cached jobs remain on this device until **Delete cache** is used. Deleting a cache does not remove files already downloaded to your computer. Capture exports are oldest first; imported files retain their input order.

## Update an existing archive or convert original HTML

1. Choose **Organize a file** and import your original HTML or JSON, or select a saved cache and click **Use selected**. Original-extension HTML is supported; no conversion step outside the workspace is needed.
2. Under **Saved in this browser**, open **Add more messages**. Choose **Add messages from a file**, or select another saved archive and click **Combine archives**.
3. A new combined archive becomes selected. Your original caches and source files remain available. Export it as compact JSON, updated HTML, or any other supported format.

Messages from the base archive appear first, followed by incoming messages in their saved order. Known channel/message ID pairs are deduplicated; the first copy wins, so merging does not refresh edited messages or remove deleted messages. Legacy HTML without IDs is retained as supplied, including possible overlaps. IDs, timestamps, or reply details absent from the original file cannot be reconstructed.

To collect only new messages, open the workspace from the matching Discord channel, select your archive, and click **Fetch newer messages**. Collection starts at the latest message and stops at the newest saved ID for that channel. It uses the request size, pacing, fetched-message cap, and user ID settings; date and start-before fields are ignored. It does not fill older gaps. A reached message cap is marked as partial history. Archives without saved IDs for this channel can still be converted or combined with another file.

Pause and resume use the saved update boundary. After collection, the workspace combines the new messages automatically. If combining fails or is cancelled, the new collection stays in the cache: select it and use **Finish saved update**, or combine the saved archives manually. A combined copy preserves partial-history/source information from its inputs. It needs disk space for both the originals and the combined result.

## Export for AI analysis or offline reading

Choose an archive, find an author by name/username/ID, and select that author or **Everyone**. Search refines the author list while retaining your explicit author selection. The preview shows up to three matching records, bounded to 256 KiB. Choose formats and click **Prepare downloads**, then save the resulting links.

**Compact JSON is the only initially selected format.** It is minified by default and ready to provide directly to an AI as text/JSON. It stores document metadata and one shared legend, followed by short message records and a final count. It avoids repeated per-message source objects and absent optional fields. The author tuple can contain `null` when the source has no author ID.

| Key | Saved meaning |
| --- | --- |
| `i` | Message ID, as a string. |
| `h` | Channel ID when different from the document channel. |
| `a` | Author tuple: `[ID or null, display name, optional username]`. |
| `t` | ISO timestamp when available, otherwise the saved display timestamp. |
| `c` | Message content, preserving case and line breaks. |
| `r` | Reply: `i` target ID, `h` channel, `a` author tuple, `c` saved quotation, `u` unavailable, `x` truncated. |
| `m` | Optional media: `a` attachments and `e` embeds. |

Compact preserves content, identities, timestamps, and reply relationships. Reply quotations are omitted when a target ID is present unless **Include compact reply quotations** is enabled; a quotation without a target ID is retained. Full detail JSON/JSONL retains additional fields such as reactions, mentions, and edited timestamps. Compact cleaned and full cleaned variants remove image/emoji content while preserving ordinary links, non-image files/videos, author identity, and reply IDs. Message-only JSON, CSV, and plain text are also available.

Media links, compact reply quotations, embedded HTML machine data, human-readable JSON, and gzip are **off by default** in the workspace. Enable them when needed. **Skip empty text** applies after transformation. Selecting multiple formats produces separate downloads.

Gzip streams compressed output to disk and adds `.gz` to the filename. Decompress it before AI analysis, or import it here to decode and export uncompressed compact JSON. File-size savings depend on the content: one representative 100-message fixture measured 39,729 bytes as full JSON and 9,115 as compact JSON, about 77% smaller. This is an example, not a promised reduction.

HTML quality choices are **Compact** (text and reply links), **Standard** (additional embed details/media links), and **Rich** (lazy images and media previews). Embedded machine data preserves exact normalized records at additional size; without it, reimport recovers the visible content and saved identity/timestamp/reply attributes. Enable media separately. Media stays linked to its original URLs and is not downloaded; remote links can expire or become unavailable.

**Messages per output file** splits exports by exported message count. `0` creates one data file; HTML always has at most 10,000 messages per part. **Clear prepared export files** releases this workspace's links and deletes generated scratch exports, including files referenced by other workspace tabs. Save the downloads you want first; cached source archives remain available.

The popup's **Quick HTML (legacy)** button retains the original JavaScript overlay for small compatibility exports. It does not use the workspace's streaming Rust/WASM pipeline or its large-file storage model.

## Storage, fidelity, and measured performance

The workspace keeps cached records in IndexedDB and generated downloads in OPFS. Allow room for the input, cached normalized records, and every prepared output format; browser quotas and available disk space vary. Clear unused caches and prepared exports to reclaim space. Quota failures preserve committed capture progress. Tokens are obtained only inside the Discord page and never enter the worker, settings, cache, or export metadata. The popup separately checks this fork's GitHub releases for updates.

Processing uses roughly 256 KiB input/output chunks and bounded record batches. Parser limits are 16 MiB per record and 8 MiB for metadata. The preview is separately capped at 256 KiB. Malformed/truncated imports are rejected. Legacy HTML cannot restore IDs, exact time zones, or reply details that the original HTML never saved. If channel metadata arrives after message records, some per-record channel IDs can remain null even though the document's channel context is known.

The [500 MB measurement](docs/benchmark-500mb.json), recorded on 2026-10-29, used the production worker and real WASM, IndexedDB, and OPFS on secure localhost in Chromium:

| Measurement | Result |
| --- | --- |
| Synthetic JSONL input | 500,006,376 bytes; 59,688 records |
| Compact output | 494,754,707 bytes; all 59,688 records revalidated |
| Import / export / validation | 46.7 s / 34.5 s / 13.5 s |
| Peak WASM linear memory | 3.3 MiB |
| Sampled browser working sets | About 655 MiB across browser processes |

The earlier [2.0 measurement](docs/benchmark-500mb-v2.0.json) is retained for
reference. Browser/runtime and concurrent activity differ between runs, so these
reports are not a controlled before/after speed comparison.

The working-set total can count shared pages more than once and is not the WASM memory figure. These are synthetic measurements, not a live Discord, Firefox, or extension-origin performance result. The workspace also passed a separate actual MV3 extension smoke test in Edge, covering imports, merging, filtering, exports and gzip. Live update orchestration uses synthetic pages in that test; it does not access a Discord account. Timing and memory depend on browser, hardware, content, and storage. The large fixture is mostly long message text, so its compact size reduction is much smaller than the short-message example above.

Selected-author reads now use an index instead of scanning every message. A separate [10,000-record Edge measurement](docs/performance-author-index.json), with one author owning 1% of records, reduced cursor visits from 10,099 to 100 and median read time from 490.1 ms to 5.5 ms. These timings are specific to the test. Existing caches upgrade automatically without deleting records; a large cache can take time on its first opening after an upgrade.

## Build and verify

Development commands below run from this extension folder. Install Node.js and Rust only to develop or rebuild. WASM builds require the `wasm32-unknown-unknown` target and exactly `wasm-bindgen-cli` 0.2.129; the build script checks the version and emits web-target bindings into `wasm/`.

```powershell
npm ci
npm test
cargo test --locked --manifest-path rust/Cargo.toml
node rust/tests/wasm.mjs

# Rebuild packaged WASM after changing Rust:
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.129 --locked
./scripts/build-wasm.ps1
```

Browser checks require Playwright's Chromium (`npx playwright install chromium`) or an existing executable supplied through `TEST_BROWSER`:

```powershell
# Default: attempt the unpacked extension. Secure-localhost fallback:
$env:TEST_HTTP = '1'
node tests/browser-smoke.mjs
Remove-Item Env:TEST_HTTP

# Synthetic large-file worker benchmark (default 500 MB):
$env:BENCHMARK_MB = '500'
npm run benchmark
```

Browser artifacts are written under `artifacts/`. The benchmark generates its own input, validates exported record counts and endpoint IDs, and writes `docs/benchmark-500mb.json`. It deletes its generated input unless `KEEP_BENCHMARK_INPUT` is set. These checks do not make live Discord requests.

## More documentation

- [Export formats, compact legend and fidelity](docs/EXPORT_FORMATS.md)
- [Troubleshooting and recovery](docs/TROUBLESHOOTING.md)
- [Architecture and module responsibilities](docs/ARCHITECTURE.md)
- [Contributing, verification and packaging](CONTRIBUTING.md)
- [Contributor and agent guide](AGENTS.md)

## Account automation and license

Upstream's account-automation notice still applies: this tool automates a Discord user account; automated scraping can violate Discord's rules and risk account suspension. Use at your own risk.

Licensed under the [MIT License](LICENSE), retaining the upstream copyright notice.
