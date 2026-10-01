import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { applyNodeChanges, Background, BackgroundVariant, Handle, MarkerType, Position, ReactFlow, ReactFlowProvider, useReactFlow } from '@xyflow/react';
import type { Connection, Edge, Node, NodeProps, NodeTypes } from '@xyflow/react';
import { ArrowDownToLine, ArrowUpToLine, BookOpen, Crosshair, EyeOff, FileDown, FilePenLine, Focus, ImageDown, LayoutGrid, Link2, Plus, Redo2, RefreshCw, RotateCcw, Save, Trash2, ZoomIn, ZoomOut } from 'lucide-react';
import { canvasCardContent } from '../core/canvas-card-content';
import { buildCanvasSceneV2 } from '../core/canvas-scene-v2';
import type { CanvasBinding } from '../core/canvas-state';
import { arrangeCanvasV2, projectCanvasStateV2ToV1, reconcileCanvasStateV2 } from '../core/canvas-state-v2';
import type { CanvasBodyDisplay, CanvasStateV2 } from '../core/canvas-state-v2';
import { extractSections } from '../core/sections';
import { encodeMarkdownBytes } from '../core/markdown-source';
import type { OpenedMarkdownDocument } from '../types/reader-api';
import type { SectionTransformOperation } from '../core/section-transform';
import '@xyflow/react/dist/style.css';

interface CardData extends Record<string, unknown> {
  title: string;
  summary: string;
  fullText?: string;
  childCount: number;
  hiddenDescendants: number;
  bodyDisplay: CanvasBodyDisplay;
  contentPosition: { readonly x: number; readonly y: number };
  descendantsCollapsed: boolean;
  readOnly: boolean;
  sectionIndex: number | null;
  fold: () => void;
  toggleBody: () => void;
  edit: () => void;
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
  return <div className={selected ? 'canvas-chapter selected' : 'canvas-chapter'}>
    <Handle type="target" position={Position.Left} isConnectable={!data.readOnly} />
    <div ref={body} className="canvas-card-body" style={{ left: data.contentPosition.x, top: data.contentPosition.y }}><div className="canvas-card-header">
      <strong>{data.title}</strong>
      <div className="canvas-card-actions nodrag">
        <button type="button" title="编辑本节" aria-label="编辑本节" onClick={data.edit}><FilePenLine size={15} /></button>
        <button type="button" title={data.bodyDisplay === 'hidden' ? '显示正文摘要' : data.bodyDisplay === 'preview' ? '展开全部正文' : '收起正文'}
          aria-label={data.bodyDisplay === 'hidden' ? '显示正文摘要' : data.bodyDisplay === 'preview' ? '展开全部正文' : '收起正文'} disabled={data.readOnly} onClick={data.toggleBody}>
          {data.bodyDisplay === 'hidden' ? <EyeOff size={15} /> : <BookOpen size={15} />}
        </button>
        {data.childCount > 0 && <button type="button" title={data.descendantsCollapsed ? '展开子章节' : '收起子章节'}
          aria-label={data.descendantsCollapsed ? '展开子章节' : '收起子章节'} disabled={data.readOnly} onClick={data.fold}>
          {data.descendantsCollapsed ? <ArrowDownToLine size={15} /> : <ArrowUpToLine size={15} />}
        </button>}
      </div>
    </div>
    {data.bodyDisplay !== 'hidden' && <p className={data.bodyDisplay === 'full' ? 'canvas-card-summary canvas-card-full' : 'canvas-card-summary'}>{(data.bodyDisplay === 'full' ? data.fullText : data.summary) || '暂无正文'}</p>}
    <span className="canvas-card-count">{data.hiddenDescendants ? `${data.hiddenDescendants} 个章节已收起` : `${data.childCount} 个直接子章节`}</span>
    {data.sectionIndex !== null && <div className="canvas-structure-drop nodrag" aria-disabled={data.readOnly}
      data-canvas-structure-target={data.readOnly ? undefined : data.sectionIndex}>{data.readOnly ? '结构投放已暂停' : '拖到此处设为子章节'}</div>}
    </div>
    <Handle type="source" position={Position.Right} isConnectable={!data.readOnly} />
  </div>;
}

const nodeTypes: NodeTypes = { chapter: ChapterCard };

