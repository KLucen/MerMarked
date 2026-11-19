import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createSavedDocumentBundle } from '../../src/main/document-bundle-store.ts';

const [sourcePath, targetPath, asset, checkpoint] = process.argv.slice(2);
if (!sourcePath || !targetPath || !asset || !['prepared', 'published'].includes(checkpoint)) throw Error('Explicit isolated bundle paths required.');
await createSavedDocumentBundle({ sourcePath, targetPath,
  expectedSourceSha256: createHash('sha256').update(await readFile(sourcePath)).digest('hex'),
  planSnapshot: async () => [asset], review: async () => {},
  beforePublish: async () => { if (checkpoint === 'prepared') process.exit(73); },
  afterPublish: async () => { if (checkpoint === 'published') process.exit(73); },
});
throw Error('Bundle crash checkpoint not reached.');
