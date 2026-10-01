export type MarkdownLineEnding = 'none' | 'lf' | 'crlf' | 'cr' | 'mixed';

export interface MarkdownSourceFormat {
  readonly bomByteLength: 0 | 3;
  readonly lineEnding: MarkdownLineEnding;
  readonly hasTrailingLineEnding: boolean;
}

export interface DecodedMarkdownBytes {
  /** UTF-8 text without the leading byte-order mark. Line endings are unchanged. */
  readonly content: string;
  readonly format: MarkdownSourceFormat;
}

const utf8Bom = Uint8Array.from([0xef, 0xbb, 0xbf]);
const encoder = new TextEncoder();

function validBomByteLength(value: number): asserts value is 0 | 3 {
  if (value !== 0 && value !== 3) {
    throw new Error('UTF-8 BOM 元数据无效。');
  }
}

function assertValidUnicodeScalarText(content: string): void {
  for (let index = 0; index < content.length; index += 1) {
    const code = content.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = content.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new Error('Markdown 缓冲区包含不完整的 Unicode 字符，未生成保存候选。');
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error('Markdown 缓冲区包含不完整的 Unicode 字符，未生成保存候选。');
    }
  }
}

export function inspectMarkdownSourceFormat(
  content: string,
  bomByteLength: number,
): MarkdownSourceFormat {
  validBomByteLength(bomByteLength);
  const endings = new Set<'lf' | 'crlf' | 'cr'>();
  for (const match of content.matchAll(/\r\n|\r|\n/g)) {
    endings.add(match[0] === '\r\n' ? 'crlf' : match[0] === '\r' ? 'cr' : 'lf');
  }

  return {
    bomByteLength,
    lineEnding: endings.size === 0
      ? 'none'
      : endings.size > 1
        ? 'mixed'
        : [...endings][0],
    hasTrailingLineEnding: /(?:\r\n|\r|\n)$/.test(content),
  };
}

export function decodeMarkdownBytes(bytes: Uint8Array): DecodedMarkdownBytes {
  const bomByteLength: 0 | 3 =
    bytes[0] === utf8Bom[0] && bytes[1] === utf8Bom[1] && bytes[2] === utf8Bom[2] ? 3 : 0;
  let content: string;
  try {
    // The decoder removes one leading UTF-8 BOM from the string view. The byte
    // metadata remains separate so encoding can reproduce the exact file form.
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('文档不是有效的 UTF-8 编码，请先转换为 UTF-8。');
  }
  return { content, format: inspectMarkdownSourceFormat(content, bomByteLength) };
}

export function encodeMarkdownBytes(content: string, bomByteLength: number): Uint8Array {
  validBomByteLength(bomByteLength);
  assertValidUnicodeScalarText(content);
  const encoded = encoder.encode(content);
  if (bomByteLength === 0) return encoded;
  const result = new Uint8Array(utf8Bom.byteLength + encoded.byteLength);
  result.set(utf8Bom, 0);
  result.set(encoded, utf8Bom.byteLength);
  return result;
}

/**
 * Rejects accidental whole-document newline normalization. A future explicit
 * conversion command may bypass this check after showing a source diff.
 */
export function assertMarkdownLineEndingsPreserved(
  original: MarkdownSourceFormat,
  candidate: MarkdownSourceFormat,
): void {
  if (original.lineEnding === 'none' || original.lineEnding === 'mixed') return;
  if (candidate.lineEnding === 'none' || candidate.lineEnding === original.lineEnding) return;
  throw new Error('Markdown 换行格式与打开文档不一致，未覆盖原文件。');
}
