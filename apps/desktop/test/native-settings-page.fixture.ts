import type { ElectronApplication, Page } from 'playwright';

function settingsPage(application: ElectronApplication): Page | undefined {
  return application.windows().find((page) => {
    try {
      return new URL(page.url()).pathname.endsWith('/settings.html');
    } catch {
      return false;
    }
  });
}

export async function openNativeSettingsPage(
  application: ElectronApplication,
  root: Page,
): Promise<Page> {
  const warm = settingsPage(application);
  if (warm && (await warm.getByRole('dialog', { name: '设置', exact: true }).isVisible()))
    return warm;
  await root.getByRole('button', { name: '打开设置', exact: true }).click();
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const page = settingsPage(application);
    if (page) {
      await page.getByRole('dialog', { name: '设置', exact: true }).waitFor();
      page.setDefaultTimeout(15000);
      return page;
    }
    await root.waitForTimeout(25);
  }
  throw Error('native_settings_fixture_window_unavailable');
}

export async function closeNativeSettingsPage(application: ElectronApplication) {
  const page = settingsPage(application);
  if (!page) return;
  const dialog = page.getByRole('dialog', { name: '设置', exact: true });
  if (!(await dialog.isVisible())) return;
  await dialog.getByRole('button', { name: '关闭设置', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
}
