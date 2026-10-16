import { useEffect, useRef, useState } from 'react';
import { VisibleSearchIndex, type VisibleSearchResults } from './reader-search';

const EMPTY: VisibleSearchResults = { matches: [], truncated: false };

/** Results are usable only for the current document, DOM revision and query. */
export function useReaderSearch(key: string | null, source: string, enabled: boolean, query: string) {
  const [session, setSession] = useState<{ key: string; source: string; index: VisibleSearchIndex } | null>(null);
  const [revision, setRevision] = useState(0);
  const active = useRef<AbortController | null>(null);
  const [result, setResult] = useState<{ index: VisibleSearchIndex; revision: number; query: string;
    data: VisibleSearchResults | null } | null>(null);
  useEffect(() => {
    setResult(null);
    if (!key || !enabled) { setSession(null); return; }
    const article = document.querySelector<HTMLElement>('.markdown-body');
    if (!article) return;
    const index = new VisibleSearchIndex(article, () => {
      active.current?.abort();
      setRevision(value => value + 1);
    });
    setSession({ key, source, index });
    return () => { active.current?.abort(); index.dispose(); };
  }, [key, source, enabled]);
  const index = enabled && session?.key === key && session.source === source && session.index.connected ? session.index : null;
  useEffect(() => {
    if (!index || !query) return;
    const controller = new AbortController();
    active.current = controller;
    void index.search(query, controller.signal).then(data => {
      if (!controller.signal.aborted) setResult({ index, revision, query, data });
    }).catch(() => {
      if (!controller.signal.aborted) setResult({ index, revision, query, data: null });
    });
    return () => controller.abort();
  }, [index, revision, query]);
  const current = result?.index === index && result.revision === revision && result.query === query ? result : null;
  if (enabled && !source.trim()) return { result: query ? EMPTY : null, status: query ? 'ready' as const : 'idle' as const };
  return { result: query ? current?.data ?? null : null,
    status: !query ? 'idle' as const : !current ? 'pending' as const : current.data ? 'ready' as const : 'error' as const };
}
