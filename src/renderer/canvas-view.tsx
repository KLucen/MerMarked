import { preflightCanvasExport } from '../core/canvas-export-preflight';
import { CanvasStructurePreview } from './canvas-structure-preview';
import { WorkspaceTaskPanel } from './workspace-panels';
import { useCanvasToolbarMenus } from './use-canvas-toolbar-menus';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { applyNodeChanges, Background, BackgroundVariant, Handle, MarkerType, Position, ReactFlow, ReactFlowProvider, useReactFlow } from '@xyflow/react';
import type { Connection, Edge, Node, NodeProps, NodeTypes } from '@xyflow/react';
import { ArrowDownToLine, ArrowUpToLine, Crosshair, FileDown, FilePenLine, Focus, ImageDown, LayoutGrid, Link2, MoreHorizontal, Plus, Redo2, RefreshCw, RotateCcw, Save, Trash2, ZoomIn, ZoomOut } from 'lucide-react';
import { createCanvasCardContentCache } from '../core/canvas-card-content';
import { buildCanvasSceneV2, isCanvasViewportVisible } from '../core/canvas-scene-v2';
import {
  classifyDragOutPromotion,
  evaluateDragOutPromotion,
  findCanvasOverlapCandidate,
  updateCanvasOverlapDwell,
} from '../core/canvas-structure-candidates';
import type {
  CanvasOverlapCandidate,
  DragOutPromotionCandidate,
  OverlapDwellState,
} from '../core/canvas-structure-candidates';
import type { CanvasBinding } from '../core/canvas-state';
import { arrangeCanvasV2, CANVAS_CARD_SIZE_LIMITS, CANVAS_DEFAULT_CARD_SIZE, projectCanvasStateV2ToV1, reconcileCanvasStateV2 } from '../core/canvas-state-v2';
import type { CanvasBodyDisplay, CanvasStateV2 } from '../core/canvas-state-v2';
import { extractSections } from '../core/sections';
import { encodeMarkdownBytes } from '../core/markdown-source';
import type { OpenedMarkdownDocument, SectionStructurePreview } from '../types/reader-api';
import type { SectionTransformOperation } from '../core/section-transform';
import type { PartStatus } from './workspace-status';
import '@xyflow/react/dist/style.css';

interface CardData extends Record<string, unknown> {
  title: string;
  pathLabel: string;
  summary: string;
  fullText?: string;
  childCount: number;
  hiddenDescendants: number;
  bodyDisplay: CanvasBodyDisplay;
  contentPosition: { readonly x: number; readonly y: number };
  size: { readonly width: number; readonly height: number };
  descendantsCollapsed: boolean;
  nestStatus?: 'candidate' | 'ready';
  detachStatus?: 'candidate' | 'ready';
  readOnly: boolean;
  sectionIndex: number | null;
  fold: () => void;
  edit: () => void;
  properties: () => void;
  hiddenLinks: number;
  measure: (height: number) => void;
}
type ChapterNode = Node<CardData, 'chapter'>;

function ChapterCard({ data, selected }: NodeProps<ChapterNode>) {
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = body.current;
    if (!element) return;
    const measure = () => data.measure(Math.ceil(element.offsetHeight + 16));
    const actualObserver = new ResizeObserver(measure);
    actualObserver.observe(element); measure();
    return () => actualObserver.disconnect();
  }, [data.measure]);
  const chapterClass = ['canvas-chapter', data.childCount > 0 && !data.descendantsCollapsed && 'canvas-chapter-group', selected && 'selected', data.nestStatus && `nest-${data.nestStatus}`,
    data.detachStatus && `detach-${data.detachStatus}`].filter(Boolean).join(' ');
  return <div className={chapterClass}>
    <Handle type="target" position={Position.Left} isConnectable={!data.readOnly} />
    <div ref={body} className="canvas-card-body" style={{ left: data.contentPosition.x, top: data.contentPosition.y,
      width: data.size.width, height: data.size.height }}><div className="canvas-card-header">
      <div className="canvas-card-heading"><strong title={data.pathLabel}>{data.title}</strong></div>
      <div className="canvas-card-actions nodrag" hidden={!selected}>
        <button type="button" title="编辑本节" aria-label="编辑本节" onClick={data.edit}><FilePenLine size={15} /></button>
        <button type="button" title="卡片操作" aria-label="卡片操作" onClick={data.properties}><MoreHorizontal size={15} /></button>
      </div>
    </div>
    {data.bodyDisplay !== 'hidden' && <p className={data.bodyDisplay === 'full' ? 'canvas-card-summary canvas-card-full' : 'canvas-card-summary'}>{(data.bodyDisplay === 'full' ? data.fullText : data.summary) || '暂无正文'}</p>}
    {data.childCount > 0 && <button type="button" className="canvas-card-count nodrag" disabled={data.readOnly} onClick={data.fold}
      aria-label={data.descendantsCollapsed ? '展开子章节' : '收起子章节'}>
      {data.descendantsCollapsed ? <ArrowDownToLine size={13} /> : <ArrowUpToLine size={13} />}
      {data.hiddenDescendants ? data.hiddenDescendants + ' 个章节已收起' : data.childCount + ' 个子章节'}
      {data.hiddenLinks > 0 && <span> · {data.hiddenLinks} 条关联</span>}
    </button>}
    {data.nestStatus && <div className="canvas-nest-indicator" role="status">
      {data.nestStatus === 'ready' ? '松开以预览设为子章节' : '继续重叠并短暂停留'}
    </div>}
    {data.detachStatus && <div className="canvas-detach-indicator" role="status">
      {data.detachStatus === 'ready' ? '松开以预览移出父章节' : '移出父章节并短暂停留'}
    </div>}
    </div>
    <Handle type="source" position={Position.Right} isConnectable={!data.readOnly} />
  </div>;
}

const nodeTypes: NodeTypes = { chapter: ChapterCard };

function domRectForNode(id: string) {
  const element = globalThis.document.querySelector<HTMLElement>(`[data-id="${id.replaceAll('"', '\\"')}"]`);
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
}

