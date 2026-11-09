'use strict';

const vscode = require('vscode');
const { randomBytes } = require('node:crypto');
const { ViewerDocument } = require('./document');
const { CancelledError, FileChangedError } = require('./file-source');
const VIEW_TYPE = 'jsonlCompact.viewer';

function settings() {
  const config = vscode.workspace.getConfiguration('jsonlCompact');
  const integer = (key, fallback, min, max) => {
    const value = config.get(key, fallback);
    return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.trunc(value))) : fallback;
  };
  return {
    pageSize: integer('pageSize', 200, 20, 1000),
    rowHeight: integer('rowHeight', 24, 18, 36),
    previewFields: integer('previewFields', 3, 1, 10),
    showLineNumbers: config.get('showLineNumbers', true) !== false
  };
}

function html(webview, extensionUri) {
  const resource = name => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', name));
  const nonce = randomBytes(24).toString('hex');
  return `<!DOCTYPE html>
<html lang="zh-CN"><head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${resource('viewer.css')}">
  <title>JSONL Compact Viewer</title>
</head><body>
  <header class="toolbar">
    <span class="brand">JSONL <span>COMPACT</span></span>
    <input id="search" type="search" placeholder="筛选记录…" aria-label="筛选全部记录" title="按原始 JSON 文本筛选全部记录（不区分大小写）">
    <button id="collapse" title="折叠本页全部记录">全部折叠</button>
    <button id="expand" title="展开本页记录的第一层">展开一层</button>
    <button id="source" title="在文本编辑器中打开原文件">打开源码 ↗</button>
  </header>
  <div class="subbar"><span id="status" role="status" aria-live="polite">正在读取…</span><span class="hint">点击箭头展开 · 双击行号定位源码</span></div>
  <main id="records" aria-label="JSONL 记录" tabindex="-1"></main>
  <footer class="pager">
    <button id="previous" aria-label="上一页">← 上一页</button>
    <label>第 <input id="page" type="number" min="1" value="1" aria-label="跳转页码"> <span id="pages">/ 1 页</span></label>
    <button id="next" aria-label="下一页">下一页 →</button>
    <span id="notice" role="status" aria-live="polite">只读预览</span>
  </footer>
  <script nonce="${nonce}" src="${resource('model.js')}"></script>
  <script nonce="${nonce}" src="${resource('viewer.js')}"></script>
</body></html>`;
}

class CompactProvider {
  constructor(context) { this.context = context; }

  openCustomDocument(uri) { return new ViewerDocument(uri); }

  async resolveCustomEditor(document, panel) {
    const webview = panel.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
    };
    let disposed = false;
    let ready = false;
    let generation = 0;
    let page = 0;
    let query = '';
    let timer;
    const listeners = [];
    const post = message => !disposed && webview.postMessage(message);

    const update = async () => {
      if (!ready || disposed) return;
      const ticket = ++generation;
      const version = document.version;
      const config = settings();
      try {
        post({ type: 'loading', message: query ? '正在筛选记录…' : '正在读取记录…' });
        const payload = await document.getPage(query, page, config.pageSize, {
          cancelled: () => disposed || generation !== ticket || version !== document.version,
          onProgress: progress => {
            if (!disposed && ticket === generation && version === document.version) {
              const done = (progress.bytes / 1048576).toFixed(1);
              const size = (progress.size / 1048576).toFixed(1);
              post({ type: 'loading', message: `${progress.stage === 'search' ? '正在筛选' : '正在索引'} ${done} / ${size} MiB · ${progress.records.toLocaleString()} 条记录` });
            }
          }
        });
        page = payload.page;
        if (ticket !== generation || disposed) return;
        post({ type: 'page', ...payload, version, query, config });
      } catch (error) {
        if (error instanceof CancelledError || disposed || ticket !== generation) return;
        if (error instanceof FileChangedError) { document.invalidate(); return; }
        if (!disposed && ticket === generation) post({ type: 'error', message: String(error.message || error) });
      }
    };

    const reveal = async line => {
      const lineIndex = Number.isSafeInteger(line) ? Math.max(0, line - 1) : 0;
      await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default', {
        viewColumn: vscode.ViewColumn.Beside,
        preview: true,
        selection: new vscode.Range(lineIndex, 0, lineIndex, 0)
      });
    };

    listeners.push(webview.onDidReceiveMessage(async message => {
      if (!message || typeof message !== 'object') return;
      try {
        if (message.type === 'ready') {
          ready = true;
          page = Number.isSafeInteger(message.page) ? Math.max(0, message.page) : 0;
          query = typeof message.query === 'string' ? message.query.slice(0, 1000) : '';
          await update();
        } else if (message.type === 'page') {
          page = Number.isSafeInteger(message.page) ? Math.max(0, message.page) : 0;
          const nextQuery = typeof message.query === 'string' ? message.query.slice(0, 1000) : '';
          if (query !== nextQuery) { query = nextQuery; page = 0; }
          await update();
        } else if (message.type === 'source') {
          await reveal(message.line);
        } else if (message.type === 'copy' && Number.isSafeInteger(message.line) && message.line > 0) {
          await vscode.env.clipboard.writeText(await document.getLine(message.line));
          post({ type: 'notice', message: `已复制第 ${message.line} 行 JSON` });
        }
      } catch (error) {
        if (error instanceof FileChangedError) document.invalidate();
        if (error instanceof CancelledError) return;
        post({ type: 'notice', message: `操作失败：${error.message || error}` });
      }
    }));
    listeners.push(document.onDidChange(() => {
      generation++;
      clearTimeout(timer);
      timer = setTimeout(update, 160);
    }));
    listeners.push(vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('jsonlCompact')) update();
    }));
    panel.onDidDispose(() => {
      disposed = true;
      generation++;
      clearTimeout(timer);
      for (const listener of listeners) listener.dispose();
    });
    webview.html = html(webview, this.context.extensionUri);
  }
}

function activate(context) {
  context.subscriptions.push(vscode.window.registerCustomEditorProvider(VIEW_TYPE, new CompactProvider(context), {
    webviewOptions: { enableFindWidget: true },
    supportsMultipleEditorsPerDocument: true
  }));
  context.subscriptions.push(vscode.commands.registerCommand('jsonlCompact.open', async uri => {
    const target = uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor?.document.uri;
    if (target) await vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE);
    else vscode.window.showInformationMessage('请先打开一个 JSONL 文件，或在资源管理器中右键选择文件。');
  }));
}

module.exports = { activate };
