import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { createProfileBackup } from '@kite-ai/agent/maintenance';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createFixedModel } from '@kite-ai/ai';
import type { RecoveryReceipt as Receipt } from '../fixtures/recovery-preparation-ownership-child';

async function within<T>(work: Promise<T>, milliseconds: number, phase: string): Promise<T> {
  if (milliseconds <= 0) {
    void work.catch(() => {});
    throw Error(`owned fixture deadline: ${phase}`);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error(`owned fixture deadline: ${phase}`)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

type Store = Awaited<ReturnType<typeof openSqliteStore>>;
// Only the owned child's exact original WorkspaceFiles directory owner close
// rejects before native close. This is a JavaScript failure, not a natural OS failure.
for (const mode of ['run', 'report', 'job'])
  test(`formal explicit ${mode} recovery retains original cleanup custody through cold recovery`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-recovery-preparation-ownership-')));
    const profile = selectProfile({ dataRoot: root, profile: 'test' });
    const started = Date.now(),
      deadline = started + 10000,
      cleanupDeadline = started + 14000;
    const bounded = <T>(work: Promise<T>, phase: string) =>
      within(work, deadline - Date.now(), phase);
    const cleanupBounded = <T>(work: Promise<T>, milliseconds: number, phase: string) =>
      within(work, Math.min(milliseconds, cleanupDeadline - Date.now()), phase);
    let child: Bun.Subprocess<'pipe', 'pipe', 'pipe'> | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let cold: Store | undefined;
    let coldRuntime: ReturnType<typeof createRuntime> | undefined;
    let coldOpening: Promise<Store> | undefined;
    let draining = false;
    const failures: unknown[] = [];
    try {
      child = Bun.spawn(
        [
          process.execPath,
          '--no-install',
          fileURLToPath(
            new URL('../fixtures/recovery-preparation-ownership-child.ts', import.meta.url),
          ),
          root,
          mode,
        ],
        {
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      const diagnostics = new Response(child.stderr).text();
      void diagnostics.catch(() => {});
      reader = child.stdout.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let buffer = '';
      while (!buffer.includes('\n')) {
        const chunk = await bounded(reader.read(), 'retained preparation receipt');
        if (chunk.done)
          throw Error(
            `owned child exited before receipt: ${await bounded(diagnostics, 'early diagnostics')}`,
          );
        buffer += decoder.decode(chunk.value, { stream: true });
        if (buffer.length > 1048576) throw Error('owned fixture receipt too large');
      }
      const lineEnd = buffer.indexOf('\n');
      const report = JSON.parse(buffer.slice(0, lineEnd)) as Receipt;
      const outputReader = reader;
      const remainingOutput = (async () => {
        let tail = buffer.slice(lineEnd + 1);
        try {
          for (;;) {
            const chunk = await outputReader.read();
            if (chunk.done) return tail + decoder.decode();
            tail += decoder.decode(chunk.value, { stream: true });
            if (tail.length > 1048576) throw Error('owned fixture tail too large');
          }
        } finally {
          outputReader.releaseLock();
          if (reader === outputReader) reader = undefined;
        }
      })();
      void remainingOutput.catch(() => {});
      expect(report.pid).toBe(child.pid);
      expect(child.exitCode).toBeNull();
      expect(report.mode).toBe(mode);
      expect(report.resolvers).toBe(1);
      expect(report.sdkError).toMatchObject({ code: 'configuration_cleanup_unconfirmed' });
      expect(report.exactReceiver).toBe(true);
      expect(report.typed).toBe(true);
      expect(report.originalCode).toBe('skill_not_discovered');
      expect(report.originalCleanup).toBe(true);
      expect(report.exactFiles).toBe(true);
      expect(report.attempts).toBe(1);
      expect(report.fileContent).toBe(report.fileBody);
      expect(report.modelCalls).toBe(0);
      expect(report.queries).toBe(0);
      expect(report.starts).toBe(mode === 'job' ? 1 : 0);
      if (mode === 'run') {
        expect(report.seedExit).toEqual({ code: 0, stdout: '', stderr: '' });
        expect(report.ledger).toBe('model-decision\n');
        expect(report.before.sessions[0]!.view.runs.some((run) => run.isActive)).toBe(true);
        expect(
          report.before.sessions[0]!.view.executions.find(
            (execution) => execution.kind === 'model',
          ),
        ).toMatchObject({ status: 'succeeded' });
        expect(
          report.before.sessions[0]!.view.executions.find((execution) => execution.kind === 'tool'),
        ).toMatchObject({ status: 'planned' });
        expect(report.before.sessions[0]!.interactions.interactions).toHaveLength(1);
      } else if (mode === 'report') {
        expect(
          report.before.commands.find((command) => command?.kind === 'job.report'),
        ).toMatchObject({
          status: 'needs_review',
          receipt: { reason: 'report_recovery_required' },
        });
        expect(
          report.before.sessions[0]!.view.executions.find((execution) => execution.childSessionId),
        ).toMatchObject({ delivery: 'pending' });
        expect(report.before.sessions).toHaveLength(2);
      } else {
        const job = report.before.sessions[0]!.view.executions.find(
          (execution) => execution.kind === 'job',
        )!;
        expect(job).toMatchObject({ status: 'outcome_unknown', delivery: 'pending' });
        expect(JSON.parse(report.ledger)).toEqual({ operation: job.id, outcome: 'succeeded' });
      }
      expect(report.after.commands).toEqual(report.before.commands);
      for (let at = 0; at < report.before.sessions.length; at++) {
        const before = report.before.sessions[at]!,
          after = report.after.sessions[at]!;
        expect(after.id).toBe(before.id);
        expect(after.view.runs).toEqual(before.view.runs);
        expect(after.view.executions).toEqual(before.view.executions);
        expect(after.messages).toEqual(before.messages);
        expect(after.interactions.interactions).toEqual(before.interactions.interactions);
        expect(before.interactions.nextAfterId).toBeNull();
        expect(after.interactions.nextAfterId).toBeNull();
        expect(before.interactions.snapshotCursor).toBe(report.before.metadata.lastChangeCursor);
        expect(after.interactions.snapshotCursor).toBe(report.after.metadata.lastChangeCursor);
      }
      expect(
        BigInt(report.after.metadata.lastChangeCursor) -
          BigInt(report.before.metadata.lastChangeCursor),
      ).toBe(mode === 'report' ? 0n : 1n);
      if (mode === 'report') expect(report.recovery).toBeNull();
      else
        expect(report.recovery).toMatchObject({
          id: 'recover',
          kind: mode === 'run' ? 'run.resume' : 'job.reconcile',
          status: 'accepted',
          originStoreId: report.before.metadata.storeId,
        });
      expect(report.owner?.ownerInstanceId).toBe('original-recovery-owner');
      expect(report.foreignOwner).toBeNull();
      expect(report.sameClose).toBe(true);
      expect(report.error).toMatchObject({ code: 'shutdown_cleanup_unconfirmed' });
      expect(report.runtimeError).toMatchObject({ code: 'shutdown_cleanup_unconfirmed' });
      expect(report.lifecycle.state).toBe('drain_failed');
      await expect(
        bounded(
          createProfileBackup({ profile, destinationRoot: join(root, 'blocked-backup') }),
          'live maintenance',
        ),
      ).rejects.toMatchObject({ code: 'owner_busy' });
      expect(child.exitCode).toBeNull();
      child.stdin.write('exit\n');
      child.stdin.end();
      const [exit, stderr, stdout] = await bounded(
        Promise.all([child.exited, diagnostics, remainingOutput]),
        'explicit process exit and double EOF',
      );
      expect(exit).toBe(0);
      expect(stderr).toBe('');
      expect(stdout).toBe('');
      const backup = await bounded(
        createProfileBackup({ profile, destinationRoot: join(root, 'backup') }),
        'released maintenance',
      );
      expect(backup.manifest.source.storeId).toBe(report.after.metadata.storeId);
      coldOpening = openSqliteStore({ dataRoot: root, profile: 'test', mode: 'readonly' }).then(
        (store) => {
          cold = store;
          if (draining) void store.close().catch((error) => failures.push(error));
          return store;
        },
      );
      void coldOpening.catch(() => {});
      cold = await bounded(coldOpening, 'cold Store');
      expect(await bounded(cold.getMetadata(), 'cold metadata')).toEqual(report.after.metadata);
      for (const session of report.after.sessions) {
        expect(await bounded(cold.getView(session.id), 'cold view')).toEqual(session.view);
        expect(
          await bounded(cold.listMessages(session.id, { limit: 200 }), 'cold messages'),
        ).toEqual(session.messages);
        expect(
          await bounded(
            cold.listInteractions({
              expectedStoreId: report.after.metadata.storeId,
              sessionId: session.id,
              origin: 'all',
              limit: 100,
            }),
            'cold interactions',
          ),
        ).toEqual(session.interactions);
        expect(await bounded(cold.listExecutions(session.id, 200), 'cold executions')).toEqual(
          session.view.executions,
        );
      }
      for (const command of report.after.commands) {
        if (!command) throw Error('original command missing from snapshot');
        expect(await bounded(cold.getCommand(command.id), 'cold original Command')).toEqual(
          command,
        );
      }
      expect(await bounded(cold.getCommand('recover'), 'cold recovery Command')).toEqual(
        report.recovery,
      );
      const coldModel = createFixedModel([]);
      coldRuntime = createRuntime({
        store: cold,
        model: coldModel,
        modelId: 'cold',
        permissions: {
          async authorize() {
            return { allowed: false, revision: 'cold' };
          },
        },
      });
      for (const session of report.after.sessions)
        expect(await bounded(coldRuntime.getView(session.id), 'cold Runtime')).toEqual(
          session.view,
        );
      expect(coldModel.requests).toHaveLength(0);
    } catch (error) {
      failures.push(error);
    } finally {
      draining = true;
      if (child && child.exitCode === null) {
        try {
          child.stdin.write('exit\n');
          child.stdin.end();
        } catch {
          child.kill('SIGTERM');
        }
        try {
          await cleanupBounded(child.exited, 200, 'requested cleanup exit');
        } catch {
          child.kill('SIGTERM');
          try {
            await cleanupBounded(child.exited, 300, 'own SIGTERM cleanup');
          } catch {
            child.kill('SIGKILL');
            try {
              await cleanupBounded(child.exited, 300, 'own SIGKILL cleanup');
            } catch (error) {
              failures.push(error);
            }
          }
        }
      }
      try {
        if (reader) await cleanupBounded(reader.cancel(), 100, 'reader cleanup');
      } catch (error) {
        failures.push(error);
      } finally {
        try {
          reader?.releaseLock();
        } catch (error) {
          failures.push(error);
        }
      }
      try {
        if (coldOpening) await cleanupBounded(coldOpening, 300, 'cold opening cleanup');
      } catch (error) {
        failures.push(error);
      }
      try {
        await cleanupBounded(Promise.resolve(coldRuntime?.close()), 300, 'cold Runtime cleanup');
      } catch (error) {
        failures.push(error);
      }
      try {
        await cleanupBounded(Promise.resolve(cold?.close()), 300, 'cold Store cleanup');
      } catch (error) {
        failures.push(error);
      }
      if (!failures.length) rmSync(root, { recursive: true, force: true });
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length)
      throw new AggregateError(failures, `recovery preparation ownership failed:${root}`);
  }, 15000);
