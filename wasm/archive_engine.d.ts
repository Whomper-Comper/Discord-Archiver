/* tslint:disable */
/* eslint-disable */

export class ArchiveExporter {
    free(): void;
    [Symbol.dispose](): void;
    begin(): string;
    count(): number;
    finish(): string;
    constructor(format: string, options_json: string, metadata_json: string);
    push(batch_json: string): string;
}

export class ArchiveImporter {
    free(): void;
    [Symbol.dispose](): void;
    feed(chunk: string): string;
    finish(): string;
    constructor(kind: string, channel_json: string);
}

export function normalize_batch(raw_json: string, channel_json: string): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_archiveexporter_free: (a: number, b: number) => void;
    readonly __wbg_archiveimporter_free: (a: number, b: number) => void;
    readonly archiveexporter_begin: (a: number, b: number) => void;
    readonly archiveexporter_count: (a: number) => number;
    readonly archiveexporter_finish: (a: number, b: number) => void;
    readonly archiveexporter_new: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly archiveexporter_push: (a: number, b: number, c: number, d: number) => void;
    readonly archiveimporter_feed: (a: number, b: number, c: number, d: number) => void;
    readonly archiveimporter_finish: (a: number, b: number) => void;
    readonly archiveimporter_new: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly normalize_batch: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_export: (a: number, b: number, c: number) => void;
    readonly __wbindgen_export2: (a: number, b: number) => number;
    readonly __wbindgen_export3: (a: number, b: number, c: number, d: number) => number;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
