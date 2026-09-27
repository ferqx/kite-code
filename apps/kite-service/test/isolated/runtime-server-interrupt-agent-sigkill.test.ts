import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeClient, type RuntimeClientTransport } from '@kite-ai/runtime-client';
import { RUNTIME_COMMAND_SCHEMA_ } from '@kite-ai/runtime-contract';
import type { RuntimeProtocolMessage } from '@kite-ai/runtime-protocol';
import type { RuntimeServerAdmissionPort } from '@kite-ai/runtime-server';
import { createMockModelServer } from '../../../../tests/tui-system/harness/fixtures';
import {
  createKiteMultiWorkspaceRuntimeServer,
  createKiteSessionAppServerStorageComposition,
} from '../../src/bootstrap';

async function until(check: () => boolean, stage: string, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) await Bun.sleep(20);
  if (!check()) throw new Error(`Interrupt SIGKILL did not reach ${stage}.`);
}
function readStop(databasePath: string) {
  const db = new Database(databasePath, { readonly: true });
  try {
    const row = db
      .query<{ target_session_id: string; command_id: string; status: string }, []>(
        'SELECT target_session_id,command_id,status FROM agent_interrupt_intents LIMIT 1',
      )
      .get();
    const child = row
      ? db
          .query<{ revision: number }, [string]>(
            'SELECT revision FROM runtime_sessions WHERE session_id=?',
          )
          .get(row.target_session_id)
      : null;
    const runs = row
      ? db
          .query<{ count: number }, [string]>(
            'SELECT count(*) AS count FROM runtime_runs WHERE session_id=?',
          )
          .get(row.target_session_id)
      : null;
    return { row, childRevision: child?.revision ?? null, childRunCount: runs?.count ?? null };
  } finally {
    db.close();
  }
}

