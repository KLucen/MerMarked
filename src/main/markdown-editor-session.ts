import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  assertMarkdownLineEndingsPreserved,
  encodeMarkdownBytes,
  inspectMarkdownSourceFormat,
} from '../core/markdown-source.ts';
import type {
  MarkdownEditorSaveResult,
  MarkdownEditorUpdateInput,
  MarkdownEditorView,
  MarkdownRecoveryDraftView,
  OpenedMarkdownDocument,
} from '../types/reader-api.ts';
import {
  discardMarkdownDraft,
  discardMarkdownSourceBackup,
  listMarkdownDrafts,
  loadMarkdownDraft,
  saveMarkdownDraft,
  saveMarkdownFile,
} from './markdown-store.ts';
import { assertStructureBaseline, bundleDigest, finalizeSectionStructurePlan } from './section-structure-store.ts';
import type { SectionStructurePlan } from './section-structure-store.ts';
import { commitDocumentTransaction, prepareDocumentTransaction } from './document-transaction.ts';
import type { DocumentTransactionRef } from './document-transaction.ts';
import type {
  MarkdownDraft,
  MarkdownDraftRevision,
  MarkdownSourceBackup,
  SaveMarkdownFileResult,
} from './markdown-store.ts';

const maxEditableMarkdownBytes = 32 * 1024 * 1024;

interface RecoveryDraftRecord {
  readonly id: string;
  readonly draft: MarkdownDraft;
}

