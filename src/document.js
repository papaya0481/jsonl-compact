'use strict';

const vscode = require('vscode');
const { FileSource, CancelledError } = require('./file-source');
const { sourceLine, indexRecords, makePage, MAX_RECORD_CHARS } = require('./records');
const MAX_VIRTUAL_BYTES = 32 * 1024 * 1024;

class TextSource {
  constructor(document) { this.document = document; this.cache = null; this.disposed = false; }
  dispose() { this.disposed = true; this.cache = null; }
  async getPage(query, page, pageSize, { cancelled = () => false } = {}) {
    const stop = () => this.disposed || cancelled();
    if (!this.cache || this.cache.query !== query) {
      const index = await indexRecords(this.document, query, stop);
      if (!index || stop()) throw new CancelledError();
      this.cache = { query, index };
    }
    if (stop()) throw new CancelledError();
    return { ...makePage(this.document, this.cache.index, page, pageSize), mode: 'text' };
  }
  async getLine(line) {
    if (line <= 0 || line > this.document.lineCount) throw new RangeError('源码行号超出范围');
    const raw = sourceLine(this.document, line - 1);
    if (raw.length > MAX_RECORD_CHARS) throw new Error('此条记录超过 2 Mi 字符，无法复制，请使用源码入口。');
    return raw;
  }
}

class ViewerDocument {
  constructor(uri) {
    this.uri = uri;
    this.version = 1;
    this.disposed = false;
    this.source = null;
    this.pending = null;
    this.changed = new vscode.EventEmitter();
    this.onDidChange = this.changed.event;
    this.listeners = [];
    const same = other => other.toString() === uri.toString();
    this.listeners.push(vscode.workspace.onDidChangeTextDocument(event => { if (same(event.document.uri)) this.invalidate(); }));
    this.listeners.push(vscode.workspace.onDidCloseTextDocument(document => { if (same(document.uri)) this.invalidate(); }));
    if (uri.scheme !== 'untitled') {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.joinPath(uri, '..'), '*'));
      for (const event of [watcher.onDidChange, watcher.onDidCreate, watcher.onDidDelete]) {
        this.listeners.push(event(changed => { if (same(changed)) this.invalidate(); }));
      }
      this.listeners.push(watcher);
    }
  }
  invalidate() {
    if (this.disposed) return;
    this.version++;
    this.source?.dispose();
    this.source = null;
    this.pending = null;
    this.changed.fire();
  }
  async getSource() {
    if (this.disposed) throw new CancelledError();
    if (this.source) return this.source;
    if (this.pending) return this.pending;
    const version = this.version;
    const create = async () => {
      const text = vscode.workspace.textDocuments.find(document => document.uri.toString() === this.uri.toString() && !document.isClosed);
      if (text?.isDirty || (text && this.uri.scheme === 'untitled')) return new TextSource(text);
      // On a remote workspace extension host, file URIs refer to that host's disk.
      if (this.uri.scheme === 'file') return new FileSource(this.uri.fsPath);
      if (text) return new TextSource(text);
      const stat = await vscode.workspace.fs.stat(this.uri);
      if (stat.size > MAX_VIRTUAL_BYTES) throw new Error('此虚拟文件系统不提供流式读取，当前最多支持 32 MiB。请下载文件到本地，或在对应的远程工作区中打开。');
      const bytes = await vscode.workspace.fs.readFile(this.uri);
      if (bytes.byteLength > MAX_VIRTUAL_BYTES) throw new Error('此虚拟文件超过 32 MiB，无法预览。');
      const lines = Buffer.from(bytes).toString('utf8').split(/\r?\n/);
      return new TextSource({ lineCount: lines.length, lineAt: index => ({ text: lines[index] }) });
    };
    this.pending = create().then(source => {
      if (this.disposed || version !== this.version) { source.dispose(); throw new CancelledError(); }
      this.source = source;
      return source;
    }).finally(() => { if (version === this.version) this.pending = null; });
    return this.pending;
  }
  async getPage(query, page, pageSize, options) {
    const source = await this.getSource();
    return source.getPage(query, page, pageSize, options);
  }
  async getLine(line) { return (await this.getSource()).getLine(line); }
  dispose() {
    this.disposed = true;
    this.source?.dispose();
    this.source = null;
    for (const listener of this.listeners) listener.dispose();
    this.changed.dispose();
  }
}

module.exports = { ViewerDocument, TextSource, MAX_VIRTUAL_BYTES };