export interface CanvasViewProps {
  readonly document: OpenedMarkdownDocument;
  readonly dirty: boolean;
  readonly activeSection: number | null;
  readonly onSectionChange: (index: number | null) => void;
  readonly onEditSection: (index: number | null) => void;
  readonly onStructurePreview: (operation: SectionTransformOperation) => Promise<void>;
}

function CanvasEditor({ document, dirty, activeSection, onSectionChange, onEditSection, onStructurePreview }: CanvasViewProps) {
  const flow = useReactFlow<ChapterNode>();
  const [model, setModel] = useState<CanvasStateV2 | null>(null);
  const [bindings, setBindings] = useState<readonly CanvasBinding[]>([]);
  const [unresolvedIds, setUnresolvedIds] = useState<readonly string[]>([]);
  const [unresolvedLinkIds, setUnresolvedLinkIds] = useState<readonly string[]>([]);
  const [nodes, setNodes] = useState<ChapterNode[]>([]);
  const [sidecarHash, setSidecarHash] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [layoutPending, setLayoutPending] = useState(true);
  const [readError, setReadError] = useState<string | null>(null);
  const [message, setMessage] = useState('正在加载画布…');
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
  const [structureSource, setStructureSource] = useState('');
  const [structureTarget, setStructureTarget] = useState('');
  const generation = useRef(0);
  const saveInFlight = useRef(false);
  const initialLayout = useRef(false);
  const sourceVersion = useRef<1 | 2>(1);
  const tree = useMemo(() => extractSections(document.content), [document.content]);
  const readOnly = dirty || Boolean(document.recoveryPending) || busy || layoutPending || Boolean(readError) || Boolean(exporting);

  useEffect(() => {
    const current = ++generation.current;
    setModel(null); setLayoutPending(true); setReadError(null); setBusy(false); setMessage('正在加载画布…'); setHistory([]); setFuture([]); setMinimumHeights({}); setSelectedLink(null);
    void (async () => {
      const loaded = await window.mermarkd.loadCanvasV2();
      if (loaded.status === 'invalid') throw new Error(loaded.reason);
      const bytes = encodeMarkdownBytes(document.content, document.bomByteLength);
      const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes));
      const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
      sourceVersion.current = loaded.sourceVersion ?? 1;
      const reconciled = await reconcileCanvasStateV2(loaded.model, { bytes, content: document.content, sha256 });
      let initial = reconciled.model;
      if (loaded.model === null) initial = await arrangeCanvasV2(tree, initial, reconciled.bindings);
      else {
        const oldIds = new Set(loaded.model.cards.map((card) => card.id));
        initial = { ...initial, cards: initial.cards.map((card, index) => oldIds.has(card.id) ? card : {
          ...card, position: { x: 24 + index * 336, y: card.anchor.kind === 'heading' &&
            tree.sections[reconciled.bindings.find((binding) => binding.id === card.id)?.sectionIndex ?? 0]?.parentIndex !== null ? 150 : 0 },
        }) };
      }
      if (generation.current !== current) return;
      initialLayout.current = loaded.model === null;
      setModel(initial); setBindings(reconciled.bindings); setUnresolvedIds(reconciled.unresolvedCardIds);
      setUnresolvedLinkIds(reconciled.unresolvedLinkIds); setSidecarHash(loaded.sidecarSha256);
      setMessage(dirty ? '未保存结构预览 · 画布写入已暂停' : loaded.model === null ? '初始布局 · 尚未创建画布文件' : loaded.sourceVersion === 1 ? '旧版画布已迁移到内存 v2' : '画布 v2 已载入');
      setFrom(reconciled.bindings[0]?.id ?? ''); setTo(reconciled.bindings[1]?.id ?? reconciled.bindings[0]?.id ?? '');
      requestAnimationFrame(() => {
        if (generation.current !== current || !loaded.model) return;
        void flow.setViewport(loaded.model.viewport).then(() => { if (generation.current === current) setLayoutPending(false); });
      });
    })().catch(() => { if (generation.current === current) { setLayoutPending(false); setReadError('画布文件无法安全载入，未修改原文件。'); setMessage('画布未载入'); } });
    return () => { generation.current += 1; };
  }, [document.path, document.content, document.bomByteLength, dirty, loadRevision, tree]);

  useEffect(() => {
    if (!initialLayout.current || !model || bindings.some((binding) => !minimumHeights[binding.id])) return;
    initialLayout.current = false;
    const current = generation.current;
    void arrangeCanvasV2(tree, model, bindings, minimumHeights).then((next) => {
      if (generation.current !== current) return;
      setModel(next);
      setTimeout(() => { if (generation.current === current) void flow.fitView({ padding: 0.15 })
        .then(() => { if (generation.current === current) setLayoutPending(false); }); }, 50);
    }).catch(() => { if (generation.current === current) { setLayoutPending(false); setReadError('初始布局失败，请重新载入画布。'); } });
  }, [bindings, minimumHeights, model, tree]);

  const persist = useCallback(async (next: CanvasStateV2, remember = true) => {
    if (!model || readOnly || saveInFlight.current) return false;
    const current = generation.current;
    saveInFlight.current = true;
    setBusy(true); setModel(next); setMessage('正在保存画布…');
    try {
      const needsV2 = sourceVersion.current === 2 || next.cards.some((card) => card.bodyDisplay !== 'preview' || card.contentPosition.x !== 0 || card.contentPosition.y !== 0);
      const result = needsV2
        ? await window.mermarkd.saveCanvasV2({ sourceSha256: document.sourceSha256, expectedSidecarSha256: sidecarHash, model: next })
        : await window.mermarkd.saveCanvas({ sourceSha256: document.sourceSha256, expectedSidecarSha256: sidecarHash, model: projectCanvasStateV2ToV1(next) });
      if (generation.current !== current) return false;
      if (result.status !== 'saved') { setReadError(result.reason ?? '画布未保存，请重新载入。'); setMessage(result.reason ?? '画布未保存'); return false; }
      sourceVersion.current = needsV2 ? 2 : 1;
      if (remember) { setHistory((previous) => [...previous.slice(-49), model]); setFuture([]); }
      setModel(next); setSidecarHash(result.sidecarSha256 ?? null); setMessage('画布已保存 · Markdown 未改动');
      return true;
    } catch { if (generation.current === current) { setReadError('画布保存失败，请重新载入。'); setMessage('画布保存失败，原文未修改。'); } }
    finally { saveInFlight.current = false; if (generation.current === current) setBusy(false); }
  }, [document.sourceSha256, model, readOnly, sidecarHash]);

  const measured = useCallback((id: string, height: number) => {
    setMinimumHeights((previous) => previous[id] === height ? previous : { ...previous, [id]: height });
  }, []);
  const scene = useMemo(() => model ? buildCanvasSceneV2(document.content, tree, model, bindings, minimumHeights) : null, [bindings, document.content, minimumHeights, model, tree]);
  useEffect(() => {
    if (!model || !scene) { setNodes([]); return; }
    setNodes(scene.cards.map((card): ChapterNode => {
      return { id: card.id, type: 'chapter', parentId: card.parentId, position: card.position,
        hidden: card.hidden, selected: card.sectionIndex !== null && card.sectionIndex === activeSection,
        draggable: !readOnly, connectable: !readOnly, style: { width: card.width, height: card.height },
        data: { ...canvasCardContent(document.content, tree, card.sectionIndex), sectionIndex: card.sectionIndex, hiddenDescendants: card.hiddenDescendants,
          bodyDisplay: card.bodyDisplay, contentPosition: card.contentPosition, descendantsCollapsed: card.descendantsCollapsed, readOnly,
          fold: () => { void persist({ ...model, cards: model.cards.map((item) => item.id === card.id ? { ...item, descendantsCollapsed: !item.descendantsCollapsed } : item) }); },
          toggleBody: () => { void persist({ ...model, cards: model.cards.map((item) => item.id === card.id ? {
            ...item, bodyDisplay: item.bodyDisplay === 'hidden' ? 'preview' : item.bodyDisplay === 'preview' ? 'full' : 'hidden',
          } : item) }); },
          edit: () => onEditSection(card.sectionIndex), measure: (height) => measured(card.id, height) } };
    }));
  }, [activeSection, document.content, measured, model, onEditSection, persist, readOnly, scene, tree]);

  const edges = useMemo((): Edge[] => scene?.links.map((link) => ({ id: link.id, source: link.from, target: link.to,
    label: `${link.label}${link.hiddenEndpoint ? '（隐藏端点）' : ''}`, markerEnd: { type: MarkerType.ArrowClosed },
    selected: selectedLink === link.id, style: { stroke: link.hiddenEndpoint ? '#b27718' : '#327766', strokeWidth: 2 },
    labelBgStyle: { fill: '#fff' } })) ?? [], [scene, selectedLink]);

  const addLink = useCallback((connection: Pick<Connection, 'source' | 'target'>) => {
    if (!model || !connection.source || !connection.target || readOnly) return;
    void persist({ ...model, links: [...model.links, { id: crypto.randomUUID(), from: connection.source, to: connection.target, label }] });
  }, [label, model, persist, readOnly]);
  const titleFor = (id: string) => nodes.find((node) => node.id === id)?.data.title ?? id;
  const currentCard = nodes.find((node) => node.selected);
  const requestStructure = useCallback(async (operation: SectionTransformOperation) => {
    if (readOnly || saveInFlight.current) return;
    setBusy(true); setMessage('正在核验结构变更…');
    try { await onStructurePreview(operation); }
    catch (error) { setMessage(error instanceof Error ? error.message : '结构预览失败，请重新检查文档。'); }
    finally { setBusy(false); }
  }, [onStructurePreview, readOnly]);
  const searchMatches = nodes.filter((node) => !node.hidden && node.data.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const exportCanvas = useCallback(async (format: 'png' | 'jpg' | 'pdf') => {
    if (!scene || exporting || readOnly || busy || Boolean(readError)) return;
    setExporting(format); setExportMessage(null);
    try {
      const cards = scene.cards.map(({ contentPosition: _contentPosition, bodyDisplay: _bodyDisplay, descendantsCollapsed: _descendantsCollapsed, ...card }) => card);
      const result = await window.mermarkd.exportCanvas({ sourceSha256: document.sourceSha256, format, cards, links: scene.links, padding: 48, background: '#f3f6f8' });
      if (result.status === 'saved') setExportMessage(`已导出 ${format.toUpperCase()} · ${result.width} × ${result.height}`);
      else if (result.status === 'error') setExportMessage(result.reason);
    } catch (error) {
      setExportMessage(error instanceof Error ? error.message : '画布导出失败。');
    } finally {
      setExporting(null);
    }
  }, [busy, document.sourceSha256, exporting, readError, readOnly, scene]);

  return <main className="canvas-mode" data-canvas-view="true">
    <div className="canvas-toolbar" role="toolbar" aria-label="画布工具">
      <button title="适应全图" aria-label="适应全图" onClick={() => void flow.fitView({ padding: 0.15 })}><Focus size={18} /></button>
      <button title="定位当前卡片" aria-label="定位当前卡片" disabled={!currentCard} onClick={() => currentCard && void flow.fitView({ nodes: [{ id: currentCard.id }], padding: 0.4 })}><Crosshair size={18} /></button>
      <button title="放大" aria-label="放大" onClick={() => void flow.zoomIn()}><ZoomIn size={18} /></button>
      <button title="缩小" aria-label="缩小" onClick={() => void flow.zoomOut()}><ZoomOut size={18} /></button>
      <button title="自动整理" aria-label="自动整理" data-canvas-arrange="true" disabled={!model || readOnly} onClick={() => {
        if (model) void arrangeCanvasV2(tree, model, bindings, minimumHeights).then((next) => persist(next));
      }}><LayoutGrid size={18} /></button>
      <button title="全部展开" aria-label="全部展开" data-canvas-expand="true" disabled={!model || readOnly} onClick={() => model && void persist({ ...model, cards: model.cards.map((card) => ({ ...card, descendantsCollapsed: false })) })}><ArrowDownToLine size={18} /></button>
      <button title="全部收起" aria-label="全部收起" data-canvas-collapse="true" disabled={!model || readOnly} onClick={() => model && void persist({ ...model, cards: model.cards.map((card) => ({ ...card, descendantsCollapsed: true })) })}><ArrowUpToLine size={18} /></button>
      <button title="撤销画布操作" aria-label="撤销画布操作" data-canvas-undo="true" disabled={!history.length || readOnly} onClick={() => {
        const previous = history.at(-1); if (previous && model) void persist(previous, false).then((saved) => { if (saved) { setHistory((items) => items.slice(0, -1)); setFuture((items) => [...items, model]); } });
      }}><RotateCcw size={18} /></button>
      <button title="重做画布操作" aria-label="重做画布操作" data-canvas-redo="true" disabled={!future.length || readOnly} onClick={() => {
        const next = future.at(-1); if (next && model) void persist(next, false).then((saved) => { if (saved) { setFuture((items) => items.slice(0, -1)); setHistory((items) => [...items, model]); } });
      }}><Redo2 size={18} /></button>
      <button title="保存布局与当前视口" aria-label="保存布局与当前视口" data-canvas-save="true" disabled={!model || readOnly}
        onClick={() => model && void persist({ ...model, viewport: flow.getViewport() })}><Save size={18} /></button>
      <button title="导出 PNG" aria-label="导出 PNG" data-canvas-export="png" disabled={!scene || readOnly || Boolean(exporting) || busy || Boolean(readError)}
        onClick={() => void exportCanvas('png')}>{exporting === 'png' ? <RefreshCw className="spin" size={18} /> : <ImageDown size={18} />}</button>
      <button title="导出 JPG" aria-label="导出 JPG" data-canvas-export="jpg" disabled={!scene || readOnly || Boolean(exporting) || busy || Boolean(readError)}
        onClick={() => void exportCanvas('jpg')}>{exporting === 'jpg' ? <RefreshCw className="spin" size={18} /> : <ImageDown size={18} />}</button>
      <button title="导出 PDF" aria-label="导出 PDF" data-canvas-export="pdf" disabled={!scene || readOnly || Boolean(exporting) || busy || Boolean(readError)}
        onClick={() => void exportCanvas('pdf')}>{exporting === 'pdf' ? <RefreshCw className="spin" size={18} /> : <FileDown size={18} />}</button>
      <label className="canvas-search">查找卡片<input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
        if (event.key === 'Enter' && searchMatches[0]) void flow.fitView({ nodes: [{ id: searchMatches[0].id }], padding: 0.4 });
      }} /></label>
      <output role="status" data-canvas-status="true">{exporting ? `正在导出 ${exporting.toUpperCase()}…` : exportMessage ?? (busy ? '正在保存…' : message)}</output>
    </div>
    {readError && <div className="canvas-warning" role="alert">{readError}
      <button title="放弃当前未保存画布候选并重新载入" onClick={() => setLoadRevision((value) => value + 1)}><RefreshCw size={15} /> 重新载入画布</button>
    </div>}
    {dirty && <p className="canvas-warning" role="status">未保存结构预览，拖动、折叠、连线与画布保存已暂停。</p>}
    <div className="canvas-workspace">
      <div className="canvas-flow" data-canvas-flow="true">
        <ReactFlow<ChapterNode> nodes={nodes} edges={edges} nodeTypes={nodeTypes} minZoom={0.05} maxZoom={8}
          nodesDraggable={!readOnly} nodesConnectable={!readOnly} edgesReconnectable={false} deleteKeyCode={null}
          panOnDrag={[1, 2]} panActivationKeyCode="Space" selectionOnDrag
          onNodesChange={(changes) => setNodes((previous) => applyNodeChanges(changes, previous))}
          onNodeClick={(_event, node) => onSectionChange(bindings.find((binding) => binding.id === node.id)?.sectionIndex ?? null)}
          onNodeDragStop={(event, node) => {
            if (!model || readOnly) return;
            const sourceIndex = bindings.find((binding) => binding.id === node.id)?.sectionIndex;
            // Rectangle hit testing includes zones beneath the dragged card;
            // ordinary card overlap never starts a structural command.
            const pointer = 'clientX' in event ? event : event.changedTouches[0];
            const target = pointer && Array.from(globalThis.document.querySelectorAll<HTMLElement>('[data-canvas-structure-target]'))
              .find((element) => {
                const bounds = element.getBoundingClientRect();
                return pointer.clientX >= bounds.left && pointer.clientX <= bounds.right && pointer.clientY >= bounds.top && pointer.clientY <= bounds.bottom &&
                  Number(element.dataset.canvasStructureTarget) !== sourceIndex;
              });
            if (target && sourceIndex !== null && sourceIndex !== undefined) {
              const original = scene?.cards.find((card) => card.id === node.id)?.position;
              if (original) setNodes((items) => items.map((item) => item.id === node.id ? { ...item, position: original } : item));
              void requestStructure({ kind: 'move', sourceIndex, targetIndex: Number(target.dataset.canvasStructureTarget) });
              return;
            }
            void persist({ ...model, cards: model.cards.map((card) => card.id === node.id
              ? { ...card, position: { x: Math.max(card.anchor.kind === 'heading' && node.parentId ? 24 : -1_000_000, node.position.x),
                y: Math.max(node.parentId ? Math.max(150, minimumHeights[node.parentId] ?? 150) : -1_000_000, node.position.y) } } : card) });
          }}
          onConnect={addLink} onEdgeClick={(_event, edge) => { setSelectedLink(edge.id); setLabel(model?.links.find((link) => link.id === edge.id)?.label ?? ''); }}
          onPaneClick={() => setSelectedLink(null)}
          onMoveEnd={(event, viewport) => { if (event && model && !readOnly) void persist({ ...model, viewport }); }}
          proOptions={{ hideAttribution: true }}>
          <Background variant={BackgroundVariant.Lines} color="#e3e8ed" gap={32} />
        </ReactFlow>
      </div>
      <aside className="canvas-properties" aria-label="卡片与关系">
        <h2>章节结构</h2>
        <p className="canvas-structure-hint">普通拖动只改布局。投到“设为子章节”区域后预览源码，也可在这里选择章节。</p>
        <label>移动章节<select data-canvas-structure-source="true" value={structureSource} disabled={readOnly} onChange={(event) => setStructureSource(event.target.value)}>
          <option value="">选择章节</option>{tree.sections.map((section) => <option key={section.index} value={section.index}>{section.title}</option>)}
        </select></label>
        <label>新父章节<select data-canvas-structure-parent="true" value={structureTarget} disabled={readOnly} onChange={(event) => setStructureTarget(event.target.value)}>
          <option value="">选择章节</option>{tree.sections.map((section) => <option key={section.index} value={section.index}>{section.title}</option>)}
        </select></label>
        <button data-canvas-preview-structure="true" disabled={readOnly || !structureSource || !structureTarget}
          onClick={() => void requestStructure({ kind: 'move', sourceIndex: Number(structureSource), targetIndex: Number(structureTarget) })}>预览设为子章节</button>
        <button data-canvas-preview-promote="true" disabled={readOnly || !structureSource || tree.sections[Number(structureSource)]?.depth <= 1}
          onClick={() => void requestStructure({ kind: 'promote', sectionIndex: Number(structureSource), targetDepth: tree.sections[Number(structureSource)].depth - 1 })}>预览提升一级</button>
        <h2>章节关系</h2>
        <label>起点<select data-canvas-link-from="true" value={from} disabled={readOnly} onChange={(event) => setFrom(event.target.value)}>
          {bindings.map((item) => <option value={item.id} key={item.id}>{titleFor(item.id)}</option>)}
        </select></label>
        <label>终点<select data-canvas-link-to="true" value={to} disabled={readOnly} onChange={(event) => setTo(event.target.value)}>
          {bindings.map((item) => <option value={item.id} key={item.id}>{titleFor(item.id)}</option>)}
        </select></label>
        <label>连线标签<input data-canvas-link-label="true" value={label} maxLength={100} disabled={readOnly} onChange={(event) => setLabel(event.target.value)} /></label>
        <button data-canvas-add-link="true" disabled={!model || !from || !to || readOnly} onClick={() => addLink({ source: from, target: to })}><Plus size={16} /> 添加箭头</button>
        {selectedLink && <div className="canvas-link-actions">
          <button disabled={readOnly} onClick={() => model && void persist({ ...model, links: model.links.map((link) => link.id === selectedLink ? { ...link, label } : link) })}><Link2 size={16} /> 更新标签</button>
          <button data-canvas-delete-link="true" disabled={readOnly} onClick={() => { if (model) void persist({ ...model, links: model.links.filter((link) => link.id !== selectedLink) }); setSelectedLink(null); }}><Trash2 size={16} /> 删除箭头</button>
        </div>}
        <p>{bindings.length} 张卡片 · {model?.links.length ?? 0} 条箭头</p>
        {unresolvedIds.length > 0 && <div className="canvas-unresolved" role="status">
          <h3>待修复</h3><p>{unresolvedIds.length} 张卡片、{unresolvedLinkIds.length} 条箭头无法确定原章节，已保留原端点。</p>
          <ul>{unresolvedIds.map((id) => <li key={id}>{model?.cards.find((card) => card.id === id)?.anchor.kind === 'heading'
            ? (model.cards.find((card) => card.id === id)!.anchor as { titlePath: readonly string[] }).titlePath.join(' / ') : '原虚拟卡片'}</li>)}</ul>
        </div>}
      </aside>
    </div>
  </main>;
}

export function CanvasView(props: CanvasViewProps) {
  return <ReactFlowProvider><CanvasEditor {...props} /></ReactFlowProvider>;
}
