export interface PartStatus {
  readonly text: string;
  readonly tone: 'neutral' | 'busy' | 'warning' | 'error';
}

export interface WorkspaceStatuses {
  readonly source: PartStatus;
  readonly annotations: PartStatus;
  readonly canvas: PartStatus;
}

/** Preserve actionable failures even when another part is saved or busy. */
export function summarizeWorkspaceStatus(statuses: WorkspaceStatuses): PartStatus {
  const parts = [
    ['正文', statuses.source], ['批注', statuses.annotations], ['画布', statuses.canvas],
  ] as const;
  for (const tone of ['error', 'warning', 'busy'] as const) {
    const match = parts.find(([, status]) => status.tone === tone);
    if (match) return { text: `${match[0]} · ${match[1].text}`, tone };
  }
  return statuses.source;
}
