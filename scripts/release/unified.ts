import { join, resolve } from 'node:path';
import {
  assertReleaseSource,
  parseReleaseArguments,
  releaseErrorCode,
  requiredReleaseValue,
  validateReleaseSourceArguments,
} from './release-arguments';

const repositoryRoot = resolve(import.meta.dir, '../..');
const options = {
  build: ['product', 'directory', 'archive', 'terminal', 'electron', 'sqlite-library'],
  pack: ['product', 'directory', 'archive'],
  unpack: ['product', 'directory', 'archive', 'sha256'],
  verify: ['product', 'directory', 'source-commit', 'clean-source'],
  smoke: ['product', 'directory'],
  install: ['product', 'archive', 'sha256', 'prefix', 'cli-prefix'],
  rollback: ['product', 'prefix'],
  uninstall: ['product', 'prefix'],
  'register-cli': ['product', 'prefix', 'cli-prefix'],
  'unregister-cli': ['product', 'prefix'],
} as const;
const help = `Unified Agent release tooling
  build [--product terminal|native] [--directory <new-directory>] [--archive <new-tar.gz>]
  verify|smoke [--product terminal|native] [--directory <candidate>]
  pack [--product terminal|native] [--directory <candidate>] --archive <new-tar.gz>
  unpack [--product terminal|native] --archive <tar.gz> --sha256 <SHA256> --directory <new-directory>
  install [--product terminal|native] --archive <tar.gz> --sha256 <SHA256> --prefix <managed-directory> [--cli-prefix <independent-terminal>]
  rollback|uninstall [--product terminal|native] --prefix <managed-directory>
Default product: terminal. Build destinations: dist/unified-terminal and dist/unified-native.
Native build additionally accepts --terminal <verified-terminal> and --electron <installed-dist>.
Terminal build accepts --sqlite-library <reviewed macOS library>; the selected library is copied into the bundle.
Verify additionally accepts --source-commit <40-hex-commit> and --clean-source true.
Native register-cli --prefix <desktop> --cli-prefix <terminal>; unregister-cli --prefix <desktop>.
Checksums establish integrity, not publisher authenticity. Profiles and legacy data are preserved.
`;

export async function runUnifiedRelease(
  argv: readonly string[],
  root = repositoryRoot,
): Promise<unknown> {
  const { command, values } = parseReleaseArguments(argv, options);
  if (command === 'help') return { help };
  validateReleaseSourceArguments(values);
  const product = values.product ?? 'terminal';
  if (
    !['terminal', 'native'].includes(product) ||
    (product === 'terminal' && (values.terminal || values.electron || values['cli-prefix'])) ||
    (product === 'native' && values['sqlite-library']) ||
    (product !== 'native' && ['register-cli', 'unregister-cli'].includes(command))
  )
    throw Error('release_arguments_invalid');
  const required: Readonly<Record<string, readonly string[]>> = {
    pack: ['archive'],
    unpack: ['archive', 'sha256', 'directory'],
    install: ['archive', 'sha256', 'prefix'],
    rollback: ['prefix'],
    uninstall: ['prefix'],
    'register-cli': ['prefix', 'cli-prefix'],
    'unregister-cli': ['prefix'],
  };
  for (const key of required[command] ?? []) requiredReleaseValue(values, key);
  if (values.sha256 && !/^[a-f0-9]{64}$/.test(values.sha256))
    throw Error('release_arguments_invalid');
  const directory = resolve(values.directory ?? join(root, `dist/unified-${product}`));
  const value = (key: string) => requiredReleaseValue(values, key);
  if (product === 'native') {
    const { runNativeRelease } = await import('./native');
    const forwarded = [command];
    for (const [key, selected] of Object.entries(values))
      if (key !== 'product' && !(command === 'build' && key === 'archive'))
        forwarded.push(`--${key}`, selected);
    const result = await runNativeRelease(forwarded, root);
    if (command === 'build' && values.archive) {
      const { packNativeBundle } = await import('./native-archive');
      return {
        build: result,
        archive: await packNativeBundle({ bundleRoot: directory, archivePath: values.archive }),
      };
    }
    return result;
  }
  if (command === 'build') {
    const { buildTerminalBundle } = await import('./terminal-bundle');
    const bundle = await buildTerminalBundle({
      destination: directory,
      repositoryRoot: root,
      ...(values['sqlite-library'] ? { sqliteLibrary: values['sqlite-library'] } : {}),
    });
    if (values.archive) {
      const { packTerminalBundle } = await import('./terminal-archive');
      return {
        root: bundle.root,
        candidateId: bundle.candidateId,
        archive: await packTerminalBundle({ bundleRoot: bundle.root, archivePath: values.archive }),
      };
    }
    return { root: bundle.root, candidateId: bundle.candidateId, buildId: bundle.buildId };
  }
  if (command === 'smoke') return (await import('./release-smoke')).smokeTerminalBundle(directory);
  if (command === 'verify') {
    const { verifyTerminalBundle } = await import('./terminal-bundle');
    const bundle = verifyTerminalBundle(directory);
    assertReleaseSource(bundle.manifest.source, values);
    return { root: bundle.root, candidateId: bundle.candidateId, manifest: bundle.manifest };
  }
  const forwarded = [command];
  if (['pack', 'verify'].includes(command)) forwarded.push('--directory', directory);
  for (const key of ['archive', 'sha256', 'prefix'])
    if (values[key]) forwarded.push(`--${key}`, value(key));
  if (command === 'unpack') forwarded.push('--directory', value('directory'));
  return (await import('./terminal')).runTerminalRelease(forwarded);
}
if (import.meta.main) {
  try {
    const result = await runUnifiedRelease(process.argv.slice(2));
    if (result && typeof result === 'object' && 'help' in result) console.log(result.help);
    else console.log(JSON.stringify(result));
  } catch (error) {
    process.stderr.write(`${releaseErrorCode(error)}\n`);
    process.exitCode = 1;
  }
}
