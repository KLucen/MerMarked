import type { CanvasCardContent } from './canvas-card-content.ts';
import type { CanvasSceneCard, CanvasSceneLink } from './canvas-scene.ts';

export const MAX_EXPORT_DIMENSION = 12_000;
export const MAX_EXPORT_PIXELS = 40_000_000;

export interface CanvasExportOptions {
  readonly padding?: number;
  readonly background?: string;
}

export interface CanvasExportBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface Point { readonly x: number; readonly y: number }
interface ExportLink extends CanvasSceneLink {
  readonly fromPoint: Point;
  readonly toPoint: Point;
  readonly controls: readonly [Point, Point];
  readonly labelPoint: Point;
  readonly displayLabel: string;
  readonly labelWidth: number;
}

export interface CanvasExportScene {
  readonly cards: readonly (CanvasSceneCard & { readonly absolute: Point })[];
  readonly links: readonly ExportLink[];
  readonly bounds: CanvasExportBounds;
}

function escape(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[character]!));
}

function absoluteCards(cards: readonly CanvasSceneCard[]): CanvasExportScene['cards'] {
  const input = new Map(cards.map((card) => [card.id, card]));
  if (input.size !== cards.length) throw new Error('Duplicate export card.');
  const resolved = new Map<string, CanvasExportScene['cards'][number]>();
  for (const card of cards) {
    const ancestors: CanvasSceneCard[] = [];
    const seen = new Set<string>();
    let current: CanvasSceneCard | undefined = card;
    while (current && !resolved.has(current.id)) {
      if (seen.has(current.id)) throw new Error('Cyclic export hierarchy.');
      if (![current.width, current.height, current.position.x, current.position.y].every(Number.isFinite) || current.width <= 0 || current.height <= 0) {
        throw new Error('Invalid export geometry.');
      }
      seen.add(current.id); ancestors.push(current);
      if (current.parentId && !input.has(current.parentId)) throw new Error('Missing export parent.');
      current = current.parentId ? input.get(current.parentId) : undefined;
    }
    for (const ancestor of ancestors.reverse()) {
      const parent = ancestor.parentId ? resolved.get(ancestor.parentId) : undefined;
      resolved.set(ancestor.id, { ...ancestor, absolute: {
        x: (parent?.absolute.x ?? 0) + ancestor.position.x,
        y: (parent?.absolute.y ?? 0) + ancestor.position.y,
      } });
    }
  }
  return [...resolved.values()].filter((card) => !card.hidden);
}

export function buildCanvasExportScene(cards: readonly CanvasSceneCard[], links: readonly CanvasSceneLink[], options: CanvasExportOptions = {}): CanvasExportScene {
  const padding = options.padding ?? 48;
  if (!Number.isFinite(padding) || padding < 0 || padding > 2000) throw new Error('Invalid export padding.');
  const absolute = absoluteCards(cards);
  const byId = new Map(absolute.map((card) => [card.id, card]));
  const routes = links.flatMap((link): ExportLink[] => {
    const from = byId.get(link.from);
    const to = byId.get(link.to);
    if (!from || !to) return [];
    const fromPoint = { x: from.absolute.x + from.width, y: from.absolute.y + from.height / 2 };
    const toPoint = { x: to.absolute.x, y: to.absolute.y + to.height / 2 };
    const distance = Math.max(50, Math.abs(toPoint.x - fromPoint.x) / 2);
    const controls: [Point, Point] = link.from === link.to
      ? [{ x: fromPoint.x + 80, y: from.absolute.y - 100 }, { x: toPoint.x - 80, y: to.absolute.y - 100 }]
      : [{ x: fromPoint.x + distance, y: fromPoint.y }, { x: toPoint.x - distance, y: toPoint.y }];
    const labelPoint = {
      x: (fromPoint.x + controls[0].x * 3 + controls[1].x * 3 + toPoint.x) / 8,
      y: (fromPoint.y + controls[0].y * 3 + controls[1].y * 3 + toPoint.y) / 8,
    };
    const displayLabel = `${link.label || '关系'}${link.hiddenEndpoint ? '（隐藏端点）' : ''}`;
    // A full em for each scalar is conservative at the selected 12 px font;
    // the export renderer also verifies actual text bounds before capture.
    const labelWidth = Array.from(displayLabel).length * 12 + 16;
    return [{ ...link, fromPoint, toPoint, controls, labelPoint, displayLabel, labelWidth }];
  });
  if (!absolute.length) return { cards: [], links: [], bounds: { x: 0, y: 0, width: 1, height: 1 } };
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  const include = (point: Point) => { minX = Math.min(minX, point.x); minY = Math.min(minY, point.y); maxX = Math.max(maxX, point.x); maxY = Math.max(maxY, point.y); };
  for (const card of absolute) {
    include({ x: card.absolute.x - 2, y: card.absolute.y - 2 });
    include({ x: card.absolute.x + card.width + 2, y: card.absolute.y + card.height + 2 });
  }
  for (const route of routes) {
    for (const point of [route.fromPoint, ...route.controls, route.toPoint]) {
      include({ x: point.x - 10, y: point.y - 10 }); include({ x: point.x + 10, y: point.y + 10 });
    }
    include({ x: route.labelPoint.x - route.labelWidth / 2, y: route.labelPoint.y - 13 });
    include({ x: route.labelPoint.x + route.labelWidth / 2, y: route.labelPoint.y + 13 });
  }
  const routeSafety = routes.length ? 24 : 0;
  const exportPadding = padding + routeSafety;
  return { cards: absolute, links: routes, bounds: { x: minX - exportPadding, y: minY - exportPadding,
    width: Math.max(1, Math.ceil(maxX - minX + exportPadding * 2)), height: Math.max(1, Math.ceil(maxY - minY + exportPadding * 2)) } };
}