test('SIGKILL after queued interrupt receipt resumes one parent-owned stop without child dispatch', async () => {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'kite-d3-sigkill-interrupt-'));
  const workspace = join(home, 'workspace');
  mkdirSync(workspace);
  const databasePath = join(home, 'kite-session.sqlite');
  const marker = join(home, 'interrupt-receipt.marker');
  const previousHome = process.env.KITE_CODE_HOME;
  process.env.KITE_CODE_HOME = home;
  const model = createMockModelServer();
  let issued = false;
  model.setResponses(
    Array.from({ length: 8 }, () => ({
      response: async () => {
        if (!issued) {
          issued = true;
          const db = new Database(databasePath, { readonly: true });
          let childId: string;
          try {
            const row = db
              .query<{ child_thread_id: string }, []>(
                'SELECT child_thread_id FROM child_session_intents LIMIT 1',
              )
              .get();
            if (!row) throw new Error('Synthetic queued child intent is absent.');
            childId = row.child_thread_id;
          } finally {
            db.close();
          }
          return {
            message: {
              tool_calls: [
                {
                  id: 'interrupt-tool-sigkill',
                  name: 'interrupt_agent',
                  args: { agent_id: childId },
                },
              ],
            },
            toolContinuation: 'aborted' as const,
          };
        }
        return { message: { content: 'RECOVERY_PARENT_DONE' } };
      },
    })),
  );
  const crashed = Bun.spawn(
    [
      process.execPath,
      'test',
      '--test-name-pattern',
      '^interrupt queued SIGKILL seed$',
      join(import.meta.dir, 'interrupt-agent-pipeline.test.ts'),
      '--parallel=1',
      '--max-concurrency=1',
    ],
    {
      cwd: join(import.meta.dir, '../../../..'),
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        KITE_D3_SIGKILL_HOME: home,
        KITE_D3_SIGKILL_MOCK_URL: model.baseURL,
        KITE_INTERRUPT_SIGKILL_SEED: '1',
      },
    },
  );
  let storage: Awaited<ReturnType<typeof createKiteSessionAppServerStorageComposition>> | undefined;
  let server: ReturnType<typeof createKiteMultiWorkspaceRuntimeServer> | undefined;
  let client: RuntimeClient | undefined;
  try {
    await until(() => existsSync(marker), 'queued receipt').catch(async (error) => {
      if (crashed.exitCode === null) crashed.kill('SIGKILL');
      await crashed.exited;
      throw new Error(`Interrupt seed failed: ${await new Response(crashed.stderr).text()}`, {
        cause: error,
      });
    });
    const before = readStop(databasePath);
    expect(before.row?.status).toBe('pending');
    expect(before.childRevision).toBe(0);
    expect(before.childRunCount).toBe(0);
    crashed.kill('SIGKILL');
    await crashed.exited;
    await Bun.sleep(1200);
    storage = await createKiteSessionAppServerStorageComposition({
      databasePath,
      hostInstanceId: 'interrupt-sigkill-recovered',
      executionLeaseMs: 1000,
      renewIntervalMs: 200,
    });
    server = createKiteMultiWorkspaceRuntimeServer({
      checkpointPath: databasePath,
      storageOwner: storage,
      workspaces: [
        {
          userId: 'orchestrator-user',
          workspace,
          config: {
            providerName: 'fixture',
            providerType: 'openai-compatible' as const,
            apiKey: 'fixture-key',
            baseURL: model.baseURL,
            modelName: 'mock-model',
            modelKwargs: { maxOutputTokens: 64 },
            modelCapabilities: { contextWindowTokens: 4096, maxOutputTokens: 64 },
            features: { resourceBudget: true },
            sandbox: { enabled: false },
          },
          shellExecutor: async ({ command }: { command: string }) => ({
            ok: true as const,
            command,
            exitCode: 0,
            stdout: '',
            stderr: '',
          }),
          interactionMode: 'accept_edits' as const,
          sandboxBackend: 'none' as const,
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
    await server.recoverPendingAgentMail();
    const admission: RuntimeServerAdmissionPort = Object.freeze({
      authorize: async () => ({ allowed: true as const, workspace }),
    });
    const transport: RuntimeClientTransport = Object.freeze({
      connect: async () => {
        const pair = server!.open({ admission });
        return Object.freeze({
          send: (message: RuntimeProtocolMessage) => pair.client.send(message),
          messages: () => pair.client.messages(),
          close: (reason?: string) => pair.client.close(reason),
        });
      },
    });
    client = new RuntimeClient({
      transport,
      clientInfo: { name: 'interrupt-sigkill-test', version: '1', instanceId: 'client' },
    });
    await client.connect();
    const resumed = await client.command({
      schema: RUNTIME_COMMAND_SCHEMA_,
      type: 'resume_session',
      commandId: 'resume-after-interrupt-sigkill',
      sessionId: 'orchestrator-parent',
    });
    expect(resumed.status).toBe('applied');
    await until(
      () => readStop(databasePath).row?.status === 'settled',
      'settled stop receipt',
      80_000,
    );
    const after = readStop(databasePath);
    expect(after.row?.command_id).toBe(before.row?.command_id);
    expect(after.childRevision).toBe(0);
    expect(after.childRunCount).toBe(0);
    const db = new Database(databasePath, { readonly: true });
    try {
      expect(
        db
          .query<{ count: number }, [string]>(`SELECT count(*) AS count FROM runtime_events
        WHERE session_id=? AND json_extract(event_json,'$.type')='model.invocation_attempt_started'`)
          .get(before.row!.target_session_id)?.count,
      ).toBe(0);
      expect(
        db
          .query<{ count: number }, [string]>(`SELECT count(*) AS count FROM runtime_events
        WHERE session_id='orchestrator-parent' AND json_extract(event_json,'$.type')=
          'background_execution.stop_requested' AND json_extract(event_json,'$.commandId')=?`)
          .get(before.row!.command_id)?.count,
      ).toBe(1);
    } finally {
      db.close();
    }
  } finally {
    if (crashed.exitCode === null) crashed.kill('SIGKILL');
    await crashed.exited;
    await client?.close();
    await server?.[Symbol.asyncDispose]();
    storage?.disposeStorage();
    model.stop();
    if (previousHome === undefined) delete process.env.KITE_CODE_HOME;
    else process.env.KITE_CODE_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
}, 100_000);
