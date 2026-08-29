import { parseArgs, main as runCliMain } from '../../../apps/kite-cli/src/cli/index';
import packageJson from '../../../package.json' with { type: 'json' };
import { createManagedLocalCoordinatorClientComposition } from '../local-coordinator-client';
import { createManagedLocalServiceClientComposition } from '../local-service-client';
import { createManagedLocalWorkspaceWorkerConnector } from '../local-workspace-worker-client';

if (process.argv.includes('--version')) {
  console.log(`Kite Code ${packageJson.version}`);
} else {
  const command = process.argv.includes('--help')
    ? 'help'
    : parseArgs(process.argv.slice(2)).command;
  const executableMode = process.env.KITE_STANDALONE_EXECUTABLE === '1' ? 'installed' : 'source';
  const run =
    command === 'help'
      ? runCliMain({})
      : command.startsWith('service-')
        ? (() => {
            // Explicit legacy Service lifecycle commands remain maintenance operations. Normal
            // run/resume traffic below uses the Coordinator-owned Workspace Worker path.
            const localService = createManagedLocalServiceClientComposition({
              argv: process.argv,
              executableMode,
            });
            return runCliMain({ serviceManager: localService.lifecycle });
          })()
        : command === 'maintenance-migrate-run-store'
          ? (() => {
              const localCoordinator = createManagedLocalCoordinatorClientComposition({
                argv: process.argv,
                executableMode,
              });
              return runCliMain({
                runStoreMaintenance: localCoordinator.maintenance,
              });
            })()
          : command.startsWith('web-')
            ? (() => {
                const localCoordinator = createManagedLocalCoordinatorClientComposition({
                  argv: process.argv,
                  executableMode,
                });
                return runCliMain({
                  coordinatorClient: localCoordinator.client,
                });
              })()
            : (() => {
                const localCoordinator = createManagedLocalCoordinatorClientComposition({
                  argv: process.argv,
                  executableMode,
                });
                const workerConnector = createManagedLocalWorkspaceWorkerConnector({
                  coordinatorClient: localCoordinator.client,
                });
                return runCliMain({
                  serviceConnector: workerConnector,
                  coordinatorClient: localCoordinator.client,
                });
              })();
  run.catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
