'use strict';
// Runs the shipped webview and extension message handlers in a real browser.
// Set PLAYWRIGHT_MODULE to an installed Playwright package; it is not a runtime dependency.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const artifacts = path.join(root, 'artifacts');
fs.mkdirSync(artifacts, { recursive: true });

let browserPage;
let provider;
let viewerDocument;
let receive;
let copied;
let sourcePosition;
let text = fs.readFileSync(path.join(root, 'examples/sample.jsonl'), 'utf8');
let lines = text.split(/\r?\n/);
const changeListeners = [];
const configurationListeners = [];
const config = {};
const disposable = () => ({ dispose() {} });
const document = { version: 1, isDirty: true, isClosed: false, uri: { scheme: 'file', fsPath: '/sample.jsonl', toString: () => 'file:///sample.jsonl' },
  get lineCount() { return lines.length; }, lineAt: index => ({ text: lines[index] }) };
const vscode = {
  Uri: { joinPath: (base, ...parts) => pathToFileURL(path.join(typeof base === 'string' ? base : base.fsPath, ...parts)) },
  EventEmitter: class EventEmitter {
    constructor() {
      this.listeners = [];
      this.event = listener => { this.listeners.push(listener); return { dispose: () => { this.listeners = this.listeners.filter(item => item !== listener); } }; };
    }
    fire() { for (const listener of this.listeners) listener(); }
    dispose() { this.listeners = []; }
  },
  RelativePattern: class RelativePattern {},
  ViewColumn: { Beside: 2 }, TextEditorRevealType: { InCenterIfOutsideViewport: 1 },
  Range: class Range { constructor(start) { this.start = start; } },
  window: {
    registerCustomEditorProvider(type, instance) { provider = instance; return disposable(); },
    async showTextDocument(doc, options) { sourcePosition = options.selection.start; return { revealRange() {} }; }
  },
  commands: {
    registerCommand: disposable,
    async executeCommand(command, uri, editor, options) {
      assert.equal(command, 'vscode.openWith');
      assert.equal(editor, 'default');
      sourcePosition = options.selection.start;
    }
  },
  workspace: {
    textDocuments: [document],
    getConfiguration: () => ({ get: (key, fallback) => config[key] ?? fallback }),
    onDidChangeTextDocument: listener => { changeListeners.push(listener); return disposable(); },
    onDidCloseTextDocument: disposable,
    createFileSystemWatcher: () => ({ onDidChange: disposable, onDidCreate: disposable, onDidDelete: disposable, dispose() {} }),
    onDidChangeConfiguration: listener => { configurationListeners.push(listener); return disposable(); },
    fs: { stat: async () => ({ size: Buffer.byteLength(text) }) }
  },
  env: { clipboard: { async writeText(value) { copied = value; } } }
};
const context = { extensionUri: root, subscriptions: [] };
const documentModule = { exports: {} };
vm.runInNewContext(fs.readFileSync(path.join(root, 'src/document.js'), 'utf8'), {
  module: documentModule,
  require: name => name === 'vscode' ? vscode : require(path.join(root, 'src', name)),
  Buffer, console
}, { filename: 'document.js' });
const extensionModule = { exports: {} };
vm.runInNewContext(fs.readFileSync(path.join(root, 'src/extension.js'), 'utf8'), {
  module: extensionModule,
  require: name => name === 'vscode' ? vscode : name === './document' ? documentModule.exports : name.startsWith('./') ? require(path.join(root, 'src', name)) : require(name),
  setTimeout, clearTimeout, console
}, { filename: 'extension.js' });
extensionModule.exports.activate(context);
const webview = {
  cspSource: 'file:', asWebviewUri: uri => uri.toString(),
  onDidReceiveMessage: listener => { receive = listener; return disposable(); },
  postMessage: message => browserPage.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), message)
};
const panel = { webview, onDidDispose: disposable };

async function fixture(nextText, stream = false) {
  text = nextText;
  lines = text.split(/\r?\n/);
  document.isDirty = !stream;
  if (stream) {
    document.uri.fsPath = path.join(artifacts, 'streaming-fixture.jsonl');
    fs.writeFileSync(document.uri.fsPath, text);
  }
  document.version++;
  for (const listener of changeListeners) listener({ document });
  await browserPage.waitForFunction(version => window.__viewerState?.version === version, viewerDocument.version);
}

