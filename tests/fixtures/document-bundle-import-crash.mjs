import { importDocumentBundle } from '../../src/main/document-bundle-import-store.ts';
const [archivePath, parentDirectory, checkpoint] = process.argv.slice(2);
let before = 0;
await importDocumentBundle({ archivePath, parentDirectory, review: async () => {},
  beforePublish: async () => { if (++before === 2 && checkpoint === 'before-markdown') process.exit(73); },
  afterPublish: async relative => { if (relative.endsWith('.md') && checkpoint === 'after-markdown') process.exit(73); },
});
throw Error('interruption checkpoint was not reached');
