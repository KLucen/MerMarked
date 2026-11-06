import { createContext, useContext, useEffect, useState } from 'react';
import type { ComponentProps, MouseEvent } from 'react';
import type { Components, ExtraProps } from 'react-markdown';
import type { ReadingAnalysis } from '../core/reading-analysis';
import { isReaderMappedTextBlock } from '../core/reader-edit';
import { ReaderEditableBlock } from './reader-editable-block';

type EditProps = ComponentProps<typeof ReaderEditableBlock>;
export interface ReaderComponentState {
  readonly analysis: ReadingAnalysis;
  readonly blocks: ReadonlyMap<number, ReadingAnalysis['selection']['blocks'][number]>;
  readonly headingIds: ReadonlyMap<number, string>;
  readonly editable: boolean;
  readonly documentPath: string;
  readonly onCommit: EditProps['onCommit'];
  readonly onDraftChange: EditProps['onDraftChange'];
  readonly onActivityChange: EditProps['onActivityChange'];
  readonly onRestricted: EditProps['onRestricted'];
  readonly onOpenLink: (event: MouseEvent<HTMLAnchorElement>, href?: string) => void;
}
const ReaderState = createContext<ReaderComponentState | null>(null);
export const ReaderComponentsProvider = ReaderState.Provider;
function useReaderState() {
  const state = useContext(ReaderState);
  if (!state) throw Error('Reading components require their current document state.');
  return state;
}

function ReaderText({ tag, node, children, ...props }: ComponentProps<'h1'> & ExtraProps & {
  readonly tag: 'p' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
}) {
  const state = useReaderState();
  const start = node?.position?.start.offset;
  const selection = state.analysis.selection;
  const block = start === undefined ? undefined : state.blocks.get(start);
  const id = tag === 'p' || start === undefined ? undefined : state.headingIds.get(start);
  if (block && start !== undefined && isReaderMappedTextBlock(selection, block)) {
    return <ReaderEditableBlock as={tag} blockStart={start} sourceText={block.visibleText} enabled={state.editable}
      onCommit={state.onCommit} onDraftChange={state.onDraftChange} onActivityChange={state.onActivityChange} onRestricted={state.onRestricted}
      id={id} tabIndex={id ? -1 : undefined} className={props.className}>{children}</ReaderEditableBlock>;
  }
  const Tag = tag;
  return <Tag {...props} id={id} tabIndex={id ? -1 : undefined} data-source-block-start={start}>{children}</Tag>;
}

function ReaderLink({ node: _node, href, children, ...props }: ComponentProps<'a'> & ExtraProps) {
  const state = useReaderState();
  return <a {...props} href={href} onClick={event => state.onOpenLink(event, href)}>{children}</a>;
}
function LocalImage({ node: _node, src, alt }: ComponentProps<'img'> & ExtraProps) {
  const { documentPath } = useReaderState();
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let active = true; setImageUrl(null); setLoaded(false);
    const relative = typeof src === 'string' && Boolean(src) && !src.startsWith('/') && !src.startsWith('\\') &&
      !src.includes('\\') && !/^[a-z][a-z\d+.-]*:/i.test(src);
    if (!relative) { setLoaded(true); return () => { active = false; }; }
    void window.mermarkd.readDocumentImage(src as string).then(result => {
      if (active) { setImageUrl(result); setLoaded(true); }
    }).catch(() => { if (active) setLoaded(true); });
    return () => { active = false; };
  }, [src, documentPath]);
  return imageUrl ? <img className="article-image" src={imageUrl} alt={alt ?? ''} />
    : <span className="image-placeholder" role="img" aria-label={alt || '图片'}><span aria-hidden="true">▧</span>
      {alt || '图片'} · {loaded ? '无法读取本地图片或不支持该地址' : '正在加载图片'}</span>;
}

// Component identity stays stable across modes and temporary source mismatches.
// Context updates editing permission/callbacks without replacing each text block.
export const readerComponents: Components = {
  h1: props => <ReaderText tag="h1" {...props} />, h2: props => <ReaderText tag="h2" {...props} />,
  h3: props => <ReaderText tag="h3" {...props} />, h4: props => <ReaderText tag="h4" {...props} />,
  h5: props => <ReaderText tag="h5" {...props} />, h6: props => <ReaderText tag="h6" {...props} />,
  p: props => <ReaderText tag="p" {...props} />,
  table: ({ node: _node, children, ...props }) => <div className="table-scroll" role="region" aria-label="表格，可水平滚动" tabIndex={0}><table {...props}>{children}</table></div>,
  td: ({ node, children, ...props }) => <td {...props} data-source-block-start={node?.position?.start.offset}>{children}</td>,
  th: ({ node, children, ...props }) => <th {...props} data-source-block-start={node?.position?.start.offset}>{children}</th>,
  pre: ({ node, children, ...props }) => <pre {...props} data-source-block-start={node?.position?.start.offset} tabIndex={0} aria-label="代码块，可水平滚动">{children}</pre>,
  a: ReaderLink, img: LocalImage,
  input: ({ node: _node, ...props }) => <input {...props} disabled readOnly />,
};
