import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { selectProfile } from '@kite-ai/agent/profile';
import { createFixedModel } from '@kite-ai/ai';
import { runServiceProcess } from '@kite-ai/service/main';

await runServiceProcess({
  configure(startup) {
    const profile = selectProfile({
      dataRoot: startup.profile.dataRoot,
      profile: startup.profile.profile,
    });
    return {
      modelId: 'fixed',
      model: createFixedModel([
        [
          { type: 'tool_call', id: 'call', name: 'fixture.question', arguments: '{}' },
          { type: 'finish', reason: 'tool_calls', usage: { inputTokens: 1, outputTokens: 1 } },
        ],
        [{ type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } }],
      ]),
      permissions: {
        async authorize(request) {
          return request.kind === 'tool'
            ? {
                allowed: false,
                revision: 'policy-1',
                approval: { request: { title: 'Approve harmless fixture' } },
              }
            : { allowed: true, revision: 'policy-1' };
        },
      },
      extensions: [
        {
          id: 'fixture',
          version: '1',
          apiMajor: 1,
          tools: [
            {
              id: 'fixture.question',
              version: '1',
              description: 'Local question',
              inputSchema: { type: 'object' },
              async execute(_input, context) {
                writeFileSync(join(profile.profilePath, 'effect'), 'one');
                const answer = await context.requestInput({
                  schema: {
                    type: 'object',
                    required: ['reply'],
                    properties: { reply: { type: 'string', enum: ['first', 'second'] } },
                    additionalProperties: false,
                  },
                });
                writeFileSync(join(profile.profilePath, 'answer'), JSON.stringify(answer));
                return { outcome: 'succeeded', content: 'answered' };
              },
            },
          ],
        },
      ],
    };
  },
});
