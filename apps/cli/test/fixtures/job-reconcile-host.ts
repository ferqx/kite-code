import { appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createFixedModel } from '@kite-ai/ai';
import type { runServiceProcess } from '@kite-ai/service/main';

import { createLedgerExtension } from './job-reconcile-ledger';

type ConfigureProcessHost = NonNullable<
  NonNullable<Parameters<typeof runServiceProcess>[0]>['configure']
>;

export const configure: ConfigureProcessHost = (startup) => {
  const base = dirname(startup.profile.dataRoot);
  appendFileSync(join(base, 'hosts'), `${process.pid}\n`);
  return {
    model: createFixedModel([]),
    modelId: 'cold-no-model',
    permissions: {
      async authorize() {
        return { allowed: false, revision: 'no-execution' };
      },
    },
    authorizeJobReconcile: async () => ({ allowed: true, revision: 'explicit-query-only' }),
    extensions: [
      createLedgerExtension(join(base, 'ledger'), {
        onStart() {
          appendFileSync(join(base, 'unexpected-start'), 'start\n');
        },
        onQuery() {
          appendFileSync(join(base, 'queries'), 'query\n');
        },
      }),
    ],
  };
};
