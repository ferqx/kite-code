import { writeFileSync } from 'node:fs';
import { createFixedModel } from '@kite-ai/ai';
import type { ConfigureProcessHost } from '@kite-ai/service/bootstrap';
import { runDaemonProcess } from '@kite-ai/service/daemon-main';
import { runServiceProcess } from '@kite-ai/service/main';

const configure: ConfigureProcessHost = (startup) => {
  const host = startup.hostConfiguration as { retained: string; models: string };
  const fixed = createFixedModel([]);
  return {
    modelId: 'fixed',
    model: {
      async *stream(...args: Parameters<typeof fixed.stream>) {
        writeFileSync(host.models, 'unexpected_model_dispatch');
        yield* fixed.stream(...args);
      },
    },
    configurationManagement(runtime) {
      if (!runtime) throw Error('fixture_expected_real_store');
      const begin = runtime.tryBeginShutdown.bind(runtime);
      runtime.tryBeginShutdown = (mode, options) =>
        begin(mode, {
          ...options,
          async beforeResourceClose() {
            const metadata = await runtime.getMetadata();
            writeFileSync(host.retained, JSON.stringify({ storeId: metadata.storeId }));
            throw Error('fixture_private_cleanup_failed');
          },
        });
      throw Error('fixture_private_http_assembly_failed');
    },
  };
};

try {
  if (process.argv[2] === 'paired') await runServiceProcess({ configure });
  else if (process.argv[2] === 'daemon') await runDaemonProcess({ configure });
  else throw Error('fixture_invalid_runner');
} catch (error) {
  // Only the finite daemon refusal is exposed; a retained failure never reaches this catch.
  process.stderr.write(
    `${JSON.stringify({ code: (error as { code?: string }).code ?? 'fixture_runner_failed' })}\n`,
  );
  process.exitCode = 1;
}
