import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeClient, type RuntimeClientTransport } from '@kite-ai/runtime-client';
import { RUNTIME_COMMAND_SCHEMA_ } from '@kite-ai/runtime-contract';
import type { RuntimeProtocolMessage } from '@kite-ai/runtime-protocol';
import type { RuntimeServerAdmissionPort } from '@kite-ai/runtime-server';
import { createMockModelServer } from '../../../../../tests/tui-system/harness/fixtures';
import {
  createKiteMultiWorkspaceRuntimeServer,
  createKiteSessionAppServerStorageComposition,
} from '../../../src/bootstrap';

const parentSessionId = 'capacity-parent';

async function until(predicate: () => boolean, stage: string, waitMs = 12_000): Promise<void> {
  const deadline = Date.now() + waitMs;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(20);
  if (!predicate()) throw new Error(`Queued SIGKILL fixture did not reach ${stage}.`);
}

function seedHome(root: string): string | undefined {
  const names = readdirSync(root).filter((name) => name.startsWith('kite-followup-capacity-'));
  return names.length === 1 ? join(root, names[0]!) : undefined;
}

function acceptedQueued(
  databasePath: string,
):
  | { targetId: string; submissionId: string; reservationId: string; initialAttempts: number }
  | undefined {
  if (!existsSync(databasePath)) return undefined;
  let database: Database;
  try {
    database = new Database(databasePath, { readonly: true });
  } catch {
    return undefined;
  }
  try {
    const mail = database
      .query<{ target_session_id: string; submission_id: string }, []>(
        "SELECT target_session_id,submission_id FROM agent_mail_outbox WHERE mode='trigger_turn' LIMIT 1",
      )
      .get();
    const snapshot = database
      .query<{ state_json: string }, [string]>(
        'SELECT state_json FROM runtime_snapshots WHERE session_id=?',
      )
      .get(parentSessionId);
    if (!mail || !snapshot) return undefined;
    const state = JSON.parse(snapshot.state_json) as {
      resourceBudget?: {
        reservations?: Record<
          string,
          { invocationId?: string; state?: string; resourceKind?: string }
        >;
      };
    };
    const backup = Object.entries(state.resourceBudget?.reservations ?? {}).find(
      ([, reservation]) =>
        reservation.invocationId === mail.submission_id &&
        reservation.resourceKind === 'subagent' &&
        reservation.state === 'queued',
    );
    if (!backup) return undefined;
    const initialAttempts =
      database
        .query<{ count: number }, [string]>(
          `SELECT count(*) AS count FROM runtime_events WHERE session_id=?
           AND json_extract(event_json,'$.type')='model.invocation_attempt_started'`,
        )
        .get(mail.target_session_id)?.count ?? 0;
    return {
      targetId: mail.target_session_id,
      submissionId: mail.submission_id,
      reservationId: backup[0],
      initialAttempts,
    };
  } catch (error) {
    if (error instanceof Error && /database is locked|no such table/u.test(error.message))
      return undefined;
    throw error;
  } finally {
    database.close();
  }
}

