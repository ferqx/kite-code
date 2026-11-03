import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Source hosts select the built package worker, never the TypeScript interpreter source. */
export function browserExecutorWorkerAsset(): string {
  const path = fileURLToPath(
    new URL(
      import.meta.url.endsWith('.ts')
        ? '../../../../dist/tools/browser/executor/worker.js'
        : import.meta.url.endsWith('/tools/browser/executor/index.js')
          ? './worker.js'
          : './tools/browser/executor/worker.js',
      import.meta.url,
    ),
  );
  if (!existsSync(path)) throw Error('browser_executor_asset_unavailable');
  return path;
}
