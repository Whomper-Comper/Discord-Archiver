# Architecture

The extension has two export paths. The workspace is the large-file path: Rust/WASM
parses and encodes incrementally in a worker, IndexedDB holds normalized records,
and OPFS holds generated downloads. `inject.js` retains the original Quick HTML
overlay for small compatibility exports; it does not share those streaming guarantees.

## Module map and data flow

| Module | Responsibility |
| --- | --- |
| `popup.html`, `popup.js` | Active Discord channel context, workspace launch, legacy injection, GitHub release check. |
| `workspace.html`, `workspace.css`, `workspace.js` | Controls, saved preferences, explicit archive/author selection, text preview, progress and download links. |
| `collector.js` | Settings, sequential pages, UTC bounds, retry/pacing, resume and Web Locks; self-contained Discord MAIN-world fetch. |
| `archive-worker.js` | RPC queue, staged imports, WASM lifecycle, disk writes, compression, progress and cancellation. |
| `storage.js` | IndexedDB records, author counts, job checkpoints, deduplication, paging and schema migration. |
| `rust/src/model.rs`, `normalize.rs` | Normalized schema and API/normalized input conversion. |
| `rust/src/import.rs`, `legacy.rs`, `visible_html.rs` | Incremental JSON/JSONL/HTML parsing and HTML rendering/recovery. |
| `rust/src/compact.rs`, `clean.rs`, `export.rs` | Compact legend/codec, cleaning, filtering and encoders. |
| `wasm/` | Generated web bindings and binary, shipped for end users. |

For capture, the workspace injects `fetchDiscordPage` into Discord MAIN. The token
is acquired and consumed there; only page data and rate information return. The
collector awaits worker `append` before requesting another page. The storage
transaction commits records, author counts, cursor and job count together.

Capture arrives newest first, so stored negative sequence numbers produce
oldest-first exports. Imports keep source order. Deduplication uses stable
channel/message ID pairs; missing IDs must not cause unrelated rows to disappear.
Author keys are `id:<ID>` or `name:<display name>` when no ID exists. Name-only
identities can merge equal names because the original source lacks a stronger key.

## Worker contract

Requests are `{id, type, ...fields}`; replies are `{id, result}` or `{id, error}`.
Progress messages have `type:'progress'`, operation, job ID, count and byte/status
information. Normal operations serialize through a queue; `cancel` immediately
increments a cancellation generation checked throughout each operation.

- `init`, `create`, `append`, `finish`: cache discovery and capture lifecycle.
- `summary`: job plus up to 200 matching authors and a truncation flag.
- `import`: stream a File into a staging job, validate finish, then mark ready.
- `preview`: encode up to three selected records with a 256 KiB output cap.
- `export`: stream each selected format, split by exported count, return OPFS-backed Files.
- `delete`: remove one cached job; `clearExports`: remove generated OPFS files.

Failed/cancelled imports delete their staging job while preserving other jobs.
A crash may leave an `importing` job; preview/export rejects it. Reimport the
original file after deleting that incomplete job. Capture jobs retain original
settings and cursor for explicit resume under a per-job Web Lock. Closing a
workspace stops collection rather than scheduling background work.

See [fixed interfaces](extension-interfaces.md) for the ABI and normalized schema;
the executable implementation/tests resolve details introduced after that design.

## Bounds and storage

The worker reads approximately 256 KiB input chunks, feeds Rust incrementally and
writes in bounded output chunks with backpressure. Storage pages hold at most 100
records. These are processing bounds, not a promise that a large record takes only
256 KiB of memory: the parser allows a record up to 16 MiB and metadata up to 8 MiB.
Preview is capped separately at 256 KiB and may therefore be an incomplete textual
sample rather than valid parseable JSON at the cap.

Exports use OPFS `discord-archive-exports`; gzip is streamed through
`CompressionStream`. Import gzip uses `DecompressionStream`. HTML without embedded
machine data triggers a second incremental legacy/visible-HTML pass. No path should
read the entire archive into a string or accumulate all output into one Blob.
HTML parts are capped at 10,000 messages even when other formats are unsplit.

