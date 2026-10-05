import { appendFileSync, existsSync, watch, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JobEvent } from '@kite-ai/agent/extensions';
import { selectProfile } from '@kite-ai/agent/profile';
import { createFixedModel, type ModelAdapter } from '@kite-ai/ai';
import { runServiceProcess } from '@kite-ai/service/main';

await runServiceProcess({
  configure(startup) {
    const profile = selectProfile({
      dataRoot: startup.profile.dataRoot,
      profile: startup.profile.profile,
    });
    const finish = {
      type: 'finish',
      reason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1 },
    } as const;
    const fixed = createFixedModel([
      [
        { type: 'tool_call', id: 'launch', name: 'fixture.launch', arguments: '{}' },
        { ...finish, reason: 'tool_calls' },
      ],
      [finish],
      [
        { type: 'tool_call', id: 'stale', name: 'fixture.stale', arguments: '{}' },
        { ...finish, reason: 'tool_calls' },
      ],
      [finish],
    ]);
    let calls = 0;
    const model: ModelAdapter = {
      async *stream(request, options) {
        appendFileSync(join(profile.profilePath, 'models'), `${JSON.stringify(request)}\n`);
        if (++calls === 3) {
          await new Promise<void>((resolve) => {
            const watcher = watch(profile.profilePath, () => {
              if (existsSync(join(profile.profilePath, 'finish-model'))) {
                watcher.close();
                resolve();
              }
            });
            if (existsSync(join(profile.profilePath, 'finish-model'))) {
              watcher.close();
              resolve();
            }
          });
        }
        yield* fixed.stream(request, options);
      },
    };
    return {
      model,
      modelId: 'fixed',
      permissions: {
        async authorize() {
          return { allowed: true, revision: 'fixture-1' };
        },
      },
      extensions: [
        {
          id: 'fixture.context',
          version: '1',
          apiMajor: 1,
          tools: [
            {
              id: 'fixture.stale',
              version: '1',
              description: 'Should be superseded',
              inputSchema: { type: 'object' },
              async execute() {
                appendFileSync(join(profile.profilePath, 'stale-effects'), 'bad\n');
                return { outcome: 'succeeded', content: 'stale' };
              },
            },
            {
              id: 'fixture.launch',
              version: '1',
              description: 'Launch harmless detached result',
              inputSchema: { type: 'object' },
              async execute(_input, context) {
                await context.operations.ensure({
                  key: 'one',
                  cancellation: 'detached',
                  request: {
                    kind: 'job',
                    definitionId: 'fixture.ledger',
                    definitionVersion: '1',
                    input: {},
                  },
                });
                return { outcome: 'succeeded', content: 'admitted' };
              },
            },
          ],
          jobs: [
            {
              id: 'fixture.ledger',
              version: '1',
              description: 'Bounded fixture physical effect',
              inputSchema: { type: 'object' },
              async start() {
                appendFileSync(join(profile.profilePath, 'effects'), 'one\n');
                return { reference: {} };
              },
              async *observe(): AsyncIterable<JobEvent> {
                await new Promise<void>((resolve) => {
                  const release = join(profile.profilePath, 'finish-job');
                  if (existsSync(release)) {
                    resolve();
                    return;
                  }
                  const watcher = watch(profile.profilePath, () => {
                    if (existsSync(release)) {
                      watcher.close();
                      resolve();
                    }
                  });
                  if (existsSync(release)) {
                    watcher.close();
                    resolve();
                  }
                });
                yield {
                  type: 'terminal',
                  supervision: 'ended',
                  result: { outcome: 'succeeded', content: 'historical untrusted data' },
                };
              },
              async cancel() {
                writeFileSync(join(profile.profilePath, 'finish-job'), 'stop');
                return { status: 'stopped' };
              },
              async dispose() {},
            },
          ],
        },
      ],
    };
  },
});
