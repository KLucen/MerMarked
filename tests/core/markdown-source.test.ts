import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertMarkdownLineEndingsPreserved,
  decodeMarkdownBytes,
  encodeMarkdownBytes,
  inspectMarkdownSourceFormat,
} from '../../src/core/markdown-source.ts';

const bom = Buffer.from([0xef, 0xbb, 0xbf]);

test('UTF-8 Markdown bytes round-trip without changing BOM, line endings, or trailing newline', () => {
  const samples = [
    Buffer.alloc(0),
    bom,
    Buffer.from('# LF\n中文 😀 e\u0301\n'),
    Buffer.concat([bom, Buffer.from('# CRLF\r\n正文\t尾随  ', 'utf8')]),
    Buffer.from('one\rtwo\r', 'utf8'),
    Buffer.from('mixed\r\nline\nlone\r', 'utf8'),
  ];

  for (const original of samples) {
    const decoded = decodeMarkdownBytes(original);
    assert.deepEqual(Buffer.from(encodeMarkdownBytes(
      decoded.content,
      decoded.format.bomByteLength,
    )), original);
  }
});

test('source format reports exact newline and trailing-newline state', () => {
  assert.deepEqual(inspectMarkdownSourceFormat('single line', 0), {
    bomByteLength: 0,
    lineEnding: 'none',
    hasTrailingLineEnding: false,
  });
  assert.deepEqual(inspectMarkdownSourceFormat('a\r\nb', 3), {
    bomByteLength: 3,
    lineEnding: 'crlf',
    hasTrailingLineEnding: false,
  });
  assert.deepEqual(inspectMarkdownSourceFormat('a\nb\n', 0), {
    bomByteLength: 0,
    lineEnding: 'lf',
    hasTrailingLineEnding: true,
  });
  assert.equal(inspectMarkdownSourceFormat('a\r\nb\nc\r', 0).lineEnding, 'mixed');
});

test('a local edit produces only the requested UTF-8 bytes', () => {
  const original = Buffer.concat([bom, Buffer.from('# 标题\r\n旧正文 😀\r\n末行', 'utf8')]);
  const decoded = decodeMarkdownBytes(original);
  const candidate = encodeMarkdownBytes(
    decoded.content.replace('旧正文', '新正文'),
    decoded.format.bomByteLength,
  );
  assert.deepEqual(
    Buffer.from(candidate),
    Buffer.concat([bom, Buffer.from('# 标题\r\n新正文 😀\r\n末行', 'utf8')]),
  );
});

test('invalid UTF-8 and incomplete Unicode scalar values are rejected', () => {
  assert.throws(
    () => decodeMarkdownBytes(Uint8Array.from([0xff, 0xfe, 0x23, 0x00])),
    /UTF-8/,
  );
  assert.throws(() => encodeMarkdownBytes('\ud800', 0), /Unicode/);
  assert.throws(() => encodeMarkdownBytes('\udc00', 0), /Unicode/);
  assert.throws(() => encodeMarkdownBytes('text', 2), /BOM/);
});

test('uniform newline normalization is rejected unless the document had no established style', () => {
  assert.throws(
    () => assertMarkdownLineEndingsPreserved(
      inspectMarkdownSourceFormat('a\r\nb', 0),
      inspectMarkdownSourceFormat('a\nb', 0),
    ),
    /换行格式/,
  );
  assert.doesNotThrow(() => assertMarkdownLineEndingsPreserved(
    inspectMarkdownSourceFormat('single', 0),
    inspectMarkdownSourceFormat('two\nlines', 0),
  ));
});
