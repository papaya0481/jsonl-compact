'use strict';

const fs = require('node:fs/promises');
const { StringDecoder } = require('node:string_decoder');
const { MAX_RECORD_CHARS, MAX_PAGE_CHARS } = require('./records');
const READ_CHUNK = 1024 * 1024;
const MAX_RECORD_BYTES = MAX_RECORD_CHARS * 4;
const BLOCK_SIZE = 4096;

class CancelledError extends Error {
  constructor() { super('读取已取消'); this.name = 'CancelledError'; }
}
class FileChangedError extends Error {
  constructor() { super('文件已发生变化，正在重新建立索引。'); this.name = 'FileChangedError'; }
}

// Twenty bytes per non-empty record, allocated in blocks rather than JS objects.
class LineIndex {
  constructor() { this.blocks = []; this.length = 0; }
  push(start, end, line) {
    if (line > 0xffffffff) throw new Error('文件物理行数超过当前索引支持的范围。');
    const blockId = Math.floor(this.length / BLOCK_SIZE);
    const offset = this.length % BLOCK_SIZE;
    if (!this.blocks[blockId]) this.blocks.push({ starts: new Float64Array(BLOCK_SIZE), ends: new Float64Array(BLOCK_SIZE), lines: new Uint32Array(BLOCK_SIZE) });
    const block = this.blocks[blockId];
    block.starts[offset] = start;
    block.ends[offset] = end;
    block.lines[offset] = line;
    this.length++;
  }
  at(index) {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.length) throw new RangeError('记录索引超出范围');
    const block = this.blocks[Math.floor(index / BLOCK_SIZE)];
    const offset = index % BLOCK_SIZE;
    return { start: block.starts[offset], end: block.ends[offset], line: block.lines[offset] };
  }
  findLine(line) {
    let low = 0;
    let high = this.length - 1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const entry = this.at(middle);
      if (entry.line === line) return entry;
      if (entry.line < line) low = middle + 1;
      else high = middle - 1;
    }
    throw new RangeError('此行不是可复制的 JSONL 记录');
  }
}

class MatchIndex {
  constructor() { this.blocks = []; this.length = 0; }
  push(index) {
    const blockId = Math.floor(this.length / BLOCK_SIZE);
    if (!this.blocks[blockId]) this.blocks.push(new Float64Array(BLOCK_SIZE));
    this.blocks[blockId][this.length % BLOCK_SIZE] = index;
    this.length++;
  }
  at(index) { return this.blocks[Math.floor(index / BLOCK_SIZE)][index % BLOCK_SIZE]; }
}

const sameFile = (a, b) => a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.ino === b.ino;
const checkCancelled = cancelled => { if (cancelled()) throw new CancelledError(); };

async function scanFile(filename, { query = '', cancelled = () => false, onProgress = () => {}, chunkSize = READ_CHUNK, collectLines = true } = {}) {
  const handle = await fs.open(filename, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('此资源不是普通文件。');
    const index = collectLines ? new LineIndex() : null;
    const matches = query ? new MatchIndex() : null;
    const needle = query.toLocaleLowerCase();
    const buffer = Buffer.allocUnsafe(Math.max(4, chunkSize));
    let position = 0;
    let lineStart = 0;
    let line = 1;
    let count = 0;
    let hasContent = false;
    let tail = '';
    let matched = false;
    let decoder = needle ? new StringDecoder('utf8') : null;
    let lastByte;
    let previousProgress = 0;
    const search = text => {
      if (!needle || matched) return;
      const candidate = tail + text.toLocaleLowerCase();
      matched = candidate.includes(needle);
      tail = needle.length > 1 ? candidate.slice(-(needle.length - 1)) : '';
    };
    const finishLine = end => {
      if (decoder) search(decoder.end());
      if (hasContent) {
        if (index) index.push(lineStart, lastByte === 13 ? end - 1 : end, line);
        if (matches && matched) matches.push(count);
        count++;
      }
      line++;
      lineStart = end + 1;
      hasContent = false;
      tail = '';
      matched = false;
      decoder = needle ? new StringDecoder('utf8') : null;
      lastByte = undefined;
    };
    while (position < stat.size) {
      checkCancelled(cancelled);
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, stat.size - position), position);
      if (!bytesRead) throw new FileChangedError();
      let start = 0;
      // A BOM is metadata only at byte zero. Keep offsets valid for all other bytes.
      if (position === 0 && bytesRead >= 3 && buffer[0] === 239 && buffer[1] === 187 && buffer[2] === 191) {
        start = 3;
        lineStart = 3;
      }
      while (start < bytesRead) {
        const newline = buffer.indexOf(10, start);
        const end = newline >= 0 && newline < bytesRead ? newline : bytesRead;
        const part = buffer.subarray(start, end);
        if (!hasContent) {
          for (let offset = 0; offset < part.length; offset++) {
            if (part[offset] !== 32 && part[offset] !== 9 && part[offset] !== 13) { hasContent = true; break; }
          }
        }
        if (part.length) lastByte = part[part.length - 1];
        if (decoder && !matched) search(decoder.write(part));
        if (end < bytesRead) finishLine(position + end);
        start = end + 1;
      }
      position += bytesRead;
      const now = Date.now();
      if (now - previousProgress >= 150 || position === stat.size) {
        onProgress({ bytes: position, size: stat.size, records: count, stage: needle ? 'search' : 'index' });
        previousProgress = now;
      }
    }
    checkCancelled(cancelled);
    if (lineStart <= stat.size && hasContent) finishLine(stat.size);
    const after = await handle.stat();
    if (!sameFile(stat, after) || !sameFile(stat, await fs.stat(filename))) throw new FileChangedError();
    return { index, matches, stat, total: count };
  } finally {
    await handle.close();
  }
}

