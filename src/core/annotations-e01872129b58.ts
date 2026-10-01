import { isAlias, isMap, isScalar, isSeq, parseDocument, stringify } from 'yaml';

/** Maximum encoded size of a sidecar accepted for editing. */
export const MAX_ANNOTATION_YAML_BYTES = 1_048_576;
const MAX_YAML_DEPTH = 8;
const MAX_YAML_NODES = 200_000;
const MAX_TAGS = 200;
const MAX_ANNOTATIONS = 5_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const hashPattern = /^[0-9a-f]{64}$/;
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const utcTimestampPattern = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/;

export type AnnotationColor = 'amber' | 'sage' | 'blue' | 'rose';
export type AnnotationAnchorStatus = 'resolved' | 'unresolved';

export interface AnnotationAnchor {
  /** SHA-256 of the complete file bytes when this anchor was created. */
  basisSha256: string;
  /** Half-open byte range in the original UTF-8 file, including a BOM if present. */
  startByte: number;
  endByte: number;
  /** Exact Markdown source bytes decoded as UTF-8; may include inline markup. */
  sourceExact: string;
  prefix: string;
  suffix: string;
  /** Visible text, which may differ from sourceExact. */
  displayQuote: string;
  sectionHint?: string;
}

export interface AnnotationTag {
  id: string;
  name: string;
}

export interface AnnotationRecord {
  id: string;
  kind: 'highlight' | 'note';
  color?: AnnotationColor;
  anchor: AnnotationAnchor;
  note?: string;
  tagId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AnnotationSidecar {
  schemaVersion: 1;
  source: {
    sha256: string;
    encoding: 'utf-8';
    coordinateSystem: 'utf8-byte';
  };
  tags: AnnotationTag[];
  annotations: AnnotationRecord[];
}

function invalid(message: string): never {
  throw new Error(`批注 YAML 无效：${message}`);
}

function record(value: unknown, path: string, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(`${path} 必须是对象。`);
  const fields = Object.keys(value);
  for (const field of required) {
    if (!Object.hasOwn(value, field)) invalid(`${path} 缺少 ${field}。`);
  }
  for (const field of fields) {
    if (!required.includes(field) && !optional.includes(field)) invalid(`${path} 含有未知字段 ${field}。`);
  }
  return value as Record<string, unknown>;
}

function textField(value: unknown, path: string, maxBytes: number, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || encoder.encode(value).length > maxBytes) {
    invalid(`${path} 必须是长度不超过 ${maxBytes} 字节的文本。`);
  }
  if (value.includes('\0')) invalid(`${path} 不能包含 NUL 字符。`);
  if (decoder.decode(encoder.encode(value)) !== value) invalid(`${path} 含有无效的 Unicode 字符。`);
  return value;
}

function hash(value: unknown, path: string): string {
  if (typeof value !== 'string' || !hashPattern.test(value)) invalid(`${path} 必须是小写 SHA-256 摘要。`);
  return value;
}

function identifier(value: unknown, path: string): string {
  if (typeof value !== 'string' || !idPattern.test(value)) invalid(`${path} 必须是稳定标识符。`);
  return value;
}

function timestamp(value: unknown, path: string): string {
  if (typeof value !== 'string' || !utcTimestampPattern.test(value) || !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString().slice(0, 19) !== value.slice(0, 19)) {
    invalid(`${path} 必须是 UTC 时间。`);
  }
  return value;
}

function safeByteOffset(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid(`${path} 必须是非负安全整数。`);
  return value;
}

function validateAnchor(value: unknown): AnnotationAnchor {
  const item = record(value, 'anchor',
    ['basisSha256', 'startByte', 'endByte', 'sourceExact', 'prefix', 'suffix', 'displayQuote'],
    ['sectionHint']);
  const startByte = safeByteOffset(item.startByte, 'anchor.startByte');
  const endByte = safeByteOffset(item.endByte, 'anchor.endByte');
  const sourceExact = textField(item.sourceExact, 'anchor.sourceExact', 16_384);
  if (endByte <= startByte || endByte - startByte !== encoder.encode(sourceExact).length) {
    invalid('anchor 字节范围与 sourceExact 不一致。');
  }
  const result: AnnotationAnchor = {
    basisSha256: hash(item.basisSha256, 'anchor.basisSha256'),
    startByte,
    endByte,
    sourceExact,
    prefix: textField(item.prefix, 'anchor.prefix', 512, true),
    suffix: textField(item.suffix, 'anchor.suffix', 512, true),
    displayQuote: textField(item.displayQuote, 'anchor.displayQuote', 16_384),
  };
  if (item.sectionHint !== undefined) result.sectionHint = textField(item.sectionHint, 'anchor.sectionHint', 512);
  return result;
}

