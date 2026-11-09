(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const model = globalThis.JsonlModel;
  const byId = id => document.getElementById(id);
  const records = byId('records');
  const saved = vscode.getState() || {};
  let current = { page: saved.page || 0, pages: 1, query: saved.query || '', config: { previewFields: 3 } };
  let expanded = new Set(Array.isArray(saved.expanded) ? saved.expanded.slice(0, 2000) : []);
  let version = saved.version;
  let searchTimer;
  let saveTimer;
  let restoring = false;
  let previousQuery = current.query;
  const fragmentSize = 100;

  function element(tag, className, text) {
    const result = document.createElement(tag);
    if (className) result.className = className;
    if (text !== undefined) result.textContent = text;
    return result;
  }
  function persist() {
    vscode.setState({ page: current.page, query: current.query, version, expanded: [...expanded].slice(-2000), scroll: records.scrollTop });
  }
  function request(page) {
    records.setAttribute('aria-busy', 'true');
    vscode.postMessage({ type: 'page', page, query: byId('search').value });
  }
  function button(label, title, handler) {
    const result = element('button', 'row-action', label);
    result.title = title;
    result.setAttribute('aria-label', title);
    result.addEventListener('click', event => { event.stopPropagation(); handler(event); });
    return result;
  }
  function coloredSummary(node, openString) {
    const output = element('span', 'node-preview');
    if (!model.isContainer(node)) {
      output.append(element('span', 'value-' + node.type, model.summary(node)));
      return output;
    }
    const array = node.type === 'array';
    output.append(element('span', 'punctuation', array ? '[' : '{'));
    const entries = node.children.slice(0, current.config.previewFields);
    entries.forEach((entry, index) => {
      if (index) output.append(element('span', 'punctuation', ', '));
      if (!array) {
        output.append(element('span', 'json-key', model.keyText(entry.key)));
        output.append(element('span', 'punctuation', ': '));
      }
      const value = element('span', 'value-' + entry.node.type, model.summary(entry.node, current.config.previewFields, 1));
      if (entry.node.type === 'string') {
        value.classList.add('string-preview');
        value.tabIndex = 0;
        value.setAttribute('role', 'button');
        value.title = '点击展开此字符串全文';
        value.setAttribute('aria-label', '展开此字符串全文');
        value.addEventListener('click', event => {
          event.preventDefault();
          event.stopPropagation();
          openString(index);
        });
        value.addEventListener('keydown', event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            event.stopPropagation();
            value.click();
          }
        });
      }
      output.append(value);
    });
    if (node.children.length > entries.length) output.append(element('span', 'punctuation', ', …'));
    output.append(element('span', 'punctuation', array ? ']' : '}'));
    return output;
  }

  function renderNode(node, key, path, rootLine) {
    const container = model.isContainer(node) && node.children.length > 0;
    // Even a short string can be ellipsized by the available viewport width.
    // Keep every string inspectable instead of guessing from its character count.
    const isString = node.type === 'string';
    const expandable = container || isString;
    const wrapper = element(expandable ? 'details' : 'div', 'json-node' + (rootLine ? ' root-node' : ''));
    wrapper.dataset.path = path;
    const header = element(expandable ? 'summary' : 'div', 'node-header');
    if (!expandable) header.tabIndex = 0;
    header.append(element('span', 'chevron' + (expandable ? '' : ' empty')));
    if (key !== null) {
      header.append(element('span', 'json-key', model.keyText(key)));
      header.append(element('span', 'punctuation', ': '));
    }
    const renderedChildren = new Map();
    const preview = coloredSummary(node, index => {
      mount();
      wrapper.open = true;
      const child = renderedChildren.get(index);
      const summary = child?.querySelector(':scope > summary');
      if (summary && !child.open) summary.click();
      summary?.focus();
    });
    header.append(preview);
    if (container) {
      header.append(element('span', 'expanded-label punctuation', (node.type === 'array' ? '[' : '{')));
      header.append(element('span', 'count', `${node.children.length} ${node.type === 'array' ? '项' : '字段'}`));
    }
    let stringToggle;
    function syncStringToggle() {
      if (!stringToggle) return;
      stringToggle.textContent = wrapper.open ? '收起全文' : '展开全文';
      const label = wrapper.open ? '收起完整字符串' : '展开完整字符串';
      stringToggle.title = label;
      stringToggle.setAttribute('aria-label', label);
      stringToggle.setAttribute('aria-expanded', String(wrapper.open));
    }
    if (isString) {
      header.append(element('span', 'count', `${node.value.length} 字符`));
      stringToggle = button('展开全文', '展开完整字符串', event => {
        event.preventDefault();
        if (!wrapper.open) mount();
        wrapper.open = !wrapper.open;
        syncStringToggle();
      });
      stringToggle.classList.add('string-toggle');
      syncStringToggle();
      header.append(stringToggle);
    }
    wrapper.append(header);
    let mounted = false;
    function mount() {
      if (mounted || !expandable) return;
      mounted = true;
      if (isString) {
        wrapper.append(element('pre', 'full-string value-string', node.value));
      } else {
        const children = element('div', 'children');
        let position = 0;
        const more = button('继续显示…', '显示接下来的 100 个字段或数组项', appendBatch);
        more.classList.add('load-more');
        function appendBatch() {
          more.remove();
          const fragment = document.createDocumentFragment();
          const end = Math.min(position + fragmentSize, node.children.length);
          for (; position < end; position++) {
            const entry = node.children[position];
            const child = renderNode(entry.node, entry.key, path + '/' + position);
            renderedChildren.set(position, child);
            fragment.append(child);
          }
          children.append(fragment);
          if (position < node.children.length) {
            more.textContent = `继续显示 ${Math.min(fragmentSize, node.children.length - position)} 项（还有 ${node.children.length - position} 项）`;
            children.append(more);
          }
        }
        appendBatch();
        wrapper.append(children);
        wrapper.append(element('div', 'closing punctuation', node.type === 'array' ? ']' : '}'));
      }
    }
    if (expandable) {
      // Populate before the browser opens the disclosure, avoiding an empty frame.
      header.addEventListener('click', () => { if (!wrapper.open) mount(); });
      wrapper.addEventListener('toggle', event => {
        if (event.target !== wrapper) return;
        if (wrapper.open) { mount(); expanded.add(path); }
        else expanded.delete(path);
        syncStringToggle();
        if (!restoring) persist();
      });
      if (expanded.has(path)) { mount(); wrapper.open = true; syncStringToggle(); }
    }
    if (rootLine) {
      const actions = element('span', 'row-actions');
      actions.append(button('复制', `复制第 ${rootLine} 行原始 JSON`, () => vscode.postMessage({ type: 'copy', line: rootLine })));
      actions.append(button('源码 ↗', `在源码中定位第 ${rootLine} 行`, () => vscode.postMessage({ type: 'source', line: rootLine })));
      header.append(actions);
    }
    return wrapper;
  }

  function renderRow(row) {
    const record = element('section', 'record');
    record.dataset.line = row.line;
    const gutter = button(String(row.line), `原文件第 ${row.line} 行（双击定位）`, () => {});
    gutter.className = 'line-number';
    gutter.addEventListener('dblclick', () => vscode.postMessage({ type: 'source', line: row.line }));
    record.append(gutter);
    try {
      if (row.omitted) throw new Error(row.omitted);
      record.append(renderNode(model.parse(row.raw), null, String(row.line), row.line));
    } catch (error) {
      const details = element('details', 'invalid-record');
      const summary = element('summary', 'node-header');
      summary.append(element('span', 'chevron'));
      summary.append(element('span', 'invalid-text', row.omitted ? '记录未预览' : '无效 JSON'));
      summary.append(element('span', 'error-message', error.message));
      summary.append(button('源码 ↗', `在源码中定位第 ${row.line} 行`, () => vscode.postMessage({ type: 'source', line: row.line })));
      details.append(summary, element('pre', 'invalid-raw', row.raw));
      record.append(details);
      record.classList.add('has-error');
    }
    return record;
  }

  function renderPage(message) {
    const oldScroll = current.page === message.page && previousQuery === message.query ? records.scrollTop : 0;
    if (version !== undefined && version !== message.version) expanded.clear();
    const firstRender = version === undefined || !records.children.length;
    current = message;
    version = message.version;
    previousQuery = message.query;
    byId('search').value = message.query;
    // Integer values only. VS Code supplies the nonce-protected external CSS.
    document.documentElement.style.setProperty('--row-height', message.config.rowHeight + 'px');
    records.classList.toggle('hide-line-numbers', !message.config.showLineNumbers);
    restoring = true;
    records.replaceChildren();
    const fragment = document.createDocumentFragment();
    for (const row of message.rows) fragment.append(renderRow(row));
    if (!message.rows.length) fragment.append(element('div', 'empty-state', message.total ? '没有匹配的记录' : '文件中没有非空 JSONL 记录'));
    records.append(fragment);
    restoring = false;
    records.setAttribute('aria-busy', 'false');
    const errors = records.querySelectorAll('.has-error').length;
    byId('status').textContent = `${message.total.toLocaleString()} 条记录` + (message.query ? ` · 匹配 ${message.matched.toLocaleString()} 条` : '') + ` · 本页 ${message.rows.length} 条` + (errors ? ` · ${errors} 条异常` : '');
    byId('page').value = message.page + 1;
    byId('page').max = message.pages;
    byId('pages').textContent = `/ ${message.pages.toLocaleString()} 页`;
    byId('previous').disabled = message.page === 0;
    byId('next').disabled = message.page >= message.pages - 1;
    byId('notice').textContent = message.mode === 'stream' ? `流式读取 · ${(message.bytes / 1048576).toFixed(1)} MiB` : '只读预览';
    requestAnimationFrame(() => {
      records.scrollTop = firstRender && saved.version === version ? saved.scroll || 0 : oldScroll;
      persist();
    });
  }

  byId('search').value = current.query;
  byId('search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => request(0), 200); });
  byId('search').addEventListener('keydown', event => { if (event.key === 'Enter') { clearTimeout(searchTimer); request(0); } });
  byId('previous').addEventListener('click', () => request(current.page - 1));
  byId('next').addEventListener('click', () => request(current.page + 1));
  byId('page').addEventListener('change', () => request(Math.max(0, (Number(byId('page').value) || 1) - 1)));
  byId('source').addEventListener('click', () => vscode.postMessage({ type: 'source', line: current.rows?.[0]?.line || 1 }));
  byId('collapse').addEventListener('click', () => {
    expanded.clear();
    for (const details of records.querySelectorAll('details')) details.open = false;
    persist();
  });
  byId('expand').addEventListener('click', () => {
    for (const details of records.querySelectorAll('.root-node')) {
      if (details.tagName === 'DETAILS') details.open = true;
    }
  });
  records.addEventListener('scroll', () => { clearTimeout(saveTimer); saveTimer = setTimeout(persist, 150); });
  records.addEventListener('keydown', event => {
    const header = event.target.closest('.node-header');
    if (!header || event.target.closest('button') || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const node = header.parentElement;
    if (event.key === 'ArrowRight' && node.tagName === 'DETAILS') node.open = true;
    else if (event.key === 'ArrowLeft') {
      if (node.open) node.open = false;
      else node.parentElement.closest('details')?.querySelector('summary')?.focus();
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      const headers = [...records.querySelectorAll('.node-header')].filter(item => item.getClientRects().length);
      const index = headers.indexOf(header);
      headers[index + (event.key === 'ArrowDown' ? 1 : -1)]?.focus();
    }
  });
  window.addEventListener('message', event => {
    const message = event.data;
    if (message.type === 'page') renderPage(message);
    else if (message.type === 'loading') byId('status').textContent = message.message || '正在读取记录…';
    else if (message.type === 'notice') byId('notice').textContent = message.message;
    else if (message.type === 'error') {
      records.replaceChildren(element('div', 'empty-state error-message', message.message));
      records.setAttribute('aria-busy', 'false');
      byId('status').textContent = '无法读取预览';
    }
  });
  vscode.postMessage({ type: 'ready', page: current.page, query: current.query });
})();
