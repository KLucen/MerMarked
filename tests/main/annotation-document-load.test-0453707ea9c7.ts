import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseAnnotationYaml } from '../../src/core/annotations.ts';
import { loadAnnotationDocumentData } from '../../src/main/annotation-document-load.ts';

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mermarkd-annotation-view-'));
  const documentPath = path.join(directory, 'private-document.md');
  const sidecarPath = `${documentPath}.annotations.yaml`;
  const draftDirectory = path.join(directory, 'private-app-data', 'annotation-drafts');
  await writeFile(documentPath, '# 标题\n正文\n', 'utf8');
  return { directory, documentPath, sidecarPath, draftDirectory };
}

function assertReasonDoesNotLeak(reason: string, forbidden: readonly string[]): void {
  for (const value of forbidden) assert.equal(reason.includes(value), false, `reason leaked ${value}`);
}

test('damaged sidecar returns a stable category and safe reader message while logging details', async () => {
  const f = await fixture();
  const sourceExact = '不应出现在阅读界面的私密原文';
  const byteRange = '[12, 48)';
  const rawError = new Error(
    `批注 YAML 无效：sourceExact=${sourceExact}; range=${byteRange}; sidecar=${f.sidecarPath}`,
  );
  const logged: Array<{ code: string; error: unknown }> = [];
  try {
    await writeFile(f.sidecarPath, `schemaVersion: 1\nsourceExact: ${sourceExact}\n`, 'utf8');
    const result = await loadAnnotationDocumentData(f.documentPath, f.draftDirectory, {
      parseSidecar: (text) => {
        assert.throws(() => parseAnnotationYaml(text), /批注 YAML 无效/);
        throw rawError;
      },
      logError: (code, error) => logged.push({ code, error }),
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.errorCode, 'sidecar-invalid');
    assert.equal(result.reason, '批注文件格式无效，已按只读处理。请修复或移走批注文件后重新检查。');
    assertReasonDoesNotLeak(result.reason, [sourceExact, byteRange, f.sidecarPath, 'sourceExact']);
    assert.deepEqual(logged, [{ code: 'sidecar-invalid', error: rawError }]);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test('annotation and Markdown read failures expose only stable codes and natural messages', async () => {
  const f = await fixture();
  const sourceExact = 'private-source-exact';
  const byteRange = '[96, 144)';
  const forbidden = [sourceExact, byteRange, f.sidecarPath, f.documentPath, 'sourceExact'];
  const logged: Array<{ code: string; error: unknown }> = [];
  try {
    const sidecarReadError = new Error(
      `EACCES ${f.sidecarPath}; sourceExact=${sourceExact}; bytes=${byteRange}`,
    );
    const sidecarResult = await loadAnnotationDocumentData(f.documentPath, f.draftDirectory, {
      loadFile: async () => { throw sidecarReadError; },
      logError: (code, error) => logged.push({ code, error }),
    });
    assert.equal(sidecarResult.ok, false);
    if (sidecarResult.ok) return;
    assert.equal(sidecarResult.errorCode, 'annotation-read-failed');
    assert.equal(sidecarResult.reason, '无法读取批注状态。请确认原文和批注文件可访问后重新检查。');
    assertReasonDoesNotLeak(sidecarResult.reason, forbidden);

    const sourceReadError = new Error(
      `EPERM ${f.documentPath}; sourceExact=${sourceExact}; bytes=${byteRange}`,
    );
    const sourceResult = await loadAnnotationDocumentData(f.documentPath, f.draftDirectory, {
      readSource: async () => { throw sourceReadError; },
      logError: (code, error) => logged.push({ code, error }),
    });
    assert.equal(sourceResult.ok, false);
    if (sourceResult.ok) return;
    assert.equal(sourceResult.errorCode, 'source-read-failed');
    assert.equal(sourceResult.reason, '无法核对当前 Markdown。请确认文件仍可读取后重新载入。');
    assertReasonDoesNotLeak(sourceResult.reason, forbidden);

    assert.deepEqual(logged, [
      { code: 'annotation-read-failed', error: sidecarReadError },
      { code: 'source-read-failed', error: sourceReadError },
    ]);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});
