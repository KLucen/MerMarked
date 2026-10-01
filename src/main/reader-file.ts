import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { decodeMarkdownBytes } from '../core/markdown-source.ts';

const maxImageBytes = 10 * 1024 * 1024;
const imageMimeTypes: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

export interface FileSelection {
  canceled: boolean;
  filePaths: string[];
}

export function selectedMarkdownPath(selection: FileSelection): string | null {
  if (selection.canceled || selection.filePaths.length !== 1) return null;
  const selectedPath = selection.filePaths[0];
  if (path.extname(selectedPath).toLowerCase() !== '.md') {
    throw new Error('请选择 .md 文件。');
  }
  return selectedPath;
}

export async function validatedLocalMarkdownPath(value: unknown): Promise<string> {
  if (
    typeof value !== 'string' ||
    !path.isAbsolute(value) ||
    path.extname(value).toLowerCase() !== '.md'
  ) {
    throw new Error('请选择单个本地 .md 文件。');
  }

  let resolvedPath: string;
  try {
    resolvedPath = await realpath(value);
    const fileStat = await stat(resolvedPath);
    if (!fileStat.isFile() || path.extname(resolvedPath).toLowerCase() !== '.md') {
      throw new Error('请选择单个本地 .md 文件。');
    }
  } catch {
    throw new Error('无法打开文件，请确认它是可读取的 .md 文件。');
  }

  return resolvedPath;
}

/** Kept for the drop-specific call site and tests; picker uses the same trust boundary. */
export const validatedDroppedMarkdownPath = validatedLocalMarkdownPath;

export function decodeUtf8Markdown(bytes: Uint8Array): string {
  return decodeMarkdownBytes(bytes).content;
}

export interface DecodedMarkdownSource {
  content: string;
  sourceSha256: string;
  bomByteLength: 0 | 3;
}

export function decodeMarkdownSource(bytes: Uint8Array): DecodedMarkdownSource {
  const decoded = decodeMarkdownBytes(bytes);
  return {
    content: decoded.content,
    sourceSha256: createHash('sha256').update(bytes).digest('hex'),
    bomByteLength: decoded.format.bomByteLength,
  };
}

function decodeImagePath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
    return null;
  }

  try {
    // Markdown destinations are URLs. Windows file names cannot contain ? or #.
    const decoded = decodeURIComponent(value.split(/[?#]/, 1)[0]);
    if (
      !decoded ||
      decoded.includes('\0') ||
      /^[a-z][a-z\d+.-]*:/i.test(decoded) ||
      path.isAbsolute(decoded) ||
      path.win32.isAbsolute(decoded)
    ) {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

export async function readDocumentImage(documentPath: string, value: unknown): Promise<string | null> {
  const relativePath = decodeImagePath(value);
  if (relativePath === null) return null;

  try {
    const documentDirectory = path.dirname(await realpath(documentPath));
    const imagePath = await realpath(path.resolve(documentDirectory, relativePath));
    const relativeResolvedPath = path.relative(documentDirectory, imagePath);
    if (
      relativeResolvedPath === '' ||
      relativeResolvedPath === '..' ||
      relativeResolvedPath.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeResolvedPath)
    ) {
      return null;
    }

    const mimeType = imageMimeTypes[path.extname(imagePath).toLowerCase()];
    if (!mimeType) return null;

    const imageStat = await stat(imagePath);
    if (!imageStat.isFile() || imageStat.size > maxImageBytes) return null;

    const bytes = await readFile(imagePath);
    if (bytes.byteLength > maxImageBytes) return null;
    return `data:${mimeType};base64,${bytes.toString('base64')}`;
  } catch {
    return null;
  }
}

export function validatedExternalUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || /[\u0000-\u001f\u007f]/.test(value)) {
    return null;
  }

  try {
    const parsed = new URL(value);
    if (parsed.protocol === 'mailto:') {
      return parsed.pathname && !parsed.username && !parsed.password ? parsed.href : null;
    }
    if (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      parsed.hostname &&
      !parsed.username &&
      !parsed.password
    ) {
      return parsed.href;
    }
  } catch {
    // Invalid destinations are ignored, including relative URLs.
  }
  return null;
}