function comparablePath(value: string): string {
  const normalized = path.normalize(path.resolve(value));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function previewLine(content: string): string {
  const line = content.split(/\r\n|\r|\n/, 1)[0].trim();
  return (line || '空白 Markdown 草稿').slice(0, 80);
}

function recoveryView(record: RecoveryDraftRecord): MarkdownRecoveryDraftView {
  return {
    id: record.id,
    relationship: record.draft.relationship,
    createdAt: record.draft.createdAt,
    updatedAt: record.draft.updatedAt,
    preview: previewLine(record.draft.content),
  };
}

function saveFailureMessage(result: Exclude<SaveMarkdownFileResult, { status: 'saved' }>): string {
  if (result.status === 'conflict') {
    return result.reason === 'busy'
      ? '另一项 Markdown 保存仍在进行，候选内容已保留为恢复草稿。'
      : '磁盘上的 Markdown 已在外部修改；外部版本未被覆盖，候选内容已保留为恢复草稿。';
  }
  const messages: Record<typeof result.reason, string> = {
    'source-missing': '磁盘上的 Markdown 已不存在，候选内容已保留为恢复草稿。',
    'source-unreadable': '无法重新读取磁盘上的 Markdown，候选内容已保留为恢复草稿。',
    'unsupported-format': '当前源码格式不满足安全保存条件，候选内容已保留为恢复草稿。',
    'parse-error': '候选 Markdown 无法安全建立章节结构，未覆盖原文件。',
    'read-only': 'Markdown 所在目录不可写，候选内容已保留为恢复草稿。',
    'write-error': 'Markdown 写入失败，候选内容已保留为恢复草稿。',
    'verify-error': '保存后的内容无法完成核验，请保留恢复文件并重新载入磁盘版本。',
  };
  return messages[result.reason];
}

export class MarkdownEditorSession {
  readonly epoch: string;
  readonly draftDirectory: string;
  document: OpenedMarkdownDocument;

  #content: string;
  #revision = 0;
  #activeDraft: MarkdownDraftRevision | undefined;
  #recoveryDrafts = new Map<string, RecoveryDraftRecord>();
  #unreadableDraftCount = 0;
  #retainedTemporaryDraftCount = 0;
  #latestSourceBackup: { readonly id: string; readonly backup: MarkdownSourceBackup } | undefined;
  #writeInProgress = false;
  #structurePlan: SectionStructurePlan | undefined;
  #structureTransaction: DocumentTransactionRef | undefined;

  get hasStructureEdit(): boolean { return this.#structurePlan !== undefined; }
  get pendingStructureTransactionId(): string | undefined { return this.#structureTransaction?.id; }

  get structureCanvas(): Uint8Array | null | undefined {
    return this.#structurePlan && this.#content === this.#structurePlan.preview.candidate
      ? this.#structurePlan.after.canvas : undefined;
  }

  async stageSectionStructure(plan: SectionStructurePlan): Promise<MarkdownEditorView> {
    if (this.dirty || plan.preview.source !== this.document.content || bundleDigest(plan.before.markdown) !== this.document.sourceSha256) {
      throw new Error('编辑基线已变化，请重新生成结构预览。');
    }
    return this.#withWrite(async () => {
      await assertStructureBaseline(this.document.path, plan.before);
      // No document or sidecar writes: this is one editor revision only.
      this.#acceptUpdate({ epoch: this.epoch, revision: this.#revision + 1, content: plan.preview.candidate }, true);
      this.#structurePlan = plan;
      this.#structureTransaction = undefined;
      return this.view();
    });
  }

  private constructor(
    document: OpenedMarkdownDocument,
    draftDirectory: string,
    epoch: string,
  ) {
    this.document = document;
    this.draftDirectory = draftDirectory;
    this.epoch = epoch;
    this.#content = document.content;
  }

  static async create(
    document: OpenedMarkdownDocument,
    draftDirectory: string,
    epoch: string = randomUUID(),
  ): Promise<MarkdownEditorSession> {
    const session = new MarkdownEditorSession(document, draftDirectory, epoch);
    await session.#refreshRecoveryDrafts();
    return session;
  }

  get dirty(): boolean {
    return this.#content !== this.document.content;
  }

  get writeInProgress(): boolean {
    return this.#writeInProgress;
  }

  view(): MarkdownEditorView {
    const format = inspectMarkdownSourceFormat(this.#content, this.document.bomByteLength);
    const byteLength = encodeMarkdownBytes(this.#content, this.document.bomByteLength).byteLength;
    const baselineFormat = inspectMarkdownSourceFormat(
      this.document.content,
      this.document.bomByteLength,
    );
    const editable = !this.#structureTransaction && baselineFormat.lineEnding !== 'mixed' && byteLength <= maxEditableMarkdownBytes;
    const readOnlyReason = this.#structureTransaction
      ? '结构保存事务尚未完成；请检查保存恢复，再继续编辑。'
      : baselineFormat.lineEnding === 'mixed'
      ? '这份文档混用了多种换行格式；当前版本只允许阅读源码，不能保存编辑。'
      : byteLength > maxEditableMarkdownBytes
        ? '这份文档超过 32 MiB；当前版本只允许阅读源码，不能保存编辑。'
        : undefined;
    return {
      epoch: this.epoch,
      revision: this.#revision,
      content: this.#content,
      dirty: this.dirty,
      editable,
      ...(readOnlyReason ? { readOnlyReason } : {}),
      sourceFormat: baselineFormat,
      format,
      draftPersisted: this.#activeDraft !== undefined,
      recoveryDrafts: [...this.#recoveryDrafts.values()].map(recoveryView),
      unreadableDraftCount: this.#unreadableDraftCount,
      retainedTemporaryDraftCount: this.#retainedTemporaryDraftCount,
      ...(this.#latestSourceBackup ? { latestSourceBackupId: this.#latestSourceBackup.id } : {}),
    };
  }

  update(input: MarkdownEditorUpdateInput): MarkdownEditorView {
    return this.#acceptUpdate(input);
  }

  #acceptUpdate(input: MarkdownEditorUpdateInput, stagingStructure = false): MarkdownEditorView {
    this.#assertEpoch(input.epoch);
    if (this.#writeInProgress && !stagingStructure) throw new Error('Markdown 正在保存，请稍后继续编辑。');
    if (this.#structureTransaction) throw new Error('结构保存事务尚待恢复，请先核验文档恢复事务。');
    const currentView = this.view();
    if (!currentView.editable) throw new Error(currentView.readOnlyReason ?? '当前源码不能安全编辑。');
    if (!Number.isSafeInteger(input.revision) || input.revision < 0) {
      throw new Error('编辑版本无效，请重新进入编辑模式。');
    }
    if (input.revision === this.#revision) {
      if (input.content !== this.#content) throw new Error('编辑版本已变化，请重新载入编辑缓冲区。');
      return this.view();
    }
    if (input.revision !== this.#revision + 1) {
      throw new Error('编辑版本不连续，请重新载入编辑缓冲区。');
    }
    const bytes = encodeMarkdownBytes(input.content, this.document.bomByteLength);
    if (bytes.byteLength > maxEditableMarkdownBytes) {
      throw new Error('Markdown 缓冲区超过 32 MiB，未接受本次编辑。');
    }
    const candidateFormat = inspectMarkdownSourceFormat(input.content, this.document.bomByteLength);
    if (candidateFormat.lineEnding === 'mixed') {
      throw new Error('Markdown 缓冲区混用了多种换行格式，未接受本次编辑。');
    }
    assertMarkdownLineEndingsPreserved(currentView.sourceFormat, candidateFormat);
    this.#content = input.content;
    this.#revision = input.revision;
    return this.view();
  }

  async persistDraft(input: MarkdownEditorUpdateInput): Promise<MarkdownEditorView> {
    this.update(input);
    return this.#withWrite(async () => {
      if (!this.dirty) {
        await this.#discardActiveDraft();
        return this.view();
      }
      const draft = await saveMarkdownDraft({
        documentPath: this.document.path,
        draftDirectory: this.draftDirectory,
        expectedSourceSha256: this.document.sourceSha256,
        content: this.#content,
        bomByteLength: this.document.bomByteLength,
        ...(this.#activeDraft ? { previousDraft: this.#activeDraft } : {}),
      });
      this.#activeDraft = { draftPath: draft.draftPath, draftSha256: draft.draftSha256 };
      this.#removeRecoveryByPath(draft.draftPath);
      return this.view();
    });
  }

  async save(input: MarkdownEditorUpdateInput): Promise<MarkdownEditorSaveResult> {
    this.update(input);
    return this.#withWrite(async () => {
      if (this.#structurePlan && this.dirty) return this.#saveStructure();
      const result = await saveMarkdownFile({
        documentPath: this.document.path,
        draftDirectory: this.draftDirectory,
        expectedSourceSha256: this.document.sourceSha256,
        content: this.#content,
        bomByteLength: this.document.bomByteLength,
        ...(this.#activeDraft ? { previousDraft: this.#activeDraft } : {}),
      });
      if (result.status !== 'saved') {
        this.#activeDraft = { draftPath: result.draftPath, draftSha256: result.draftSha256 };
        return {
          status: result.status,
          editor: this.view(),
          message: saveFailureMessage(result),
        };
      }

      this.document = {
        ...this.document,
        content: this.#content,
        sourceSha256: result.sourceSha256,
      };
      this.#structurePlan = undefined;
      this.#structureTransaction = undefined;
      this.#activeDraft = result.draftRetained
        ? { draftPath: result.draftPath, draftSha256: result.draftSha256 }
        : undefined;
      // A successful save only consumes this session's active generation.
      // Concurrent or older branches remain on disk and must stay visible,
      // now classified against the newly persisted source baseline.
      await this.#refreshRecoveryDrafts();
      this.#latestSourceBackup = result.sourceBackup
        ? { id: randomUUID(), backup: result.sourceBackup }
        : undefined;
      const cleanupNotice = result.cleanupWarnings.length > 0
        ? ' 部分恢复文件或保存锁未能清理，请保留当前窗口并检查恢复提示。'
        : '';
      return {
        status: 'saved',
        changed: result.changed,
        document: this.document,
        editor: this.view(),
        message: result.changed
          ? `Markdown 已保存；本次保存的恢复文件已保留，可在编辑状态栏中显式清理。${cleanupNotice}`
          : `Markdown 内容没有变化，磁盘字节保持不变。${cleanupNotice}`,
      };
    });
  }

  restoreRecoveryDraft(id: string): MarkdownEditorView {
    if (this.dirty) throw new Error('请先保存或放弃当前编辑，再恢复其他草稿。');
    const record = this.#recoveryRecord(id);
    if (record.draft.relationship !== 'recoverable') {
      throw new Error('这份草稿与当前磁盘版本不在同一基线，当前只能保留或丢弃，不能直接覆盖。');
    }
    if (record.draft.format.bomByteLength !== this.document.bomByteLength) {
      throw new Error('这份恢复草稿的 BOM 状态与当前磁盘版本不同，未载入缓冲区。');
    }
    const bytes = encodeMarkdownBytes(record.draft.content, this.document.bomByteLength);
    if (bytes.byteLength > maxEditableMarkdownBytes || record.draft.format.lineEnding === 'mixed') {
      throw new Error('这份恢复草稿不满足当前编辑格式限制，未载入缓冲区。');
    }
    this.#content = record.draft.content;
    this.#revision += 1;
    this.#activeDraft = {
      draftPath: record.draft.draftPath,
      draftSha256: record.draft.draftSha256,
    };
    this.#recoveryDrafts.delete(id);
    return this.view();
  }

  async discardRecoveryDraft(id: string): Promise<MarkdownEditorView> {
    if (this.#writeInProgress) throw new Error('Markdown 恢复文件正在处理，请稍后重试。');
    const record = this.#recoveryRecord(id);
    const result = await discardMarkdownDraft({
      documentPath: this.document.path,
      draftDirectory: this.draftDirectory,
      draftPath: record.draft.draftPath,
      expectedDraftSha256: record.draft.draftSha256,
    });
    if (result.status === 'conflict') throw new Error('恢复草稿已变化，未执行丢弃。');
    this.#recoveryDrafts.delete(id);
    return this.view();
  }

  async discardChanges(): Promise<MarkdownEditorView> {
    return this.#withWrite(async () => {
      await this.#discardActiveDraft();
      this.#content = this.document.content;
      this.#structurePlan = undefined;
      this.#structureTransaction = undefined;
      this.#revision += 1;
      return this.view();
    });
  }

  async #saveStructure(): Promise<MarkdownEditorSaveResult> {
    const plan = this.#structurePlan!;
    // Keep a recoverable editor generation even if baseline validation fails.
    const draft = await saveMarkdownDraft({ documentPath: this.document.path, draftDirectory: this.draftDirectory,
      expectedSourceSha256: this.document.sourceSha256, content: this.#content, bomByteLength: this.document.bomByteLength,
      ...(this.#activeDraft ? { previousDraft: this.#activeDraft } : {}) });
    this.#activeDraft = { draftPath: draft.draftPath, draftSha256: draft.draftSha256 };
    try {
      if (this.#structureTransaction) {
        return { status: 'pending-draft', editor: this.view(), message: '此前的结构保存事务尚待核验；请先处理文档恢复事务，再重新载入。' };
      }
      await assertStructureBaseline(this.document.path, plan.before);
      const final = await finalizeSectionStructurePlan(plan, this.#content);
      const ref = await prepareDocumentTransaction({ documentPath: this.document.path, before: final.before, after: final.after });
      this.#structureTransaction = ref;
      const result = await commitDocumentTransaction(this.document.path, ref);
      if (result.status !== 'committed') return { status: result.status === 'conflict' || result.status === 'busy' ? 'conflict' : 'pending-draft',
        editor: this.view(), message: '结构保存未完成；候选与原始三文件快照已保留，请检查文档恢复事务。' };
      this.document = { ...this.document, content: this.#content, sourceSha256: bundleDigest(final.after.markdown)! };
      this.#structurePlan = undefined;
      this.#structureTransaction = undefined;
      let cleanupNotice = '';
      try { await this.#discardActiveDraft(); await this.#refreshRecoveryDrafts(); }
      catch { cleanupNotice = ' 源码恢复草稿仍保留。'; }
      return { status: 'saved', changed: true, document: this.document, editor: this.view(),
        annotationMapping: { status: final.impact.status === 'ready' ? 'saved' : 'not-needed', mappedCount: final.impact.mappedCount,
          unresolvedCount: final.impact.unresolved.length, message: final.impact.message },
        message: `结构已保存，Markdown、批注和画布已同步；原始三文件快照已保留。${final.impact.message}${cleanupNotice}` };
    } catch {
      return { status: 'conflict', editor: this.view(), message: '文档或伴随文件无法按原基线保存；未静默覆盖外部版本，源码候选已保留。' };
    }
  }

  async discardLatestSourceBackup(id: string): Promise<MarkdownEditorView> {
    this.#assertOpaqueId(id);
    const latest = this.#latestSourceBackup;
    if (!latest || latest.id !== id) throw new Error('本次保存的恢复文件已变化，请重新查看状态。');
    const result = await discardMarkdownSourceBackup({
      documentPath: this.document.path,
      backupPath: latest.backup.backupPath,
      expectedBackupSha256: latest.backup.backupSha256,
    });
    if (result.status === 'locked') throw new Error('Markdown 保存锁仍存在，暂不能清理恢复文件。');
    if (result.status === 'conflict') throw new Error('恢复文件内容已变化，未执行清理。');
    this.#latestSourceBackup = undefined;
    return this.view();
  }

  async #refreshRecoveryDrafts(): Promise<void> {
    const loaded = await loadMarkdownDraft(this.document.path, this.draftDirectory);
    const candidates = loaded.status === 'available' ? [loaded.draft, ...loaded.branches] : [];
    const previousIds = new Map(
      [...this.#recoveryDrafts.values()].map((record) => [record.draft.draftPath, record.id]),
    );
    this.#recoveryDrafts.clear();
    for (const draft of candidates) {
      if (this.#activeDraft?.draftPath === draft.draftPath) continue;
      const id = previousIds.get(draft.draftPath) ?? randomUUID();
      this.#recoveryDrafts.set(id, { id, draft });
    }
    this.#unreadableDraftCount = loaded.status === 'none' ? 0 : loaded.unreadableDrafts.length;

    const inventory = await listMarkdownDrafts(this.draftDirectory);
    const documentPath = comparablePath(this.document.path);
    this.#retainedTemporaryDraftCount = inventory.retainedTemporaryDrafts.filter((draft) =>
      comparablePath(draft.documentPath) === documentPath).length;
  }

  async #discardActiveDraft(): Promise<void> {
    if (!this.#activeDraft) return;
    const result = await discardMarkdownDraft({
      documentPath: this.document.path,
      draftDirectory: this.draftDirectory,
      draftPath: this.#activeDraft.draftPath,
      expectedDraftSha256: this.#activeDraft.draftSha256,
    });
    if (result.status === 'conflict') throw new Error('恢复草稿已变化，未丢弃当前编辑。');
    this.#activeDraft = undefined;
  }

  #removeRecoveryByPath(draftPath: string): void {
    for (const [id, record] of this.#recoveryDrafts) {
      if (record.draft.draftPath === draftPath) this.#recoveryDrafts.delete(id);
    }
  }

  #recoveryRecord(id: string): RecoveryDraftRecord {
    this.#assertOpaqueId(id);
    const record = this.#recoveryDrafts.get(id);
    if (!record) throw new Error('恢复草稿已变化，请重新进入编辑模式。');
    return record;
  }

  #assertEpoch(epoch: string): void {
    if (epoch !== this.epoch) throw new Error('文档已切换，请重新进入编辑模式。');
  }

  #assertOpaqueId(id: string): void {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
      throw new Error('恢复项标识无效。');
    }
  }

  async #withWrite<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#writeInProgress) throw new Error('Markdown 恢复文件正在写入，请稍后重试。');
    this.#writeInProgress = true;
    try {
      return await operation();
    } finally {
      this.#writeInProgress = false;
    }
  }
}
