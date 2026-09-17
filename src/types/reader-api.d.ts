export interface OpenedMarkdownDocument {
  path: string;
  name: string;
  content: string;
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
