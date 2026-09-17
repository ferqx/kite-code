import {
  describeServiceStartupProgress,
  formatServiceStartupReport,
} from '@kite-ai/kite-local-runtime/startup-diagnostic';
import { RuntimeClientStartupError } from '@kite-ai/runtime-client';
import { parseArgs, main as runCliMain } from '../../../apps/kite-cli/src/cli/index';
import packageJson from '../../../package.json' with { type: 'json' };
import { createManagedLocalAppServerComposition } from '../app-server-client';
import { createManagedLocalAppServerDaemon } from '../app-server-daemon';

const onStartupProgress = (progress: Parameters<typeof describeServiceStartupProgress>[0]) => {
  console.error(describeServiceStartupProgress(progress));
};

if (process.argv.includes('--version')) {
  console.log(`Kite Code ${packageJson.version}`);
} else {
  const parsed = process.argv.includes('--help') ? undefined : parseArgs(process.argv.slice(2));
  const command = parsed?.command ?? 'help';
  const executableMode = process.env.KITE_STANDALONE_EXECUTABLE === '1' ? 'installed' : 'source';
  const run =
    command === 'help'
      ? runCliMain({})
      : command === 'server-restart' ||
          command === 'server-start' ||
          command === 'server-status' ||
          command === 'server-stop'
        ? (() => {
            const daemon = createManagedLocalAppServerDaemon({
              argv: process.argv,
              executableMode,
              onStartupProgress,
              ...(parsed?.serverEndpoint ? { endpoint: parsed.serverEndpoint } : {}),
            });
            return runCliMain({ appServerDaemon: daemon });
          })()
        : command.startsWith('web-')
          ? (() => {
              const daemon = createManagedLocalAppServerDaemon({
                argv: process.argv,
                executableMode,
                onStartupProgress,
                ...(parsed?.serverEndpoint ? { endpoint: parsed.serverEndpoint } : {}),
              });
              return runCliMain({ appServerWeb: { discover: daemon.discoverWeb } });
            })()
          : (() => {
              const connector = parsed?.serverEndpoint
                ? createManagedLocalAppServerDaemon({
                    argv: process.argv,
                    executableMode,
                    onStartupProgress,
                    endpoint: parsed.serverEndpoint,
                  }).connector
                : createManagedLocalAppServerComposition({
                    argv: process.argv,
                    executableMode,
                    onStartupProgress,
                  }).connector;
              return runCliMain({
                runtimeConnector: connector,
              });
            })();
  run.catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    if (error instanceof RuntimeClientStartupError) {
      console.error('可将以下脱敏诊断保存，用于排查：');
      console.error(
        formatServiceStartupReport({
          code: error.diagnosticCode,
          actualSchema: error.actualSchema,
          expectedSchema: error.expectedSchema,
          ...(error.stage ? { stage: error.stage } : {}),
        }),
      );
    }
    process.exitCode = 1;
  });
}
