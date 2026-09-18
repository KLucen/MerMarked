import type { AnnotationAnchor, AnnotationColor, AnnotationRecord, AnnotationSidecar } from '../core/annotations';

export interface HighlightMutation {
  model: AnnotationSidecar;
  changed: boolean;
  id: string;
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
): HighlightMutation {
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
): HighlightMutation {
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

export function deleteHighlightCandidate(model: AnnotationSidecar, id: string): HighlightMutation {
  existingRecord(model, id);
  return {
    model: { ...model, annotations: model.annotations.filter((item) => item.id !== id) },
    changed: true,
    id,
  };
}
