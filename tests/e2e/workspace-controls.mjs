export async function openWorkspaceStatus(cdp, expectedName) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const ready = await cdp.evaluate(`(() => {
      const name = document.querySelector('.workspace-current-name')?.textContent;
      const expected = ${JSON.stringify(expectedName ?? null)};
      const button = document.querySelector('[aria-label="文档状态"]');
      if (!button || (expected && name !== expected)) return false;
      if (button.getAttribute('aria-expanded') !== 'true') button.click();
      return true;
    })()`);
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  throw new Error('Document status control did not become available');
}

/** Reveal the shared task panel through its visible entry point. */
export async function openWorkspaceTask(cdp) {
  const opened = await cdp.evaluate(`(() => {
    const trigger = document.querySelector('[data-workspace-right-toggle]');
    const content = document.querySelector('.workspace-task-content');
    if (!trigger || !content) return false;
    if (!content.getClientRects().length) trigger.click();
    return true;
  })()`);
  if (!opened) throw new Error('Task panel entry missing');
  for (let i = 0; i < 100; i++) {
    if (await cdp.evaluate(`Boolean(document.querySelector('.workspace-task-content')?.getClientRects().length)`)) return;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  throw new Error('Task panel did not become visible');
}