function validateSidecar(value: unknown): AnnotationSidecar {
  const root = record(value, 'root', ['schemaVersion', 'source', 'tags', 'annotations']);
  if (root.schemaVersion !== 1) invalid('不支持的 schemaVersion；保留原文件，只读打开。');
  const source = record(root.source, 'source', ['sha256', 'encoding', 'coordinateSystem']);
  if (source.encoding !== 'utf-8' || source.coordinateSystem !== 'utf8-byte') {
    invalid('不支持的源文件编码或坐标系统。');
  }
  if (!Array.isArray(root.tags) || root.tags.length > MAX_TAGS) invalid(`tags 必须是至多 ${MAX_TAGS} 项的列表。`);
  if (!Array.isArray(root.annotations) || root.annotations.length > MAX_ANNOTATIONS) {
    invalid(`annotations 必须是至多 ${MAX_ANNOTATIONS} 项的列表。`);
  }
  const tagIds = new Set<string>();
  const tags = root.tags.map((value, index): AnnotationTag => {
    const entry = record(value, `tags[${index}]`, ['id', 'name']);
    const id = identifier(entry.id, `tags[${index}].id`);
    if (tagIds.has(id)) invalid(`标签 ID 重复：${id}。`);
    tagIds.add(id);
    const name = textField(entry.name, `tags[${index}].name`, 256);
    if (!name.trim()) invalid(`tags[${index}].name 不能为空白。`);
    return { id, name };
  });
  const annotationIds = new Set<string>();
  const annotations = root.annotations.map((value, index): AnnotationRecord => {
    const entry = record(value, `annotations[${index}]`,
      ['id', 'kind', 'anchor', 'createdAt', 'updatedAt'], ['color', 'note', 'tagId']);
    const id = identifier(entry.id, `annotations[${index}].id`);
    if (annotationIds.has(id)) invalid(`批注 ID 重复：${id}。`);
    annotationIds.add(id);
    if (entry.kind !== 'highlight' && entry.kind !== 'note') invalid(`annotations[${index}].kind 不支持。`);
    const kind = entry.kind;
    let color: AnnotationColor | undefined;
    if (entry.color !== undefined) {
      if (entry.color !== 'amber' && entry.color !== 'sage' && entry.color !== 'blue' && entry.color !== 'rose') {
        invalid(`annotations[${index}].color 不支持。`);
      }
      color = entry.color;
    }
    let note: string | undefined;
    if (entry.note !== undefined) note = textField(entry.note, `annotations[${index}].note`, 32_768);
    if (kind === 'highlight' && (color === undefined || note !== undefined)) invalid('高亮必须有颜色且不能有便签正文。');
    if (kind === 'note' && (note === undefined || !note.trim())) invalid('便签必须有非空正文。');
    let tagId: string | undefined;
    if (entry.tagId !== undefined) {
      tagId = identifier(entry.tagId, `annotations[${index}].tagId`);
      if (!tagIds.has(tagId)) invalid(`批注引用了不存在的标签 ${tagId}。`);
    }
    const createdAt = timestamp(entry.createdAt, `annotations[${index}].createdAt`);
    const updatedAt = timestamp(entry.updatedAt, `annotations[${index}].updatedAt`);
    if (Date.parse(updatedAt) < Date.parse(createdAt)) invalid('updatedAt 早于 createdAt。');
    return { id, kind, ...(color && { color }), anchor: validateAnchor(entry.anchor),
      ...(note !== undefined && { note }), ...(tagId && { tagId }), createdAt, updatedAt };
  });
  return {
    schemaVersion: 1,
    source: { sha256: hash(source.sha256, 'source.sha256'), encoding: 'utf-8', coordinateSystem: 'utf8-byte' },
    tags,
    annotations,
  };
}

function materialize(node: unknown, depth: number, budget: { nodes: number }): unknown {
  budget.nodes += 1;
  if (budget.nodes > MAX_YAML_NODES || depth > MAX_YAML_DEPTH) invalid('层级或节点数量超过上限。');
  if (node === null) return null;
  if (isAlias(node)) invalid('不允许 YAML 别名。');
  if (!isScalar(node) && !isMap(node) && !isSeq(node)) invalid('存在不支持的 YAML 节点。');
  if (node.anchor || node.tag) invalid('不允许 YAML 锚点或显式标签。');
  if (node.comment || node.commentBefore) invalid('文件含有无法保留的注释；保留原文件，只读打开。');
  if (isScalar(node)) return node.value;
  if (isSeq(node)) return node.items.map((item) => materialize(item, depth + 1, budget));
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const pair of node.items) {
    const key = materialize(pair.key, depth + 1, budget);
    if (typeof key !== 'string') invalid('YAML 对象键必须是文本。');
    if (Object.hasOwn(result, key)) invalid(`重复的 YAML 字段 ${key}。`);
    result[key] = materialize(pair.value, depth + 1, budget);
  }
  return result;
}

