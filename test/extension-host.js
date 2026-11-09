'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

exports.run = async function () {
  const extension = vscode.extensions.getExtension('local-tools.jsonl-compact-viewer');
  assert.ok(extension, 'Packaged extension is discoverable');
  await extension.activate();
  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes('jsonlCompact.open'), 'Viewer command is registered');
  const sample = vscode.Uri.file(path.resolve(__dirname, '../examples/sample.jsonl'));
  await vscode.commands.executeCommand('vscode.open', sample);
  await new Promise(resolve => setTimeout(resolve, 1500));
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  assert.ok(tab.input instanceof vscode.TabInputCustom, 'JSONL defaults to the real custom editor');
  assert.equal(tab.input.viewType, 'jsonlCompact.viewer');
  const document = await vscode.workspace.openTextDocument(sample);
  assert.equal(document.isDirty, false, 'Read-only preview leaves source untouched');
  const edit = new vscode.WorkspaceEdit();
  edit.insert(sample, new vscode.Position(0, 0), '\n');
  await vscode.workspace.applyEdit(edit);
  assert.equal(document.isDirty, true);
  await vscode.window.showTextDocument(document, { preview: true });
  await vscode.commands.executeCommand('workbench.action.files.revert');
  assert.equal(document.isDirty, false, 'The integration test restores its unsaved edit');
  const result = { passed: true, vscode: vscode.version, viewType: tab.input.viewType, version: extension.packageJSON.version };
  if (process.env.JSONL_LARGE_FILE) {
    const uri = vscode.Uri.file(process.env.JSONL_LARGE_FILE);
    await vscode.commands.executeCommand('vscode.open', uri);
    await new Promise(resolve => setTimeout(resolve, 2000));
    const largeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
    assert.ok(largeTab.input instanceof vscode.TabInputCustom);
    assert.equal(largeTab.input.viewType, 'jsonlCompact.viewer');
    assert.equal(vscode.workspace.textDocuments.some(document => document.uri.toString() === uri.toString()), false,
      'A large JSONL file opens independently of the VS Code text-model size limit');
    const { FileSource } = require(path.join(extension.extensionPath, 'src/file-source.js'));
    const source = new FileSource(uri.fsPath);
    try {
      const first = await source.getPage('', 0, 200);
      const last = await source.getPage('', first.pages - 1, 200);
      assert.ok(first.rows.length && last.rows.length);
      const row = first.rows.find(row => !row.omitted);
      if (row) assert.equal(await source.getLine(row.line), row.raw);
      result.largeFile = { bytes: first.bytes, records: first.total, pages: first.pages, firstPageRows: first.rows.length, lastPageRows: last.rows.length };
    } finally { source.dispose(); }
  }
  // This test does not save any source changes or record contents.
  fs.writeFileSync(process.env.JSONL_TEST_RESULT, JSON.stringify(result));
};
