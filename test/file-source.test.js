'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { FileSource, FileChangedError, CancelledError } = require('../src/file-source');

async function temporary(t, text) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jsonl-source-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'records.jsonl');
  await fs.writeFile(filename, text);
  return filename;
}

test('streaming preserves physical lines, UTF-8 across chunks, BOM, CRLF, and final records', async t => {
  const filename = await temporary(t, '\uFEFF{"名字":"小林😀"}\r\n\r\n \t\r\n{"id":9223372036854775807}\nfalse');
  const source = new FileSource(filename, { chunkSize: 5 });
  t.after(() => source.dispose());
  const page = await source.getPage('', 0, 20);
  assert.equal(page.total, 3);
  assert.deepEqual(page.rows.map(row => row.line), [1, 4, 5]);
  assert.deepEqual(page.rows.map(row => row.raw), ['{"名字":"小林😀"}', '{"id":9223372036854775807}', 'false']);
  assert.equal(await source.getLine(1), '{"名字":"小林😀"}');
  const result = await source.getPage('小林😀', 0, 20);
  assert.equal(result.matched, 1);
  assert.equal(result.rows[0].line, 1);
});

test('chunked indexes page and filter across thousands of records without renumbering source lines', async t => {
  const filename = await temporary(t, Array.from({ length: 5100 }, (_, index) =>
    (index % 7 === 0 ? '\n' : '') + JSON.stringify({ id: index, tag: index % 2 ? 'MATCH' : 'other' })).join('\n'));
  const source = new FileSource(filename, { chunkSize: 127 });
  t.after(() => source.dispose());
  const page = await source.getPage('', 25, 200);
  assert.equal(page.total, 5100);
  assert.equal(page.rows.length, 100);
  assert.equal(JSON.parse(page.rows[0].raw).id, 5000);
  assert.equal(await source.getLine(page.rows[0].line), page.rows[0].raw);
  const filtered = await source.getPage('match', 999, 200);
  assert.equal(filtered.matched, 2550);
  assert.equal(filtered.page, 12);
  assert.equal(filtered.rows.length, 150);
  assert.equal(JSON.parse(filtered.rows[0].raw).id, 4801);
  const none = await source.getPage('absent', 999, 200);
  assert.equal(none.pages, 1);
  assert.equal(none.rows.length, 0);
});

test('opens a file above the VS Code text-model limit and searches beyond an oversized record preview', async t => {
  const filename = await temporary(t, '{"first":true}\n{"huge":"');
  const handle = await fs.open(filename, 'a');
  try {
    const chunk = Buffer.alloc(1024 * 1024, 120);
    for (let index = 0; index < 72; index++) await handle.write(chunk);
    await handle.write('跨块搜索 Needle-at-the-end"}\n\n{"last":true}');
  } finally { await handle.close(); }
  const source = new FileSource(filename);
  t.after(() => source.dispose());
  const progress = [];
  const page = await source.getPage('', 0, 20, { onProgress: event => progress.push(event.bytes) });
  assert.ok(page.bytes > 72 * 1024 * 1024);
  assert.equal(page.mode, 'stream');
  assert.equal(page.total, 3);
  assert.deepEqual(page.rows.map(row => row.line), [1, 2, 4]);
  assert.ok(page.rows[1].omitted);
  assert.ok(page.rows[1].raw.length <= 300);
  assert.equal(page.rows[2].raw, '{"last":true}');
  assert.ok(progress.length);
  const filtered = await source.getPage('needle-at-the-END', 0, 20);
  assert.equal(filtered.matched, 1);
  assert.equal(filtered.rows[0].line, 2);
  await assert.rejects(source.getLine(2), /过大/);
});

test('detects file changes instead of using stale byte offsets', async t => {
  const filename = await temporary(t, '{"id":1}\n');
  const source = new FileSource(filename);
  t.after(() => source.dispose());
  await source.getPage('', 0, 20);
  await fs.writeFile(filename, '{"id":200}\n{"id":300}\n');
  await assert.rejects(source.getPage('', 0, 20), FileChangedError);
  await assert.rejects(source.getLine(1), FileChangedError);
  const refreshed = new FileSource(filename);
  t.after(() => refreshed.dispose());
  assert.equal((await refreshed.getPage('', 0, 20)).total, 2);
});

test('splits pages by data size instead of omitting valid records', async t => {
  const rows = Array.from({ length: 10 }, (_, id) => JSON.stringify({ id, text: 'x'.repeat(1024 * 1024) }));
  const filename = await temporary(t, rows.join('\n'));
  const source = new FileSource(filename);
  t.after(() => source.dispose());
  const first = await source.getPage('', 0, 200);
  assert.equal(first.pages, 2);
  assert.equal(first.rows.length, 7);
  assert.ok(first.rows.every(row => !row.omitted));
  const last = await source.getPage('', 1, 200);
  assert.equal(last.rows.length, 3);
  assert.ok(last.rows.every(row => !row.omitted));
  assert.deepEqual([...first.rows, ...last.rows].map(row => JSON.parse(row.raw).id), Array.from({ length: 10 }, (_, index) => index));
});

test('cancels stale queries without poisoning subsequent requests', async t => {
  const filename = await temporary(t, Array.from({ length: 200 }, (_, id) => JSON.stringify({ id, text: '内容😀' })).join('\n'));
  const source = new FileSource(filename, { chunkSize: 16 });
  t.after(() => source.dispose());
  await source.getPage('', 0, 20);
  let checks = 0;
  await assert.rejects(source.getPage('missing', 0, 20, { cancelled: () => ++checks > 5 }), CancelledError);
  assert.equal((await source.getPage('内容😀', 0, 20)).matched, 200);
  source.dispose();
  await assert.rejects(source.getPage('', 0, 20), CancelledError);
});

test('empty and BOM-only files show no records', async t => {
  for (const text of ['', '\uFEFF', '\r\n \t\r\n']) {
    const filename = await temporary(t, text);
    const source = new FileSource(filename);
    const page = await source.getPage('', 0, 20);
    assert.equal(page.total, 0);
    assert.equal(page.pages, 1);
    assert.deepEqual(page.rows, []);
    source.dispose();
  }
});
