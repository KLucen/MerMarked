import { commitDocumentTransaction } from '../../src/main/document-transaction.ts';

const [documentPath, refText, phase, fileKind] = process.argv.slice(2);
await commitDocumentTransaction(documentPath, JSON.parse(refText), {
  [phase]: async (kind) => { if (kind === fileKind) process.exit(37); },
});
process.exit(38);
