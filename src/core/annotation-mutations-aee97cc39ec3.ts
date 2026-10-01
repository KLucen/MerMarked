import type { AnnotationAnchor, AnnotationColor, AnnotationRecord, AnnotationSidecar } from './annotations';
import type { NoteTagInput } from '../types/reader-api';

export interface AnnotationMutation {
  model: AnnotationSidecar;
  changed: boolean;
  id: string;
}

/** Kept as an alias so the A4 call sites and focused tests remain source compatible. */
export type HighlightMutation = AnnotationMutation;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const identifierPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

function plainText(value: string, label: string, maxBytes: number, singleLine = false, trim = false): string {
  if (typeof value !== 'string') throw new Error(`${label}必须是文本。`);
  const stored = trim ? value.trim() : value;
  if (!stored.trim()) throw new Error(`${label}不能为空。`);
  if (stored.includes('\0') || (singleLine && /[\r\n]/.test(stored))) {
    throw new Error(`${label}包含不支持的字符。`);
  }
  const bytes = encoder.encode(stored);
  if (bytes.length > maxBytes || decoder.decode(bytes) !== stored) {
    throw new Error(`${label}不能超过 ${maxBytes} 个 UTF-8 字节。`);
  }
  return stored;
}

function identifier(value: string, label: string): string {
  if (typeof value !== 'string' || !identifierPattern.test(value)) throw new Error(`${label} 无效。`);
  return value;
}

function sameAnchor(left: AnnotationAnchor, right: AnnotationAnchor): boolean {
  return left.basisSha256 === right.basisSha256 && left.startByte === right.startByte &&
    left.endByte === right.endByte && left.sourceExact === right.sourceExact;
}

function normalizedTagName(value: string): string {
  return value.normalize('NFC');
}

function resolveTag(
  model: AnnotationSidecar,
  choice: NoteTagInput,
  newTagId?: string,
): { tags: AnnotationSidecar['tags']; tagId?: string } {
  if (choice.mode === 'none') return { tags: model.tags };
  if (choice.mode === 'existing') {
    const id = identifier(choice.id, '标签 ID');
    if (!model.tags.some((tag) => tag.id === id)) throw new Error('所选标签不存在，请重新选择。');
    return { tags: model.tags, tagId: id };
  }
  const name = plainText(choice.name, '标签名称', 256, true, true).normalize('NFC');
  const existing = model.tags.find((tag) => normalizedTagName(tag.name.trim()) === normalizedTagName(name));
  if (existing) return { tags: model.tags, tagId: existing.id };
  if (model.tags.length >= 200) throw new Error('标签数量已达到上限。');
  const id = identifier(newTagId ?? '', '新标签 ID');
  if (model.tags.some((tag) => tag.id === id)) throw new Error('标签 ID 已存在，请重试。');
  return { tags: [...model.tags, { id, name }], tagId: id };
}

function existingRecord(model: AnnotationSidecar, id: string): AnnotationRecord {
  const record = model.annotations.find((item) => item.id === id);
  if (!record || record.kind !== 'highlight') throw new Error('高亮不存在或已变为便签，请重新载入批注。');
  return record;
}

/** Only append a new record; neither tags nor existing annotation order change. */
export function createHighlightCandidate(
  model: AnnotationSidecar,
  anchor: AnnotationAnchor,
  color: AnnotationColor,
  id: string,
  now: string,
): AnnotationMutation {
  if (model.annotations.some((item) => item.id === id)) throw new Error('批注 ID 已存在，请重试。');
  if (model.annotations.some((item) => item.anchor.basisSha256 === anchor.basisSha256 &&
      item.anchor.startByte === anchor.startByte && item.anchor.endByte === anchor.endByte &&
      item.anchor.sourceExact === anchor.sourceExact)) {
    throw new Error('这段文字已有高亮或便签，请选择现有记录。');
  }
  return {
    model: {
      ...model,
      annotations: [...model.annotations, { id, kind: 'highlight', color, anchor, createdAt: now, updatedAt: now }],
    },
    changed: true,
    id,
  };
}

export function recolorHighlightCandidate(
  model: AnnotationSidecar,
  id: string,
  color: AnnotationColor,
  now: string,
): AnnotationMutation {
  const current = existingRecord(model, id);
  if (current.color === color) return { model, changed: false, id };
  return {
    model: {
      ...model,
      annotations: model.annotations.map((item) => item.id === id ? { ...item, color, updatedAt: now } : item),
    },
    changed: true,
    id,
  };
}

export function deleteHighlightCandidate(model: AnnotationSidecar, id: string): AnnotationMutation {
  existingRecord(model, id);
  return {
    model: { ...model, annotations: model.annotations.filter((item) => item.id !== id) },
    changed: true,
    id,
  };
}

