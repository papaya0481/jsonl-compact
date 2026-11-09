'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parse, summary } = require('../media/model');

function plain(node) {
  if (node.type === 'object') return Object.fromEntries(node.children.map(entry => [entry.key, plain(entry.node)]));
  if (node.type === 'array') return node.children.map(entry => plain(entry.node));
  if (node.type === 'string') return node.value;
  return JSON.parse(node.value);
}

test('preserves large numbers, decimal precision, exponent spelling, and duplicate keys', () => {
  const node = parse('{"id":9223372036854775807,"n":1.234567890123456789,"n":1E+400,"zero":-0}');
  assert.deepEqual(node.children.map(entry => entry.node.value), ['9223372036854775807', '1.234567890123456789', '1E+400', '-0']);
  assert.deepEqual(node.children.map(entry => entry.key), ['id', 'n', 'n', 'zero']);
  assert.match(summary(node), /9223372036854775807/);
});

test('handles Chinese, escapes, empty values, nested arrays, and primitive records', () => {
  const inputs = [
    '{"序号":"1","内容":"你好\\n世界\\t\\\"\\\\","布尔":true,"空":null,"x":[{},[],false,-12.3e-4]}',
    ' [1,2,{"a":[3,4]}] ', 'null', 'true', 'false', '-0', '"字符串"', '{}', '[]',
    '{"__proto__":{"polluted":true},"constructor":1}', '{"emoji":"\\uD83D\\uDE00","slash":"a\\/b"}'
  ];
  for (const input of inputs) assert.deepEqual(plain(parse(input)), JSON.parse(input));
  assert.equal({}.polluted, undefined);
});

test('rejects malformed JSON independently', () => {
  for (const input of ['', ' ', '{', '[', '{"a":}', '{a:1}', '{"a" 1}', '[1,]', '{"a":1,}',
    '[01]', '[+1]', '[-]', '[1.]', '[1e]', '[.1]', 'NaN', 'undefined', 'true false', 'nulla',
    '"unterminated', '"bad\\x"', '"bad\nstring"', '[1 2]', '{"a":1 "b":2}', '[]extra']) {
    assert.throws(() => parse(input), SyntaxError, input);
  }
});

test('deep records do not overflow the parser call stack', () => {
  let node = parse('['.repeat(10000) + '0' + ']'.repeat(10000));
  for (let depth = 0; depth < 10000; depth++) node = node.children[0].node;
  assert.equal(node.value, '0');
});

test('summaries stay compact and distinguish empty and nested containers', () => {
  assert.equal(summary(parse('{"序号":"1","x":{"a":1},"y":[1,2],"z":3}')), '{序号: "1", x: {…}, y: [2 项], …}');
  assert.equal(summary(parse('[]')), '[]');
  assert.equal(summary(parse('{}')), '{}');
  assert.equal(summary(parse('{"with space":1}')), '{"with space": 1}');
});

test('matches native JSON parsing for generated mixed records', () => {
  let seed = 37;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  function generate(depth) {
    const choice = Math.floor(random() * (depth > 3 ? 4 : 6));
    if (choice === 0) return null;
    if (choice === 1) return random() < .5;
    if (choice === 2) return Math.round(random() * 100000) / 100;
    if (choice === 3) return '内容\n"\\\t😀' + random();
    if (choice === 4) return Array.from({ length: Math.floor(random() * 5) }, () => generate(depth + 1));
    return Object.fromEntries(Array.from({ length: Math.floor(random() * 5) }, (_, index) => ['字段' + index, generate(depth + 1)]));
  }
  for (let index = 0; index < 300; index++) {
    const text = JSON.stringify(generate(0));
    assert.deepEqual(plain(parse(text)), JSON.parse(text));
  }
});
