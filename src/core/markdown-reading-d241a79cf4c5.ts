import type { Element, Root as HastRoot, RootContent } from 'hast';
import type { Html as MdastHtml, Root as MdastRoot } from 'mdast';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

export type UnsupportedMarkdownExtension = 'display-math' | 'wiki-link' | 'directive';

export interface TextMatch {
  readonly start: number;
  readonly end: number;
}

const READING_HTML_TAGS = [
  'a', 'abbr', 'b', 'bdi', 'bdo', 'blockquote', 'br', 'cite', 'code', 'dd', 'del', 'details',
  'dfn', 'dl', 'dt', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'input',
  'ins', 'kbd', 'li', 'mark', 'ol', 'p', 'pre', 'q', 'rp', 'rt', 'ruby', 's', 'samp', 'small',
  'span', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'th', 'thead', 'time', 'tr',
  'u', 'ul', 'var', 'wbr',
] as const;
const SAFE_HTML_TAGS = new Set<string>(READING_HTML_TAGS);
const DANGEROUS_HTML_TAGS = new Set([
  'audio', 'base', 'body', 'embed', 'form', 'frame', 'frameset', 'head', 'html', 'iframe',
  'link', 'meta', 'noscript', 'object', 'picture', 'script', 'source', 'style', 'svg',
  'template', 'video', 'mermarkd-dangerous-html',
]);
const DENIED_VOID_HTML_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'frame', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
]);
const DANGEROUS_PLACEHOLDER_HTML = '<mermarkd-dangerous-html></mermarkd-dangerous-html>';
const UNSUPPORTED_PLACEHOLDER_TAG = 'mermarkd-unsupported-html';
const UNSUPPORTED_EXTENSION_ORDER: readonly UnsupportedMarkdownExtension[] = [
  'display-math', 'wiki-link', 'directive',
];
const markdownDetectionProcessor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkFrontmatter, 'yaml');

export const readingSanitizeSchema = {
  tagNames: [...READING_HTML_TAGS],
  clobberPrefix: 'mermarkd-user-content-',
  protocols: {
    href: ['http', 'https', 'mailto'],
    src: ['http', 'https'],
  },
  attributes: {
    '*': ['dir', 'lang', 'title'],
    a: ['href', 'title'],
    blockquote: ['cite'],
    code: [['className', /^language-/]],
    del: ['cite'],
    details: ['open'],
    img: ['alt', 'src', 'title'],
    input: [['disabled', true], ['type', 'checkbox'], 'checked'],
    ins: ['cite'],
    li: [['className', 'task-list-item']],
    ol: ['start', ['className', 'contains-task-list']],
    q: ['cite'],
    span: [
      ['className', 'html-placeholder'],
      ['role', 'note'],
    ],
    td: ['align', 'colSpan', 'headers', 'rowSpan'],
    th: ['align', 'colSpan', 'headers', 'rowSpan', 'scope'],
    time: ['dateTime'],
    ul: [['className', 'contains-task-list']],
  },
};

function htmlPlaceholder(tagName: string, dangerous: boolean, position: Element['position']): Element {
  return {
    type: 'element',
    tagName: 'span',
    properties: { className: ['html-placeholder'], role: 'note' },
    children: [{
      type: 'text',
      value: dangerous
        ? '不安全的 HTML 内容已隐藏'
        : `此 HTML 内容暂不显示（${tagName}）`,
    }],
    position,
  };
}

function applyHtmlPolicy(parent: HastRoot | Element): void {
  const children = parent.children as RootContent[];
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    if (child.type !== 'element') continue;
    const tagName = child.tagName.toLocaleLowerCase();
    if (tagName === UNSUPPORTED_PLACEHOLDER_TAG) {
      const originalTag = child.children.length === 1 && child.children[0].type === 'text' &&
        /^[a-z][a-z\d:-]*$/u.test(child.children[0].value)
        ? child.children[0].value
        : 'HTML';
      children[index] = htmlPlaceholder(originalTag, false, child.position);
      continue;
    }
    if (!SAFE_HTML_TAGS.has(tagName)) {
      children[index] = htmlPlaceholder(tagName, DANGEROUS_HTML_TAGS.has(tagName), child.position);
      continue;
    }
    // These values are reserved for placeholders created above. Raw HTML must
    // not impersonate application notices or opt its own text out of search.
    if (tagName === 'span') {
      delete child.properties.className;
      delete child.properties.role;
    }
    applyHtmlPolicy(child);
  }
}

/** Rehype transformer used after rehype-raw and before rehype-sanitize. */
export function rehypeReadingHtmlPolicy() {
  return (tree: HastRoot) => applyHtmlPolicy(tree);
}

interface MutableMdastNode {
  readonly type: string;
  value?: unknown;
  position?: MdastHtml['position'];
  children?: MutableMdastNode[];
}

