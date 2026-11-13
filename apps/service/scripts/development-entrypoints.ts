import { renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const out = resolve(process.argv[2] ?? 'dist');
// Release entrypoints are created by the release builder, which also acquires
// the verified candidate lease and never needs a checkout module resolver.
if (out === resolve(import.meta.dirname, '../dist')) {
  const loader = pathToFileURL(
    resolve(import.meta.dirname, '../../../scripts/development/node-loader.mjs'),
  ).href;
  for (const [entry, run] of [
    ['main', 'runServiceProcess'],
    ['daemon-main', 'runDaemonProcess'],
  ]) {
    const implementation = `${entry}-implementation.js`;
    renameSync(resolve(out, `${entry}.js`), resolve(out, implementation));
    writeFileSync(
      resolve(out, `${entry}.js`),
      `import ${JSON.stringify(loader)};
import { Console } from 'node:console';
const { ${run} } = await import('./${implementation}');
export { ${run} };
if (import.meta.main) {
  globalThis.console = new Console(process.stderr, process.stderr);
  await ${run}();
}
`,
    );
  }
}
