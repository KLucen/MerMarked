import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { copyDocumentFiles } from '../../src/main/document-copy-store.ts';
const [sourcePath, targetPath, journalDirectory, checkpoint] = process.argv.slice(2);
if (!sourcePath || !targetPath || !journalDirectory || !checkpoint) throw Error('Copy crash fixture needs explicit temporary paths.');
const bytes = await readFile(sourcePath);
await copyDocumentFiles({ sourcePath, targetPath, journalDirectory,
  expectedSourceSha256: createHash('sha256').update(bytes).digest('hex'),
  afterPublish: async suffix => { if (suffix === (checkpoint === 'markdown' ? '' : checkpoint)) process.exit(73); },
});
throw Error('Crash checkpoint not reached.');