async function main() {
  viewerDocument = provider.openCustomDocument(document.uri);
  await provider.resolveCustomEditor(viewerDocument, panel);
  const htmlPath = path.join(artifacts, 'test-webview.html');
  fs.writeFileSync(htmlPath, webview.html);
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true, args: ['--no-sandbox']
  });
  const errors = [];
  try {
    browserPage = await browser.newPage({ viewport: { width: 1240, height: 780 }, deviceScaleFactor: 1 });
    browserPage.setDefaultTimeout(10000);
    browserPage.on('pageerror', error => errors.push(error.message));
    await browserPage.exposeFunction('sendToHost', message => receive(message));
    await browserPage.addInitScript(() => {
      window.acquireVsCodeApi = () => ({
        getState: () => undefined,
        setState: value => { window.__viewerState = value; },
        postMessage: message => window.sendToHost(message)
      });
    });
    await browserPage.goto(pathToFileURL(htmlPath).toString());
    await browserPage.waitForFunction(() => document.querySelectorAll('.record').length === 10);
    assert.equal(await browserPage.locator('.root-node[open]').count(), 0, 'Records start collapsed');
    const geometry = await browserPage.locator('.record').evaluateAll(rows => rows.map(row => ({ top: row.getBoundingClientRect().top, height: row.getBoundingClientRect().height })));
    assert.equal(geometry[0].height, 24, 'Default row height is 24px');
    assert.equal(geometry[1].top - geometry[0].top, 24, 'Collapsed records have no vertical gaps');
    await browserPage.screenshot({ path: path.join(artifacts, 'collapsed-dark.png') });

    const first = browserPage.locator('.record[data-line="1"]');
    await first.locator(':scope > details > summary > .chevron').click();
    await first.locator('summary:has(> .json-key:text-is("输入"))').click();
    await browserPage.waitForFunction(() => document.querySelectorAll('.root-node[open]').length === 1);
    assert.equal(await browserPage.locator('.root-node[open]').count(), 1, 'Opening one row leaves neighboring rows collapsed');
    await first.locator('summary:has(> .json-key:text-is("上下文"))').click();
    await first.locator('summary:has(> .json-key:text-is("0"))').click();
    await browserPage.waitForFunction(() => document.querySelector('.record[data-line="1"]').innerText.includes('每行先折叠，需要时查看层级'));
    assert.match(await first.innerText(), /每行先折叠，需要时查看层级/);
    const third = browserPage.locator('.record[data-line="3"]');
    await third.locator(':scope > details > summary > .chevron').click();
    await third.locator('summary:has(> .json-key:text-is("用户"))').click();
    await browserPage.waitForFunction(() => document.querySelector('.record[data-line="3"]').innerText.includes('9223372036854775807'));
    assert.match(await third.innerText(), /9223372036854775807/, 'Unsafe integer is never rounded');
    await browserPage.screenshot({ path: path.join(artifacts, 'expanded-dark.png') });

    // Exercise the same light-theme class and CSS variables provided by VS Code.
    await browserPage.evaluate(() => {
      document.body.classList.add('vscode-light');
      const vars = {
        '--vscode-editor-background': '#fafafa', '--vscode-editor-foreground': '#252526',
        '--vscode-descriptionForeground': '#757575', '--vscode-panel-border': '#e3e3e3',
        '--vscode-button-secondaryBackground': '#eeeeee', '--vscode-button-secondaryHoverBackground': '#e2e2e2',
        '--vscode-input-background': '#ffffff', '--vscode-input-border': '#d7d7d7',
        '--vscode-list-hoverBackground': '#00000005', '--vscode-editorLineNumber-foreground': '#9d9d9d'
      };
      for (const [key, value] of Object.entries(vars)) document.documentElement.style.setProperty(key, value);
    });
    await browserPage.getByRole('button', { name: '全部折叠', exact: true }).click();
    await browserPage.waitForFunction(() => document.querySelectorAll('.root-node[open]').length === 0);
    await browserPage.screenshot({ path: path.join(artifacts, 'collapsed-light.png') });
    await first.locator(':scope > details > summary > .chevron').click();
    await first.locator('summary:has(> .json-key:text-is("输入"))').click();
    await browserPage.screenshot({ path: path.join(artifacts, 'expanded-light.png') });
    fs.copyFileSync(path.join(artifacts, 'expanded-light.png'), path.join(root, 'media/preview.png'));

    const malicious = '<img src=x onerror="globalThis.__injected=true">';
    const firstRaw = JSON.stringify({ html: malicious, long: '完整文本'.repeat(30), nested: { good: true } });
    await fixture([firstRaw, '{"broken":}', '', 'true', JSON.stringify(Array.from({ length: 250 }, (_, index) => index)), '9223372036854775807'].join('\n'));
    assert.equal(await browserPage.locator('.record').count(), 5);
    assert.equal(await browserPage.locator('.has-error').count(), 1);
    assert.equal(await browserPage.locator('#records img, #records script').count(), 0, 'Data never becomes executable HTML');
    assert.equal(await browserPage.evaluate(() => globalThis.__injected), undefined);
    const htmlRow = browserPage.locator('.record[data-line="1"]');
    await htmlRow.locator(':scope > details > summary > .chevron').click();
    await htmlRow.locator('summary:has(> .json-key:text-is("long"))').click();
    assert.equal(await htmlRow.locator('.full-string').innerText(), '完整文本'.repeat(30));
    await htmlRow.hover();
    await htmlRow.getByRole('button', { name: '复制第 1 行原始 JSON', exact: true }).click();
    assert.equal(copied, firstRaw, 'Copy preserves raw source');
    await htmlRow.getByRole('button', { name: '在源码中定位第 1 行', exact: true }).click();
    assert.equal(sourcePosition, 0, 'Source action uses physical line');
    const array = browserPage.locator('.record[data-line="5"]');
    await array.locator(':scope > details > summary > .chevron').click();
    await browserPage.waitForFunction(() => document.querySelector('.record[data-line="5"] .children')?.children.length === 101);
    assert.equal(await array.locator('.children > .json-node').count(), 100, 'Wide arrays mount only the first batch');
    await array.getByRole('button', { name: '显示接下来的 100 个字段或数组项' }).click();
    assert.equal(await array.locator('.children > .json-node').count(), 200);

    const fullText = '第一段：保留中文、引号 " 和反斜杠 \\。\n' + '很长的内容😀'.repeat(12000) + '\n最后一段：全文结束。';
    const clippedText = 'abcdefghijklmnopqrstuvwxyz'.repeat(3);
    const scalarText = '根级字符串：'.repeat(150) + '根级全文结束';
    await fixture([
      JSON.stringify({ text: fullText, neighbor: '邻近字段', nested: { content: fullText }, items: [fullText] }),
      JSON.stringify({ narrow: clippedText }),
      JSON.stringify(scalarText)
    ].join('\n'));
    const textRow = browserPage.locator('.record[data-line="1"]');
    const inlineString = textRow.locator(':scope > .root-node > summary .string-preview').first();
    assert.match(await inlineString.innerText(), /…/);
    await inlineString.click();
    const textNode = textRow.locator('.json-node[data-path="1/0"]');
    assert.equal(await textRow.locator(':scope > details').getAttribute('open'), '', 'Clicking a string summary expands its record');
    assert.equal(await textNode.locator(':scope > .full-string').textContent(), fullText, 'The complete original string is present');
    assert.equal(await browserPage.locator('.record[data-line="2"] > details[open]').count(), 0, 'Other records stay collapsed');
    await textNode.getByRole('button', { name: '收起完整字符串', exact: true }).click();
    assert.equal(await textNode.getAttribute('open'), null);
    await textNode.getByRole('button', { name: '展开完整字符串', exact: true }).click();
    assert.equal(await textNode.locator(':scope > .full-string').textContent(), fullText);
    await textNode.getByRole('button', { name: '收起完整字符串', exact: true }).click();
    await textNode.locator(':scope > summary').focus();
    await browserPage.keyboard.press('Enter');
    await browserPage.waitForFunction(() => document.querySelector('[data-path="1/0"]').open);

    const nestedPreview = textRow.locator('[data-path="1/2"] > summary .string-preview').first();
    await nestedPreview.click();
    assert.equal(await textRow.locator('[data-path="1/2/0"] > .full-string').textContent(), fullText);
    await textRow.locator('[data-path="1/3"] > summary .string-preview').first().click();
    assert.equal(await textRow.locator('[data-path="1/3/0"] > .full-string').textContent(), fullText);

    await browserPage.setViewportSize({ width: 480, height: 700 });
    const narrowRow = browserPage.locator('.record[data-line="2"]');
    await narrowRow.locator(':scope > .root-node > summary > .chevron').click();
    const narrowNode = narrowRow.locator('[data-path="2/0"]');
    const isClipped = await narrowNode.locator(':scope > summary > .node-preview').evaluate(node => node.scrollWidth > node.clientWidth);
    assert.equal(isClipped, true, 'This value is clipped by viewport width despite being shorter than 90 characters');
    await narrowNode.getByRole('button', { name: '展开完整字符串', exact: true }).click();
    assert.equal(await narrowNode.locator(':scope > .full-string').textContent(), clippedText);
    assert.equal(await narrowNode.locator(':scope > .full-string').evaluate(node => node.scrollWidth <= node.clientWidth), true, 'The expanded text wraps within a narrow pane');

    const scalar = browserPage.locator('.record[data-line="3"] > .root-node');
    await scalar.getByRole('button', { name: '展开完整字符串', exact: true }).click();
    assert.equal(await scalar.locator(':scope > .full-string').textContent(), scalarText);
    await browserPage.setViewportSize({ width: 1240, height: 780 });
    await browserPage.getByRole('button', { name: '全部折叠', exact: true }).click();
    await inlineString.click();
    await browserPage.screenshot({ path: path.join(artifacts, 'expanded-full-string-light.png') });

    await fixture(Array.from({ length: 450 }, (_, index) => JSON.stringify({ id: index + 1, tag: index % 2 ? 'needle' : 'other' })).join('\n'));
    assert.equal(await browserPage.locator('.record').count(), 200);
    await browserPage.getByRole('button', { name: '下一页', exact: true }).click();
    await browserPage.waitForFunction(() => document.querySelector('.record')?.dataset.line === '201');
    await browserPage.getByRole('searchbox').fill('NEEDLE');
    await browserPage.waitForFunction(() => document.getElementById('status').textContent.includes('匹配 225'));
    assert.equal(await browserPage.locator('.record').first().getAttribute('data-line'), '2');
    await browserPage.getByRole('button', { name: '下一页', exact: true }).click();
    await browserPage.waitForFunction(() => document.querySelectorAll('.record').length === 25);
    assert.equal(await browserPage.locator('.record').first().getAttribute('data-line'), '402');
    await browserPage.getByRole('searchbox').fill('no matches at all');
    await browserPage.waitForFunction(() => document.querySelector('.empty-state')?.textContent === '没有匹配的记录');
    await browserPage.getByRole('searchbox').fill('');
    await browserPage.waitForFunction(() => document.querySelectorAll('.record').length === 200);
    config.rowHeight = 20;
    for (const listener of configurationListeners) listener({ affectsConfiguration: () => true });
    await browserPage.waitForFunction(() => document.querySelector('.record').getBoundingClientRect().height === 20);
    await browserPage.setViewportSize({ width: 600, height: 700 });
    assert.equal(await browserPage.evaluate(() => document.body.scrollWidth <= window.innerWidth), true, 'Works in a narrow editor group');
    await fixture(Array.from({ length: 450 }, (_, id) => JSON.stringify({ id, source: 'streaming file' })).join('\n'), true);
    assert.equal(viewerDocument.source.constructor.name, 'FileSource', 'Saved files use the streaming backend');
    assert.equal(await browserPage.locator('.record').count(), 200);
    assert.match(await browserPage.locator('#notice').innerText(), /流式读取/);
    await browserPage.getByRole('button', { name: '下一页', exact: true }).click();
    await browserPage.waitForFunction(() => document.querySelector('.record')?.dataset.line === '201');
    await browserPage.getByRole('searchbox').fill('streaming FILE');
    await browserPage.waitForFunction(() => document.getElementById('status').textContent.includes('匹配 450'));
    assert.equal(await browserPage.locator('.record').first().getAttribute('data-line'), '1');
    assert.deepEqual(errors, [], 'No browser errors');
    fs.writeFileSync(path.join(artifacts, 'ui-test-result.json'), JSON.stringify({ passed: true, checks: [
      '24px compact rows', 'independent inline expansion', 'nested objects and arrays', '64-bit number fidelity',
      'light and dark themes', 'literal HTML data', 'full string expansion from summaries', 'narrow clipped strings', 'string expand/collapse buttons', 'root and nested string values', 'keyboard string expansion', 'copy original record', 'source navigation',
      'lazy batches', 'pagination', 'whole-document filtering', 'invalid line isolation', 'live updates', 'config updates', 'narrow panes', 'streaming file UI'
    ] }, null, 2));
    console.log('PASS: real-browser webview tests, light/dark screenshots, filtering, pagination, source actions and live updates');
  } catch (error) {
    if (browserPage) {
      await browserPage.screenshot({ path: path.join(artifacts, 'ui-failure.png') });
      fs.writeFileSync(path.join(artifacts, 'ui-failure.html'), await browserPage.content());
    }
    throw error;
  } finally {
    viewerDocument.dispose();
    await browser.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
