import { expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { acquireProfileAccess, acquireProfileDataLock } from '@kite-ai/agent/profile-access';
import { type AgentClient, ClientError } from '@kite-ai/client';
import type { TuiCallerRequest } from '@kite-ai/ui/tui';
import { privateDirectory, temporaryDirectory } from '../../../tests/fixtures/test-filesystem';
import { callerRequestDigest } from '../host/caller-intents';
import { openCallerJournal } from '../host/caller-journal';
import { createTuiCallerPort } from '../host/caller-port';

for (const [label, kind, failure, expected, afterResponse = false] of [
  [
    '409 stopped steer',
    'input.steer',
    new ClientError('input_target_stopped', undefined, 409),
    'rejected',
  ],
  [
    '400 stopped steer',
    'input.steer',
    new ClientError('input_target_stopped', undefined, 400),
    'rejected',
  ],
  [
    '500 stopped steer',
    'input.steer',
    new ClientError('input_target_stopped', undefined, 500),
    'unknown',
  ],
  ['missing status', 'input.steer', new ClientError('input_target_stopped'), 'unknown'],
  ['other 409', 'input.steer', new ClientError('outcome_unknown', undefined, 409), 'unknown'],
  ['network', 'input.steer', new Error('network'), 'unknown'],
  ['run start', 'run.start', new ClientError('input_target_stopped', undefined, 409), 'unknown'],
  [
    'checked GET failure',
    'input.steer',
    new ClientError('input_target_stopped', undefined, 409),
    'unknown',
    true,
  ],
] as const) {
  test(`first caller submit classifies only proven uncreated steer: ${label}`, async () => {
    const root = temporaryDirectory('kite-caller-rejected-');
    const access = acquireProfileAccess({ dataRoot: join(root, 'data'), profile: 'owned' });
    privateDirectory(access.profilePath);
    const open = () =>
      openCallerJournal({
        access,
        acquireWriteLock: () => acquireProfileDataLock(access, 'tui_private'),
      });
    let journal = open(),
      posts = 0,
      gets = 0,
      viewReads = 0;
    const client = {
      serverInfo: { storeId: 'store', subjectId: 'local-user' },
      getView: async () => {
        if (afterResponse && ++viewReads > 1) throw failure;
        return { storeId: 'store', session: { id: 's', workspaceId: 'w', deletedAt: null } };
      },
      steer: async (_sessionId: string, request: TuiCallerRequest) => {
        posts++;
        if (afterResponse)
          return {
            id: request.commandId,
            kind: request.kind,
            sessionId: 's',
            originStoreId: 'store',
            subjectId: 'local-user',
            requestDigest: callerRequestDigest(request),
            status: 'accepted',
            receipt: {},
            cancelRequestedAt: null,
          };
        throw failure;
      },
      startRun: async () => {
        posts++;
        throw failure;
      },
      getCommand: async () => {
        gets++;
        throw new ClientError('command_not_found', undefined, 404);
      },
    } as unknown as AgentClient;
    try {
      const port = createTuiCallerPort({ client, storeId: 'store', journal });
      const request: TuiCallerRequest =
        kind === 'input.steer'
          ? {
              kind,
              expectedStoreId: 'store',
              commandId: 'original',
              targetRunId: 'run',
              contextSelectionId: 'selection',
              content: 'original input',
            }
          : { kind, expectedStoreId: 'store', commandId: 'original', content: 'original input' };
      const intent = await port.prepare(
        { storeId: 'store', sessionId: 's', workspaceId: 'w' },
        request,
      );
      const result = await port.submit(intent);
      expect(result.phase).toBe(expected);
      expect(result.command).toBeUndefined();
      expect(result.error).toBe(expected === 'rejected' ? 'input_target_stopped' : undefined);
      expect(posts).toBe(1);
      expect(gets).toBe(0);
      expect(journal.list()[0]?.phase).toBe(expected);
      expect((await port.lookup(intent, new AbortController().signal)).phase).toBe('unknown');
      expect(posts).toBe(1);
      expect(gets).toBe(1);
      journal.close();
      journal = open();
      expect(journal.list()[0]?.phase).toBe(expected);
    } finally {
      journal.close();
      access.lock.release();
      rmSync(root, { recursive: true, force: true });
    }
  });
}
