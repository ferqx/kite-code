import { appendFileSync, renameSync, writeFileSync } from 'node:fs';
import { selectProfile } from '@kite-ai/agent/profile';
import { createDefaultProcessConfiguration } from '../../src/configuration';
import { runServiceProcess } from '../../src/main';
import { createPermissionManagement } from '../../src/permission-management';
import { mixedShellConfiguration } from './multi-session-shell-load.shared';
import type { LoadTelemetry } from './multi-session-stream-load.types';

let slots = 4;
let modelStartsPath = '';
let timer: ReturnType<typeof setInterval> | undefined;
await runServiceProcess({
  configure(startup, host) {
    const input = startup.hostConfiguration as {
      slots: number;
      supervisorPath: string;
      metricsPath: string;
    };
    slots = input.slots;
    modelStartsPath = `${input.metricsPath}.model-starts.jsonl`;
    const profile = selectProfile({
      dataRoot: startup.profile.dataRoot,
      profile: startup.profile.profile,
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
      const value: LoadTelemetry = {
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
      writeFileSync(`${input.metricsPath}.pending`, JSON.stringify(value));
      renameSync(`${input.metricsPath}.pending`, input.metricsPath);
    };
    timer = setInterval(sample, 100);
    sample();
    const tools = ['task.spawn', 'shell.launch', 'shell.read', 'shell.wait', 'shell.stop'];
    const configuration = createDefaultProcessConfiguration({
      profile,
      observerSubjectId: host.subjectId,
      userConfigurationPath: `${profile.profilePath}/config.jsonc`,
      shell: mixedShellConfiguration(profile, input.supervisorPath),
      child: [
        {
          id: 'worker',
          version: '1',
          modelId: 'mixed-child',
          toolIds: ['shell.launch', 'shell.read', 'shell.wait', 'shell.stop'],
        },
      ],
      permissionPolicy: {
        readPolicy: () => ({
          mode: 'full',
          workspaceTrust: true,
          revision: 'isolated-mixed-shell-authorized',
          allowed: [
            ...['mixed-parent', 'mixed-child'].map((definitionId) => ({
              kind: 'model' as const,
              definitionId,
              definitionVersion: '1',
            })),
            ...tools.map((definitionId) => ({
              kind: 'tool' as const,
              definitionId,
              definitionVersion: '1',
            })),
            ...['shell.command', 'agent/worker'].map((definitionId) => ({
              kind: 'job' as const,
              definitionId,
              definitionVersion: '1',
            })),
          ],
        }),
      },
    });
    const bindPermissions = configuration.permissionManagement!;
    return {
      ...configuration,
      permissionManagement(runtime: Parameters<typeof bindPermissions>[0]) {
        bindPermissions(runtime);
        // This isolated host explicitly owns its mode controller; the production external-authority rejection remains.
        return createPermissionManagement({
          runtime,
          profile,
          nativeShellRead: process.platform === 'darwin',
        });
      },
    };
  },
  decorateConfiguration(configuration) {
    const resolve = configuration.resolveRunConfiguration;
    const observed = resolve
      ? {
          ...configuration,
          async resolveRunConfiguration(input: Parameters<typeof resolve>[0]) {
            const selected = await resolve(input);
            const model = selected.model;
            if (!model) return selected;
            return {
              ...selected,
              model: {
                ...(model.describeRequest
                  ? { describeRequest: model.describeRequest.bind(model) }
                  : {}),
                stream(...args: Parameters<typeof model.stream>) {
                  // Private fixture observation at the real compatible adapter boundary.
                  // A rejected dispatch cannot reach this call or the Provider wire.
                  appendFileSync(
                    modelStartsPath,
                    `${JSON.stringify({ executionId: args[0].requestId, sessionId: input.session.id })}\n`,
                  );
                  return model.stream(...args);
                },
              },
            };
          },
        }
      : configuration;
    return slots === 4
      ? observed
      : { ...observed, modelConcurrency: slots, processConcurrency: slots };
  },
  async beforeResourceClose() {
    clearInterval(timer);
  },
});
