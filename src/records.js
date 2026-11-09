'use strict';

// Bound the data crossing into the webview. Source is always available in VS Code.
const MAX_RECORD_CHARS = 2 * 1024 * 1024;
const MAX_PAGE_CHARS = 8 * 1024 * 1024;
const pause = () => new Promise(resolve => setImmediate(resolve));

function sourceLine(document, index) {
  const raw = document.lineAt(index).text;
  return index === 0 ? raw.replace(/^\uFEFF/, '') : raw;
}

async function indexRecords(document, query, cancelled = () => false) {
  const matches = [];
  const needle = query.toLocaleLowerCase();
  let total = 0;
  for (let index = 0; index < document.lineCount; index++) {
    if (cancelled()) return null;
    const raw = sourceLine(document, index);
    if (raw.trim()) {
      total++;
      if (!needle || raw.toLocaleLowerCase().includes(needle)) matches.push(index);
    }
    if (index % 2000 === 1999) await pause();
  }
  return { total, matches };
}

function makePage(document, index, requestedPage, pageSize) {
  const pages = Math.max(1, Math.ceil(index.matches.length / pageSize));
  const page = Math.max(0, Math.min(pages - 1, Math.trunc(requestedPage) || 0));
  const rows = [];
  let chars = 0;
  for (const lineIndex of index.matches.slice(page * pageSize, (page + 1) * pageSize)) {
    const raw = sourceLine(document, lineIndex);
    let omitted;
    if (raw.length > MAX_RECORD_CHARS) omitted = '此条记录超过 2 Mi 字符，请点击「源码」查看完整内容。';
    else if (chars + raw.length > MAX_PAGE_CHARS) omitted = '本页预览内容超过 8 Mi 字符，请点击「源码」查看此条，或调小每页记录数。';
    if (!omitted) chars += raw.length;
    rows.push({ line: lineIndex + 1, raw: omitted ? raw.slice(0, 300) : raw, omitted });
  }
  return { total: index.total, matched: index.matches.length, page, pages, pageSize, rows };
}

module.exports = { sourceLine, indexRecords, makePage, MAX_RECORD_CHARS, MAX_PAGE_CHARS };
