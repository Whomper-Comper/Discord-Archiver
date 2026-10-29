# Fixed implementation interfaces

## Rust/WASM ABI

### User refinement, 2026-10-29

Add `compact` and `compact-cleaned` formats. Compact JSON is self-describing:
version/format/legend/channel/source/status metadata once, a messages array, and
a final count. Short record keys: i=ID, a=author tuple [ID,display name,username],
t=timestamp (ISO if available, otherwise saved display timestamp), c=content,
r=reply object (i=target ID,a=author tuple,c=preview,u=unavailable,x=truncated),
m=media attachments/embeds only if requested. Omit absent/empty optional values.
No repeated per-record source object or empty/null full-schema fields. Preserve
all content and identity; include reply preview when no target ID exists, or when
options.include_reply_text is true. Full formats stay available for other fields.
Import compact JSON through the normal streaming `json` importer; semantic
content/IDs/names/replies must round-trip. The legend is intended for AI analysis.

Exporter options add `html_quality:'compact'|'standard'|'rich'`,
`include_machine_data:boolean`, and `include_reply_text:boolean`. Compact HTML
avoids duplicated embedded records when machine data is off; include identity,
timestamps and reply IDs in safe attributes so the parser can recover what is
saved. Standard/rich progressively add embed/media presentation. Rich images must
be lazy and links restricted to HTTP(S). Machine data explicitly preserves exact
records at additional file size. Import should reject truncation between complete
HTML rows when a document was opened but not closed.

Worker export options add `gzip:boolean`. If enabled, stream encoded output through
CompressionStream('gzip') into OPFS, with backpressure and cancellation. Final
file names end `.gz`; compression must never buffer whole output. Gzip requires
decompression before AI analysis; uncompressed compact JSON remains the default.
Add RPC `clearExports` to delete only generated scratch downloads after the user
explicitly releases those links. On restart expose stale importing jobs for
deletion (never export them as complete). Pass import file.name as source metadata.

Generated module: `wasm/archive_engine.js` (web target), binary `archive_engine_bg.wasm`.
Export `default init` and:

- `normalize_batch(raw_json: string, channel_json: string): string` returns a JSON
  array of normalized Message records. Accept API objects and already-normalized
  records (author.display_name + source). Channel JSON is `{id,name,source?}`.
- `new ArchiveImporter(kind: string, channel_json: string)`; kind `json`, `jsonl`,
  `html`, or `legacy_html`. `feed(chunk: string): string` and `finish(): string`
  return JSON `{messages: Message[], channel?: {id,name}, warnings?: string[],
  legacy_required?: boolean}`. HTML streams recognize existing global
  `discord-archive-data` JSON and new per-record `archive-record` JSON script
  elements. HTML without machine data returns `legacy_required:true` at finish;
  worker rereads file with legacy_html. Never retain whole input. Reject truncated
  input; message cap 16 MiB and header/metadata cap 8 MiB. `free()` is generated.
- `new ArchiveExporter(format: string, options_json: string, metadata_json: string)`.
  `begin(): string`, `push(batch_json: string): string`, `finish(): string`,
  `count(): number`. Formats `full`, `cleaned`, `messages`, `jsonl`,
  `cleaned-jsonl`, `csv`, `text`, `html`. Options `{user_key:null|string,
  skip_empty:false,include_media:true,pretty:false}`. Metadata contains channel,
  source/status/settings with no token. Push takes normalized records. Rust owns
  filtering, cleaning, encoding. HTML embeds safely escaped per-record JSON in
  `<script type="application/json" class="archive-record">` plus channel metadata.
  Full JSON has `schema_version:1`, `sources`/metadata, `messages`, `message_count`.
  Messages format is a plain JSON array of strings. CSV guards formula-leading
  cells and quotes delimiters/newlines. URLs in HTML restricted to http(s).

Message schema matches the prior Rust tool: id/channel_id nullable strings;
author {id,username,display_name,avatar_url,bot}; timestamp/timestamp_display/
edited_timestamp nullable strings; content; reply {message_id,channel_id,author,
content,unavailable,truncated} or null; attachments/embeds/mentions/reactions
arrays; custom_emoji_labels; source {file,index,fidelity}.

## Worker RPC

Worker at `archive-worker.js`, launched with `{type:'module'}`. Requests
`{id:number,type:string,...fields}`; response `{id,result}` or `{id,error:string}`.
Unsolicited progress `{type:'progress',operation,jobId,count,bytes,totalBytes,status}`.
Each RPC is serialized, except `cancel` sets a cancellation flag immediately.

- `init` -> `{jobs,storage:{usage,quota}}`.
- `create` {channel,settings} -> Job.
- `append` {jobId,messages:APIObject[],checkpoint:{cursor,status,scanned}} -> Job;
  normalize via Rust then atomically append/checkpoint. Await this before fetch.
- `finish` {jobId,status:'ready'|'paused'|'error',error?} -> Job.
- `summary` {jobId,search?:string} -> `{job,users:[{key,id,display_name,username,count}],truncatedUsers}`; limit user results to 200.
- `import` {file:File,kind?:'json'|'jsonl'|'html'} -> Job; staged cache, only ready
  after validated finish. On failure/cancel discard this staging job and retain
  other jobs. Channel defaults to filename; track actual file bytes.
- `preview` {jobId,format,options} -> `{text,count}`; first three matching records,
  bounded output preview (at most 256 KiB). Count may be the preview count.
- `export` {jobId,formats:string[],options,splitMessages:number,filename:string}
  -> `{files:[{name,file:File,count,format,bytes}],count}`. Stream one format at a
  time into OPFS, bounded batches about 100 records. HTML always split at most
  10,000 records; splitMessages 0 disables splitting for data formats. Safe unique
  filenames; no all-output Blob/string concatenation. Exports survive as download
  links; Files remain backed by OPFS. Report partial archive status in metadata.
- `delete` {jobId} -> `{deleted:true}`.
- `cancel` -> `{cancelled:true}`.

Job: `{id,name,channel:{id,name},kind:'capture'|'import',status,count,bytes,scanned,
cursor,settings,createdAt,updatedAt,error?,warnings?:string[]}`. Keep the original
settings and cursor for resume. Capture order is oldest-first on export, imports
retain input order. Deduplicate only stable channel/message ID pairs. No global
in-memory dedup set: use IndexedDB keys/indexes.

## Storage module

`storage.js` may expose its own tested API to worker. Database operations must
commit batch records, user counts, cursor and job count in one transaction.
Read output in bounded pages with a continuation key; never getAll all messages.
Persist normalized records with job/identity/order keys; ID-based dedup does not
drop messages without IDs. Store source order, and descending collection sequence
so exports of newest-first capture pages become oldest-first.