function pointerForEvent(event: unknown): { x: number; y: number } | null {
  if (!event || typeof event !== 'object') return null;
  const value = event as { clientX?: unknown; clientY?: unknown; changedTouches?: { clientX?: unknown; clientY?: unknown }[]; touches?: { clientX?: unknown; clientY?: unknown }[] };
  if (typeof value.clientX === 'number' && typeof value.clientY === 'number') return { x: value.clientX, y: value.clientY };
  const touch = value.changedTouches?.[0] ?? value.touches?.[0];
  return touch && typeof touch.clientX === 'number' && typeof touch.clientY === 'number' ? { x: touch.clientX, y: touch.clientY } : null;
}

export interface CanvasViewProps {
  readonly document: OpenedMarkdownDocument;
  readonly dirty: boolean;
  readonly activeSection: number | null;
  readonly focusRequest?: number;
  readonly onSectionChange: (index: number | null) => void;
  readonly onEditSection: (index: number | null) => void;
  readonly onStructurePreview: (operation: SectionTransformOperation) => Promise<void>;
  readonly structurePreview: SectionStructurePreview | null;
  readonly structureBusy: boolean;
  readonly onConfirmStructure: () => Promise<boolean>;
  readonly onCancelStructure: () => void;
  readonly onOpenProperties: () => void;
  readonly canUndoSource: boolean;
  readonly canRedoSource: boolean;
  readonly onUndoSource: () => void;
  readonly onRedoSource: () => void;
  readonly onStatusChange?: (path: string, sha256: string, status: PartStatus) => void;
}

