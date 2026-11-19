const MAX_ARCHIVE_BYTES = 52 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

export type BundleArchiveFileKind = 'markdown' | 'annotations' | 'canvas' | 'image';
export interface BundleArchiveFile {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly kind: BundleArchiveFileKind;
}
export interface ParsedDocumentBundle {
  readonly documentName: string;
  readonly files: readonly BundleArchiveFile[];
  readonly imageCount: number;
  readonly totalBytes: number;
}
export class BundleArchiveError extends Error {
  constructor() {
    super('副本包格式不支持、内容不完整或超出限制，请使用 MerMarkd 生成的文档副本包。');
    this.name = 'BundleArchiveError';
  }
}
function invalid(): never { throw new BundleArchiveError(); }
function requireArchive(condition: unknown): asserts condition { if (!condition) invalid(); }
const nameKey = (name: string) => name.normalize('NFC').toUpperCase();

function validPath(name: string): boolean {
  return name.length > 0 && name.length <= 2048 && !/[\\\uD800-\uDFFF]/u.test(name) &&
    name.split('/').every(segment => segment.length > 0 && segment.length <= 255 && segment !== '.' && segment !== '..' &&
      !/[<>:"|?*\u0000-\u001f\u007f-\u009f]/.test(segment) && !/[ .]$/.test(segment) &&
      !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(segment));
}
function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  return crc >>> 0;
});
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const value of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ value) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}

/** Read only the bounded, stored UTF-8 ZIP32 dialect emitted by FILE1C. */
export function parseDocumentBundleArchive(bytes: Uint8Array): ParsedDocumentBundle {
  try {
    requireArchive(bytes instanceof Uint8Array && bytes.length >= 22 && bytes.length <= MAX_ARCHIVE_BYTES);
    // Own the validated snapshot and returned payloads; caller mutations cannot
    // subsequently change either names or file contents behind the result.
    const input = Uint8Array.from(bytes), view = new DataView(input.buffer);
    const end = input.length - 22;
    requireArchive(view.getUint32(end, true) === 0x06054b50 && view.getUint16(end + 4, true) === 0 &&
      view.getUint16(end + 6, true) === 0 && view.getUint16(end + 20, true) === 0);
    const count = view.getUint16(end + 10, true), centralBytes = view.getUint32(end + 12, true);
    const centralStart = view.getUint32(end + 16, true);
    requireArchive(count > 0 && count <= 35 && view.getUint16(end + 8, true) === count &&
      centralStart + centralBytes === end && centralBytes >= count * 46);
    const entries: { path: string; data: Uint8Array }[] = [];
    const names = new Set<string>(), directoryNames = new Map<string, string>();
    let central = centralStart, local = 0, totalBytes = 0;
    for (let index = 0; index < count; index++) {
      requireArchive(central <= end - 46 && view.getUint32(central, true) === 0x02014b50 &&
        view.getUint16(central + 4, true) === 20 && view.getUint16(central + 6, true) === 20 &&
        view.getUint16(central + 8, true) === 0x0800 && view.getUint16(central + 10, true) === 0 &&
        view.getUint16(central + 30, true) === 0 && view.getUint16(central + 32, true) === 0 &&
        view.getUint16(central + 34, true) === 0 && view.getUint16(central + 36, true) === 0 &&
        view.getUint32(central + 38, true) === 0x20 && view.getUint32(central + 42, true) === local);
      const crc = view.getUint32(central + 16, true), size = view.getUint32(central + 24, true);
      const nameLength = view.getUint16(central + 28, true);
      requireArchive(size === view.getUint32(central + 20, true) && nameLength > 0 && nameLength <= 4096 &&
        central + 46 + nameLength <= end && local <= centralStart - 30);
      const encodedName = input.subarray(central + 46, central + 46 + nameLength);
      const name = decoder.decode(encodedName), key = nameKey(name);
      requireArchive(validPath(name) && equalBytes(encoder.encode(name), encodedName) && !names.has(key));
      names.add(key);
      const parts = name.split('/');
      for (let depth = 1; depth < parts.length; depth++) {
        const prefix = parts.slice(0, depth).join('/'), prefixKey = nameKey(prefix);
        const prior = directoryNames.get(prefixKey);
        requireArchive(prior === undefined || prior === prefix);
        directoryNames.set(prefixKey, prefix);
      }
      requireArchive(view.getUint32(local, true) === 0x04034b50 && view.getUint16(local + 4, true) === 20 &&
        view.getUint16(local + 6, true) === 0x0800 && view.getUint16(local + 8, true) === 0 &&
        view.getUint16(local + 10, true) === view.getUint16(central + 12, true) &&
        view.getUint16(local + 12, true) === view.getUint16(central + 14, true) &&
        view.getUint32(local + 14, true) === crc && view.getUint32(local + 18, true) === size &&
        view.getUint32(local + 22, true) === size && view.getUint16(local + 26, true) === nameLength &&
        view.getUint16(local + 28, true) === 0);
      const dataStart = local + 30 + nameLength, dataEnd = dataStart + size;
      requireArchive(dataEnd <= centralStart && equalBytes(input.subarray(local + 30, dataStart), encodedName));
      totalBytes += size;
      requireArchive(totalBytes <= MAX_TOTAL_BYTES);
      const data = input.subarray(dataStart, dataEnd);
      requireArchive(crc32(data) === crc);
      entries.push({ path: name, data }); local = dataEnd; central += 46 + nameLength;
    }
    requireArchive(central === end && local === centralStart);
    for (const key of directoryNames.keys()) requireArchive(!names.has(key));
    const documents = entries.filter(entry => !entry.path.includes('/') && entry.path.length > 3 && /\.md$/i.test(entry.path));
    requireArchive(documents.length === 1);
    const documentName = documents[0].path;
    let imageCount = 0;
    const files = entries.map((entry): BundleArchiveFile => {
      let kind: BundleArchiveFileKind, limit: number;
      if (entry.path === documentName) { kind = 'markdown'; limit = 32 * 1024 * 1024; }
      else if (entry.path === documentName + '.annotations.yaml') { kind = 'annotations'; limit = 1024 * 1024; }
      else if (entry.path === documentName + '.mermarkd.json') { kind = 'canvas'; limit = 4 * 1024 * 1024; }
      else {
        const basename = entry.path.split('/').at(-1)!;
        requireArchive(basename.lastIndexOf('.') > 0 && /\.(?:png|jpe?g|gif|webp)$/i.test(basename));
        kind = 'image'; limit = MAX_IMAGE_BYTES; imageCount += 1;
      }
      requireArchive(entry.data.length <= limit);
      return { path: entry.path, bytes: Uint8Array.from(entry.data), kind };
    });
    requireArchive(imageCount <= 32);
    return { documentName, files, imageCount, totalBytes };
  } catch (error) { throw error instanceof BundleArchiveError ? error : new BundleArchiveError(); }
}
