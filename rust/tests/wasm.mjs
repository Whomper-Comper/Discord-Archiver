import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import init, { ArchiveImporter, ArchiveExporter, normalize_batch } from '../../wasm/archive_engine.js';

const engine = await init({ module_or_path: await readFile(new URL('../../wasm/archive_engine_bg.wasm', import.meta.url)) });
const channel = JSON.stringify({ id: 'channel', name: 'General' });
const raw = [{ id: '1234567890123456789', author: { id: '42', username: 'User' }, content: 'Hello 😀 </script> 雪' }];
const normalized = normalize_batch(JSON.stringify(raw), channel);
assert.equal(JSON.parse(normalized)[0].id, raw[0].id);
for (const format of ['full', 'cleaned', 'compact', 'compact-cleaned', 'messages', 'jsonl', 'cleaned-jsonl', 'csv', 'text', 'html']) {
  const exporter = new ArchiveExporter(format, '{}', JSON.stringify({ channel: JSON.parse(channel), status: 'paused' }));
  const output = exporter.begin() + exporter.push(normalized) + exporter.finish();
  assert.equal(exporter.count(), 1);
  exporter.free();
  if (['full', 'cleaned', 'compact', 'compact-cleaned', 'messages', 'jsonl', 'cleaned-jsonl'].includes(format)) JSON.parse(output);
  if (format === 'compact' || format === 'compact-cleaned') {
    const importer = new ArchiveImporter('json', channel);
    const messages = [];
    for (const scalar of output) messages.push(...JSON.parse(importer.feed(scalar)).messages);
    messages.push(...JSON.parse(importer.finish()).messages);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].id, raw[0].id);
    assert.ok(messages[0].content.includes('Hello'));
    importer.free();
  }
  if (format === 'html') {
    const importer = new ArchiveImporter('html', channel);
    const messages = [];
    for (const scalar of output) messages.push(...JSON.parse(importer.feed(scalar)).messages);
    messages.push(...JSON.parse(importer.finish()).messages);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].content, raw[0].content);
    importer.free();
  }
}
const media = normalize_batch(JSON.stringify([{ ...raw[0], timestamp: '2026-10-29T00:00:00Z', author: { id: '42', username: 'MiXeD', avatar: 'hash' }, attachments: [{ url: 'https://example.com/image.png', content_type: 'image/png' }, { url: 'javascript:alert(1)' }], message_reference: { message_id: 'TARGET' } }]), channel);
for (const quality of ['compact', 'standard', 'rich']) {
  for (const machine of [false, true]) {
    const e = new ArchiveExporter('html', JSON.stringify({ html_quality: quality, include_machine_data: machine }), JSON.stringify({ channel: JSON.parse(channel) }));
    const output = e.begin() + e.push(media) + e.finish();
    e.free();
    assert.equal(output.includes('class="archive-record"'), machine);
    assert.ok(!output.includes('href="javascript:'));
    if (quality !== 'compact') assert.ok(output.includes('loading="lazy"'));
    const p = new ArchiveImporter('html', channel);
    let records = [];
    const bytes = Buffer.from(output), decoder = new TextDecoder();
    for (let offset = 0; offset < bytes.length; offset += 73) records.push(...JSON.parse(p.feed(decoder.decode(bytes.subarray(offset, offset + 73), { stream: true }))).messages);
    records.push(...JSON.parse(p.feed(decoder.decode())).messages);
    records.push(...JSON.parse(p.finish()).messages);
    p.free();
    assert.equal(records.length, 1);
    assert.equal(records[0].reply.message_id, 'TARGET');
    assert.equal(records[0].author.username, 'MiXeD');
  }
}
const sizes = {};
for (const format of ['full', 'compact']) {
  const e = new ArchiveExporter(format, '{}', JSON.stringify({ channel: JSON.parse(channel), status: 'paused' }));
  const output = e.begin() + e.push(JSON.stringify(Array(100).fill(JSON.parse(normalized)[0]))) + e.finish();
  sizes[format] = Buffer.byteLength(output);
  e.free();
}
assert.ok(sizes.compact * 2 < sizes.full);
const legacy = new ArchiveImporter('legacy_html', channel);
const namedRow = (id, name, content) => `<div class="chatlog__message-container"><div><img class="chatlog__avatar" src="https://cdn.discordapp.com/avatars/${id}/x.png"></div><div><span class="chatlog__author">${name}</span>${content}</div></div>`;
const legacyRows = JSON.parse(legacy.feed(`<div class="chatlog">${namedRow('1', 'First', 'One')}${namedRow('2', 'Unknown', 'Two')}<div class="chatlog__message-container"><div>10:01</div><div>Grouped</div></div></div>`)).messages;
legacyRows.push(...JSON.parse(legacy.finish()).messages);
legacy.free();
assert.deepEqual(legacyRows.map(m => [m.author.id, m.author.display_name]), [['1', 'First'], ['2', 'Unknown'], ['2', 'Unknown']]);
for (const format of ['full', 'compact', 'html']) {
  const source = { kind: 'capture', name: 'partial.json', status: 'paused', partial: true, settings: { minimumInterval: 100 }, auth: 'SECRET' };
  let metadata = { channel: JSON.parse(channel), status: 'ready', partial: true, sources: [source] };
  for (let generation = 0; generation < 2; generation++) {
    const e = new ArchiveExporter(format, '{}', JSON.stringify(metadata));
    const input = e.begin() + e.push(normalized) + e.finish();
    e.free();
    const p = new ArchiveImporter(format === 'html' ? 'html' : 'json', channel);
    const rows = [];
    for (const scalar of input) {
      const result = JSON.parse(p.feed(scalar));
      assert.equal(result.source_metadata, undefined);
      rows.push(...result.messages);
    }
    const finish = JSON.parse(p.finish());
    p.free();
    assert.equal(finish.source_metadata.partial, true);
    assert.equal(finish.source_metadata.status, 'ready');
    assert.deepEqual(finish.source_metadata.sources, [{ kind: 'capture', name: 'partial.json', status: 'paused', partial: true }]);
    assert.ok(!JSON.stringify(finish.source_metadata).includes('SECRET'));
    assert.ok(!JSON.stringify(finish.source_metadata).includes('settings'));
    metadata = { channel: JSON.parse(channel), ...finish.source_metadata };
  }
}
// A large stream reuses bounded input chunks and emits immediately.
const importer = new ArchiveImporter('jsonl', channel);
const line = JSON.stringify(raw[0]) + '\n';
const chunk = line.repeat(100);
let count = 0;
const memoryStart = engine.memory.buffer.byteLength;
for (let i = 0; i < 1000; i++) count += JSON.parse(importer.feed(chunk)).messages.length;
count += JSON.parse(importer.finish()).messages.length;
assert.equal(count, 100000);
const memoryEnd = engine.memory.buffer.byteLength;
assert.ok(memoryEnd - memoryStart < 32 * 1024 * 1024, `Unexpected retained memory growth: ${memoryEnd - memoryStart}`);
importer.free();
console.log(JSON.stringify({ wasm: 'passed', formats: 10, htmlQualityCases: 6, sizes, streamedRecords: count, memoryStart, memoryEnd }));
