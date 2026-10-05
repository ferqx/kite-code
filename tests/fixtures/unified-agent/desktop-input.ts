import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { selectProfile } from '@kite-ai/agent/profile';
import type { ModelEvent } from '@kite-ai/ai';
import { runServiceProcess } from '@kite-ai/service/main';

const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
await runServiceProcess({
  configure(startup) {
    const profile = selectProfile({
      dataRoot: startup.profile.dataRoot,
      profile: startup.profile.profile,
    });
    let calls = 0;
    return {
      modelId: 'parent',
      modelConcurrency: 1,
      permissions: {
        async authorize() {
          return { allowed: true, revision: 'trusted-test' };
        },
      },
      model: {
        async *stream(request) {
          appendFileSync(join(profile.profilePath, 'models'), `${JSON.stringify(request)}\n`);
          if (calls++ === 0) {
            yield {
              type: 'tool_call',
              id: 'delegate',
              name: 'fixture.delegate',
              arguments: '{}',
            } as const;
            yield { ...finish, reason: 'tool_calls' } as const;
          } else {
            yield { type: 'text_delta', text: 'completed' } as const;
            yield finish;
          }
        },
      },
      childConfigurations: [
        {
          id: 'child',
          version: '1',
          modelId: 'child',
          snapshot: {},
          toolIds: [],
          maxConcurrentSubagents: 1,
          model: {
            async *stream(_request, { signal }) {
              writeFileSync(join(profile.profilePath, 'child-started'), 'one');
              const deadline = Date.now() + 10000;
              while (!existsSync(join(profile.profilePath, 'release-child'))) {
                signal.throwIfAborted();
                if (Date.now() > deadline) throw new Error('fixture_gate_deadline');
                await Bun.sleep(5);
              }
              appendFileSync(join(profile.profilePath, 'child-finished'), 'one\n');
              yield finish;
            },
          },
        },
      ],
      extensions: [
        {
          id: 'fixture',
          version: '1',
          apiMajor: 1,
          tools: [
            {
              id: 'fixture.delegate',
              version: '1',
              description: 'Await a real child',
              inputSchema: { type: 'object' },
              async execute(_input, context) {
                const ref = await context.operations.ensure({
                  key: 'child',
                  request: { kind: 'agent', configurationId: 'child', input: { content: 'child' } },
                });
                const result = await context.operations.wait(ref, {
                  signal: context.signal,
                  timeoutMs: 8000,
                });
                return { outcome: 'succeeded', content: JSON.stringify(result.result) };
              },
            },
          ],
        },
      ],
    };
  },
});
