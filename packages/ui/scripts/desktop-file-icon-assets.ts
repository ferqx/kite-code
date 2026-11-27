import { copyFile, cp, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileTreeIconDirectory } from '../src/desktop/lib/file-tree-icons';

const require = createRequire(import.meta.url);

export async function copyDesktopFileIconAssets(output: string) {
  const source = dirname(require.resolve('material-icon-theme/package.json'));
  const destination = join(output, fileTreeIconDirectory);
  const icons = join(source, 'icons');
  await mkdir(destination, { recursive: true });
  await Promise.all([
    cp(icons, destination, {
      recursive: true,
      filter: (path) => path === icons || path.endsWith('.svg'),
    }),
    copyFile(join(source, 'LICENSE'), join(destination, 'LICENSE')),
  ]);
}
