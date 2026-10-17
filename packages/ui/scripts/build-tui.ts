import { mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

const [argument] = process.argv.slice(2);
if (!argument?.startsWith('--outdir=') || process.argv.slice(2).length !== 1)
  throw Error('usage_build_tui_outdir');
const outdir = resolve(argument.slice('--outdir='.length));
const require = createRequire(import.meta.url);
const inkDirectory = dirname(require.resolve('ink'));
const manifest = JSON.parse(readFileSync(join(inkDirectory, '../package.json'), 'utf8'));
if (manifest.name !== 'ink' || manifest.version !== '7.1.1')
  throw Error('tui_ink_build_version_unreviewed');
const reconciler = realpathSync(join(inkDirectory, 'reconciler.js'));
mkdirSync(outdir, { recursive: true });
const result = await Bun.build({
  entrypoints: [
    resolve(import.meta.dir, '../src/tui/index.tsx'),
    resolve(import.meta.dir, '../src/tui/ink.ts'),
  ],
  root: resolve(import.meta.dir, '../src/tui'),
  outdir,
  target: 'bun',
  splitting: true,
  packages: 'bundle',
  external: ['react', 'react-dom', '@kite-ai/client'],
  plugins: [
    {
      name: 'closed-ink-devtools',
      setup(build) {
        // Upstream imports its own process binding, so a global process.env define
        // does not close this branch. Bind only the reviewed original module.
        build.onLoad({ filter: /reconciler\.js$/ }, ({ path }) => {
          if (realpathSync(path) !== reconciler) return undefined;
          const source = readFileSync(path, 'utf8');
          const pattern = /process\.env\[['"]DEV['"]\]/gu;
          if ([...source.matchAll(pattern)].length !== 2)
            throw Error('tui_ink_devtools_contract_changed');
          return { loader: 'js', contents: source.replace(pattern, JSON.stringify('false')) };
        });
        build.onResolve({ filter: /devtools\.js$/ }, ({ path, importer }) => {
          if (realpathSync(importer) !== reconciler || path !== './devtools.js') return undefined;
          return { path: 'closed', namespace: 'kite-closed-ink-devtools' };
        });
        build.onLoad({ filter: /.*/, namespace: 'kite-closed-ink-devtools' }, () => ({
          loader: 'js',
          contents: 'throw new Error("ink_devtools_unavailable"); export {};',
        }));
      },
    },
  ],
});
if (!result.success) throw new AggregateError(result.logs, 'tui_build_failed');