async function readRange(handle, start, length) {
  const buffer = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, start + offset);
    if (!bytesRead) throw new FileChangedError();
    offset += bytesRead;
  }
  return buffer.toString('utf8');
}

class FileSource {
  constructor(filename, options = {}) {
    this.filename = filename;
    this.options = options;
    this.disposed = false;
    this.snapshot = null;
    this.building = null;
    this.filter = null;
    this.pagination = null;
  }
  dispose() { this.disposed = true; this.snapshot = null; this.filter = null; this.pagination = null; }
  async ready(onProgress) {
    checkCancelled(() => this.disposed);
    if (this.snapshot) return this.snapshot;
    if (!this.building) {
      this.building = scanFile(this.filename, { ...this.options, cancelled: () => this.disposed, onProgress })
        .then(snapshot => { this.snapshot = snapshot; return snapshot; })
        .finally(() => { this.building = null; });
    }
    return this.building;
  }
  async openCurrent(snapshot) {
    const handle = await fs.open(this.filename, 'r');
    try {
      if (!sameFile(snapshot.stat, await handle.stat())) throw new FileChangedError();
      return handle;
    } catch (error) { await handle.close(); throw error; }
  }
  async getPage(query, requestedPage, pageSize, { cancelled = () => false, onProgress = () => {} } = {}) {
    const stop = () => this.disposed || cancelled();
    const snapshot = await this.ready(onProgress);
    checkCancelled(stop);
    let matches = null;
    if (query) {
      if (this.filter?.query === query) matches = this.filter.matches;
      else {
        const result = await scanFile(this.filename, { ...this.options, query, collectLines: false, cancelled: stop, onProgress });
        if (!sameFile(snapshot.stat, result.stat)) throw new FileChangedError();
        matches = result.matches;
        checkCancelled(stop);
        this.filter = { query, matches };
      }
    }
    const matched = matches ? matches.length : snapshot.total;
    // Page by both record count and byte budget. Large records must not make
    // otherwise-valid neighbors disappear behind a per-page transfer warning.
    if (!this.pagination || this.pagination.matches !== matches || this.pagination.pageSize !== pageSize) {
      const starts = new MatchIndex();
      starts.push(0);
      let used = 0;
      let count = 0;
      for (let record = 0; record < matched; record++) {
        checkCancelled(stop);
        const entry = snapshot.index.at(matches ? matches.at(record) : record);
        const length = entry.end - entry.start;
        const cost = length > MAX_RECORD_BYTES ? Math.min(length, 1200) : length;
        if (count && (count >= pageSize || used + cost > MAX_PAGE_CHARS)) { starts.push(record); used = 0; count = 0; }
        used += cost;
        count++;
        if (record % 32768 === 32767) await new Promise(resolve => setImmediate(resolve));
      }
      checkCancelled(stop);
      this.pagination = { matches, pageSize, starts };
    }
    const starts = this.pagination.starts;
    const pages = starts.length;
    const page = Math.max(0, Math.min(pages - 1, Math.trunc(requestedPage) || 0));
    const rows = [];
    const handle = await this.openCurrent(snapshot);
    let chars = 0;
    try {
      const first = starts.at(page);
      const end = page + 1 < pages ? starts.at(page + 1) : matched;
      for (let record = first; record < end; record++) {
        checkCancelled(stop);
        const entry = snapshot.index.at(matches ? matches.at(record) : record);
        const length = entry.end - entry.start;
        let omitted;
        if (length > MAX_RECORD_BYTES) omitted = '此条记录超过预览大小限制，请点击「源码」查看。';
        else if (chars >= MAX_PAGE_CHARS) omitted = '本页预览内容超过 8 Mi 字符，请点击「源码」查看此条，或调小每页记录数。';
        let raw = await readRange(handle, entry.start, omitted ? Math.min(length, 1200) : length);
        if (!omitted && raw.length > MAX_RECORD_CHARS) omitted = '此条记录超过 2 Mi 字符，请点击「源码」查看完整内容。';
        else if (!omitted && chars + raw.length > MAX_PAGE_CHARS) omitted = '本页预览内容超过 8 Mi 字符，请点击「源码」查看此条，或调小每页记录数。';
        if (omitted) raw = raw.slice(0, 300);
        else chars += raw.length;
        rows.push({ line: entry.line, raw, omitted });
      }
      if (!sameFile(snapshot.stat, await handle.stat()) || !sameFile(snapshot.stat, await fs.stat(this.filename))) throw new FileChangedError();
    } finally { await handle.close(); }
    return { total: snapshot.total, matched, page, pages, pageSize, rows, mode: 'stream', bytes: snapshot.stat.size };
  }
  async getLine(line) {
    const snapshot = await this.ready(() => {});
    const entry = snapshot.index.findLine(line);
    if (entry.end - entry.start > MAX_RECORD_BYTES) throw new Error('此条记录过大，无法复制，请使用源码入口。');
    const handle = await this.openCurrent(snapshot);
    try {
      const raw = await readRange(handle, entry.start, entry.end - entry.start);
      if (raw.length > MAX_RECORD_CHARS) throw new Error('此条记录超过 2 Mi 字符，无法复制，请使用源码入口。');
      if (!sameFile(snapshot.stat, await handle.stat()) || !sameFile(snapshot.stat, await fs.stat(this.filename))) throw new FileChangedError();
      return raw;
    } finally { await handle.close(); }
  }
}

module.exports = { FileSource, LineIndex, scanFile, CancelledError, FileChangedError, MAX_RECORD_BYTES };
