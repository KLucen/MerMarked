export interface OpenedMarkdownDocument {
  path: string;
  name: string;
  content: string;
  /** SHA-256 of the exact bytes read from disk, including any BOM and CRLF. */
  sourceSha256: string;
  bomByteLength: 0 | 3;
}

export interface MerMarkdApi {
  readonly appName: 'MerMarkd';
  openMarkdown(): Promise<OpenedMarkdownDocument | null>;
  readDocumentImage(relativePath: string): Promise<string | null>;
  openExternal(url: string): Promise<boolean>;
}

declare global {
  interface Window {
    mermarkd: MerMarkdApi;
  }
}