/** Parse a single, restricted YAML document; invalid or unfamiliar input must never be saved over. */
export function parseAnnotationYaml(text: string): AnnotationSidecar {
  if (encoder.encode(text).length > MAX_ANNOTATION_YAML_BYTES) invalid('文件超过大小上限。');
  const doc = parseDocument(text, { version: '1.2', schema: 'core', uniqueKeys: true, merge: false, resolveKnownTags: false });
  if (doc.errors.length > 0 || doc.warnings.length > 0) invalid(doc.errors[0]?.message ?? doc.warnings[0]?.message ?? '解析失败。');
  if (doc.directives.yaml.explicit || doc.directives.docStart || doc.directives.docEnd ||
      doc.directives.yaml.version !== '1.2' ||
      Object.keys(doc.directives.tags).some((key) => key !== '!!' || doc.directives.tags[key] !== 'tag:yaml.org,2002:')) {
    invalid('文件含有无法保留的 YAML 指令或文档标记；保留原文件，只读打开。');
  }
  if (doc.comment || doc.commentBefore) invalid('文件含有无法保留的注释；保留原文件，只读打开。');
  return validateSidecar(materialize(doc.contents, 0, { nodes: 0 }));
}

/** Canonical key order and original record order keep locally generated YAML diffs small. */
export function serializeAnnotationYaml(sidecar: AnnotationSidecar): string {
  const valid = validateSidecar(sidecar);
  const data = {
    schemaVersion: 1,
    source: { sha256: valid.source.sha256, encoding: 'utf-8', coordinateSystem: 'utf8-byte' },
    tags: valid.tags.map((tag) => ({ id: tag.id, name: tag.name })),
    annotations: valid.annotations.map((annotation) => ({
      id: annotation.id,
      kind: annotation.kind,
      ...(annotation.color && { color: annotation.color }),
      anchor: {
        basisSha256: annotation.anchor.basisSha256,
        startByte: annotation.anchor.startByte,
        endByte: annotation.anchor.endByte,
        sourceExact: annotation.anchor.sourceExact,
        prefix: annotation.anchor.prefix,
        suffix: annotation.anchor.suffix,
        displayQuote: annotation.anchor.displayQuote,
        ...(annotation.anchor.sectionHint && { sectionHint: annotation.anchor.sectionHint }),
      },
      ...(annotation.note !== undefined && { note: annotation.note }),
      ...(annotation.tagId && { tagId: annotation.tagId }),
      createdAt: annotation.createdAt,
      updatedAt: annotation.updatedAt,
    })),
  };
  const yaml = stringify(data, { version: '1.2', schema: 'core', lineWidth: 0, indent: 2, sortMapEntries: false });
  if (encoder.encode(yaml).length > MAX_ANNOTATION_YAML_BYTES) invalid('序列化结果超过文件大小上限。');
  return yaml;
}

/** Hash the complete source once, then check every anchor against the same immutable byte snapshot. */
export async function classifyAnnotationAnchors(
  anchors: readonly AnnotationAnchor[],
  sourceBytes: Uint8Array,
): Promise<AnnotationAnchorStatus[]> {
  if (anchors.length === 0) return [];
  // Snapshot before hashing so a concurrent mutation cannot make the hash and range refer to different bytes.
  const bytes = Uint8Array.from(sourceBytes);
  let sha256: string;
  try {
    const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
    sha256 = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
  } catch {
    return anchors.map(() => 'unresolved');
  }
  return anchors.map((anchor): AnnotationAnchorStatus => {
    if (anchor.basisSha256 !== sha256 || anchor.startByte < 0 || anchor.endByte > bytes.length ||
        anchor.endByte <= anchor.startByte || !Number.isSafeInteger(anchor.startByte) || !Number.isSafeInteger(anchor.endByte)) {
      return 'unresolved';
    }
    try {
      const exact = decoder.decode(bytes.subarray(anchor.startByte, anchor.endByte));
      return exact === anchor.sourceExact && encoder.encode(exact).length === anchor.endByte - anchor.startByte
        ? 'resolved' : 'unresolved';
    } catch {
      return 'unresolved';
    }
  });
}

/** A mismatched source digest freezes the old byte range until explicit reattachment. */
export async function classifyAnnotationAnchor(
  anchor: AnnotationAnchor,
  sourceBytes: Uint8Array,
): Promise<AnnotationAnchorStatus> {
  return (await classifyAnnotationAnchors([anchor], sourceBytes))[0];
}