/**
 * Append a note, or convert the one highlight at the exact same source anchor.
 * Conversion keeps the record identity, color, anchor and creation time.
 */
export function createNoteCandidate(
  model: AnnotationSidecar,
  anchor: AnnotationAnchor,
  noteValue: string,
  tagChoice: NoteTagInput,
  id: string,
  newTagId: string | undefined,
  now: string,
): AnnotationMutation {
  const note = plainText(noteValue, '便签正文', 32_768);
  const matching = model.annotations.filter((item) => sameAnchor(item.anchor, anchor));
  if (matching.some((item) => item.kind === 'note')) throw new Error('这段文字已有便签，请编辑现有记录。');
  if (matching.length > 1) throw new Error('这段文字有多条重复高亮，无法确定要转换的记录。');

  const current = matching[0];
  if (!current) {
    identifier(id, '批注 ID');
    if (model.annotations.some((item) => item.id === id)) throw new Error('批注 ID 已存在，请重试。');
  }
  const selectedTag = resolveTag(model, tagChoice, newTagId);
  if (current) {
    return {
      model: {
        ...model,
        tags: selectedTag.tags,
        annotations: model.annotations.map((item) => {
          if (item.id !== current.id) return item;
          const next: AnnotationRecord = { ...item, kind: 'note', note, updatedAt: now };
          if (selectedTag.tagId) next.tagId = selectedTag.tagId;
          else delete next.tagId;
          return next;
        }),
      },
      changed: true,
      id: current.id,
    };
  }

  return {
    model: {
      ...model,
      tags: selectedTag.tags,
      annotations: [...model.annotations, {
        id,
        kind: 'note',
        anchor,
        note,
        ...(selectedTag.tagId ? { tagId: selectedTag.tagId } : {}),
        createdAt: now,
        updatedAt: now,
      }],
    },
    changed: true,
    id,
  };
}

export function updateNoteCandidate(
  model: AnnotationSidecar,
  idValue: string,
  noteValue: string,
  tagChoice: NoteTagInput,
  newTagId: string | undefined,
  now: string,
): AnnotationMutation {
  const id = identifier(idValue, '便签 ID');
  const current = model.annotations.find((item) => item.id === id);
  if (!current || current.kind !== 'note') throw new Error('便签不存在，请重新载入批注。');
  const note = plainText(noteValue, '便签正文', 32_768);
  const selectedTag = resolveTag(model, tagChoice, newTagId);
  const tagId = selectedTag.tagId;
  if (current.note === note && current.tagId === tagId && selectedTag.tags === model.tags) {
    return { model, changed: false, id };
  }
  return {
    model: {
      ...model,
      tags: selectedTag.tags,
      annotations: model.annotations.map((item) => {
        if (item.id !== id) return item;
        const next = { ...item, note, updatedAt: now };
        if (tagId) next.tagId = tagId;
        else delete next.tagId;
        return next;
      }),
    },
    changed: true,
    id,
  };
}

export function deleteNoteCandidate(model: AnnotationSidecar, idValue: string): AnnotationMutation {
  const id = identifier(idValue, '便签 ID');
  const current = model.annotations.find((item) => item.id === id);
  if (!current || current.kind !== 'note') throw new Error('便签不存在，请重新载入批注。');
  return {
    model: { ...model, annotations: model.annotations.filter((item) => item.id !== id) },
    changed: true,
    id,
  };
}

/** Replace one record's source anchor after an explicit user selection. */
export function reattachAnnotationCandidate(
  model: AnnotationSidecar,
  idValue: string,
  anchor: AnnotationAnchor,
  now: string,
): AnnotationMutation {
  const id = identifier(idValue, '批注 ID');
  const current = model.annotations.find((item) => item.id === id);
  if (!current) throw new Error('批注不存在，请重新载入批注。');
  if (model.annotations.some((item) => item.id !== id && sameAnchor(item.anchor, anchor))) {
    throw new Error('这段文字已绑定其他高亮或便签，请选择不同文字。');
  }
  if (sameAnchor(current.anchor, anchor) && current.anchor.displayQuote === anchor.displayQuote &&
      current.anchor.prefix === anchor.prefix && current.anchor.suffix === anchor.suffix &&
      current.anchor.sectionHint === anchor.sectionHint) {
    return { model, changed: false, id };
  }
  return {
    model: {
      ...model,
      annotations: model.annotations.map((item) => item.id === id
        ? { ...item, anchor, updatedAt: now }
        : item),
    },
    changed: true,
    id,
  };
}
