import type {
  AnnotationAnchorStatus,
  AnnotationColor,
  AnnotationRecord,
  AnnotationSidecar,
} from './annotations';

export type ReadingSummaryFilter =
  | { mode: 'all' }
  | { mode: 'tag'; tagId: string }
  | { mode: 'untagged' };

export interface ReadingSummarySection {
  /** Unique only within the current parsed document, for example a section index. */
  key: string;
  /** Display title or complete section path for this current document snapshot. */
  title: string;
}

export interface ReadingSummaryOptions {
  documentName: string;
  /** Missing entries are deliberately treated as unresolved. */
  statusByAnnotationId: Readonly<Record<string, AnnotationAnchorStatus | undefined>>;
  /** Current verified sections. A missing entry is grouped as unlabelled. */
  sectionByAnnotationId?: Readonly<Record<string, ReadingSummarySection | undefined>>;
  filter?: ReadingSummaryFilter;
}

const colorNames: Readonly<Record<AnnotationColor, string>> = {
  amber: '琥珀色',
  sage: '鼠尾草绿',
  blue: '蓝色',
  rose: '玫瑰色',
};

function escapeMarkdownLine(line: string): string {
  // Escape inline Markdown and raw HTML everywhere. Block markers are escaped at
  // the start of a line so text nested in our quote cannot become a heading/list.
  let inlineSafe = line
    .replace(/\\/g, '\\\\')
    .replace(/([`*_[\]{}()!~|<>])/g, '\\$1');
  // Four spaces or a tab would otherwise form an indented code block inside
  // the blockquote. An entity is resolved only after Markdown block parsing.
  if (inlineSafe.startsWith(' ')) inlineSafe = `&#32;${inlineSafe.slice(1)}`;
  else if (inlineSafe.startsWith('\t')) inlineSafe = `&#9;${inlineSafe.slice(1)}`;
  return inlineSafe.replace(
    /^(\s{0,3})(#{1,6}(?=\s|$)|[-=]+(?=\s*$)|[-+](?=\s)|\d+[.)](?=\s))/, '$1\\$2',
  );
}

function quoted(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.length === 0 ? '>' : `> ${escapeMarkdownLine(line)}`)
    .join('\n');
}

function statusFor(
  statuses: ReadingSummaryOptions['statusByAnnotationId'],
  id: string,
): AnnotationAnchorStatus {
  return Object.hasOwn(statuses, id) && statuses[id] === 'resolved' ? 'resolved' : 'unresolved';
}

function matchesFilter(annotation: AnnotationRecord, filter: ReadingSummaryFilter): boolean {
  if (filter.mode === 'all') return true;
  if (filter.mode === 'untagged') return annotation.tagId === undefined;
  return annotation.tagId === filter.tagId;
}

function appendQuotedField(lines: string[], label: string, value: string): void {
  lines.push(`- ${label}：`, '', quoted(value));
}

interface SummaryEntry {
  annotation: AnnotationRecord;
  status: AnnotationAnchorStatus;
  section?: ReadingSummarySection;
}

type ChapterGroup =
  | { kind: 'resolved'; section: ReadingSummarySection; entries: SummaryEntry[] }
  | { kind: 'unspecified'; entries: SummaryEntry[] };

function chapterGroupKind(entry: SummaryEntry): ChapterGroup['kind'] {
  return entry.section ? 'resolved' : 'unspecified';
}

function sameChapterGroup(group: ChapterGroup, entry: SummaryEntry): boolean {
  const kind = chapterGroupKind(entry);
  if (group.kind !== kind) return false;
  if (group.kind === 'unspecified') return true;
  return group.section.key === entry.section?.key;
}

function groupByContiguousChapter(entries: SummaryEntry[]): ChapterGroup[] {
  const groups: ChapterGroup[] = [];
  for (const entry of entries) {
    const current = groups.at(-1);
    if (current && sameChapterGroup(current, entry)) {
      current.entries.push(entry);
      continue;
    }
    const kind = chapterGroupKind(entry);
    if (kind === 'unspecified') groups.push({ kind, entries: [entry] });
    else groups.push({ kind, section: entry.section as ReadingSummarySection, entries: [entry] });
  }
  return groups;
}

/**
 * Build copyable Markdown without mutating the sidecar or source document.
 *
 * User controlled text is always emitted in escaped blockquotes. Resolved
 * records use current verified byte positions. Unresolved records have no
 * comparable current position, so they stay in sidecar order in a final area.
 */
export function formatReadingSummary(sidecar: AnnotationSidecar, options: ReadingSummaryOptions): string {
  const filter = options.filter ?? { mode: 'all' };
  const tagById = new Map(sidecar.tags.map((tag) => [tag.id, tag.name]));
  if (filter.mode === 'tag' && !tagById.has(filter.tagId)) {
    throw new Error('阅读摘要筛选的标签不存在。');
  }

  const selected = sidecar.annotations
    .map((annotation, sourceIndex) => ({ annotation, sourceIndex }))
    .filter(({ annotation }) => matchesFilter(annotation, filter))
    .map(({ annotation, sourceIndex }) => ({
      annotation,
      status: statusFor(options.statusByAnnotationId, annotation.id),
      sourceIndex,
      section: options.sectionByAnnotationId && Object.hasOwn(options.sectionByAnnotationId, annotation.id)
        ? options.sectionByAnnotationId[annotation.id]
        : undefined,
    }));
  const resolved = selected
    .filter(({ status }) => status === 'resolved')
    .sort((left, right) => left.annotation.anchor.startByte - right.annotation.anchor.startByte ||
      left.sourceIndex - right.sourceIndex);
  const unresolved = selected.filter(({ status }) => status === 'unresolved');

  const lines: string[] = ['# MerMarkd 阅读摘要', '', '## 文档', '', quoted(options.documentName), ''];
  if (filter.mode === 'all') {
    lines.push('- 筛选：全部批注');
  } else if (filter.mode === 'untagged') {
    lines.push('- 筛选：无标签');
  } else {
    lines.push('- 筛选：指定标签', '', quoted(tagById.get(filter.tagId) ?? ''));
  }
  lines.push(`- 批注数：${selected.length}`);

  if (selected.length === 0) {
    lines.push('', '## 批注', '', '> 当前筛选条件下没有批注。', '');
    return lines.join('\n');
  }

  let annotationNumber = 0;
  for (const [groupIndex, group] of groupByContiguousChapter(resolved).entries()) {
    lines.push('', `## 章节分组 ${groupIndex + 1}`, '');
    if (group.kind === 'unspecified') {
      lines.push('- 分组：未标明章节');
    } else {
      lines.push('- 分组：已定位章节');
      appendQuotedField(lines, '章节', group.section.title);
    }
    for (const { annotation, status } of group.entries) {
      annotationNumber += 1;
      lines.push(
        '',
        `### 批注 ${annotationNumber}`,
        '',
        `- 状态：${status === 'resolved' ? '已定位' : '待定位（原位置未核验）'}`,
        `- 类型：${annotation.kind === 'note' ? '便签' : '高亮'}`,
        `- 高亮颜色：${annotation.color ? colorNames[annotation.color] : '无'}`,
      );
      appendQuotedField(lines, '引文', annotation.anchor.displayQuote);
      if (annotation.tagId) {
        appendQuotedField(lines, '标签', tagById.get(annotation.tagId) ?? annotation.tagId);
      } else {
        lines.push('- 标签：无标签');
      }
      if (annotation.kind === 'note' && annotation.note !== undefined) {
        appendQuotedField(lines, '便签', annotation.note);
      }
    }
  }
  if (unresolved.length > 0) {
    lines.push(
      '',
      '## 待定位',
      '',
      '> 以下批注尚未在当前原文中确认位置，按 sidecar 原记录顺序保留。',
    );
    for (const { annotation } of unresolved) {
      annotationNumber += 1;
      lines.push(
        '',
        `### 待定位批注 ${annotationNumber}`,
        '',
        '- 状态：待定位（原位置未核验）',
        `- 类型：${annotation.kind === 'note' ? '便签' : '高亮'}`,
        `- 高亮颜色：${annotation.color ? colorNames[annotation.color] : '无'}`,
      );
      if (annotation.anchor.sectionHint) {
        appendQuotedField(lines, '原章节线索', annotation.anchor.sectionHint);
      } else {
        lines.push('- 原章节线索：无');
      }
      appendQuotedField(lines, '引文', annotation.anchor.displayQuote);
      if (annotation.tagId) appendQuotedField(lines, '标签', tagById.get(annotation.tagId) ?? annotation.tagId);
      else lines.push('- 标签：无标签');
      if (annotation.kind === 'note' && annotation.note !== undefined) appendQuotedField(lines, '便签', annotation.note);
    }
  }
  lines.push('');
  return lines.join('\n');
}