export function assertCanvasExportSize(bounds: CanvasExportBounds): { width: number; height: number } {
  const width = Math.ceil(bounds.width); const height = Math.ceil(bounds.height);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
      width > MAX_EXPORT_DIMENSION || height > MAX_EXPORT_DIMENSION || width * height > MAX_EXPORT_PIXELS) {
    throw new Error(`完整画布 ${width} × ${height} 超出单文件导出上限（单边 ${MAX_EXPORT_DIMENSION} px、${MAX_EXPORT_PIXELS / 1_000_000} MP）；请收起部分章节或调整布局后重试。`);
  }
  return { width, height };
}

export function canvasSceneToSvg(scene: CanvasExportScene, options: CanvasExportOptions = {}, content: ReadonlyMap<string, CanvasCardContent> = new Map()): string {
  const background = options.background ?? '#f3f6f8';
  if (!/^#[a-f\d]{3}(?:[a-f\d]{3})?$/i.test(background)) throw new Error('Invalid export background.');
  const { bounds } = scene;
  const width = Math.ceil(bounds.width);
  const height = Math.ceil(bounds.height);
  const cardSvg = scene.cards.map((card) => {
    const x = card.absolute.x - bounds.x;
    const y = card.absolute.y - bounds.y;
    const body = content.get(card.id);
    const title = body?.title ?? (card.sectionIndex === null ? '全文' : `章节 ${card.sectionIndex + 1}`);
    const detail = card.hiddenDescendants ? `${card.hiddenDescendants} 个章节已收起` : `${body?.childCount ?? 0} 个直接子章节`;
    return `<g data-card="${escape(card.id)}"><rect x="${x}" y="${y}" width="${card.width}" height="${card.height}" rx="7" fill="#fafdfc" stroke="#8ca5ad" stroke-width="1.5"/><foreignObject x="${x}" y="${y}" width="300" height="${card.height}"><div xmlns="http://www.w3.org/1999/xhtml" class="export-card"><strong>${escape(title)}</strong><p>${escape(body?.summary || '暂无正文')}</p><span>${escape(detail)}</span></div></foreignObject></g>`;
  }).join('');
  const linkSvg = scene.links.map((link) => {
    const local = (point: Point) => `${point.x - bounds.x} ${point.y - bounds.y}`;
    const labelX = link.labelPoint.x - bounds.x; const labelY = link.labelPoint.y - bounds.y;
    return `<g data-link="${escape(link.id)}"><path d="M ${local(link.fromPoint)} C ${local(link.controls[0])}, ${local(link.controls[1])}, ${local(link.toPoint)}" fill="none" stroke="${link.hiddenEndpoint ? '#98651c' : '#327766'}" stroke-width="2" marker-end="url(#arrow)"/><rect x="${labelX - link.labelWidth / 2}" y="${labelY - 12}" width="${link.labelWidth}" height="24" rx="4" fill="#fff"/><text x="${labelX}" y="${labelY + 4}" text-anchor="middle" font-family="Segoe UI,Microsoft YaHei,sans-serif" font-size="12" fill="#315e56">${escape(link.displayLabel)}</text></g>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><style>.export-card{box-sizing:border-box;width:300px;padding:14px;font-family:Segoe UI,Microsoft YaHei,sans-serif;color:#253345;overflow-wrap:anywhere;line-height:1.5;letter-spacing:0}.export-card strong{display:block;font-size:14px;line-height:1.4;padding-right:56px}.export-card p{font-size:12px;margin:9px 0 8px}.export-card span{font-size:11px;color:#58746c}</style><defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="userSpaceOnUse"><path d="M 0 0 L 8 4 L 0 8 z" fill="#327766"/></marker></defs><rect width="100%" height="100%" fill="${escape(background)}"/>${cardSvg}${linkSvg}</svg>`;
}
