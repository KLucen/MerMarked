export type LocalInputKind = 'new-note' | 'edit-note' | 'reader-block' | 'unapplied-input';
export type LeaveInputsChoice = 'return' | 'discard' | 'cancel';
export interface LeaveInputSnapshot {
  readonly key: string;
  readonly kinds: readonly LocalInputKind[];
  readonly busy: boolean;
}

/** Discard authorization belongs to the exact document and input snapshot shown. */
export async function authorizeInputLeave(
  getSnapshot: () => LeaveInputSnapshot,
  confirm: (kinds: readonly LocalInputKind[]) => Promise<LeaveInputsChoice>,
): Promise<'allow' | 'return' | 'cancel' | 'blocked'> {
  const before = getSnapshot();
  if (before.busy) return 'blocked';
  if (!before.kinds.length) return 'allow';
  const answer = await confirm(before.kinds);
  if (answer !== 'discard') return answer === 'return' ? 'return' : 'cancel';
  const after = getSnapshot();
  return !after.busy && after.key === before.key ? 'allow' : 'blocked';
}
