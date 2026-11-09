'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { indexRecords, makePage, MAX_RECORD_CHARS } = require('../src/records');

const doc = text => {
  const lines = text.split(/\r?\n/);
  return { lineCount: lines.length, lineAt: index => ({ text: lines[index] }) };
};

test('skips blank lines, strips initial BOM, and preserves physical source lines', async () => {
  const document = doc('\uFEFF{"序号":1}\r\n\r\n {"序号":2}\r\ninvalid\r\n');
  const index = await indexRecords(document, '');
  const page = makePage(document, index, 0, 20);
  assert.equal(page.total, 3);
  assert.deepEqual(page.rows.map(row => row.line), [1, 3, 4]);
  assert.equal(page.rows[0].raw, '{"序号":1}');
  assert.equal(page.rows[2].raw, 'invalid');
});

test('searches all records and clamps pagination', async () => {
  const document = doc(Array.from({ length: 65 }, (_, index) => JSON.stringify({ id: index, tag: index % 2 ? 'MATCH' : 'other' })).join('\n'));
  const index = await indexRecords(document, 'match');
  const page = makePage(document, index, 99, 20);
  assert.equal(page.total, 65);
  assert.equal(page.matched, 32);
  assert.equal(page.page, 1);
  assert.equal(page.pages, 2);
  assert.equal(page.rows.length, 12);
  assert.equal(page.rows[0].line, 42);
  const none = makePage(document, await indexRecords(document, 'missing'), 100, 20);
  assert.equal(none.pages, 1);
  assert.equal(none.rows.length, 0);
});

test('cancels stale searches and caps oversized records without losing line positions', async () => {
  assert.equal(await indexRecords(doc('1\n2\n3'), '', () => true), null);
  const document = doc('"' + 'x'.repeat(MAX_RECORD_CHARS) + '"\n{"ok":true}');
  const page = makePage(document, await indexRecords(document, ''), 0, 20);
  assert.match(page.rows[0].omitted, /2 Mi/);
  assert.equal(page.rows[0].raw.length, 300);
  assert.equal(page.rows[1].line, 2);
  assert.equal(page.rows[1].omitted, undefined);
});
