import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireProfileAccess, acquireProfileDataLock } from '@kite-ai/agent/profile-access';
import type { AgentClient } from '@kite-ai/client';
import { openRecoveryJournal } from '../../host/recovery-journal';
import { lookupRecovery, type RecoveryIntent, submitRecovery } from '../../src/recovery';
import { recoveryProfile, untilRecovery } from '../fixtures/recovery-profile';

for (const mode of ['run', 'interrupt'] as const)
  test(`actual cold ${mode} preserves original scope after one POST and lost original GET`, async () => {
    const f = await recoveryProfile();
    const service = await f.launch().catch((error) => {
      f.close();
      throw error;
    });
    const access = acquireProfileAccess(f.profile),
      journal = openRecoveryJournal({
        access,
        acquireWriteLock: () => acquireProfileDataLock(access, 'tui_private'),
      });
    try {
      let posts = 0,
        gets = 0,
        lost = false;
      const actual = service.client;
      // Lose real committed receipts, never substitute a response or business fact.
      const client = new Proxy(actual, {
        get(target, key) {
          if (key === 'resumeRun' || key === 'recoverSession')
            return async (...args: unknown[]) => {
              posts++;
              expect(journal.list()).toEqual([{ intent, phase: 'submitting' }]);
              await (target[key] as (...args: unknown[]) => Promise<unknown>).apply(target, args);
              throw Error('physical committed response loss');
            };
          if (key === 'getCommand')
            return async (...args: Parameters<AgentClient['getCommand']>) => {
              gets++;
              const result = await target.getCommand(...args);
              if (!lost) {
                lost = true;
                throw Error('physical first GET response loss');
              }
              return result;
            };
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const intent: RecoveryIntent =
        mode === 'run'
          ? {
              kind: 'run',
              sessionId: 's',
              request: {
                kind: 'run.resume',
                expectedStoreId: f.storeId,
                commandId: 'original-recovery',
                runId: f.run.id,
              },
            }
          : {
              kind: 'interrupt',
              sessionId: 's',
              request: {
                kind: 'session.recover',
                expectedStoreId: f.storeId,
                commandId: 'original-recovery',
                decision: 'interrupt',
              },
            };
      const first = await submitRecovery(intent, { client, journal });
      expect(first.status).toBe('outcome_unknown');
      expect((await submitRecovery(structuredClone(intent), { client, journal })).status).toBe(
        'outcome_unknown',
      );
      expect(posts).toBe(1);
      expect(gets).toBe(1);
      const recovered = await lookupRecovery(intent, { client, journal });
      expect(recovered.status).toBe(mode === 'run' ? 'resumed' : 'interrupted');
      expect(posts).toBe(1);
      expect(gets).toBe(2);
      expect(recovered.command?.id).toBe('original-recovery');
      expect(f.rows('SELECT id,origin_command_id FROM run')).toEqual([
        { id: f.run.id, origin_command_id: 'work' },
      ]);
      expect(f.calls()).toBe(1);
      expect(existsSync(join(f.workspace, 'effect'))).toBe(false);
      if (mode === 'run') {
        expect(recovered.run?.id).toBe(f.run.id);
        const answer = async (id: string, revision: string) =>
          actual.answerInteraction('s', id, {
            expectedStoreId: f.storeId,
            commandId: `approval-${id}`,
            expectedRevision: revision,
            answer: { kind: 'approval', decision: 'approve', grant: 'approve_once' },
          });
        const pending = (
          await actual.listInteractions('s', { storeId: f.storeId, state: 'pending' })
        ).interactions;
        expect(pending.map((card) => card.id)).toEqual([f.card.id]);
        await answer(f.card.id, f.card.revision);
        await untilRecovery(async () => (await actual.getRun(f.run.id)).status === 'completed');
        const complete = await lookupRecovery(intent, { client, journal });
        expect(complete.run?.id).toBe(f.run.id);
        expect(complete.exitCode).toBe(0);
        expect(readFileSync(join(f.workspace, 'effect'), 'utf8')).toBe('ORIGINAL_EFFECT_ONCE');
        expect(readFileSync(f.ledger, 'utf8')).toBe('decision\ncompletion\n');
        expect(
          f.rows("SELECT state AS status FROM execution WHERE adapter_id='files.write'"),
        ).toEqual([{ status: 'succeeded' }]);
      } else {
        expect((await actual.getRun(f.run.id)).status).toBe('interrupted');
        expect(
          f.rows("SELECT state AS status FROM execution WHERE adapter_id='files.write'"),
        ).toEqual([{ status: 'cancelled' }]);
        expect(JSON.stringify(recovered.command)).not.toMatch(/generation|lease/);
      }
      expect(f.rows("SELECT kind,status FROM command WHERE id='original-recovery'")).toEqual([
        { kind: mode === 'run' ? 'run.resume' : 'session.recover', status: 'applied' },
      ]);
      expect(posts).toBe(1);
    } finally {
      journal.close();
      access.lock.release();
      await service.close();
      f.close();
    }
  }, 30000);

for (const mode of ['paired', 'shared'] as const)
  for (const operation of ['interrupt', 'run'] as const)
    test(`compiled CLI ${mode} cold ${operation} observes original work and looks up saved intent`, async () => {
      const { writeFileSync, mkdirSync, realpathSync } = await import('node:fs');
      const { createHash } = await import('node:crypto');
      const { runSelectedDaemon } = await import('../../host/daemon');
      const f = await recoveryProfile();
      try {
        const hash = (bytes: string | Uint8Array) =>
          createHash('sha256').update(bytes).digest('hex');
        const network = join(f.root, 'cli-network');
        const driverSource = join(f.root, 'artifact/recovery-driver.ts');
        writeFileSync(
          driverSource,
          `import {appendFileSync} from 'node:fs';import {runCLIProcess} from ${JSON.stringify(new URL('../../host/main.ts', import.meta.url).pathname)};const actual=globalThis.fetch;globalThis.fetch=Object.assign(async(...args:Parameters<typeof fetch>)=>{appendFileSync(${JSON.stringify(network)},JSON.stringify({method:args[1]?.method??'GET',path:new URL(String(args[0])).pathname,body:args[1]?.body?JSON.parse(String(args[1].body)):null})+'\\n');return actual(...args);},{preconnect:actual.preconnect});process.exitCode=await runCLIProcess({profile:'owned',argv:process.argv.slice(2),resolveArtifact:()=>(${JSON.stringify(f.artifact)})});`,
        );
        const built = await Bun.build({
          entrypoints: [driverSource],
          target: 'bun',
          packages: 'external',
          outdir: join(f.root, 'artifact'),
        });
        expect(built.success).toBe(true);
        const socket = join(f.root, 's.sock'),
          web = join(f.root, 'web');
        mkdirSync(web);
        const raw = JSON.stringify(
          [
            ['/index.html', 'text/html; charset=utf-8', '<title>Owned</title>'],
            ['/app.js', 'text/javascript; charset=utf-8', 'globalThis.owned=true;'],
            ['/app.css', 'text/css; charset=utf-8', 'body{}'],
          ].map(([path, mediaType, content]) => {
            writeFileSync(join(web, path!.slice(1)), content!);
            return { path, mediaType, size: Buffer.byteLength(content!), sha256: hash(content!) };
          }),
        );
        writeFileSync(join(web, 'manifest.json'), raw);
        const daemonEntry = join(f.root, 'artifact/node_modules/@kite-ai/service/daemon-main.js');
        const daemon = (action: 'start' | 'stop') =>
          runSelectedDaemon({
            arguments: { kind: 'server', action, server: socket, cancel: false, json: false },
            dataRoot: f.profile.dataRoot,
            profile: 'owned',
            cwd: f.workspace,
            artifact: {
              ...f.artifact,
              daemon: {
                entrypoint: daemonEntry,
                entrypointSha256: hash(readFileSync(daemonEntry)),
                web: { directory: web, manifestSha256: hash(raw) },
              },
            },
            write() {},
          });
        let started = false;
        const intent: RecoveryIntent =
          operation === 'run'
            ? {
                kind: 'run',
                sessionId: 's',
                request: {
                  kind: 'run.resume',
                  expectedStoreId: f.storeId,
                  commandId: 'cli-resume',
                  runId: f.run.id,
                },
              }
            : {
                kind: 'interrupt',
                sessionId: 's',
                request: {
                  kind: 'session.recover',
                  expectedStoreId: f.storeId,
                  commandId: 'cli-interrupt',
                  decision: 'interrupt',
                },
              };
        let originalCardPresentations = 0;
        const invoke = async (action: 'interrupt' | 'run' | 'lookup' | 'list') => {
          const child = Bun.spawn(
            [
              realpathSync(process.execPath),
              join(f.root, 'artifact/recovery-driver.js'),
              'recovery',
              action,
              's',
              '--data-root',
              f.profile.dataRoot,
              '--input',
              JSON.stringify(
                action === 'lookup'
                  ? { expectedStoreId: f.storeId, commandId: intent.request.commandId }
                  : action === 'list'
                    ? { expectedStoreId: f.storeId }
                    : intent.request,
              ),
              ...(mode === 'shared' ? ['--server', socket] : []),
            ],
            {
              cwd: f.workspace,
              stdin:
                operation === 'run' && action === 'run'
                  ? new Blob(['approve approve_once\n'])
                  : 'ignore',
              stdout: 'pipe',
              stderr: 'pipe',
            },
          );
          try {
            const [out, err, exit] = await Promise.all([
              new Response(child.stdout).text(),
              new Response(child.stderr).text(),
              child.exited,
            ]);
            expect(exit).toBe(0);
            if (operation === 'run' && action === 'run' && originalCardPresentations === 0) {
              originalCardPresentations++;
              expect(err).toContain(f.card.id);
              expect(err).toContain('approve');
            } else expect(err).toBe('');
            const fact = JSON.parse(out.trim().split('\n').at(-1)!);
            if (action === 'list') {
              expect(fact.kind).toBe('recovery.directory');
              expect(fact.records).toEqual([
                { intent, phase: operation === 'run' ? 'resumed' : 'interrupted' },
              ]);
              return;
            }
            expect(fact.status).toBe(operation === 'run' ? 'resumed' : 'interrupted');
            if (operation === 'run') {
              expect(fact.run.id).toBe(f.run.id);
              expect(fact.run.originCommandId).toBe('work');
              expect(fact.run.status).toBe('completed');
            }
            expect(fact.intent).toEqual(intent);
            expect(fact.command.kind).toBe(operation === 'run' ? 'run.resume' : 'session.recover');
          } finally {
            if (child.exitCode === null) {
              child.kill('SIGKILL');
              await child.exited;
            }
          }
        };
        try {
          if (mode === 'shared') {
            await daemon('start');
            started = true;
          }
          await invoke(operation);
          await invoke(operation);
          await invoke('list');
          await invoke('lookup');
          const requests = readFileSync(network, 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line));
          expect(
            requests.filter(
              (row) =>
                row.method === 'POST' &&
                row.body?.kind === (operation === 'run' ? 'run.resume' : 'session.recover'),
            ),
          ).toHaveLength(1);
          expect(
            requests.filter(
              (row) =>
                row.method === 'GET' && row.path === '/v1/commands/' + intent.request.commandId,
            ).length,
          ).toBeGreaterThanOrEqual(2);
          expect(f.rows('SELECT id,status FROM run')).toEqual([
            { id: f.run.id, status: operation === 'run' ? 'completed' : 'interrupted' },
          ]);
          const kind = operation === 'run' ? 'run.resume' : 'session.recover';
          expect(f.rows(`SELECT id,kind,status FROM command WHERE kind='${kind}'`)).toEqual([
            { id: intent.request.commandId, kind, status: 'applied' },
          ]);
          expect(f.rows("SELECT id FROM command WHERE kind='command.cancel'")).toEqual([]);
          if (operation === 'run') {
            expect(originalCardPresentations).toBe(1);
            expect(
              f.rows(
                `SELECT id,state,accepted_decision_revision,origin_store_id,run_id FROM interaction WHERE id='${f.card.id}'`,
              ),
            ).toEqual([
              {
                id: f.card.id,
                state: 'answered',
                accepted_decision_revision: Number(BigInt(f.card.revision) + 1n),
                origin_store_id: f.storeId,
                run_id: f.run.id,
              },
            ]);
            const answers = f.rows(
              "SELECT session_id,origin_store_id,request_json FROM command WHERE kind='interaction.answer'",
            ) as { session_id: string; origin_store_id: string; request_json: string }[];
            expect(answers).toHaveLength(1);
            expect(answers[0]!.session_id).toBe('s');
            expect(answers[0]!.origin_store_id).toBe(f.storeId);
            expect(JSON.parse(answers[0]!.request_json)).toMatchObject({
              interactionId: f.card.id,
              expectedRevision: f.card.revision,
              answer: { kind: 'approval', decision: 'approve', grant: 'approve_once' },
            });
          }

          expect(f.calls()).toBe(operation === 'run' ? 2 : 1);
          expect(existsSync(join(f.workspace, 'effect'))).toBe(operation === 'run');
        } finally {
          if (started) await daemon('stop');
          f.close();
        }
      } finally {
        f.close();
      }
    }, 30000);

test('actual recovered Run observation abort releases original approval wait without cancelling or rebinding original work', async () => {
  const { observeRecoveryRun } = await import('../../src/index');
  const f = await recoveryProfile();
  const service = await f.launch().catch((error) => {
    f.close();
    throw error;
  });
  try {
    const intent: RecoveryIntent = {
      kind: 'run',
      sessionId: 's',
      request: {
        kind: 'run.resume',
        expectedStoreId: f.storeId,
        commandId: 'observer-recovery',
        runId: f.run.id,
      },
    };
    const resumed = await submitRecovery(intent, { client: service.client });
    expect(resumed.status).toBe('resumed');
    const stop = new AbortController();
    let cards = 0;
    const outcome = await observeRecoveryRun(
      's',
      { expectedStoreId: f.storeId, commandId: 'work', runId: f.run.id },
      {
        client: service.client,
        signal: stop.signal,
        write() {},
        async answerInteraction(card) {
          expect(card.id).toBe(f.card.id);
          expect(card.originStoreId).toBe(f.storeId);
          expect(card.runId).toBe(f.run.id);
          cards++;
          stop.abort(Error('owned user read cancellation'));
          return undefined;
        },
      },
    );
    expect(outcome.status).toBe('outcome_unknown');
    expect(outcome.cancellationAttempted).toBeUndefined();
    expect(cards).toBe(1);
    expect(
      f.rows("SELECT id FROM command WHERE kind='command.cancel' OR kind='interaction.answer'"),
    ).toEqual([]);
    expect(
      f.rows(`SELECT state,accepted_decision_revision FROM interaction WHERE id='${f.card.id}'`),
    ).toEqual([{ state: 'pending', accepted_decision_revision: null }]);
    expect((await service.client.getRun(f.run.id)).isActive).toBe(true);
    expect(f.calls()).toBe(1);
    expect(existsSync(join(f.workspace, 'effect'))).toBe(false);
  } finally {
    await service.close();
    f.close();
  }
}, 30000);
