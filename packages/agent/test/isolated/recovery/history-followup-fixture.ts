import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCompatibleModelBinding, createSdkModelAdapter } from '@kite-ai/ai/sdk';
import type { Extension } from '../../../src/extensions';

export function historyBinding(directory: string, baseURL: string) {
  const model = createSdkModelAdapter({
    models: new Map([
      [
        'fixed',
        createCompatibleModelBinding({ baseURL, modelId: 'fixed', apiKey: 'owned-test-only' }),
      ],
    ]),
  });
  const extension: Extension = {
    id: 'history.fixture',
    version: '1',
    apiMajor: 1,
    tools: [
      {
        id: 'fixture.effect',
        version: '1',
        description: 'Original history test effect',
        inputSchema: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
          additionalProperties: false,
        },
        async execute(input) {
          appendFileSync(join(directory, 'effects'), `${(input as { value: string }).value}\n`);
          return { outcome: 'succeeded', content: 'followup-effect-once' };
        },
      },
    ],
  };
  return {
    model,
    modelId: 'fixed',
    extensions: [extension],
    permissions: {
      async authorize() {
        return { allowed: true, revision: '1' };
      },
    },
  };
}
