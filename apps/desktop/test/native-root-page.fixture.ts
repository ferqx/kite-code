import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ElectronApplication, Page } from 'playwright';

/** Select the actual application renderer among Root and auxiliary native Views. */
export async function nativeRootPage(
  application: ElectronApplication,
  timeout: number,
): Promise<Page> {
  const directory = await application.evaluate(({ app }) => app.getAppPath());
  const rendererURL = pathToFileURL(join(directory, 'index.html')).href;
  const deadline = Date.now() + timeout;
  for (;;) {
    const page = application.windows().find((candidate) => candidate.url() === rendererURL);
    if (page) return page;
    if (Date.now() >= deadline) throw Error('native_root_renderer_unavailable');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
