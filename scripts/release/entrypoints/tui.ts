import { runTui } from '@kite-ai/kite-cli/tui';
import packageJson from '../../../package.json' with { type: 'json' };
import { createManagedLocalSingleServiceComposition } from '../single-service-native-client';

if (process.argv.includes('--version')) {
  console.log(`Kite Code TUI ${packageJson.version}`);
} else {
  const executableMode = process.env.KITE_STANDALONE_EXECUTABLE === '1' ? 'installed' : 'source';
  const serviceTopology =
    executableMode === 'source' && !usesExplicitSharedServer(process.argv)
      ? 'standalone'
      : 'shared';
  const localService = createManagedLocalSingleServiceComposition({
    argv: process.argv,
    executableMode,
    serviceTopology,
  });
  runTui({
    connectService: localService.connector,
    discoverWeb: localService.discoverWeb,
    expectedServiceBuildId: localService.expectedBuildId,
    clientVersion: packageJson.version,
    ...(serviceTopology === 'standalone' ? { disposeRuntime: localService.dispose } : {}),
  });
}

function usesExplicitSharedServer(argv: readonly string[]): boolean {
  const positions = argv.flatMap((value, index) => (value === '--server' ? [index] : []));
  if (positions.length === 0) return false;
  if (positions.length !== 1 || argv[(positions[0] ?? -1) + 1] !== 'shared') {
    throw new Error('TUI --server currently accepts exactly one target: shared.');
  }
  return true;
}