interface HtmlTagToken {
  readonly tagName: string;
  readonly closing: boolean;
  readonly start: number;
  readonly end: number;
}

type DeniedHtmlKind = 'dangerous' | 'unsupported';

interface DeniedHtmlContainer {
  readonly tagName: string;
}

/**
 * Read actual HTML tag tokens without treating angle brackets inside quoted
 * attributes or comments as markup. This is deliberately a small tokenizer:
 * Markdown has already classified the value as raw HTML, and we only need tag
 * boundaries for the fixed reading-mode allowlist.
 */
function htmlTagTokens(value: string): readonly HtmlTagToken[] {
  const tokens: HtmlTagToken[] = [];
  let cursor = 0;
  while (cursor < value.length) {
    const opening = value.indexOf('<', cursor);
    if (opening < 0) break;
    if (value.startsWith('<!--', opening)) {
      const commentEnd = value.indexOf('-->', opening + 4);
      cursor = commentEnd < 0 ? value.length : commentEnd + 3;
      continue;
    }
    if (value.startsWith('<![CDATA[', opening)) {
      const cdataEnd = value.indexOf(']]>', opening + 9);
      cursor = cdataEnd < 0 ? value.length : cdataEnd + 3;
      continue;
    }

    let index = opening + 1;
    const closing = value[index] === '/';
    if (closing) index += 1;
    while (/\s/u.test(value[index] ?? '')) index += 1;
    const nameStart = index;
    while (/[A-Za-z0-9:-]/u.test(value[index] ?? '')) index += 1;
    if (index === nameStart || !/[A-Za-z]/u.test(value[nameStart])) {
      cursor = opening + 1;
      continue;
    }
    const tagName = value.slice(nameStart, index).toLocaleLowerCase();

    let quote: '"' | "'" | null = null;
    while (index < value.length) {
      const character = value[index];
      if (quote) {
        if (character === quote) quote = null;
      } else if (character === '"' || character === "'") quote = character;
      else if (character === '>') {
        index += 1;
        break;
      }
      index += 1;
    }
    tokens.push({ tagName, closing, start: opening, end: index });
    cursor = Math.max(index, opening + 1);
  }
  return tokens;
}

function deniedHtmlKind(tagName: string): DeniedHtmlKind | null {
  if (SAFE_HTML_TAGS.has(tagName)) return null;
  return DANGEROUS_HTML_TAGS.has(tagName) ? 'dangerous' : 'unsupported';
}

function closeDeniedContainer(stack: DeniedHtmlContainer[], tagName: string): void {
  const matchingIndex = stack.map((entry) => entry.tagName).lastIndexOf(tagName);
  if (matchingIndex >= 0) stack.splice(matchingIndex);
}

function applyDeniedTagToken(stack: DeniedHtmlContainer[], token: HtmlTagToken): DeniedHtmlKind | null {
  const kind = deniedHtmlKind(token.tagName);
  if (!kind) return null;
  if (token.closing) closeDeniedContainer(stack, token.tagName);
  else if (!DENIED_VOID_HTML_TAGS.has(token.tagName)) stack.push({ tagName: token.tagName });
  return kind;
}

function deniedPlaceholderHtml(tagName: string, kind: DeniedHtmlKind): string {
  return kind === 'dangerous'
    ? DANGEROUS_PLACEHOLDER_HTML
    : `<${UNSUPPORTED_PLACEHOLDER_TAG}>${tagName}</${UNSUPPORTED_PLACEHOLDER_TAG}>`;
}

function rewriteDeniedHtml(value: string, stack: DeniedHtmlContainer[]): string {
  const parts: string[] = [];
  let cursor = 0;

  for (const token of htmlTagTokens(value)) {
    if (stack.length > 0) {
      cursor = token.end;
      applyDeniedTagToken(stack, token);
      continue;
    }
    const kind = deniedHtmlKind(token.tagName);
    if (!kind) continue;

    parts.push(value.slice(cursor, token.start), deniedPlaceholderHtml(token.tagName, kind));
    cursor = token.end;
    applyDeniedTagToken(stack, token);
  }

  if (stack.length === 0) parts.push(value.slice(cursor));
  return parts.join('');
}

function applyPreRawHtmlPolicy(
  parent: MutableMdastNode,
  deniedContainers: DeniedHtmlContainer[] = [],
): void {
  if (!parent.children) return;
  const safeChildren: MutableMdastNode[] = [];

  for (const child of parent.children) {
    if (child.type === 'html' && typeof child.value === 'string') {
      const safeHtml = rewriteDeniedHtml(child.value, deniedContainers);
      if (safeHtml) {
        child.value = safeHtml;
        safeChildren.push(child);
      }
      continue;
    }

    if (child.children) {
      const beganInsideDeniedContainer = deniedContainers.length > 0;
      applyPreRawHtmlPolicy(child, deniedContainers);
      if (!beganInsideDeniedContainer || child.children.length > 0) safeChildren.push(child);
      continue;
    }

    if (deniedContainers.length === 0) safeChildren.push(child);
  }

  parent.children = safeChildren;
}

