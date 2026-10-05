import { expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireProfileAccess, acquireProfileDataLock } from '@kite-ai/agent/profile-access';
import { launchPairedService } from '@kite-ai/service/paired';
import { createFileRecoveryPort } from '../../host/file-recovery';
import { openFileRecoveryJournal } from '../../host/file-recovery-intents';
import { fileRecoveryProfile } from '../fixtures/file-recovery-profile';

async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean) {
  const end = Date.now() + 20000;
  for (;;) {
    const value = await read();
    if (accept(value)) return value;
    if (Date.now() > end) throw Error('drift_qualification_deadline');
    await Bun.sleep(5);
  }
}
for (const drift of ['external_edit', 'later_run'] as const)
  test(`actual Code known success cannot authorize both Fork after ${drift}; original intent and bytes retained`, async () => {
    const f = await fileRecoveryProfile({ secondMutation: drift === 'later_run' });
    const service = await launchPairedService({
      profile: f.profile,
      entrypoint: f.artifact.entrypoint,
      executable: f.artifact.executable,
      instanceId: 'second-leg',
      buildId: f.artifact.buildId,
      apiMajor: 1,
      requiredCapabilities: ['file_recovery'],
      spawnChild: (args, { env }) =>
        Bun.spawn([...args], {
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: 'pipe',
          env: { ...env, HOME: f.home },
        }),
    });
    const access = acquireProfileAccess(f.profile),
      journal = openFileRecoveryJournal({
        access,
        acquireWriteLock: () => acquireProfileDataLock(access, 'tui_private'),
      });
    try {
      const client = service.client,
        storeId = service.bootstrap.storeId!;
      const port = createFileRecoveryPort({ client, journal });
      const initial = await port.begin('s', f.checkpointId, 'both');
      let current = await port.continue(initial),
        answered = false;
      current = await until(
        async () => {
          const command = await client.getCommand(initial.code!.request.commandId),
            actionId = (command.receipt as { executionId?: string })?.executionId;
          const view = await client.getView('s');
          const card = (
            await client.listInteractions('s', { storeId, state: 'pending' })
          ).interactions.find(
            (i) =>
              i.executionId === actionId ||
              view.executions.find((e) => e.id === i.executionId)?.parentExecutionId === actionId,
          );
          if (card && !answered) {
            answered = true;
            await client.answerInteraction(card.presentationSessionId, card.id, {
              expectedStoreId: storeId,
              commandId: 'actual-restore-approval',
              expectedRevision: card.revision,
              answer: { kind: 'approval', decision: 'approve', grant: 'approve_once' },
            });
          }
          return port.lookup(current);
        },
        (intent) => intent.code!.phase === 'succeeded',
      );
      expect(readFileSync(f.file, 'utf8')).toBe('original bytes\r\n');
      const selector = (await client.getView('s')).session.contextSelectionId;
      if (drift === 'external_edit') writeFileSync(f.file, 'external editor bytes\r\n');
      else {
        await client.startRun('s', {
          expectedStoreId: storeId,
          commandId: 'later-work',
          kind: 'run.start',
          content: 'Read and change again in a distinct Run.',
        });
        const command = await until(
          () => client.getCommand('later-work'),
          (c) => c.status === 'applied',
        );
        const run = await until(
          () => client.getRun((command.receipt as { runId: string }).runId),
          (r) => !r.isActive,
        );
        expect(run.status).toBe('completed');
        expect(f.calls()).toBe(6);
      }
      expect((await client.getView('s')).session.contextSelectionId).toBe(selector);
      let forks = 0;
      const original = client.forkSession.bind(client);
      client.forkSession = (...args) => {
        forks++;
        return original(...args);
      };
      const bytes = readFileSync(f.file);
      const journalBefore = readFileSync(
        join(f.profile.profilePath, 'ui/file-recovery-intents.json'),
      );
      await expect(port.continue(current)).rejects.toThrow();
      expect(forks).toBe(0);
      expect(readFileSync(f.file)).toEqual(bytes);
      expect(readFileSync(join(f.profile.profilePath, 'ui/file-recovery-intents.json'))).toEqual(
        journalBefore,
      );
      const after = await port.lookup(current);
      expect(after.code!.phase).toBe('succeeded');
      expect(after.fork!.phase).toBe('not_started');
      expect(f.calls()).toBe(drift === 'external_edit' ? 3 : 6);
    } finally {
      journal.close();
      access.lock.release();
      await service.close();
      f.close();
    }
  }, 65000);
