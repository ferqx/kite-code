import { runKiteServiceMain } from '../../../apps/kite-service/src/executable';

await runKiteServiceMain().catch((error: unknown) => {
  process.stderr.write(
    `[kite-service] ${error instanceof Error ? error.message : 'service failed'}\n`,
  );
  process.exitCode = 1;
});
