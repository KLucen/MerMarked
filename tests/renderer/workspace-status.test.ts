import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeWorkspaceStatus } from '../../src/renderer/workspace-status.ts';
import type { WorkspaceStatuses } from '../../src/renderer/workspace-status.ts';

const saved: WorkspaceStatuses = {
  source: { text: '已保存', tone: 'neutral' },
  annotations: { text: '已保存', tone: 'neutral' },
  canvas: { text: '尚未载入', tone: 'neutral' },
};

test('a canvas conflict remains visible when source is saved or being saved', () => {
  for (const source of [saved.source, { text: '保存中', tone: 'busy' as const }]) {
    assert.deepEqual(summarizeWorkspaceStatus({ ...saved, source,
      canvas: { text: '外部文件已改变', tone: 'error' } }),
    { text: '画布 · 外部文件已改变', tone: 'error' });
  }
});

test('annotation failure takes priority over a source warning', () => {
  assert.deepEqual(summarizeWorkspaceStatus({ ...saved,
    source: { text: '正文有外部改动', tone: 'warning' },
    annotations: { text: '保存失败', tone: 'error' } }),
  { text: '批注 · 保存失败', tone: 'error' });
});

test('clean and dirty documents preserve the source status without claiming canvas is saved', () => {
  assert.deepEqual(summarizeWorkspaceStatus(saved), saved.source);
  const source = { text: '未保存', tone: 'neutral' as const };
  assert.deepEqual(summarizeWorkspaceStatus({ ...saved, source }), source);
});
