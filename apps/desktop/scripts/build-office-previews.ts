import { copyFile, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

// The fixed UMD carries our namespace-aware SAX adapter (see patchedDependencies).
export const xlsxPreviewRuntime = 'exceljs/dist/exceljs.js';

export async function buildOfficePreviews(outdir: string) {
  const result = await Bun.build({
    entrypoints: ['docx-preview.ts', 'xlsx-preview.tsx', 'pptx-preview.ts'].map((entry) =>
      resolve(import.meta.dir, '../electron', entry),
    ),
    target: 'browser',
    format: 'iife',
    minify: true,
    outdir,
    naming: '[name].js',
    define: {
      'process.env.NODE_ENV': '"production"',
      'process.platform': JSON.stringify(process.platform),
      // The PPT library probes native module resolution for its optional PDF fallback.
      'import.meta.resolve': 'undefined',
    },
    plugins: [
      {
        name: 'office-browser-zip',
        setup(build) {
          build.onResolve({ filter: /^jszip$/ }, () => ({
            path: 'jszip',
            namespace: 'office-browser',
          }));
          build.onLoad({ filter: /.*/, namespace: 'office-browser' }, () => ({
            contents: 'export default globalThis.JSZip;',
          }));
        },
      },
    ],
  });
  if (!result.success) throw new AggregateError(result.logs, 'office_preview_build_failed');
  // Evaluate the published browser UMD wrappers unchanged in the isolated world.
  // Bundling their CommonJS fallback can introduce an unresolved require().
  const require = createRequire(import.meta.url);
  const excel = require.resolve(xlsxPreviewRuntime);
  const zip = require.resolve('jszip/dist/jszip.min.js');
  const docx = dirname(dirname(require.resolve('docx-preview')));
  const pptx = dirname(dirname(require.resolve('@aiden0z/pptx-renderer/browser')));
  await Promise.all(
    [
      ['docx', zip],
      ['xlsx', excel],
      ['pptx', zip],
    ].map(async ([format, runtime]) => {
      const entry = join(outdir, `${format}-preview.js`);
      const [library, view] = await Promise.all([
        readFile(runtime!, 'utf8'),
        readFile(entry, 'utf8'),
      ]);
      await writeFile(entry, `${library}\n;\n${view}`);
    }),
  );
  const notices = join(outdir, 'office-preview-licenses');
  await mkdir(join(notices, 'pptx/scripts/ooxml-geometry'), { recursive: true });
  await Promise.all([
    copyFile(join(docx, 'LICENSE'), join(notices, 'docx-preview.txt')),
    copyFile(join(pptx, 'LICENSE'), join(notices, 'pptx/LICENSE')),
    copyFile(join(pptx, 'THIRD_PARTY_NOTICES.md'), join(notices, 'pptx/THIRD_PARTY_NOTICES.md')),
    copyFile(
      join(pptx, 'scripts/ooxml-geometry/source-manifest.json'),
      join(notices, 'pptx/scripts/ooxml-geometry/source-manifest.json'),
    ),
    cp(join(pptx, 'licenses'), join(notices, 'pptx/licenses'), { recursive: true }),
  ]);
}