Cached jobs and prepared files are separate. Clearing prepared exports invalidates
links in other workspace tabs but retains cached source jobs. Deleting a cache does
not delete already saved downloads. Browser eviction, quota and available disk
space remain environmental limits even with the extension's `unlimitedStorage`
permission. Quota preflight is an estimate, not a full reservation.

## Cache schema and selected-author reads

Database version 2 adds `messages.authorOrder`, a secondary index on
`[jobId,authorKey,order]`. `authorKey` uses the same stable author-key helper as
summary counts. Fresh appends maintain the field/index in the records/checkpoint
transaction. Upgrading a version 1 cache cursor-updates one row at a time inside
the atomic version-change transaction, preserving jobs, messages, identity keys,
user counts and source order. Initialization waits for that upgrade; large old
caches may take time. JavaScript holds one migration row at a time, while browser
index construction still consumes disk and browser-managed memory.

`readPage(jobId,{after:null,limit:100,userKey:null})` accepts an optional stable
author key. When present, it reads the author/order index instead of scanning all
messages. Its `{messages,next}` continuation remains a source-order number: the
last returned row's order if another matching row exists, otherwise null. Pages
are capped at 100 rows. Worker preview/export supplies `options.user_key`; Rust
still applies the final author filter. Test migration, pagination, sparse-author
reads and missing-ID/name-only records when changing this contract.

## Security and verification boundaries

Keep tokens out of workers, metadata, persisted settings and logs. Preview uses
text content; Rust escapes HTML/script data and restricts rendered links to HTTP(S).
Content and media originate from archives; remote media remains linked and can expire.
No remote executable code is needed by the workspace.

Node tests cover orchestration and the packaged WASM; browser smoke covers real
browser storage and the UI. The recorded [500 MB benchmark](benchmark-500mb.json)
used secure localhost in Chromium. It does not establish extension-origin, live
Discord or Firefox behavior. See [contribution checks](../CONTRIBUTING.md) and
[troubleshooting](TROUBLESHOOTING.md) for environment-specific verification.

## Updating and combining archives

The update operations create a new cached archive rather than modifying either
source. `merge {baseJobId,file,kind?}` stages an incoming file, combines it with the
base and removes the temporary incoming job. `combine {baseJobId,additionalJobId}`
combines two existing jobs. Both return a new ready import Job with
`mergeStats:{originalCount,incomingCount,added,duplicates,unidentified}`. Added and
duplicate counts refer to incoming records; unidentified counts retained rows
without a stable channel/message pair. Failure/cancellation removes stages owned
by that operation and leaves original caches recoverable.

Before publishing a combined copy, the worker checks the number of copied source
rows and rechecks each source's existence, count, update timestamp and status.
Concurrent source changes abort the operation instead of silently omitting rows.

Combination reads bounded pages (100 records), emits base records then incoming
records in each source's existing order, and keeps the first stable ID-pair copy.
It neither sorts by guessed timestamps nor merges equal author/text strings.
Identical ID-less legacy messages remain separate with a warning. Known source
channel context can fill a missing per-record channel within that source; mixed
or unknown channels leave the combined document channel ID null.

`updateInfo {jobId,channelId}` returns `{job,channelId,newestId,hasMissingIds,
hasNonNumericIds}`. `newestId` is the decimal maximum stable message ID for the
specified channel; the flags report uncertain identity data. A collector can use
that known boundary to fetch newer messages before combining a completed capture.
No safe live boundary can be inferred from legacy display text alone.

Source descriptors retain name, kind, status and partial flags. A combined job can
be ready to export while `partial:true` still describes incomplete input history.
Exports carry `sources`, `partial` and `merge_stats`; imported source metadata must
preserve those warnings through another conversion. Source files on disk are never
rewritten by the worker: users save a new prepared export.
