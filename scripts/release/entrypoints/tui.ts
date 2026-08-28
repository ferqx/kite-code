import { runTui } from '@kite-ai/kite-cli/tui';
import packageJson from '../../../package.json' with { type: 'json' };
import { createManagedLocalCoordinatorClientComposition } from '../local-coordinator-client';
import { createManagedLocalWorkspaceWorkerConnector } from '../local-workspace-worker-client';

if (process.argv.includes('--version')) {
  console.log(`Kite Code TUI ${packageJson.version}`);
} else {
  const localCoordinator = createManagedLocalCoordinatorClientComposition({
    argv: process.argv,
    executableMode: process.env.KITE_STANDALONE_EXECUTABLE === '1' ? 'installed' : 'source',
  });
  const workerConnector = createManagedLocalWorkspaceWorkerConnector({
    coordinatorClient: localCoordinator.client,
  });
  runTui({
    connectService: workerConnector,
    discoverWebGateway: localCoordinator.discoverWebGateway,
  });
}
