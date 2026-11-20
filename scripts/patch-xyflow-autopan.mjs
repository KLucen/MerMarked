import { createHash } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const XYFLOW_VERSION = '0.0.83';
export const XYFLOW_ORIGINAL_SHA256 = 'ba3932f6ceab1529c9f3587695b43bdae84e31d356eb153473df5f5c38e6bd5c';
export const XYFLOW_PATCHED_SHA256 = 'a24ad58cf3d16245cbaa2f7254970a963282a189adec5a844f345e0b54c1e699';
const launch = '            if (!autoPanStarted && autoPanOnNodeDrag && dragStarted) {\n' +
  '                autoPanStarted = true;\n' +
  '                autoPan();\n' +
  '            }\n';
const tail = '                updateNodes(pointerPos);\n' +
  '            }\n' +
  '        })\n' +
  "            .on('end'";
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const capture = '            const shouldStartAutoPan = !autoPanStarted && autoPanOnNodeDrag && dragStarted;\n';
const deferredLaunch = launch.replace('!autoPanStarted && autoPanOnNodeDrag && dragStarted', 'shouldStartAutoPan');

/** Preserve the original start decision, then pan after pointer compensation. */
export function patchXyflowAutopanBytes(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('Expected XYFlow source bytes.');
  const sha256 = digest(bytes);
  if (sha256 === XYFLOW_PATCHED_SHA256) return { bytes: Buffer.from(bytes), changed: false };
  if (sha256 !== XYFLOW_ORIGINAL_SHA256) throw new Error('Unsupported @xyflow/system source checksum; review the patch before upgrading.');
  const source = Buffer.from(bytes).toString('utf8');
  if (source.split(launch).length !== 2 || source.split(tail).length !== 2) throw new Error('XYFlow auto-pan patch signature mismatch.');
  const patched = Buffer.from(source.replace(launch, capture).replace(tail,
    '                updateNodes(pointerPos);\n' + '            }\n' + deferredLaunch + '        })\n' + "            .on('end'"));
  if (digest(patched) !== XYFLOW_PATCHED_SHA256) throw new Error('XYFlow auto-pan patch output checksum mismatch.');
  return { bytes: patched, changed: true };
}

/** Validate both published ESM entry points before changing either one. */
export async function patchXyflowAutopan(packageDirectory = fileURLToPath(new URL('../node_modules/@xyflow/system/', import.meta.url))) {
  const manifest = JSON.parse(await readFile(path.join(packageDirectory, 'package.json'), 'utf8'));
  if (manifest.name !== '@xyflow/system' || manifest.version !== XYFLOW_VERSION) {
    throw new Error('Unsupported @xyflow/system version; review the auto-pan patch before upgrading.');
  }
  const plans = [];
  for (const entry of ['dist/esm/index.js', 'dist/esm/index.mjs']) {
    const file = path.join(packageDirectory, entry), info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Expected a plain XYFlow ESM entry file.');
    const original = await readFile(file);
    plans.push({ entry, file, originalSha256: digest(original), ...patchXyflowAutopanBytes(original) });
  }
  for (const plan of plans) {
    if (digest(await readFile(plan.file)) !== plan.originalSha256) throw new Error('XYFlow entry changed while preparing its patch.');
  }
  for (const plan of plans) {
    if (plan.changed) await writeFile(plan.file, plan.bytes);
    if (digest(await readFile(plan.file)) !== XYFLOW_PATCHED_SHA256) throw new Error('XYFlow patched entry failed verification.');
  }
  return plans.map(({ entry, changed }) => ({ entry, changed, sha256: XYFLOW_PATCHED_SHA256 }));
}

const samePath = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
if (process.argv[1] && samePath(path.resolve(process.argv[1]), fileURLToPath(import.meta.url))) {
  try {
    const entries = await patchXyflowAutopan();
    console.log(`Verified @xyflow/system ${XYFLOW_VERSION} auto-pan ordering (${entries.filter(entry => entry.changed).length} updated ESM entries).`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Unable to verify the XYFlow auto-pan patch.');
    process.exitCode = 1;
  }
}
