export type DocumentDepartureChoice = 'save' | 'discard' | 'cancel';
export interface DocumentDepartureSnapshot {
  readonly documentKey: number;
  readonly epoch: string | null;
  readonly revision: number;
  readonly content: string;
  readonly dirty: boolean;
}

/** Source authorization is for one exact buffer, not a later edit or document. */
export async function authorizeDocumentDeparture(
  snapshot: () => DocumentDepartureSnapshot,
  confirm: () => Promise<DocumentDepartureChoice>,
  apply: (choice: 'save' | 'discard') => Promise<boolean>,
): Promise<'allow' | 'cancel' | 'failed' | 'stale'> {
  const before = snapshot();
  if (!before.dirty) return 'allow';
  const choice = await confirm();
  if (choice === 'cancel') return 'cancel';
  const current = snapshot();
  if (current.documentKey !== before.documentKey || current.epoch !== before.epoch ||
    current.revision !== before.revision || current.content !== before.content || current.dirty !== before.dirty) return 'stale';
  if (!await apply(choice)) return 'failed';
  const after = snapshot();
  if (after.documentKey !== before.documentKey || after.dirty || (choice === 'save' && after.content !== before.content)) return 'stale';
  return 'allow';
}
