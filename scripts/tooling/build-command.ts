import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { build } from './bun-build';

export function workspaceBuildOptions(
  args: readonly string[],
  mode: 'workspace' | 'desktop' = 'workspace',
  cwd = process.cwd(),
) {
  const desktop = mode === 'desktop';
  const { positionals, values } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: {
      target: { type: 'string', default: desktop ? undefined : 'browser' },
      packages: { type: 'string', default: desktop ? undefined : 'bundle' },
      external: { type: 'string', multiple: true, default: [] },
      root: { type: 'string' },
      outdir: { type: 'string' },
      outfile: { type: 'string' },
      splitting: { type: 'boolean' },
    },
  });
  const { target, packages, external, root, outdir, outfile, splitting } = values;
  if (
    (target !== 'node' && target !== 'browser') ||
    (packages !== 'bundle' && packages !== 'external') ||
    (desktop && outfile !== undefined) ||
    Boolean(outdir) === Boolean(outfile) ||
    !positionals.length
  )
    throw Error(
      desktop ? 'desktop_runtime_build_options_invalid' : 'workspace_build_arguments_invalid',
    );
  return {
    entrypoints: positionals.map((path) => resolve(cwd, path)),
    target,
    packages,
    external,
    root: root && resolve(cwd, root),
    outdir: outdir && resolve(cwd, outdir),
    outfile: outfile && resolve(cwd, outfile),
    splitting,
  } as const;
}

async function buildFromArguments(args: readonly string[]): Promise<void> {
  const options = workspaceBuildOptions(args);
  const result = await build(
    options,
    options.target === 'browser' && options.outdir ? 'files' : undefined,
  );
  if (!result.success) {
    for (const diagnostic of result.logs)
      console.error(`${diagnostic.location?.file ?? 'build'}: ${diagnostic.text}`);
    throw Error('workspace_build_failed');
  }
}

if (import.meta.main) await buildFromArguments(process.argv.slice(2));