function CanvasEditor({ document, dirty, activeSection, focusRequest = 0, onSectionChange, onEditSection, onStructurePreview, onStatusChange, structurePreview, structureBusy, onConfirmStructure, onCancelStructure, onOpenProperties, canUndoSource, canRedoSource, onUndoSource, onRedoSource }: CanvasViewProps) {
  const flow = useReactFlow<ChapterNode>();
  const toolbar = useRef<HTMLDivElement>(null);
  useCanvasToolbarMenus(toolbar);
  const [model, setModel] = useState<CanvasStateV2 | null>(null);
  const [bindings, setBindings] = useState<readonly CanvasBinding[]>([]);
  const [unresolvedIds, setUnresolvedIds] = useState<readonly string[]>([]);
  const [unresolvedLinkIds, setUnresolvedLinkIds] = useState<readonly string[]>([]);
  const [nodes, setNodes] = useState<ChapterNode[]>([]);
  const [sidecarHash, setSidecarHash] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [layoutPending, setLayoutPending] = useState(true);
  const [readError, setReadError] = useState<string | null>(null);
  const [loadWarning, setLoadWarning] = useState<string | null>(null);
  const [message, setMessage] = useState('正在加载画布…');
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [selectedLinkLabel, setSelectedLinkLabel] = useState('');
  const [selectedLink, setSelectedLink] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [query, setQuery] = useState('');
  const [history, setHistory] = useState<CanvasStateV2[]>([]);
  const [future, setFuture] = useState<CanvasStateV2[]>([]);
  const [loadRevision, setLoadRevision] = useState(0);
  const [minimumHeights, setMinimumHeights] = useState<Record<string, number>>({});
  const [exporting, setExporting] = useState<'png' | 'jpg' | 'pdf' | null>(null);
  const [exportMessage, setExportMessage] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [nestCandidate, setNestCandidate] = useState<CanvasOverlapCandidate | null>(null);
  const [detachCandidate, setDetachCandidate] = useState<DragOutPromotionCandidate | null>(null);
  const [structureSource, setStructureSource] = useState('');
  const [structureTarget, setStructureTarget] = useState('');
  const generation = useRef(0);
  const saveInFlight = useRef(false);
  const initialLayout = useRef(false);
  const sourceVersion = useRef<1 | 2>(1);
  const dragStart = useRef<{ nodeId: string; sectionIndex: number | null; position: { x: number; y: number }; screenRect?: { x: number; y: number; width: number; height: number }; pointer?: { x: number; y: number }; parentId?: string } | null>(null);
  const nestDwell = useRef<OverlapDwellState | null>(null);
  const detachDwell = useRef<OverlapDwellState | null>(null);
  const feedbackAt = useRef(0);
  const nestCandidateRef = useRef<CanvasOverlapCandidate | null>(null);
  const detachCandidateRef = useRef<DragOutPromotionCandidate | null>(null);
  const lastFocusRequest = useRef(0);
  const tree = useMemo(() => extractSections(document.content), [document.content]);
  const cardContent = useMemo(() => createCanvasCardContentCache(document.content, tree), [document.content, tree]);
  const readOnly = dirty || Boolean(document.recoveryPending) || busy || layoutPending || Boolean(readError) || Boolean(exporting) || Boolean(structurePreview) || structureBusy;

  useEffect(() => {
    const status: PartStatus = readError ? { text: '未能载入或保存，请检查画布提示', tone: 'error' }
      : document.recoveryPending ? { text: '需要恢复', tone: 'error' }
      : dirty ? { text: '等待正文保存', tone: 'neutral' }
      : layoutPending ? { text: '加载中', tone: 'busy' }
      : busy ? { text: '处理中', tone: 'busy' }
      : unresolvedIds.length || unresolvedLinkIds.length ? { text: '有章节或箭头待修复', tone: 'warning' }
      : loadWarning ? { text: '布局需要检查', tone: 'warning' }
      : { text: sidecarHash ? '已载入' : '临时布局，尚未保存', tone: 'neutral' };
    onStatusChange?.(document.path, document.sourceSha256, status);
  }, [onStatusChange, document.path, document.sourceSha256, document.recoveryPending, dirty, readError, layoutPending, busy, unresolvedIds.length, unresolvedLinkIds.length, loadWarning, sidecarHash]);

  useEffect(() => {
    const current = ++generation.current;
    setModel(null); setLayoutPending(true); setReadError(null); setLoadWarning(null); setBusy(false); setMessage('正在加载画布…'); setHistory([]); setFuture([]); setMinimumHeights({}); setSelectedLink(null); setSelectedCardId(null);
    void (async () => {
      const loadedResult = await window.mermarkd.loadCanvasV2();
      const sidecarInvalid = loadedResult.status === 'invalid';
      const loaded = sidecarInvalid ? { ...loadedResult, model: null, sidecarSha256: null, sourceVersion: null } : loadedResult;
      const bytes = encodeMarkdownBytes(document.content, document.bomByteLength);
      const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes));
      const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
      sourceVersion.current = loaded.sourceVersion ?? 1;
      let reconciled = await reconcileCanvasStateV2(loaded.model, { bytes, content: document.content, sha256 });
      let loadWarningText = sidecarInvalid ? '画布文件无法安全载入，已使用当前 Markdown 重新生成临时布局，原文件未修改。' : null;
      let initial = reconciled.model;
      const oldIds = new Set(loaded.model?.cards.map((card) => card.id) ?? []);
      const hasNewCards = reconciled.bindings.some((binding) => !oldIds.has(binding.id));
      const sourceChanged = Boolean(loaded.model && loaded.model.source.sha256 !== sha256);
      const boundCards = initial.cards.filter((card) => reconciled.bindings.some((binding) => binding.id === card.id));
      const allCardsAtOrigin = boundCards.length > 0 && boundCards.every((card) => card.position.x === 0 && card.position.y === 0);
      const rootIds = new Set(reconciled.bindings.filter((binding) => binding.sectionIndex === null || tree.sections[binding.sectionIndex]?.parentIndex === null).map((binding) => binding.id));
      const rootAtCorner = boundCards.some((card) => rootIds.has(card.id) && card.position.x < 32 && card.position.y < 32);
      const needsArrangement = loaded.model === null || hasNewCards || (sourceChanged && reconciled.unresolvedCardIds.length > 0) || allCardsAtOrigin || rootAtCorner;
      if (needsArrangement) initial = await arrangeCanvasV2(tree, initial, reconciled.bindings);
      const initialScene = buildCanvasSceneV2(document.content, tree, initial, reconciled.bindings, {}, cardContent);
      const viewportValid = loaded.model !== null && isCanvasViewportVisible(loaded.model.viewport, initialScene.cards);
      if (loaded.model && !viewportValid && !needsArrangement) loadWarningText ??= '已保存的画布视口不再覆盖当前卡片，已自动定位到当前布局。';
      if (loaded.model && needsArrangement && (sourceChanged || hasNewCards || rootAtCorner)) loadWarningText ??= '检测到卡片位置未初始化或文档结构已变化，已自动整理当前章节。';
      if (generation.current !== current) return;
      initialLayout.current = needsArrangement;
      setModel(initial); setBindings(reconciled.bindings); setUnresolvedIds(reconciled.unresolvedCardIds);
      setUnresolvedLinkIds(reconciled.unresolvedLinkIds); setSidecarHash(loaded.sidecarSha256); setLoadWarning(loadWarningText);
      setMessage(dirty ? '未保存结构预览 · 画布写入已暂停' : needsArrangement ? '正在整理画布布局…' : loaded.model === null ? '初始布局 · 尚未创建画布文件' : loaded.sourceVersion === 1 ? '旧版画布已迁移到内存 v2' : '画布 v2 已载入');
      setFrom(reconciled.bindings[0]?.id ?? ''); setTo(reconciled.bindings[1]?.id ?? reconciled.bindings[0]?.id ?? '');
      requestAnimationFrame(() => {
        if (generation.current !== current || !loaded.model || needsArrangement) return;
        const done = viewportValid ? flow.setViewport(loaded.model.viewport) : flow.fitView({ padding: 0.15 });
        void done.then(() => {
          if (generation.current !== current) return;
          const viewport = flow.getViewport();
          setModel((previous) => previous ? { ...previous, viewport } : previous);
          setLayoutPending(false);
        });
      });
    })().catch(() => { if (generation.current === current) { setLayoutPending(false); setReadError('画布无法载入，原文件未修改；请重新载入或检查 Markdown。'); setMessage('画布未载入'); } });
    return () => { generation.current += 1; };
  }, [document.path, document.content, document.bomByteLength, dirty, loadRevision, tree, cardContent]);

  useEffect(() => {
    if (!initialLayout.current || !model || bindings.some((binding) => !minimumHeights[binding.id])) return;
    initialLayout.current = false;
    const current = generation.current;
    void arrangeCanvasV2(tree, model, bindings, minimumHeights).then((next) => {
      if (generation.current !== current) return;
      setModel(next);
      setTimeout(() => { if (generation.current === current) void flow.fitView({ padding: 0.15 })
        .then(() => {
          if (generation.current !== current) return;
          const viewport = flow.getViewport();
          setModel((previous) => previous ? { ...previous, viewport } : previous);
          setLayoutPending(false);
          setMessage(dirty ? '未保存结构预览 · 画布写入已暂停' : '布局已就绪 · 尚未保存');
        }); }, 50);
    }).catch(() => { if (generation.current === current) { setLayoutPending(false); setReadError('初始布局失败，请重新载入画布。'); } });
  }, [bindings, dirty, minimumHeights, model, tree]);

  const persist = useCallback(async (next: CanvasStateV2, remember = true) => {
    if (!model || readOnly || saveInFlight.current) return false;
    const current = generation.current;
    saveInFlight.current = true;
    setBusy(true); setModel(next); setMessage('正在保存画布…');
    try {
      const needsV2 = sourceVersion.current === 2 || next.cards.some((card) => card.bodyDisplay !== 'preview' || card.contentPosition.x !== 0 || card.contentPosition.y !== 0 ||
        card.size !== undefined && (card.size.width !== CANVAS_DEFAULT_CARD_SIZE.width || card.size.height !== CANVAS_DEFAULT_CARD_SIZE.height));
      const result = needsV2
        ? await window.mermarkd.saveCanvasV2({ sourceSha256: document.sourceSha256, expectedSidecarSha256: sidecarHash, model: next })
        : await window.mermarkd.saveCanvas({ sourceSha256: document.sourceSha256, expectedSidecarSha256: sidecarHash, model: projectCanvasStateV2ToV1(next) });
      if (generation.current !== current) return false;
      if (result.status !== 'saved') { setReadError(result.reason ?? '画布未保存，请重新载入。'); setMessage(result.reason ?? '画布未保存'); return false; }
      sourceVersion.current = needsV2 ? 2 : 1;
      if (remember) { setHistory((previous) => [...previous.slice(-49), model]); setFuture([]); }
      setModel(next); setSidecarHash(result.sidecarSha256 ?? null); setLoadWarning(null); setMessage('画布已保存 · Markdown 未改动');
      return true;
    } catch { if (generation.current === current) { setReadError('画布保存失败，请重新载入。'); setMessage('画布保存失败，原文未修改。'); } }
    finally { saveInFlight.current = false; if (generation.current === current) setBusy(false); }
  }, [document.sourceSha256, model, readOnly, sidecarHash]);

  const measured = useCallback((id: string, height: number) => {
    setMinimumHeights((previous) => previous[id] === height ? previous : { ...previous, [id]: height });
  }, []);
  const scene = useMemo(() => model ? buildCanvasSceneV2(document.content, tree, model, bindings, minimumHeights, cardContent) : null, [bindings, document.content, minimumHeights, model, tree, cardContent]);
  useEffect(() => {
    if (activeSection !== null) {
      setSelectedCardId(bindings.find(binding => binding.sectionIndex === activeSection)?.id ?? null);
      setSelectedLink(null);
      setStructureSource(String(activeSection));
    }
  }, [activeSection, bindings, focusRequest]);
  const selectCard = (id: string) => {
    const binding = bindings.find(item => item.id === id);
    setSelectedCardId(binding ? id : null); setSelectedLink(null);
    setStructureSource(binding?.sectionIndex === null || binding?.sectionIndex === undefined ? '' : String(binding.sectionIndex));
    if (binding) onSectionChange(binding.sectionIndex);
  };
  const selectLink = (id: string) => {
    const link = model?.links.find(item => item.id === id);
    setSelectedCardId(null); setSelectedLink(link?.id ?? null); setSelectedLinkLabel(link?.label ?? '');
  };
  const updateDragFeedback = useCallback((event: unknown, node: ChapterNode) => {
    feedbackAt.current = performance.now();
    const sourceIndex = bindings.find((binding) => binding.id === node.id)?.sectionIndex ?? null;
    const start = dragStart.current;
    const sourceDomRect = domRectForNode(node.id);
    const pointer = pointerForEvent(event);
    const sourceRect = start?.nodeId === node.id && start.screenRect && pointer && start.pointer
      ? { ...start.screenRect, x: start.screenRect.x + pointer.x - start.pointer.x,
          y: start.screenRect.y + pointer.y - start.pointer.y }
      : start?.nodeId === node.id && start.screenRect
        ? { ...start.screenRect, x: start.screenRect.x + (node.position.x - start.position.x) * flow.getViewport().zoom,
            y: start.screenRect.y + (node.position.y - start.position.y) * flow.getViewport().zoom }
      : sourceDomRect;
    if (!sourceRect || !scene || sourceIndex === null) return;
    const isDescendant = (candidateIndex: number): boolean => {
      let parent = tree.sections[candidateIndex]?.parentIndex ?? null;
      while (parent !== null) {
        if (parent === sourceIndex) return true;
        parent = tree.sections[parent]?.parentIndex ?? null;
      }
      return false;
    };
    const targets = scene.cards.flatMap((card) => {
      if (card.id === node.id || card.hidden || card.sectionIndex === null || card.sectionIndex === sourceIndex ||
          card.sectionIndex === tree.sections[sourceIndex]?.parentIndex || isDescendant(card.sectionIndex)) return [];
      const rect = domRectForNode(card.id);
      return rect ? [{ id: card.id, rect, sectionIndex: card.sectionIndex }] : [];
    });
    const candidate = findCanvasOverlapCandidate({ id: node.id, rect: sourceRect, sectionIndex: sourceIndex }, targets,
      { minimumRatio: 0.35, readyRatio: 0.5, dwellMs: 280, minimumArea: 1200 });
    const overlap = updateCanvasOverlapDwell(nestDwell.current, candidate, performance.now(),
      { minimumRatio: 0.35, readyRatio: 0.5, dwellMs: 280, minimumArea: 1200 });
    nestDwell.current = overlap.state;
    const nextNest = candidate ? { ...candidate, status: overlap.status === 'ready' ? 'ready' as const : 'candidate' as const, dwellMs: overlap.dwellMs } : null;
    nestCandidateRef.current = nextNest;
    setNestCandidate(nextNest);
    if (nextNest || !start?.parentId) {
      detachDwell.current = null;
      detachCandidateRef.current = null;
      setDetachCandidate(null);
      return;
    }
    const parentRect = domRectForNode(start.parentId);
    if (!parentRect) return;
    const sample = evaluateDragOutPromotion(tree, sourceIndex, sourceRect, parentRect, { destination: 'top-level' });
    const promotion = classifyDragOutPromotion(sample, detachDwell.current, node.id, performance.now(),
      { minimumEscapeRatio: 0.35, readyEscapeRatio: 0.7, dwellMs: 280 });
    detachDwell.current = promotion.state;
    const nextDetach = promotion.candidate;
    detachCandidateRef.current = nextDetach;
    setDetachCandidate(nextDetach);
  }, [bindings, flow, scene, tree]);

  useEffect(() => {
    if (!model || !scene) { setNodes([]); return; }
    setNodes(scene.cards.map((card): ChapterNode => {
      const titlePath: string[] = [];
      let pathIndex = card.sectionIndex;
      while (pathIndex !== null && pathIndex !== undefined) {
        const pathSection = tree.sections[pathIndex];
        if (!pathSection) break;
        titlePath.unshift(pathSection.title);
        pathIndex = pathSection.parentIndex;
      }
      return { id: card.id, type: 'chapter', parentId: card.parentId, position: card.position,
        hidden: card.hidden, selected: card.id === selectedCardId && !selectedLink,
        draggable: !readOnly, connectable: !readOnly, style: { width: card.width, height: card.height },
        data: { ...cardContent.get(card.sectionIndex), pathLabel: titlePath.join(' / ') || (card.sectionIndex === null ? '文档' : '未命名章节'), sectionIndex: card.sectionIndex, hiddenDescendants: card.hiddenDescendants,
          bodyDisplay: card.bodyDisplay, contentPosition: card.contentPosition, size: card.size ?? CANVAS_DEFAULT_CARD_SIZE, descendantsCollapsed: card.descendantsCollapsed, readOnly,
          fold: () => { void persist({ ...model, cards: model.cards.map((item) => item.id === card.id ? { ...item, descendantsCollapsed: !item.descendantsCollapsed } : item) }); },
          edit: () => onEditSection(card.sectionIndex),
          properties: onOpenProperties,
          hiddenLinks: scene.links.filter(link => link.hiddenEndpoint && (link.from === card.id || link.to === card.id)).length,
          measure: (height) => measured(card.id, height) } };
    }));
  }, [selectedCardId, selectedLink, cardContent, measured, model, onEditSection, onOpenProperties, persist, readOnly, scene, tree]);

  useEffect(() => {
    setNodes((previous) => previous.map((node) => ({ ...node, data: {
      ...node.data,
      nestStatus: nestCandidate?.targetId === node.id ? nestCandidate.status : undefined,
      detachStatus: detachCandidate?.sourceIndex === node.data.sectionIndex ? detachCandidate.status : undefined,
    } })));
  }, [detachCandidate, nestCandidate]);

  const edges = useMemo((): Edge[] => scene?.links.map((link) => ({ id: link.id, source: link.from, target: link.to,
    label: `${link.label}${link.hiddenEndpoint ? '（隐藏端点）' : ''}`, markerEnd: { type: MarkerType.ArrowClosed },
    selected: selectedLink === link.id, style: { stroke: link.hiddenEndpoint ? '#b27718' : '#327766', strokeWidth: 2 },
    labelBgStyle: { fill: '#fff' } })) ?? [], [scene, selectedLink]);

  const addLink = useCallback((connection: Pick<Connection, 'source' | 'target'>) => {
    if (!model || !connection.source || !connection.target || readOnly) return;
    void persist({ ...model, links: [...model.links, { id: crypto.randomUUID(), from: connection.source, to: connection.target, label }] });
  }, [label, model, persist, readOnly]);
  const titleFor = (id: string) => {
    const node = nodes.find(item => item.id === id);
    if (!node) return '未定位章节';
    return node.data.sectionIndex === null ? node.data.title : (node.data.sectionIndex + 1) + '. ' + node.data.pathLabel;
  };
  const currentCard = nodes.find((node) => node.selected);
  const currentModelCard = currentCard && model?.cards.find((card) => card.id === currentCard.id);
  const updateCardSize = useCallback((dimension: 'width' | 'height', rawValue: string) => {
    if (!model || readOnly || !currentCard) return;
    const value = Number(rawValue);
    if (!Number.isFinite(value)) return;
    const limits = dimension === 'width'
      ? { min: CANVAS_CARD_SIZE_LIMITS.minWidth, max: CANVAS_CARD_SIZE_LIMITS.maxWidth }
      : { min: CANVAS_CARD_SIZE_LIMITS.minHeight, max: CANVAS_CARD_SIZE_LIMITS.maxHeight };
    const clamped = Math.min(limits.max, Math.max(limits.min, Math.round(value)));
    const current = currentModelCard?.size ?? CANVAS_DEFAULT_CARD_SIZE;
    if (current[dimension] === clamped) return;
    void persist({ ...model, cards: model.cards.map((card) => card.id === currentCard.id
      ? { ...card, size: { ...current, [dimension]: clamped } } : card) });
  }, [currentCard, currentModelCard?.size, model, persist, readOnly]);
  useEffect(() => {
    if (!focusRequest || lastFocusRequest.current === focusRequest || layoutPending) return;
    let node = nodes.find((item) => item.data.sectionIndex === activeSection);
    while (node?.hidden && node.parentId) node = nodes.find((item) => item.id === node!.parentId);
    if (!node || node.hidden) return;
    lastFocusRequest.current = focusRequest;
    void flow.fitView({ nodes: [{ id: node.id }], padding: 0.4 });
  }, [activeSection, flow, focusRequest, layoutPending, nodes]);
  const requestStructure = useCallback(async (operation: SectionTransformOperation): Promise<boolean> => {
    if (readOnly || saveInFlight.current) return false;
    const current = generation.current;
    setBusy(true); setMessage('正在核验结构变更…');
    try {
      await onStructurePreview(operation);
      if (generation.current !== current) return false;
      setMessage('结构预览已完成 · Markdown 未改动'); return true;
    } catch (error) {
      if (generation.current === current) setMessage(error instanceof Error ? error.message : '结构预览失败，请重新检查文档。');
      return false;
    } finally { if (generation.current === current) setBusy(false); }
  }, [onStructurePreview, readOnly]);
  const exportPreflight = useMemo(() => {
    if (!scene) return null;
    try { return preflightCanvasExport(scene.cards, scene.links, { padding: 48 }); }
    catch { return null; }
  }, [scene]);
  const searchMatches = nodes.filter((node) => !node.hidden && node.data.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const exportCanvas = useCallback(async (format: 'png' | 'jpg' | 'pdf') => {
    if (!scene || !exportPreflight?.allowed || exporting || readOnly || busy || Boolean(readError)) return;
    setExporting(format); setExportMessage(null);
    try {
      const cards = scene.cards.map(({ contentPosition: _contentPosition, size: _size, bodyDisplay: _bodyDisplay, descendantsCollapsed: _descendantsCollapsed, ...card }) => card);
      const result = await window.mermarkd.exportCanvas({ sourceSha256: document.sourceSha256, format, cards, links: scene.links, padding: 48, background: '#f3f6f8' });
      if (result.status === 'saved') setExportMessage(`已导出 ${format.toUpperCase()} · ${result.width} × ${result.height}`);
      else if (result.status === 'error') setExportMessage(result.reason);
    } catch (error) {
      setExportMessage(error instanceof Error ? error.message : '画布导出失败。');
    } finally {
      setExporting(null);
    }
  }, [busy, document.sourceSha256, exporting, exportPreflight, readError, readOnly, scene]);

  return <main className="canvas-mode" data-canvas-view="true">
    <div ref={toolbar} className="canvas-toolbar" role="toolbar" aria-label="画布工具">
      <div className="canvas-toolbar-group canvas-toolbar-primary" role="group" aria-label="视图导航">
        <button className="canvas-toolbar-labeled" title="适应全图" aria-label="适应全图" onClick={() => void flow.fitView({ padding: 0.15 })}><Focus size={17} /><span>适应</span></button>
        <button className="canvas-toolbar-labeled" title="定位当前卡片" aria-label="定位当前卡片" disabled={!currentCard} onClick={() => currentCard && void flow.fitView({ nodes: [{ id: currentCard.id }], padding: 0.4 })}><Crosshair size={17} /><span>定位</span></button>
        <button className="canvas-toolbar-icon" title="放大" aria-label="放大" onClick={() => void flow.zoomIn()}><ZoomIn size={18} /></button>
        <button className="canvas-toolbar-icon" title="缩小" aria-label="缩小" onClick={() => void flow.zoomOut()}><ZoomOut size={18} /></button>
      </div>
      <details className="canvas-toolbar-more">
        <summary title="更多画布操作"><MoreHorizontal size={18} aria-hidden="true" /><span>更多</span></summary>
        <div className="canvas-toolbar-more-menu" role="group" aria-label="更多画布操作">
          <button className="canvas-toolbar-labeled" title="自动整理" aria-label="自动整理" data-canvas-arrange="true" disabled={!model || readOnly} onClick={() => {
            if (model) void arrangeCanvasV2(tree, model, bindings, minimumHeights).then((next) => persist(next));
          }}><LayoutGrid size={17} /><span>自动整理</span></button>
          <button className="canvas-toolbar-labeled" title="全部展开" aria-label="全部展开" data-canvas-expand="true" disabled={!model || readOnly} onClick={() => model && void persist({ ...model, cards: model.cards.map((card) => ({ ...card, descendantsCollapsed: false })) })}><ArrowDownToLine size={17} /><span>全部展开</span></button>
          <button className="canvas-toolbar-labeled" title="全部收起" aria-label="全部收起" data-canvas-collapse="true" disabled={!model || readOnly} onClick={() => model && void persist({ ...model, cards: model.cards.map((card) => ({ ...card, descendantsCollapsed: true })) })}><ArrowUpToLine size={17} /><span>全部收起</span></button>
          <button className="canvas-toolbar-labeled" title="撤销画布操作" aria-label="撤销画布操作" data-canvas-undo="true" disabled={!history.length || readOnly} onClick={() => {
            const previous = history.at(-1); if (previous && model) void persist(previous, false).then((saved) => { if (saved) { setHistory((items) => items.slice(0, -1)); setFuture((items) => [...items, model]); } });
          }}><RotateCcw size={17} /><span>撤销</span></button>
          <button className="canvas-toolbar-labeled" title="重做画布操作" aria-label="重做画布操作" data-canvas-redo="true" disabled={!future.length || readOnly} onClick={() => {
            const next = future.at(-1); if (next && model) void persist(next, false).then((saved) => { if (saved) { setFuture((items) => items.slice(0, -1)); setHistory((items) => [...items, model]); } });
          }}><Redo2 size={17} /><span>重做</span></button>
        </div>
      </details>
      <button className="canvas-toolbar-labeled canvas-toolbar-save" title="保存布局与当前视口" aria-label="保存布局与当前视口" data-canvas-save="true" disabled={!model || readOnly}
        onClick={() => model && void persist({ ...model, viewport: flow.getViewport() })}><Save size={17} /><span>保存</span></button>
      <details className="canvas-toolbar-exports">
        <summary title="导出画布"><FileDown size={17} aria-hidden="true" /><span>导出</span></summary>
        <div className="canvas-toolbar-export-menu" role="group" aria-label="导出画布">
          <div className="canvas-export-info" data-canvas-export-preflight="true">
            <strong>导出完整画布</strong>
            <p>包含视口外的卡片、箭头和标签，保留当前折叠状态。</p>
            {exportPreflight ? <>
              <p>{exportPreflight.visibleCardCount} 张卡片 · {exportPreflight.linkCount} 条关系{exportPreflight.hiddenCardCount > 0 ? ' · ' + exportPreflight.hiddenCardCount + ' 张已收起' : ''}</p>
              <p>{exportPreflight.width} × {exportPreflight.height} px</p>
              {!exportPreflight.allowed && <p role="alert">{exportPreflight.reason}</p>}
            </> : <p>等待画布范围就绪。</p>}
          </div>
          <button className="canvas-toolbar-labeled" title="导出 PNG" aria-label="导出 PNG" data-canvas-export="png" disabled={!exportPreflight?.allowed || readOnly}
            onClick={() => void exportCanvas('png')}>{exporting === 'png' ? <RefreshCw className="spin" size={17} /> : <ImageDown size={17} />}<span>PNG</span></button>
          <button className="canvas-toolbar-labeled" title="导出 JPG" aria-label="导出 JPG" data-canvas-export="jpg" disabled={!exportPreflight?.allowed || readOnly}
            onClick={() => void exportCanvas('jpg')}>{exporting === 'jpg' ? <RefreshCw className="spin" size={17} /> : <ImageDown size={17} />}<span>JPG</span></button>
          <button className="canvas-toolbar-labeled" title="导出 PDF" aria-label="导出 PDF" data-canvas-export="pdf" disabled={!exportPreflight?.allowed || readOnly}
            onClick={() => void exportCanvas('pdf')}>{exporting === 'pdf' ? <RefreshCw className="spin" size={17} /> : <FileDown size={17} />}<span>PDF</span></button>
        </div>
      </details>
      <label className="canvas-search">查找卡片<input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
        if (event.key === 'Enter' && searchMatches[0]) void flow.fitView({ nodes: [{ id: searchMatches[0].id }], padding: 0.4 });
      }} /></label>
      <output role="status" data-canvas-status="true">{exporting ? `正在导出 ${exporting.toUpperCase()}…` : exportMessage ?? (draggingId && nestCandidate
        ? `${nestCandidate.status === 'ready' ? '松开' : '继续'}以预览设为子章节 · 重叠 ${Math.round(nestCandidate.overlapRatio * 100)}%`
        : draggingId && detachCandidate
          ? `${detachCandidate.status === 'ready' ? '松开' : '继续'}以预览移出父章节 · 已移出 ${Math.round(detachCandidate.escapeRatio * 100)}%`
          : busy ? '正在保存…' : message)}</output>
    </div>
    {loadWarning && <div className="canvas-warning canvas-warning-info" role="status">{loadWarning}</div>}
    {readError && <div className="canvas-warning" role="alert">{readError}
      <button title="放弃当前未保存画布候选并重新载入" onClick={() => setLoadRevision((value) => value + 1)}><RefreshCw size={15} /> 重新载入画布</button>
    </div>}
    {(dirty || canRedoSource) && <div className="canvas-warning canvas-source-history" role="status">
      <span>{dirty ? '正文修改尚未保存；保存或撤销后可继续调整画布。' : '正文修改已撤销，可重做。'}</span>
      <button type="button" data-canvas-source-undo="true" disabled={!canUndoSource || structureBusy || Boolean(structurePreview)} onClick={onUndoSource}>撤销正文修改</button>
      <button type="button" data-canvas-source-redo="true" disabled={!canRedoSource || structureBusy || Boolean(structurePreview)} onClick={onRedoSource}>重做正文修改</button>
    </div>}
    <div className="canvas-workspace">
      <div className="canvas-flow" data-canvas-flow="true">
        <ReactFlow<ChapterNode> nodes={nodes} edges={edges} nodeTypes={nodeTypes} minZoom={0.05} maxZoom={8}
          nodesDraggable={!readOnly} nodesConnectable={!readOnly} edgesReconnectable={false} deleteKeyCode={null}
          panOnDrag={[1, 2]} panActivationKeyCode="Space" selectionOnDrag
          onNodesChange={(changes) => {
            setNodes(previous => applyNodeChanges(changes, previous));
            const chosen = changes.find(change => change.type === 'select' && change.selected);
            if (chosen && chosen.type === 'select' && chosen.id !== selectedCardId) selectCard(chosen.id);
          }}
          onNodeClick={(_event, node) => selectCard(node.id)}
          onNodeDragStart={(event, node) => {
            const sourceIndex = bindings.find((binding) => binding.id === node.id)?.sectionIndex ?? null;
            dragStart.current = { nodeId: node.id, sectionIndex: sourceIndex, position: { ...node.position }, screenRect: domRectForNode(node.id) ?? undefined,
              pointer: pointerForEvent(event) ?? undefined,
              ...(node.parentId ? { parentId: node.parentId } : {}) };
            nestDwell.current = null; detachDwell.current = null;
            nestCandidateRef.current = null; detachCandidateRef.current = null;
            setNestCandidate(null); setDetachCandidate(null); setDraggingId(node.id);
          }}
          onNodeDrag={(event, node) => updateDragFeedback(event, node)}
          onNodeDragStop={(_event, node) => {
            if (!model || readOnly) return;
            const sourceIndex = bindings.find((binding) => binding.id === node.id)?.sectionIndex;
            const start = dragStart.current;
            const now = performance.now();
            const candidate = nestCandidateRef.current;
            const candidateReady = candidate && candidate.overlapRatio >= 0.5 &&
              candidate.dwellMs + Math.max(0, now - feedbackAt.current) >= 280
              ? { ...candidate, status: 'ready' as const } : candidate;
            const detach = detachCandidateRef.current;
            const detachReady = detach && detach.escapeRatio >= 0.7 &&
              detach.dwellMs + Math.max(0, now - feedbackAt.current) >= 280
              ? { ...detach, status: 'ready' as const } : detach;
            const dragGeneration = generation.current;
            const clearDrag = () => {
              if (generation.current !== dragGeneration) return;
              dragStart.current = null; nestDwell.current = null; detachDwell.current = null;
              nestCandidateRef.current = null; detachCandidateRef.current = null;
              setNestCandidate(null); setDetachCandidate(null); setDraggingId(null);
            };
            if (sourceIndex !== null && sourceIndex !== undefined && candidateReady?.status === 'ready') {
              void requestStructure({ kind: 'move', sourceIndex, targetIndex: bindings.find((binding) => binding.id === candidateReady.targetId)?.sectionIndex ?? -1 })
                .then(() => { if (generation.current !== dragGeneration) return; if (start) setNodes((items) => items.map((item) => item.id === node.id ? { ...item, position: start.position } : item)); clearDrag(); });
              return;
            }
            if (sourceIndex !== null && sourceIndex !== undefined && detachReady?.status === 'ready') {
              void requestStructure(detachReady.operation)
                .then(() => { if (generation.current !== dragGeneration) return; if (start) setNodes((items) => items.map((item) => item.id === node.id ? { ...item, position: start.position } : item)); clearDrag(); });
              return;
            }
            void persist({ ...model, cards: model.cards.map((card) => card.id === node.id
              ? { ...card, position: { x: Math.max(card.anchor.kind === 'heading' && node.parentId ? 24 : -1_000_000, node.position.x),
                y: Math.max(node.parentId ? Math.max(150, minimumHeights[node.parentId] ?? 150) : -1_000_000, node.position.y) } } : card) })
              .finally(clearDrag);
          }}
          onConnect={addLink} onEdgeClick={(_event, edge) => selectLink(edge.id)}
          onPaneClick={() => { setSelectedLink(null); setSelectedCardId(null); }}
          onMoveEnd={(event, viewport) => { if (event && model && !readOnly) void persist({ ...model, viewport }); }}
          proOptions={{ hideAttribution: true }}>
          <Background variant={BackgroundVariant.Lines} color="#e3e8ed" gap={32} />
        </ReactFlow>
      </div>
      <WorkspaceTaskPanel><section className="canvas-properties" aria-label="卡片与关系">
        {structurePreview ? <CanvasStructurePreview preview={structurePreview} busy={structureBusy}
          stale={structurePreview.source !== document.content || dirty}
          onConfirm={() => void onConfirmStructure()} onCancel={onCancelStructure} /> : <>
          <h2>{selectedLink ? '箭头' : currentCard ? '章节卡片' : '画布'}</h2>
          <label>选择卡片<select data-canvas-card-picker="true" value={currentCard?.id ?? ''}
            onChange={event => selectCard(event.target.value)}>
            <option value="">选择一张卡片</option>{bindings.map(item => <option value={item.id} key={item.id}>{titleFor(item.id)}</option>)}
          </select></label>
          {Boolean(model?.links.length) && <label>选择箭头<select data-canvas-link-picker="true" value={selectedLink ?? ''}
            onChange={event => selectLink(event.target.value)}>
            <option value="">选择一条箭头</option>{model?.links.map(link => <option key={link.id} value={link.id}>
              {link.label || '未命名箭头'} · {titleFor(link.from)} → {titleFor(link.to)}
            </option>)}
          </select></label>}
          {selectedLink ? <div className="canvas-link-inspector" data-canvas-link-inspector="true">
            <p>{titleFor(model?.links.find(link => link.id === selectedLink)?.from ?? '')} → {titleFor(model?.links.find(link => link.id === selectedLink)?.to ?? '')}</p>
            <label>箭头标签<input data-canvas-selected-link-label="true" value={selectedLinkLabel} maxLength={100} disabled={readOnly}
              onChange={event => setSelectedLinkLabel(event.target.value)} /></label>
            <div className="canvas-link-actions">
              <button data-canvas-update-link="true" disabled={readOnly} onClick={() => model && void persist({ ...model,
                links: model.links.map(link => link.id === selectedLink ? { ...link, label: selectedLinkLabel } : link) })}><Link2 size={16} /> 保存标签</button>
              <button data-canvas-delete-link="true" disabled={readOnly} onClick={() => {
                if (model) void persist({ ...model, links: model.links.filter(link => link.id !== selectedLink) }); setSelectedLink(null);
              }}><Trash2 size={16} /> 删除箭头</button>
            </div>
          </div> : <>
            {currentCard && currentModelCard ? <div data-canvas-card-inspector="true">
              <p className="canvas-inspector-path">{currentCard.data.pathLabel}</p>
              <button onClick={currentCard.data.edit}><FilePenLine size={16} /> 编辑本节</button>
              <label>正文显示<select data-canvas-body-display="true" value={currentModelCard.bodyDisplay} disabled={readOnly}
                onChange={event => model && void persist({ ...model, cards: model.cards.map(card => card.id === currentCard.id
                  ? { ...card, bodyDisplay: event.target.value as CanvasBodyDisplay } : card) })}>
                <option value="hidden">只显示标题</option><option value="preview">正文摘要</option><option value="full">全部正文</option>
              </select></label>
              {currentCard.data.childCount > 0 && <button disabled={readOnly} onClick={currentCard.data.fold}>
                {currentCard.data.descendantsCollapsed ? '展开子章节' : '收起子章节'}
              </button>}
              <details className="canvas-inspector-section" data-canvas-size-tools="true"><summary>卡片尺寸</summary>
                <label>宽度（px）<input type="number" min={CANVAS_CARD_SIZE_LIMITS.minWidth} max={CANVAS_CARD_SIZE_LIMITS.maxWidth} step={8}
                  value={currentModelCard.size?.width ?? CANVAS_DEFAULT_CARD_SIZE.width} disabled={readOnly}
                  onChange={event => updateCardSize('width', event.target.value)} /></label>
                <label>高度（px）<input type="number" min={CANVAS_CARD_SIZE_LIMITS.minHeight} max={CANVAS_CARD_SIZE_LIMITS.maxHeight} step={8}
                  value={currentModelCard.size?.height ?? CANVAS_DEFAULT_CARD_SIZE.height} disabled={readOnly}
                  onChange={event => updateCardSize('height', event.target.value)} /></label>
              </details>
            </div> : <p className="canvas-structure-hint">选择卡片或箭头，查看对应操作。</p>}
            <details className="canvas-inspector-section" data-canvas-structure-tools="true"><summary>调整章节结构</summary>
              <p className="canvas-structure-hint">先预览章节位置和标题级别，确认后可撤销。</p>
              <label>移动章节<select data-canvas-structure-source="true" value={structureSource} disabled={readOnly}
                onChange={event => setStructureSource(event.target.value)}>
                <option value="">选择章节</option>{tree.sections.map(section => <option key={section.index} value={section.index}>
                  {titleFor(bindings.find(binding => binding.sectionIndex === section.index)?.id ?? '')} · {section.depth} 级
                </option>)}
              </select></label>
              <label>新父章节<select data-canvas-structure-parent="true" value={structureTarget} disabled={readOnly}
                onChange={event => setStructureTarget(event.target.value)}>
                <option value="">选择章节</option>{tree.sections.map(section => <option key={section.index} value={section.index}>
                  {titleFor(bindings.find(binding => binding.sectionIndex === section.index)?.id ?? '')} · {section.depth} 级
                </option>)}
              </select></label>
              <button data-canvas-preview-structure="true" disabled={readOnly || !structureSource || !structureTarget}
                onClick={() => void requestStructure({ kind: 'move', sourceIndex: Number(structureSource), targetIndex: Number(structureTarget) })}>预览设为子章节</button>
              <button data-canvas-preview-promote="true" disabled={readOnly || !structureSource || tree.sections[Number(structureSource)]?.depth <= 1}
                onClick={() => void requestStructure({ kind: 'promote', sectionIndex: Number(structureSource), targetDepth: tree.sections[Number(structureSource)].depth - 1 })}>预览提升一级</button>
            </details>
          </>}
          <div hidden={Boolean(selectedLink)}><details className="canvas-inspector-section" data-canvas-link-composer="true"><summary>添加箭头</summary>
            <label>起点<select data-canvas-link-from="true" value={from} disabled={readOnly} onChange={event => setFrom(event.target.value)}>
              {bindings.map(item => <option value={item.id} key={item.id}>{titleFor(item.id)}</option>)}
            </select></label>
            <label>终点<select data-canvas-link-to="true" value={to} disabled={readOnly} onChange={event => setTo(event.target.value)}>
              {bindings.map(item => <option value={item.id} key={item.id}>{titleFor(item.id)}</option>)}
            </select></label>
            <label>连线标签<input data-canvas-link-label="true" value={label} maxLength={100} disabled={readOnly} onChange={event => setLabel(event.target.value)} /></label>
            <button data-canvas-add-link="true" disabled={!model || !from || !to || readOnly} onClick={() => addLink({ source: from, target: to })}><Plus size={16} /> 添加箭头</button>
          </details></div>
          <p className="canvas-inspector-total">{bindings.length} 张卡片{Boolean(model?.links.length) && ' · ' + model?.links.length + ' 条箭头'}</p>
        </>}
        {(unresolvedIds.length > 0 || unresolvedLinkIds.length > 0) && <div className="canvas-unresolved" role="status">
          <h3>待修复</h3><p>{unresolvedIds.length} 张卡片、{unresolvedLinkIds.length} 条箭头无法确定原章节，已保留原端点。</p>
          <ul>{unresolvedIds.map(id => <li key={id}>{model?.cards.find(card => card.id === id)?.anchor.kind === 'heading'
            ? (model.cards.find(card => card.id === id)!.anchor as { titlePath: readonly string[] }).titlePath.join(' / ') : '原虚拟卡片'}</li>)}</ul>
        </div>}
      </section></WorkspaceTaskPanel>
    </div>
  </main>;
}

export function CanvasView(props: CanvasViewProps) {
  return <ReactFlowProvider><CanvasEditor {...props} /></ReactFlowProvider>;
}
