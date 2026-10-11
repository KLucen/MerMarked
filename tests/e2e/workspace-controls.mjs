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
