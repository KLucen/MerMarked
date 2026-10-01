import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { mapAnnotationSidecarThroughEdit } from '../core/annotation-edit-map.ts';
import { MAX_ANNOTATION_YAML_BYTES, parseAnnotationYaml, serializeAnnotationYaml } from '../core/annotations.ts';
import { MAX_CANVAS_JSON_BYTES, mapCanvasThroughSectionTransform, parseCanvasJson, reconcileCanvasState, serializeCanvasJson } from '../core/canvas-state.ts';
import { decodeMarkdownBytes, encodeMarkdownBytes } from '../core/markdown-source.ts';
import { previewSectionTransform, type ReadySectionTransformPreview, type SectionTransformOperation } from '../core/section-transform.ts';
import type { MarkdownAnnotationImpact, OpenedMarkdownDocument } from '../types/reader-api.ts';
import type { DocumentBundle } from './document-transaction.ts';

export interface SectionStructurePlan {
  readonly before: DocumentBundle;
  readonly after: DocumentBundle;
  readonly preview: ReadySectionTransformPreview;
  readonly impact: MarkdownAnnotationImpact;
}

export function bundleDigest(bytes: Uint8Array | null): string | null {
  return bytes === null ? null : createHash('sha256').update(bytes).digest('hex');
}

async function optionalFile(filePath: string, limit: number): Promise<Buffer | null> {
  try {
    const info = await lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > limit) throw new Error('伴随文件不能安全读取，请先处理后重试。');
    const bytes = await readFile(filePath);
    if (bytes.length > limit) throw new Error('伴随文件超过当前大小限制。');
    return bytes;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

export async function readStructureBundle(documentPath: string): Promise<DocumentBundle> {
  const markdown = await optionalFile(documentPath, 32 * 1024 * 1024);
  if (!markdown) throw new Error('Markdown 已不存在，请重新载入。');
  return { markdown, annotations: await optionalFile(`${documentPath}.annotations.yaml`, MAX_ANNOTATION_YAML_BYTES),
    canvas: await optionalFile(`${documentPath}.mermarkd.json`, MAX_CANVAS_JSON_BYTES) };
}

export async function assertStructureBaseline(documentPath: string, before: DocumentBundle): Promise<void> {
  const current = await readStructureBundle(documentPath);
  if ((['markdown', 'annotations', 'canvas'] as const).some((kind) => bundleDigest(current[kind]) !== bundleDigest(before[kind]))) {
    throw new Error('文档、批注或画布在预览后发生变化，请重新载入并生成预览。');
  }
}

export async function prepareSectionStructurePlan(document: OpenedMarkdownDocument, operation: SectionTransformOperation): Promise<SectionStructurePlan> {
  const before = await readStructureBundle(document.path);
  if (bundleDigest(before.markdown) !== document.sourceSha256) throw new Error('Markdown 已在外部修改，请重新载入。');
  const source = decodeMarkdownBytes(before.markdown);
  if (source.content !== document.content || source.format.bomByteLength !== document.bomByteLength) throw new Error('Markdown 基线不一致。');
  const preview = previewSectionTransform(document.content, operation);
  if (preview.status !== 'ready') throw new Error(preview.rejection.message);
  const markdown = encodeMarkdownBytes(preview.candidate, document.bomByteLength);
  const beforeSource = { bytes: before.markdown, content: document.content, sha256: document.sourceSha256 };
  const afterSource = { bytes: markdown, content: preview.candidate, sha256: bundleDigest(markdown)! };
  let annotations = before.annotations;
  let impact: MarkdownAnnotationImpact = { status: 'not-needed', mappedCount: 0, unresolved: [], message: '当前没有批注，未创建批注文件。' };
  if (annotations !== null) {
    const model = parseAnnotationYaml(new TextDecoder('utf-8', { fatal: true }).decode(annotations));
    const newest = Math.max(Date.now(), ...model.annotations.map((item) => Date.parse(item.updatedAt)));
    const mapping = await mapAnnotationSidecarThroughEdit(model, beforeSource, afterSource, new Date(newest).toISOString(), preview);
    const unresolved = new Set(mapping.items.filter((item) => item.status === 'unresolved').map((item) => item.id));
    impact = { status: 'ready', mappedCount: mapping.mappedCount,
      unresolved: model.annotations.filter((item) => unresolved.has(item.id)).map((item) => ({ id: item.id, quote: Array.from(item.anchor.displayQuote).slice(0, 120).join('') })),
      message: `${mapping.mappedCount} 条批注可随保存同步；${mapping.unresolvedCount} 条保留原锚点，待阅读模式审查。` };
    annotations = Buffer.from(serializeAnnotationYaml(mapping.model));
  }
  let canvas = before.canvas;
  if (canvas !== null) {
    const state = parseCanvasJson(new TextDecoder('utf-8', { fatal: true }).decode(canvas));
    const mapped = await mapCanvasThroughSectionTransform(state, beforeSource, afterSource, preview);
    const sourceIndex = operation.kind === 'move' ? operation.sourceIndex : operation.sectionIndex;
    const movedId = mapped.bindings.find((item) => item.sectionIndex === preview.sectionOrder.indexOf(sourceIndex))?.id;
    canvas = Buffer.from(serializeCanvasJson({ ...mapped.model, cards: mapped.model.cards.map((card) => card.id === movedId
      ? { ...card, position: { x: 24, y: preview.candidateTree.sections[preview.sectionOrder.indexOf(sourceIndex)].parentIndex === null ? 0 : 150 } } : card) }));
  }
  return { before, after: { markdown, annotations, canvas }, preview, impact };
}

/** Exact undo/redo keeps the verified map. Other edits use the conservative
 * baseline map, so an uncertain identity cannot inherit a moved card's links. */
export async function finalizeSectionStructurePlan(plan: SectionStructurePlan, content: string): Promise<SectionStructurePlan> {
  if (content === plan.preview.candidate) return plan;
  const decoded = decodeMarkdownBytes(plan.before.markdown);
  const markdown = encodeMarkdownBytes(content, decoded.format.bomByteLength);
  const beforeSource = { bytes: plan.before.markdown, content: decoded.content, sha256: bundleDigest(plan.before.markdown)! };
  const afterSource = { bytes: markdown, content, sha256: bundleDigest(markdown)! };
  let annotations = plan.before.annotations;
  let impact = plan.impact;
  if (annotations !== null) {
    const model = parseAnnotationYaml(new TextDecoder('utf-8', { fatal: true }).decode(annotations));
    const mapping = await mapAnnotationSidecarThroughEdit(model, beforeSource, afterSource,
      new Date(Math.max(Date.now(), ...model.annotations.map((item) => Date.parse(item.updatedAt)))).toISOString());
    const unresolved = new Set(mapping.items.filter((item) => item.status === 'unresolved').map((item) => item.id));
    impact = { status: 'ready', mappedCount: mapping.mappedCount,
      unresolved: model.annotations.filter((item) => unresolved.has(item.id)).map((item) => ({ id: item.id, quote: Array.from(item.anchor.displayQuote).slice(0, 120).join('') })),
      message: `额外源码编辑按保守规则核验：${mapping.mappedCount} 条批注同步，${mapping.unresolvedCount} 条待定位。` };
    annotations = Buffer.from(serializeAnnotationYaml(mapping.model));
  }
  let canvas = plan.before.canvas;
  if (canvas !== null) {
    const mapping = await reconcileCanvasState(parseCanvasJson(new TextDecoder('utf-8', { fatal: true }).decode(canvas)), afterSource);
    canvas = Buffer.from(serializeCanvasJson(mapping.model));
  }
  return { ...plan, after: { markdown, annotations, canvas }, impact };
}