/**
 * Remove denied raw-HTML source ranges before rehype-raw applies HTML5 tree
 * construction. Doing this first prevents foster parenting from moving text or
 * resource nodes out of dangerous or unsupported containers.
 */
export function remarkReadingDangerousHtmlPolicy() {
  return (tree: MdastRoot) => applyPreRawHtmlPolicy(tree as unknown as MutableMdastNode);
}

interface SourceTextSpan {
  readonly start: number;
  readonly end: number;
  readonly raw: string;
}

function markdownTextSpans(source: string): readonly SourceTextSpan[] {
  const root = markdownDetectionProcessor.parse(source) as MdastRoot;
  const spans: SourceTextSpan[] = [];
  const visit = (node: { readonly type: string; readonly position?: {
    readonly start: { readonly offset?: number };
    readonly end: { readonly offset?: number };
  }; readonly children?: readonly unknown[] }): void => {
    if (node.type === 'text') {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined && start < end) {
        spans.push({ start, end, raw: source.slice(start, end) });
      }
      return;
    }
    node.children?.forEach((child) => visit(child as Parameters<typeof visit>[0]));
  }
  visit(root as Parameters<typeof visit>[0]);
  return spans;
}

function positionBelongsToText(spans: readonly SourceTextSpan[], position: number): boolean {
  let low = 0;
  let high = spans.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const span = spans[middle];
    if (position < span.start) high = middle - 1;
    else if (position >= span.end) low = middle + 1;
    else return true;
  }
  return false;
}

/** Conservatively flag only extension spellings that are unlikely to be ordinary prose. */
export function detectUnsupportedMarkdownExtensions(source: string): readonly UnsupportedMarkdownExtension[] {
  const found = new Set<UnsupportedMarkdownExtension>();
  const normalized = source.replace(/^\uFEFF/, '');
  const spans = markdownTextSpans(normalized);
  let mathDelimiterCount = 0;

  const lineExpression = /([^\r\n]*)(\r\n|\r|\n|$)/g;
  for (let match = lineExpression.exec(normalized); match && match[0]; match = lineExpression.exec(normalized)) {
    const line = match[1];
    const firstContent = line.search(/\S/);
    if (firstContent < 0 || !positionBelongsToText(spans, match.index + firstContent)) continue;
    if (line.trim() === '$$') mathDelimiterCount += 1;
    if (/^ {0,3}:::[A-Za-z][\w-]*(?:\s+.*|\{.*\})?$/.test(line) ||
        /^ {0,3}::[A-Za-z][\w-]*(?:\[[^\]\r\n]*\])?(?:\{[^\r\n]*\})?\s*$/.test(line)) {
      found.add('directive');
    }
  }

  for (const span of spans) {
    if (/(?<!\\)\[\[[^\]\r\n]+\]\]/u.test(span.raw)) found.add('wiki-link');
    if (/(?<![:\\\w]):[A-Za-z][\w-]*(?:\[[^\]\r\n]*\]|\{[^}\r\n]*\})/u.test(span.raw)) {
      found.add('directive');
    }
  }

  if (mathDelimiterCount >= 2) found.add('display-math');
  return UNSUPPORTED_EXTENSION_ORDER.filter((kind) => found.has(kind));
}

/** Find non-overlapping visible-text matches using UTF-16 DOM offsets. */
export function findVisibleTextMatches(
  text: string,
  query: string,
  limit = Number.POSITIVE_INFINITY,
): readonly TextMatch[] {
  if (!query) return [];
  const expression = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
  const matches: TextMatch[] = [];
  const graphemeBoundaries = new Set<number>([0, text.length]);
  if (typeof Intl.Segmenter === 'function') {
    for (const segment of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) {
      graphemeBoundaries.add(segment.index);
      graphemeBoundaries.add(segment.index + segment.segment.length);
    }
  } else {
    let offset = 0;
    for (const character of Array.from(text)) {
      graphemeBoundaries.add(offset);
      offset += character.length;
      graphemeBoundaries.add(offset);
    }
  }
  for (let match = expression.exec(text); match; match = expression.exec(text)) {
    const end = match.index + match[0].length;
    if (graphemeBoundaries.has(match.index) && graphemeBoundaries.has(end)) {
      matches.push({ start: match.index, end });
      if (matches.length >= limit) break;
    }
    if (match[0].length === 0) expression.lastIndex += 1;
  }
  return matches;
}
