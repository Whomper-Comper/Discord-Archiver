# Troubleshooting

Start with the workspace's visible error and the selected job's status. Cached
capture progress and downloaded files have different lifecycles; save important
outputs before clearing browser data or generated exports.

| Symptom | Action |
| --- | --- |
| Worker/WASM fails to start | Reload the extension after updating files, then reopen the workspace. Confirm `wasm/archive_engine.js` and `wasm/archive_engine_bg.wasm` exist beside the manifest's runtime files. Use the packaged build or rebuild both together. |
| IndexedDB or OPFS unavailable | Open the actual extension workspace in a browser supporting IndexedDB, OPFS, module workers and WebAssembly. Collection additionally needs Web Locks and scripting access. Restricted/private contexts may disable storage. There is no whole-archive memory fallback. |
| Browser disk quota exceeded | Free disk space and delete unused cached jobs or prepared export files, then retry. A quota estimate cannot reserve enough room for every output. Committed capture pages remain saved; a failed import staging job is removed. |
| No collectable Discord channel | Open a channel you can read, grant site access, then launch the workspace from the extension icon again. A workspace opened for local import has no Discord tab context. |
| Discord session unavailable / 401 / 403 | Reload/sign in to Discord and confirm channel access. Resume the saved capture from its original channel. Do not copy tokens into settings or issue reports. |
| Rate limited or apparently waiting | Requests are sequential. The server's rate limit takes precedence over the selected minimum pacing; wait or pause. Filtering authors still scans channel history. |
| Another workspace is collecting this job | Pause/close the other active collection. Web Locks prevent two collectors advancing the same cursor. |
| Collection stopped after closing the workspace | Reopen it, select the cached capture and use **Resume collection** from its original channel. Resume uses saved settings/cursor, not newly edited form values. It does not collect in the background. |
| Incomplete import after a restart | Delete the job marked `importing` and import the original file again. It cannot be previewed/exported as complete. Normal cancellation/failure removes staging automatically. |
| Truncated/malformed import | Obtain the complete original file. The parser rejects invalid UTF-8, unfinished JSON/HTML and over-limit records/metadata (16 MiB / 8 MiB). A valid prefix is not a complete import. |
| Gzip unsupported | Turn off gzip for export, or decompress input first; the browser needs CompressionStream/DecompressionStream. See the streaming [Node example](EXPORT_FORMATS.md#splitting-gzip-and-large-files). |
| Preview looks cut off or JSON does not parse | Preview is a three-match, 256 KiB textual sample. Download the complete export; do not treat the preview as the full archive. |
| Author is absent from search results | Summary returns up to 200 matches. Refine by username or ID. Equal display names with known IDs remain distinct; name-only sources lack that distinction. Search preserves an explicit selected author. |
| Download link stops working | Prepare the export again from its cached source. Clearing prepared files affects links in all workspace tabs. Browser-data deletion/eviction can also remove files. Saved downloads are independent. |
| Images or attachments do not appear | Enable media and choose appropriate HTML quality. Cleaned formats intentionally remove images/emoji. Media is linked, not bundled; remote URLs can expire. |
| HTML reimport lacks IDs/reactions/time details | The source may not have saved them. Use full JSON/JSONL for normalized detail, or enable HTML machine data before exporting. No importer can recover absent fields. |

## Older archives and updates

Convert old HTML by importing it and exporting compact/full JSON or improved HTML.
Missing identities or reply metadata remain missing after conversion. When adding
a file, overlap is removed only for known channel/message ID pairs; equal-looking
legacy text without those IDs is deliberately retained. A newer copy of an edited
message does not replace the base copy. Compare original sources if edits matter.

Combined results are new caches and new downloads, so the original saved files
remain recoverable. Allow storage for the base, incoming staging cache and combined
result. Partial-source warnings describe the history, even after a successful
combination. Preserve a document format with metadata if exporting that warning
matters; JSONL contains records without a document wrapper.

If another workspace changes or deletes a source while combining, the operation
stops and removes its staging copy. Pause collection in other workspaces, select
the source again and retry. A combined copy is published only after its source
counts and metadata are checked.

For a completed newer-message capture whose combination failed or was cancelled,
select that capture and use **Finish saved update**. The original base must still
exist. You can also choose a different base and combine the saved capture manually.

Automatic newer-message collection needs a known numeric message ID in the target
channel. A display timestamp/name alone is not a reliable boundary. If legacy HTML
lacks such IDs, convert it and add another saved file; do not infer an anchor from
text or assume old HTML contains enough information for automatic collection.

## Developer browser environment

The smoke test defaults to an actual unpacked extension. A Windows **SideBySide**
launch failure was observed with Chrome for Testing in this environment, before
extension behavior could be checked. It is a browser executable/runtime problem,
not evidence of a successful or failed archive import. Try an existing supported
Chromium executable via `TEST_BROWSER`, or use the secure-localhost fallback:

```powershell
$env:TEST_HTTP = '1'
node tests/browser-smoke.mjs
Remove-Item Env:TEST_HTTP
```

The fallback verifies the production workspace/CSP, real WASM, IndexedDB and OPFS;
it does not verify extension permissions or Discord injection. Artifacts and
screenshots are under `artifacts/browser-smoke/`. Firefox workspace compatibility
and live Discord collection have not been verified by these synthetic checks.
The [500 MB measurement](benchmark-500mb.json) is also synthetic secure-localhost
Chromium, not a Firefox or live-account performance guarantee.

For an issue report, include browser/OS versions, extension version, visible error,
job kind/status, input format/approximate size and reproduction steps. Use a small
redacted fixture preserving the problematic structure. Exclude tokens, personal
message contents and private downloaded archives. See [CONTRIBUTING](../CONTRIBUTING.md)
for build and verification commands.
