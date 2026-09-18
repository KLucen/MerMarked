/** Creates a source anchor from a selection already proven by selection-map. */
export interface AnchorSelection {
  readonly startByte: number;
  readonly endByte: number;
  readonly sourceExact: string;
  readonly displayQuote: string;
}

export interface SourceAnchorDraft extends AnchorSelection {
  readonly basisSha256: string;
  readonly prefix: string;
  readonly suffix: string;
  readonly sectionHint?: string;
}

function utf8Width(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

function sourceOffsets(content: string, bomByteLength: 0 | 3, startByte: number, endByte: number): [number, number] {
  let currentByte = bomByteLength;
  let startOffset: number | null = null;
  let endOffset: number | null = null;

  for (let offset = 0; offset <= content.length;) {
    if (currentByte === startByte) startOffset = offset;
    if (currentByte === endByte) {
      endOffset = offset;
      break;
    }
    if (offset === content.length) break;
    const codePoint = content.codePointAt(offset);
    if (codePoint === undefined || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
      throw new Error('原文包含无法映射的字符。');
    }
    currentByte += utf8Width(codePoint);
    offset += codePoint > 0xffff ? 2 : 1;
    if (currentByte > endByte) break;
  }

  if (startOffset === null || endOffset === null || startOffset >= endOffset) {
    throw new Error('选区未落在完整的 UTF-8 字符边界。');
  }
  return [startOffset, endOffset];
}

export function makeAnnotationAnchor(
  content: string,
  bomByteLength: 0 | 3,
  sourceSha256: string,
  selection: AnchorSelection,
  sectionHint = '',
): SourceAnchorDraft {
  if (
    !/^[0-9a-f]{64}$/.test(sourceSha256) ||
    !Number.isSafeInteger(selection.startByte) || !Number.isSafeInteger(selection.endByte) ||
    selection.startByte < bomByteLength || selection.endByte <= selection.startByte ||
    !selection.displayQuote || !selection.sourceExact
  ) {
    throw new Error('选区锚点信息无效。');
  }

  const [startOffset, endOffset] = sourceOffsets(
    content, bomByteLength, selection.startByte, selection.endByte,
  );
  if (content.slice(startOffset, endOffset) !== selection.sourceExact) {
    throw new Error('原文与选区不一致，请重新选择。');
  }

  return {
    basisSha256: sourceSha256,
    startByte: selection.startByte,
    endByte: selection.endByte,
    sourceExact: selection.sourceExact,
    prefix: Array.from(content.slice(0, startOffset)).slice(-48).join(''),
    suffix: Array.from(content.slice(endOffset)).slice(0, 48).join(''),
    displayQuote: selection.displayQuote,
    ...(sectionHint ? { sectionHint } : {}),
  };
}
