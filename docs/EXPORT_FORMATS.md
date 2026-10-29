# Export formats and fidelity

Compact JSON is the sole initial workspace selection. Media, reply quotations,
pretty JSON, gzip and HTML machine data are off initially; saved preferences may
restore your previous choices. Exporting never modifies the cached source records.

| Format / worker name | Contents and tradeoff |
| --- | --- |
| Compact JSON / `compact` | Shared metadata/legend plus short records; text, identity, timestamps and reply relationships. Best small default for AI input. |
| Cleaned compact / `compact-cleaned` | Same compact schema after image/emoji cleaning. |
| Full JSON / `full` | Document metadata and normalized message objects, including extra fields omitted by compact. |
| Cleaned JSON / `cleaned` | Full normalized schema after cleaning. |
| JSONL / `jsonl`, `cleaned-jsonl` | One normalized message object per line, optionally cleaned; no document-level header/count wrapper. |
| Message-only JSON / `messages` | Array of content strings; loses author, time and reply structure. |
| CSV / `csv` | ID, channel, author, timestamp, content, reply and attachment columns; not a full fidelity archive. Quotes cells and guards formula-leading values. |
| Text / `text` | Human-readable messages; not a full fidelity archive. |
| HTML / `html` | Offline reader, search and reply links; fidelity depends on quality/media/machine-data settings. |

All IDs are strings. Do not convert Discord snowflakes to JavaScript numbers or
spreadsheet numeric cells: precision can be lost. Full means the **normalized
schema**, not a byte-for-byte copy of Discord's raw API response.

## Compact decoding

The top-level object has `schema_version:1`, `format:'compact'` (or
`compact-cleaned`), a `legend`, channel/source/status/settings metadata when present,
a `messages` array and final `message_count`. `status` and `partial` describe the
cached job; `message_count` counts records actually emitted in that output part.

| Record key | Decode |
| --- | --- |
| `i` | Message ID string; omitted when unknown. |
| `h` | Channel ID differing from document channel; otherwise inherit document context. |
| `a` | `[author ID or null, display name, optional username]`. |
| `t` | ISO timestamp if known; otherwise saved display timestamp. Do not infer a timezone from display text. |
| `c` | Message content with case and line breaks preserved. |
| `r` | Reply object: `i` target ID, `h` channel, `a` author tuple, `c` quotation, `u` unavailable, `x` truncated. |
| `m` | Media object: `a` attachments, `e` embeds; present only when saved and enabled. |

Optional empty values are omitted. `r.u`/`r.x` are true-only flags. The reply target
may be outside the selected author, split file or collected history; its ID still
matters. By default `r.c` is omitted when a target ID exists; enable **Include compact
reply quotations** to keep it. A saved quotation without a target ID is retained.

For example, given document channel ID `20`, this record means Alice (`101`) wrote
`Hello\nworld`, replying to message `99` in channel `20`:

```json
{"i":"100","a":["101","Alice","alice"],"t":"2026-10-28T12:00:00Z","c":"Hello\nworld","r":{"i":"99","h":"20"}}
```

Compact omits reactions, mentions, edited timestamps, avatar/bot fields and repeated
per-record provenance. Full JSON/JSONL retains those normalized fields when the
input provided them. Reimporting compact restores compact semantics, not fields
already omitted. The importer supplies provenance in `source.file`, a `source.index` sequence
and a fidelity label; normalized inputs can retain their saved provenance. These are provenance of the imported records,
not a reconstruction of raw API objects or an identity key. Late document channel
metadata can leave some normalized per-record channel IDs null.

## Conversion and additions

Importing an older HTML/JSON archive and exporting it again converts the saved
information into the selected format. Full JSON preserves the available normalized
fields; compact preserves its documented subset. For improved HTML, choose a
quality level and embed machine data when later reimport fidelity matters.
Conversion cannot restore IDs or reply details missing from the old file.

Combined archives preserve the base source order followed by additional source
order. They are not sorted by inferred dates. Repeated stable channel/message
pairs keep the first copy, including its original content; this is an addition
workflow rather than an edit-history reconciliation. Unidentified legacy rows
are retained even if their text matches, so overlaps can appear twice. Keep
original files for comparison. Download the combined archive as a new file.

Document formats can carry `sources`, `partial` and `merge_stats`. A job being
ready to export does not prove complete history: a paused/error/partial source
continues to mark the combined document partial. JSONL's record-only format has
no document-level place for that source-history summary; choose full/compact JSON
or HTML when retaining that context through conversion matters.

## Cleaning and options

Cleaned variants remove emoji/custom-emoji text, image markdown/URLs and image
attachments; remove avatar/image/thumbnail details, reactions and custom emoji
labels; and clean saved reply text/embed text. Ordinary links, non-image files,
videos, author identity and reply IDs survive. This is intentionally lossy. Keep
an uncleaned format when those details matter.

**Include media** controls attachment/embed inclusion for all formats that support
it. It does not fetch media bytes. **Skip empty text** applies after transformation,
so a message reduced to empty text can disappear. **Human-readable JSON** adds
whitespace where supported. It does not restore fields omitted by compact.

HTML quality is independent of embedded machine data:

- **Compact:** text and reply links with identity/time/reply attributes.
- **Standard:** additional embed details and media links when media is enabled.
- **Rich:** lazy images/media previews when media is enabled.

**Embed machine data** adds exact exported normalized records alongside the visible
HTML, increasing file size. With it off, reimport can recover only what visible
content/attributes saved. Media suppression and cleaning still apply before
embedding. Legacy HTML cannot recover absent IDs, precise timezones or reply
metadata. HTML links allow only HTTP(S); linked media can expire or need network access.

## Splitting, gzip and large files

**Messages per output file** counts emitted records after author/empty filtering.
`0` leaves data formats unsplit; HTML always uses at most 10,000 records per part.
Each JSON part is a complete document; each JSONL part is independently readable.
Multiple selected formats produce separate files. Prepared links point to OPFS;
save them before clearing prepared files or browser data.

Gzip adds `.gz` without changing the underlying schema. Decompress before supplying
the text to a tool that cannot read gzip, or reimport it in the workspace and export
uncompressed compact JSON. For large archives, stream decompression to another file.
This standalone Node example does not buffer the whole input or output:

```javascript
// Save as unpack.mjs; run: node unpack.mjs archive.json.gz archive.json
import {createReadStream, createWriteStream} from 'node:fs';
import {createGunzip} from 'node:zlib';
import {pipeline} from 'node:stream/promises';
const [input, output] = process.argv.slice(2);
if (!input || !output || input === output) throw new Error('Choose distinct input/output paths');
await pipeline(createReadStream(input), createGunzip(), createWriteStream(output, {flags:'wx'}));
```

The destination must not exist (`wx` prevents overwriting). For record-by-record
processing, choose JSONL and use a streaming line parser with an explicit record
limit; do not use `readFile`/whole-document `JSON.parse` on a 500 MB JSON file.
The workspace accepts records up to 16 MiB and metadata up to 8 MiB; these are
record/header limits, not total archive-size limits. Preview shows at most three
matching records and 256 KiB, so inspect downloaded output for complete analysis.
See [troubleshooting](TROUBLESHOOTING.md) for malformed or incomplete imports.
