import { realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireArtifactAccess } from '@kite-ai/agent/artifact-access';
import { verifyNativeRuntimeBundle } from '@kite-ai/service/native-runtime-assets';
import { registerNativeCLI, unregisterNativeCLI } from '../cli-registration';
import {
  installNativeBundle,
  rollbackNativeBundle,
  uninstallNativeBundle,
  verifyNativeInstallation,
} from '../native-install';
import {
  parseReleaseArguments,
  releaseErrorCode,
  requiredReleaseValue,
} from '../release-arguments';

const commands = {
  verify: ['prefix'],
  install: ['prefix', 'cli-prefix'],
  rollback: ['prefix'],
  uninstall: ['prefix'],
  'register-cli': ['prefix', 'cli-prefix'],
  'unregister-cli': ['prefix'],
} as const;

function run(argv: readonly string[]) {
  const { command, values } = parseReleaseArguments(argv, commands);
  if (command === 'help') {
    return {
      help: 'kite-install.command verify | install --prefix <directory> [--cli-prefix <terminal>] | rollback --prefix <directory> | uninstall --prefix <directory>',
    };
  }
  const bundleRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../..'));
  const leases: ReturnType<typeof acquireArtifactAccess>[] = [];
  let candidateId: string;
  try {
    for (const root of [bundleRoot, join(bundleRoot, 'terminal')])
      leases.push(acquireArtifactAccess({ root, mode: 'shared' }));
    const bundle = verifyNativeRuntimeBundle(bundleRoot);
    if (
      bundle.terminal.manifest.nodeVersion !== process.versions.node ||
      realpathSync(process.execPath) !==
        join(bundle.terminal.root, bundle.terminal.manifest.entries.runtime)
    )
      throw Error('native_maintenance_runtime_mismatch');
    candidateId = bundle.digest;
  } finally {
    for (const lease of leases.reverse()) lease.release();
  }
  if (command === 'verify') {
    return values.prefix
      ? verifyNativeInstallation(values.prefix)
      : { candidateId, nodeVersion: process.versions.node };
  }
  const prefix = requiredReleaseValue(values, 'prefix');
  switch (command) {
    case 'install':
      return installNativeBundle({ bundleRoot, prefix, cliPrefix: values['cli-prefix'] });
    case 'rollback':
      return rollbackNativeBundle(prefix);
    case 'uninstall':
      uninstallNativeBundle(prefix);
      return { removed: resolve(prefix) };
    case 'register-cli':
      return registerNativeCLI({
        nativePrefix: prefix,
        terminalPrefix: requiredReleaseValue(values, 'cli-prefix'),
      });
    case 'unregister-cli':
      return { removed: unregisterNativeCLI(prefix) };
    default:
      throw Error('release_arguments_invalid');
  }
}

try {
  const result = run(process.argv.slice(2));
  console.log('help' in result ? result.help : JSON.stringify(result));
} catch (error) {
  process.stderr.write(`${releaseErrorCode(error)}\n`);
  process.exitCode = 1;
}
