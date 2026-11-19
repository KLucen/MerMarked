import type { Nodes } from 'mdast';
import { extensionsFromSnapshot } from './markdown-reading.ts';
import { parseMarkdownSnapshot } from './markdown-snapshot.ts';

export const MAX_DOCUMENT_BUNDLE_IMAGES = 32;

export interface DocumentBundlePlan {
  readonly portable: boolean;
  /** Decoded, slash-separated archive paths in first source-use order. */
  readonly images: readonly { readonly path: string }[];
  /** URL-bearing AST nodes, including definitions; not unique network URLs. */
  readonly remoteReferenceCount: number;
  readonly blockedReferenceCount: number;
  readonly htmlNodeCount: number;
  readonly unsupportedExtensionCount: number;
}

const controls = /[\u0000-\u001f\u007f-\u009f]/;
const reservedWindowsName = /^(?:con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\.|$)/i;

function remoteDestination(value: string): boolean {
  if (controls.test(value) || !/^(?:https?:\/\/|mailto:)/i.test(value)) return false;
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password) return false;
    if (parsed.protocol === 'mailto:') return Boolean(parsed.pathname);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

function localImagePath(value: string): string | null {
  // Preserve source destinations verbatim. Only the archive/file lookup uses
  // one URI decoding pass; query/fragment stripping would hide a source change.
  if (!value || value.length > 2048 || controls.test(value) || /[?#]/.test(value)) return null;
  let decoded: string;
  try { decoded = decodeURIComponent(value); } catch { return null; }
  if (!decoded || decoded.length > 2048 || controls.test(decoded) || /[<>:"\\|?*#]/.test(decoded) ||
      /[\uD800-\uDFFF]/u.test(decoded)) return null;
  const segments = decoded.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..' || segment.length > 255 ||
      /[ .]$/.test(segment) || reservedWindowsName.test(segment))) return null;
  const name = segments[segments.length - 1];
  // Match the current reader's PNG/JPEG/GIF/WebP support, including its
  // treatment of a bare dotfile such as .png as having no extension.
  if (name.lastIndexOf('.') <= 0 || !/\.(?:png|jpe?g|gif|webp)$/i.test(name)) return null;
  return decoded;
}

/** Plan direct local raster resources without reading files or rewriting text. */
export async function planDocumentBundle(content: string): Promise<DocumentBundlePlan> {
  const snapshot = parseMarkdownSnapshot(content);
  const images: { path: string }[] = [];
  const names = new Map<string, string>();
  let remoteReferenceCount = 0, blockedReferenceCount = 0, htmlNodeCount = 0;
  const pending: Nodes[] = [snapshot.root];
  while (pending.length) {
    const node = pending.pop()!;
    if (node.type === 'html') htmlNodeCount += 1;
    if (node.type === 'link' || node.type === 'image' || node.type === 'definition') {
      const value = node.url;
      if (controls.test(value)) blockedReferenceCount += 1;
      else if (value === '' || value.startsWith('#')) { /* current document */ }
      else if (remoteDestination(value)) remoteReferenceCount += 1;
      else {
        const image = localImagePath(value);
        if (image === null) blockedReferenceCount += 1;
        else {
          const key = image.normalize('NFC').toUpperCase();
          const existing = names.get(key);
          if (existing !== undefined) {
            if (existing !== image) blockedReferenceCount += 1;
          } else if (images.length >= MAX_DOCUMENT_BUNDLE_IMAGES) blockedReferenceCount += 1;
          else { names.set(key, image); images.push({ path: image }); }
        }
      }
    }
    if ('children' in node) for (let index = node.children.length - 1; index >= 0; index--) pending.push(node.children[index]);
  }
  const unsupportedExtensionCount = extensionsFromSnapshot(snapshot).length;
  return { portable: blockedReferenceCount === 0 && htmlNodeCount === 0 && unsupportedExtensionCount === 0,
    images, remoteReferenceCount, blockedReferenceCount, htmlNodeCount, unsupportedExtensionCount };
}