test('SIGKILL with unknown occupied attempts keeps a queued followup fail closed after restart', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'kite-queued-sigkill-root-'));
  const seed = Bun.spawn(
    [
      process.execPath,
      'test',
      '--test-name-pattern',
      '^two occupied child slots queue a followup until one slot releases$',
      join(import.meta.dir, '../runtime-server-followup-capacity-queue.test.ts'),
      '--parallel=1',
      '--max-concurrency=1',
    ],
    {
      cwd: join(import.meta.dir, '../../../../..'),
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, TMPDIR: root },
    },
  );
  let home: string | undefined;
  let storage: Awaited<ReturnType<typeof createKiteSessionAppServerStorageComposition>> | undefined;
  let server: ReturnType<typeof createKiteMultiWorkspaceRuntimeServer> | undefined;
  let client: RuntimeClient | undefined;
  const recoveryDiagnostics: unknown[] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    if (args[0] === 'Independent child followup recovery requires attention.')
      recoveryDiagnostics.push(args[1]);
    originalConsoleError(...args);
  };
  const model = createMockModelServer();
  let recoveredTargetRequests = 0;
  model.setResponses(
    Array.from({ length: 8 }, () => ({
      response: async ({ messages }: { messages: readonly unknown[] }) => {
        if (JSON.stringify(messages).includes('CAPACITY_TARGET')) recoveredTargetRequests++;
        return { message: { content: 'RECOVERED_MODEL_RESULT' } };
      },
    })),
  );
  const previousHome = process.env.KITE_CODE_HOME;
  try {
    await until(() => {
      home = seedHome(root);
      return home !== undefined && acceptedQueued(join(home, 'kite-session.sqlite')) !== undefined;
    }, 'durable queued followup before slot release');
    const databasePath = join(home!, 'kite-session.sqlite');
    seed.kill('SIGKILL');
    await seed.exited;
    const pending = acceptedQueued(databasePath);
    if (!pending) throw new Error('Queued backup was not durable at the crash boundary.');
    expect(pending.initialAttempts).toBe(1);
    // The reused production-entry capacity fixture has the default 30-second
    // session lease. Its killed owner must expire before a new host may recover.
    await Bun.sleep(30_500);
    process.env.KITE_CODE_HOME = home!;
    storage = await createKiteSessionAppServerStorageComposition({
      databasePath,
      hostInstanceId: 'queued-capacity-sigkill-recovered',
      executionLeaseMs: 1_000,
      renewIntervalMs: 200,
    });
    const workspace = join(home!, 'workspace');
    const admission: RuntimeServerAdmissionPort = Object.freeze({
      authorize: async () => ({ allowed: true as const, workspace }),
    });
    server = createKiteMultiWorkspaceRuntimeServer({
      checkpointPath: databasePath,
      storageOwner: storage,
      workspaces: [
        {
          userId: 'capacity-user',
          workspace,
          config: {
            providerName: 'capacity-model',
            providerType: 'openai-compatible' as const,
            apiKey: 'fixture-key',
            baseURL: model.baseURL,
            modelName: 'mock-model',
            modelKwargs: { maxOutputTokens: 64 },
            modelCapabilities: { contextWindowTokens: 32_768, maxOutputTokens: 64 },
            features: { resourceBudget: true, toolSearch: false },
            sandbox: { enabled: true },
          },
          shellExecutor: async ({ command }: { command: string }) => ({
            ok: true as const,
            command,
            exitCode: 0,
            stdout: '',
            stderr: '',
          }),
          interactionMode: 'accept_edits' as const,
          sandboxBackend: 'seatbelt' as const,
          skillOptions: {
            userKiteCodeSkillsDir: join(workspace, 'user-kite-skills'),
            userAgentsSkillsDir: join(workspace, 'user-agent-skills'),
            projectKiteCodeSkillsDir: join(workspace, '.kite-code', 'skills'),
            projectAgentsSkillsDir: join(workspace, '.agents', 'skills'),
          },
          initialSkillActivations: [],
        },
      ],
    });
    const currentServer = server;
    const transport: RuntimeClientTransport = Object.freeze({
      connect: async () => {
        const pair = currentServer.open({ admission });
        return Object.freeze({
          send: (message: RuntimeProtocolMessage) => pair.client.send(message),
          messages: () => pair.client.messages(),
          close: (reason?: string) => pair.client.close(reason),
        });
      },
    });
    client = new RuntimeClient({
      transport,
      clientInfo: { name: 'queued-capacity-sigkill-test', version: '1', instanceId: 'client' },
    });
    await client.connect();
    const resumed = await client.command({
      schema: RUNTIME_COMMAND_SCHEMA_,
      type: 'resume_session',
      commandId: 'resume-queued-capacity-after-sigkill',
      sessionId: parentSessionId,
    });
    if (resumed.status !== 'applied' && (!('code' in resumed) || resumed.code !== 'runtime_busy'))
      throw new Error(`Queued source resume rejected: ${JSON.stringify(resumed)}`);
    await until(
      () =>
        recoveryDiagnostics.some(
          (value) =>
            value !== null &&
            typeof value === 'object' &&
            'followups' in value &&
            Array.isArray(value.followups) &&
            value.followups.some(
              (followup: unknown) =>
                followup !== null &&
                typeof followup === 'object' &&
                'submissionId' in followup &&
                followup.submissionId === pending.submissionId &&
                'reason' in followup &&
                followup.reason === 'followup_recovery_required',
            ),
        ),
      'explicit followup recovery-required diagnostic',
    );
    const source = storage.loadCurrentSnapshot(parentSessionId);
    expect(source?.resourceBudget).toMatchObject({
      reservations: { [pending.reservationId]: { state: 'queued' } },
    });
    const database = new Database(databasePath, { readonly: true });
    try {
      const outbox = database
        .query<{ accepted_release_source_revision: number | null }, [string]>(
          'SELECT accepted_release_source_revision FROM agent_mail_outbox WHERE submission_id=?',
        )
        .get(pending.submissionId);
      expect(outbox?.accepted_release_source_revision).toBeNull();
      const routes = database
        .query<{ count: number }, [string]>(
          'SELECT count(*) AS count FROM agent_followup_routes WHERE submission_id=?',
        )
        .get(pending.submissionId);
      expect(routes?.count).toBe(0);
    } finally {
      database.close();
    }
    const targetEvents = storage.storage.sessions
      .loadEventsStrict(pending.targetId)
      .map(({ event }) => event);
    expect(targetEvents.filter((event) => event.type === 'agent.followup_routed')).toHaveLength(0);
    expect(
      targetEvents.filter((event) => event.type === 'model.invocation_attempt_started'),
    ).toHaveLength(pending.initialAttempts);
    expect(recoveredTargetRequests).toBe(0);
    model.assertComplete({ allowUnconsumedResponses: true });
  } catch (error) {
    if (seed.exitCode === null) seed.kill('SIGKILL');
    await seed.exited;
    throw error;
  } finally {
    // Closing a recovered parent while its children require reconciliation can
    // reject cancellation; this is teardown, not the recovery assertion above.
    await client?.close().catch(() => {});
    await Promise.resolve(server?.[Symbol.asyncDispose]()).catch(() => {});
    storage?.disposeStorage();
    model.stop();
    console.error = originalConsoleError;
    if (previousHome === undefined) delete process.env.KITE_CODE_HOME;
    else process.env.KITE_CODE_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
}, 75_000);
