# Rust/WASM exports and large-archive extension design

## Intent and decisions

Bring the approved desktop conversion features into the user's GitHub fork,
Whomper-Comper/Discord-Archiver. The user explicitly chose Rust/WebAssembly
processing and requested improved stability and speed for files around 500 MB.
Keep the extension installable from the repository, including built WASM assets.

## Approaches

- Direct JavaScript exports would be simplest but the user chose Rust/WASM.
- A native Rust companion would require a separate installation; it does not
  satisfy processing inside the extension.
- Chosen: Rust/WASM in a dedicated worker, with disk-backed browser storage and
  streaming import/export. JavaScript handles browser integration and collection.

## Findings

The fork is currently the original v1.2.0 extension. Collection repeatedly calls
`concat` on the full accumulated history, introducing quadratic copying. It always
renders HTML and keeps the entire dataset in memory. The popup has no settings,
and no background job survives popup closure. Fixed jitter is 500–800 ms/page.
Discord's history endpoint permits 1–100 messages per page; cursor pages are
sequential. Honor response rate-limit headers and Retry-After, including 429s.

## Architecture

- Popup opens a full extension workspace tab with collection/import controls,
  progress, user selection, previews, saved settings, and export choices.
- A packaged module worker initializes packaged Rust/WASM. It imports, normalizes,
  cleans, filters, and encodes data in bounded batches.
- IndexedDB stores messages and user counts on disk. Transactions atomically
  commit each batch with its collection cursor and job metadata.
- OPFS stores streamed export files. Download links use disk-backed File objects
  after writing finishes. Never concatenate all output into a JS string/array.
- All browser APIs are feature-detected. Missing disk storage produces an
  actionable error; do not silently fall back to an unbounded in-memory path.
- Keep raw messages and tokens out of persistent extension settings. Cached
  message content stays local in the explicit archive cache; tokens never leave
  the Discord page or enter extension storage/logs.

## Collection and stability

Use one in-flight history request. Fetch one API page at a time from the original
Discord tab, then send it to the worker and await disk commit before the next
request. This provides backpressure and bounded memory. Use API batch size 100
by default, configurable from 1–100; overall cap 0 means unlimited. Avoid whole
array copies and unnecessary UI updates. Track fetched/saved counts and elapsed
time separately.

Offer adaptive/balanced/gentle presets plus explicit minimum interval, timeout,
and maximum retries. An adaptive setting removes unnecessary fixed waiting when
headers permit requests; exhausted buckets and Retry-After always take precedence.
Use bounded retries with backoff for transient network/5xx failures. Stop on
authentication/permission errors. Cancellation interrupts waits and requests.
Never change tokens, rotate identities, parallelize around limits, or bypass them.

Offer after/before dates, starting-before message ID, optional target user IDs,
and a total fetched-message cap. Date bounds are UTC and clearly labeled. A
user filter limits stored/exported authors but still requires scanning history;
the UI must explain that it does not reduce Discord page requests.

Checkpoint successful batches. A pause, closed workspace, or network failure
leaves the last committed batch recoverable. Resume an unfinished collection
with its original settings/cursor; deduplicate stable channel/message IDs.
An explicit resume action is required: do not automatically restart API requests.
Cache deletion is an explicit UI action. Surface quota/storage errors with the
last saved progress; never label an incomplete archive as complete.

## Existing files and 500 MB stability

Import API JSON arrays, full JSON documents with a messages array, JSONL, and
Discord Archiver HTML. Read File streams in chunks (about 256 KiB). Rust scans
message boundaries across chunks, including braces/quotes/Unicode splits.
Extract embedded machine-readable JSON without building a whole-document DOM.
Support legacy HTML with incremental message-container extraction and the known
author/reply limitations from the desktop tool. Legacy HTML may need a detection
pass before parsing, but remains bounded-memory.

Use a staging job for imports. Commit the job as ready only after the parser
validates end-of-input; malformed/truncated files are errors, and staged content
must not silently replace an existing good archive. Bound a single message and
metadata header separately (for example 16 MiB and 8 MiB) to reject pathological
inputs without unbounded allocation. Document these limits and storage needs.

Verify the actual WASM pipeline on a generated 500 MB input, recording throughput,
peak memory, record count, and a verifiable output. Do not promise a speedup
percentage without measurement. Verify that memory depends on chunk/message size
rather than total input size. Include cancellation/restart and malformed inputs
in automated integration tests.

## Export contracts

- HTML: searchable offline view with escaped content, names, replies, media
  links, and recoverable machine data. Split large HTML output by a configurable
  message count to keep the viewer usable.
- Full JSON: schema version, channel/source/job status, and records retaining
  available author names/IDs, content, timestamps, replies, attachments/embeds.
- Cleaned JSON: same records with image and emoji content removed; preserve
  author identities, ordinary links, non-image files/videos, and reply IDs.
- Messages-only JSON: array of strings with no metadata wrapper.
- JSONL: one full or cleaned message record per line.
- CSV: quoted tabular message/author/reply columns; guard spreadsheet formulas.
- Plain text: message text only; preserve line breaks and separate records.

Users can export everyone or one selected stable author ID/name, and choose
multiple formats. Empty-text skipping runs after transformation. Use Rust for
normalization, cleanup, filtering, and encoding in every data export. Streaming
HTML rendering must also escape untrusted text and restrict media/link schemes.
Provide optional output splitting, compact/pretty JSON, and media inclusion
controls. No media downloading is needed; existing CDN links remain links.

## Delivery and verification

Keep Chrome/Firefox Manifest V3 support. Add storage/download permissions needed
by the workflow and the documented wasm-unsafe-eval CSP for packaged WASM only.
Set the update source to the user's fork. Preserve the existing quick HTML
export as a compatibility route if feasible; new workspace exports use Rust.
Include Rust source, reproducible WASM build script, committed generated assets,
unit/integration tests, a 500 MB benchmark harness, and installation instructions.

Work in an isolated clone of the user's fork and a feature branch. Preserve the
previous standalone Rust tool in the original workspace. Prepare changes and
push a reviewable feature branch to the fork when credentials allow; report any
authentication block without exposing credentials. Do not merge or publish a
store release.
