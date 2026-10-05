import { appendFileSync } from 'node:fs';
import { defineExtension, type Json } from '@kite-ai/agent/extensions';
import { createShellJob } from '@kite-ai/agent/jobs/shell';
import {
  createWorkspaceSerialLocks,
  type WorkspaceSerialCoordinator,
} from '@kite-ai/agent/resources';
import { runServiceProcess } from '../../../apps/service/src/main';

let locks: WorkspaceSerialCoordinator | undefined;
try {
  await runServiceProcess({
    configure(startup) {
      const configuration = startup.hostConfiguration as {
        cwd: string;
        helper: string;
        ledger: string;
        graceMs: number;
        serial?: boolean;
      };
      locks = createWorkspaceSerialLocks({
        dataRoot: startup.profile.dataRoot,
        profile: startup.profile.profile,
      });
      const shell = createShellJob({
        cwd: configuration.cwd,
        env: { PATH: '/usr/bin:/bin' },
        supervisorPath: configuration.helper,
        graceMs: configuration.graceMs,
        maxQueuedBytes: 32768,
      });
      const extension = defineExtension({
        id: 'fixture.shell',
        version: '1',
        apiMajor: 1,
        jobs: [
          {
            ...shell,
            resources: configuration.serial
              ? { slot: 'process', serial: { scope: 'workspace', key: 'fixture-shell' } }
              : shell.resources,
            async start(input, context) {
              appendFileSync(
                configuration.ledger,
                `${JSON.stringify({ executionId: context.executionId, input })}\n`,
              );
              return shell.start(input, context);
            },
          },
        ],
        actions: [
          {
            id: 'fixture.shell-launch',
            version: '1',
            description: 'Explicit local Shell fixture',
            inputSchema: {
              type: 'object',
              additionalProperties: false,
              required: ['key', 'command'],
              properties: { key: { type: 'string' }, command: { type: 'string' } },
            },
            async prepare(input) {
              return input;
            },
            async execute(input, context) {
              const request = input as { key: string; command: string };
              const ref = await context.operations.ensure({
                key: request.key,
                cancellation: 'detached',
                request: {
                  kind: 'job',
                  definitionId: shell.id,
                  definitionVersion: shell.version,
                  input: { command: request.command },
                },
              });
              return {
                outcome: 'succeeded',
                content: 'Shell admitted',
                details: ref as unknown as Json,
              };
            },
          },
        ],
      });
      return {
        extensions: [extension],
        workspaceSerialLocks: locks,
        processConcurrency: 1,
        permissions: {
          async authorize() {
            return { allowed: true, revision: '1' };
          },
        },
      };
    },
  });
} finally {
  await locks?.close();
}
