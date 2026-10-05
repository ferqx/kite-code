import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineExtension } from '@kite-ai/agent/extensions';
import { selectProfile } from '@kite-ai/agent/profile';
import { createFixedModel, type ModelAdapter } from '@kite-ai/ai';
import { runServiceProcess } from '../../src/main';

await runServiceProcess({
  configure(startup) {
    const profile = selectProfile({
      dataRoot: startup.profile.dataRoot,
      profile: startup.profile.profile,
    });
    const fixed = createFixedModel([
      [
        { type: 'tool_call', id: 'publish', name: 'fixture.artifacts.publish', arguments: '{}' },
        { type: 'finish', reason: 'tool_calls', usage: { inputTokens: 0, outputTokens: 0 } },
      ],
    ]);
    let requests = 0;
    const model: ModelAdapter = {
      async *stream(request, options) {
        appendFileSync(join(profile.profilePath, 'model-ledger'), 'request\n');
        requests++;
        if (requests === 1) {
          yield* fixed.stream(request, options);
          return;
        }
        await new Promise<void>((resolve) => {
          if (options.signal.aborted) {
            resolve();
            return;
          }
          options.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        options.signal.throwIfAborted();
      },
    };
    return {
      model,
      modelId: 'local',
      permissions: {
        async authorize() {
          return { allowed: true, revision: 'fixture' };
        },
      },
      extensions: [
        defineExtension({
          id: 'fixture.artifacts',
          version: '1',
          apiMajor: 1,
          tools: [
            {
              id: 'fixture.artifacts.publish',
              version: '1',
              description: 'Publish harmless immutable bytes',
              inputSchema: {},
              async execute(_input, context) {
                appendFileSync(join(profile.profilePath, 'tool-ledger'), 'publish\n');
                if (!context.artifacts) throw new Error('artifact_context_missing');
                const ref = await context.artifacts.publish({
                  key: 'result',
                  mediaType: 'application/octet-stream',
                  content: Uint8Array.from([0, 1, 2, 255, 65, 66]),
                });
                return {
                  outcome: 'succeeded',
                  content: 'Published harmless bytes',
                  artifactRefs: [ref],
                };
              },
            },
          ],
        }),
      ],
    };
  },
});
