import { appendFileSync, renameSync, writeFileSync } from 'node:fs';
import { createTaskExtension } from '@kite-ai/agent/task';
import { createCompatibleModelBinding, createSdkModelAdapter } from '@kite-ai/ai/sdk';
import { runServiceProcess } from '../../src/main';
import type { LoadTelemetry } from './multi-session-stream-load.types';

let modelSlots = 4;
let timer: ReturnType<typeof setInterval> | undefined;
let lifecyclePath: string | undefined;
const lifecycle = (phase: string, error?: Error) => {
  if (!lifecyclePath) return;
  appendFileSync(
    lifecyclePath,
    `${JSON.stringify({
      phase,
      pid: process.pid,
      elapsedMs: performance.now(),
      error: error ? { name: error.name, message: error.message, stack: error.stack } : undefined,
    })}\n`,
  );
};
// This monitor observes the original fatal exception without handling or suppressing it.
process.on('uncaughtExceptionMonitor', (error) => lifecycle('uncaughtExceptionMonitor', error));
process.on('exit', (code) => lifecycle(`exit:${code}`));
await runServiceProcess({
  configure(startup) {
    const input = startup.hostConfiguration as {
      baseURL: string;
      slots: number;
      metricsPath: string;
    };
    lifecyclePath = `${input.metricsPath}.lifecycle`;
    lifecycle('configure');
    modelSlots = input.slots;
    const model = createSdkModelAdapter({
      models: new Map(
        ['load-parent', 'load-child'].map((id) => [
          id,
          createCompatibleModelBinding({ baseURL: input.baseURL, modelId: id }),
        ]),
      ),
    });
    const started = performance.now();
    let previous = started,
      lagMaxMs = 0,
      samples = 0;
    const sample = () => {
      const now = performance.now();
      lagMaxMs = Math.max(lagMaxMs, now - previous - 100);
      previous = now;
      samples++;
      const memory = process.memoryUsage();
      const telemetry: LoadTelemetry = {
        pid: process.pid,
        rss: memory.rss,
        heapUsed: memory.heapUsed,
        external: memory.external,
        arrayBuffers: memory.arrayBuffers,
        cpu: process.cpuUsage(),
        elapsedMs: now - started,
        lagMaxMs,
        samples,
      };
      writeFileSync(`${input.metricsPath}.pending`, JSON.stringify(telemetry));
      renameSync(`${input.metricsPath}.pending`, input.metricsPath);
    };
    timer = setInterval(sample, 100);
    sample();
    return {
      model,
      modelId: 'load-parent',
      maxConcurrentSubagents: 3,
      permissions: {
        async authorize() {
          return { allowed: true, revision: 'isolated-loopback-load' };
        },
      },
      extensions: [
        (() => {
          const extension = createTaskExtension({
            roles: [
              {
                id: 'worker',
                configurationId: 'load-worker',
                description: 'Isolated loopback load worker',
              },
            ],
          });
          return {
            ...extension,
            tools: extension.tools!.map((tool) =>
              tool.id !== 'task.spawn'
                ? tool
                : {
                    ...tool,
                    async execute(input, context) {
                      // Trusted isolated policy retains the original detached-cancellation load case.
                      // The actual Provider sees only the six-tool prompt schema, never this switch.
                      const detached =
                        typeof input === 'object' &&
                        input !== null &&
                        !Array.isArray(input) &&
                        typeof input.prompt === 'string' &&
                        input.prompt.startsWith('load-root-1 ');
                      return tool.execute(input, {
                        ...context,
                        operations: {
                          ...context.operations,
                          ensure(options) {
                            return context.operations.ensure({
                              ...options,
                              cancellation: detached ? 'detached' : 'attached',
                            });
                          },
                        },
                      });
                    },
                  },
            ),
          };
        })(),
      ],
      childConfigurations: [
        {
          id: 'load-worker',
          version: '1',
          model,
          modelId: 'load-child',
          toolIds: [],
          snapshot: { fixture: true },
        },
      ],
    };
  },
  // Test-only trusted host selection, still using the real Runtime semaphore.
  decorateConfiguration(configuration) {
    return modelSlots === 4 ? configuration : { ...configuration, modelConcurrency: modelSlots };
  },
  async beforeResourceClose() {
    lifecycle('beforeResourceClose');
    clearInterval(timer);
  },
});
