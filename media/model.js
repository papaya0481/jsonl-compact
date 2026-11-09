(function (root) {
  'use strict';

  // Keep number lexemes and object entries rather than converting to JS numbers
  // and dictionaries. This preserves 64-bit IDs, exponents, and duplicate keys.
  function parse(text) {
    let pos = 0;
    const stack = [];
    const fail = message => { throw new SyntaxError(`${message}（第 ${pos + 1} 列）`); };
    const space = () => { while (/[\t\n\r ]/.test(text[pos] || '\0')) pos++; };
    const string = () => {
      const start = pos++;
      while (pos < text.length) {
        const char = text[pos++];
        if (char === '"') {
          const raw = text.slice(start, pos);
          try { return JSON.parse(raw); } catch { fail('无效的字符串或转义'); }
        }
        if (char === '\\') pos++;
        else if (char.charCodeAt(0) < 32) fail('字符串包含未转义的控制字符');
      }
      fail('字符串缺少结束引号');
    };
    const value = () => {
      space();
      const char = text[pos];
      if (char === '{' || char === '[') {
        pos++;
        const node = { type: char === '{' ? 'object' : 'array', children: [] };
        stack.push({ node, state: 'first' });
        return node;
      }
      if (char === '"') return { type: 'string', value: string() };
      for (const [literal, type] of [['true', 'boolean'], ['false', 'boolean'], ['null', 'null']]) {
        if (text.startsWith(literal, pos)) { pos += literal.length; return { type, value: literal }; }
      }
      const number = text.slice(pos).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
      if (number) { pos += number[0].length; return { type: 'number', value: number[0] }; }
      fail('此处需要一个 JSON 值');
    };

    const result = value();
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const object = frame.node.type === 'object';
      const close = object ? '}' : ']';
      space();
      if (frame.state === 'first' && text[pos] === close) { pos++; stack.pop(); continue; }
      if (frame.state === 'after') {
        if (text[pos] === close) { pos++; stack.pop(); continue; }
        if (text[pos] !== ',') fail(`此处需要逗号或 ${close}`);
        pos++;
        space();
      }
      let key;
      if (object) {
        if (text[pos] !== '"') fail('对象字段名需要双引号');
        key = string();
        space();
        if (text[pos++] !== ':') fail('字段名后缺少冒号');
      } else key = String(frame.node.children.length);
      frame.state = 'after';
      frame.node.children.push({ key, node: value() });
    }
    space();
    if (pos !== text.length) fail('JSON 值后有多余内容');
    return result;
  }

  const isContainer = node => node.type === 'object' || node.type === 'array';
  const shortString = (value, length = 90) => JSON.stringify(value.length > length ? value.slice(0, length) + '…' : value);
  const keyText = key => /^[\p{L}\p{N}_$]+$/u.test(key) && key.length > 0 ? key : JSON.stringify(key);
  function summary(node, fields = 3, depth = 0) {
    if (node.type === 'string') return shortString(node.value);
    if (!isContainer(node)) return node.value;
    const array = node.type === 'array';
    if (!node.children.length) return array ? '[]' : '{}';
    if (depth >= 1) return array ? `[${node.children.length} 项]` : '{…}';
    const entries = node.children.slice(0, fields).map(entry =>
      (array ? '' : keyText(entry.key) + ': ') + summary(entry.node, fields, depth + 1));
    if (node.children.length > fields) entries.push('…');
    return (array ? '[' : '{') + entries.join(', ') + (array ? ']' : '}');
  }

  const api = { parse, isContainer, summary, keyText };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.JsonlModel = api;
})(typeof globalThis === 'undefined' ? this : globalThis);
