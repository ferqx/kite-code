import { appendFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { createTemporaryCredentialBackend } from '@kite-ai/agent/config';
import { selectProfile } from '@kite-ai/agent/profile';
import { createWorkspaceSerialLocks } from '@kite-ai/agent/resources';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { ModelAdapter, ModelEvent } from '@kite-ai/ai';
import { createClient } from '@kite-ai/client';
import { startService } from '../../src';
import { createDefaultProcessConfiguration } from '../../src/configuration';
import { initializeLivePermissionFixture } from './live-permission-fixture';

export const currentChildContent = 'one current Service child write 雪🙂\n';
const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
export async function startCurrentChildResume(directory: string) {
  const profile = selectProfile({ dataRoot: join(directory, 'data'), profile: 'test' });
  const target = join(directory, 'workspace', 'result.txt');
  const model = (actor: 'parent' | 'child'): ModelAdapter => ({
    async *stream(request) {
      appendFileSync(join(directory, 'models.ndjson'), `${JSON.stringify({ actor, request })}\n`);
      if (actor === 'child') {
        if (request.messages.some((message) => message.role === 'tool')) {
          yield { type: 'text_delta', text: 'CURRENT_CHILD_WRITE_COMPLETED' };
          yield finish;
        } else {
          yield {
            type: 'tool_call',
            id: 'current-child-write',
            name: 'write_file',
            arguments: JSON.stringify({ path: target, content: currentChildContent }),
          };
          yield { ...finish, reason: 'tool_calls' };
        }
        return;
      }
      if (!request.messages.some((message) => message.role === 'tool')) {
        yield {
          type: 'tool_call',
          id: 'current-child-spawn',
          name: 'spawn_agent',
          arguments: JSON.stringify({
            prompt: `Write ${JSON.stringify(currentChildContent)} exactly once at ${JSON.stringify(target)}, omitting base_ref, then report the result.`,
          }),
        };
        yield { ...finish, reason: 'tool_calls' };
      } else if (
        request.messages.some((message) =>
          message.content.includes('CURRENT_CHILD_WRITE_COMPLETED'),
        )
      ) {
        yield { type: 'text_delta', text: 'CURRENT_PARENT_COMPLETED' };
        yield finish;
      } else {
        const last = request.messages.filter((message) => message.role === 'tool').at(-1);
        let cursor: string | undefined;
        try {
          const body = JSON.parse(last?.content ?? '{}');
          if (typeof body.next_cursor === 'string') cursor = body.next_cursor;
        } catch {
          // A spawn receipt does not supply an event cursor.
        }
        yield {
          type: 'tool_call',
          id: crypto.randomUUID(),
          name: 'wait_agent_events',
          arguments: JSON.stringify({ wait_ms: 5000, ...(cursor ? { cursor } : {}) }),
        };
        yield { ...finish, reason: 'tool_calls' };
      }
    },
  });
  const parentModel = model('parent');
  const childModel = model('child');
  const host = createDefaultProcessConfiguration({
    profile,
    userConfigurationPath: join(profile.profilePath, 'config.jsonc'),
    localCodex: false,
    browser: false,
    credentialBackend: createTemporaryCredentialBackend(),
    permissions: {
      async authorize(request) {
        if (request.kind === 'tool' && request.definitionId === 'files.write')
          return {
            allowed: false,
            revision: 'current-child-resume-policy',
            approval: {
              request: { title: 'Approve the original child file write' },
              grants: ['approve_once'],
            },
          };
        return { allowed: true, revision: 'current-child-resume-policy' };
      },
    },
  });
  const store = await openSqliteStore(profile);
  let artifacts: ReturnType<typeof createArtifactStore> | undefined;
  let runtime: ReturnType<typeof createRuntime> | undefined;
  let locks: ReturnType<typeof createWorkspaceSerialLocks> | undefined;
  let service: Awaited<ReturnType<typeof startService>> | undefined;
  let client: ReturnType<typeof createClient> | undefined;
  try {
    locks = createWorkspaceSerialLocks(profile);
    host.bindWorkspaceSerialLocks?.(locks);
    artifacts = createArtifactStore({ profile, store });
    runtime = createRuntime({
      ...host,
      store,
      artifacts,
      permissions: host.permissions!,
      workspaceSerialLocks: locks,
      async resolveRunConfiguration(input) {
        return { ...(await host.resolveRunConfiguration!(input)), model: parentModel };
      },
      async resolveChildRunConfiguration(input) {
        return { ...(await host.resolveChildRunConfiguration!(input)), model: childModel };
      },
      async resolveRecoveryRunConfiguration(input) {
        return { ...(await host.resolveRecoveryRunConfiguration!(input)), model: parentModel };
      },
    });
    service = await startService({
      runtime,
      permissionManagement: host.permissionManagement!(runtime),
      subjectId: 'owner',
      buildId: 'current-child-resume',
      profile: {
        dataRoot: profile.dataRoot,
        name: profile.profile,
        accessKey: profile.profileAccessKey,
      },
    });
    client = createClient({
      endpoint: service.endpoint,
      token: service.bootstrap.token,
      bootstrap: service.bootstrap,
      expected: {
        profile: service.bootstrap.profile,
        apiMajor: 1,
        requiredCapabilities: ['commands', 'sessions'],
      },
    });
    await client.connect();
    const connectedService = service;
    const connectedClient = client;
    const connectedLocks = locks;
    return {
      profile,
      store,
      runtime,
      service,
      client,
      target,
      async close() {
        connectedClient.disposeNetwork();
        try {
          await connectedService.close();
        } finally {
          await connectedLocks.close();
        }
      },
    };
  } catch (error) {
    client?.disposeNetwork();
    try {
      if (service) await service.close();
      else if (runtime) await runtime.close();
      else {
        try {
          await artifacts?.close();
        } finally {
          await store.close();
        }
      }
    } finally {
      await locks?.close();
    }
    throw error;
  }
}

if (import.meta.main) {
  const [directory] = process.argv.slice(2);
  if (!directory) throw Error('An explicit disposable current child fixture root is required.');
  const fixture = await startCurrentChildResume(directory);
  const { store, runtime, client, profile } = fixture;
  const expectedStoreId = (await store.getMetadata()).storeId;
  await client.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'Owned',
    rootUri: pathToFileURL(join(directory, 'workspace')).href,
  });
  await client.createSession({
    expectedStoreId,
    commandId: 'create',
    sessionId: 's',
    workspaceId: 'w',
    title: 'Current general recovery',
  });
  await initializeLivePermissionFixture({
    runtime,
    profile,
    expectedStoreId,
    subjectId: 'owner',
    sessionId: 's',
    workspaceId: 'w',
    mode: 'accept_edits',
    trusted: true,
  });
  await client.startRun('s', {
    expectedStoreId,
    commandId: 'work',
    kind: 'run.start',
    content: `Delegate exactly one write of ${JSON.stringify(currentChildContent)} to ${JSON.stringify(fixture.target)} and report its result.`,
  });
  const deadline = Date.now() + 15000;
  for (;;) {
    const root = await runtime.getView('s');
    const carrier = root.executions.find((row) => row.definitionId === 'agent/general');
    const child = carrier?.childSessionId
      ? await runtime.getView(carrier.childSessionId)
      : undefined;
    const effect = child?.executions.find((row) => row.definitionId === 'files.write');
    const pending = await runtime.listInteractions({
      expectedStoreId,
      sessionId: 's',
      state: 'pending',
    });
    if (
      effect?.status === 'planned' &&
      pending.interactions.length === 1 &&
      root.executions.some(
        (row) => row.kind === 'model' && ['planned', 'dispatching'].includes(row.status),
      )
    ) {
      writeFileSync(
        join(directory, 'ready.tmp'),
        JSON.stringify({
          expectedStoreId,
          root,
          child,
          carrier,
          effect,
          card: pending.interactions[0],
        }),
      );
      renameSync(join(directory, 'ready.tmp'), join(directory, 'ready.json'));
      await new Promise<void>(() => {});
    }
    if (Date.now() >= deadline)
      throw Error(
        `current_service_child_boundary_missing:${JSON.stringify({ roots: root.runs.map((row) => [row.status, row.reason]), children: child?.runs.map((row) => [row.status, row.reason]), effect, cards: pending.interactions.length })}`,
      );
    await Bun.sleep(5);
  }
}
