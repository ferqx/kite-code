import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleepTimer } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { createPermissionPolicy } from '@kite-ai/agent/permissions';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { readSessionLogs } from '@kite-ai/agent/storage';
import { createFixedModel, type ModelAdapter, type ModelEvent } from '@kite-ai/ai';
import { createClient } from '@kite-ai/client';
import { createBrowserClient } from '@kite-ai/client/browser';
import { expect, test } from '#kite-test';
import { startDevelopmentWeb } from '../../src/development-web';
import { startService } from '../../src/index';

const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
for (const scenario of ['reused_approval', 'timeout_continue'] as const)
  test(`actual ${scenario} policy observation survives Store, HTTP, Native and Cookie Browser`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-policy-http-')));
    const profile = { dataRoot: root, profile: 'owned' };
    const store = await openSqliteStore(profile);
    const expectedStoreId = (await store.getMetadata()).storeId;
    let effects = 0;
    const model = createFixedModel([
      ...['first', 'second'].map((id) => [
        { type: 'tool_call', id, name: 'fixture.effect', arguments: '{}' } as ModelEvent,
        { ...finish, reason: 'tool_calls' } as ModelEvent,
      ]),
      [finish],
    ]);
    const reviewer: ModelAdapter = {
      async *stream() {
        if (scenario === 'timeout_continue') await sleepTimer(150);
        yield {
          type: 'text_delta',
          text: JSON.stringify({
            decision: 'approve_once',
            reason: 'Exact harmless fixture operation.',
          }),
        };
        yield finish;
      },
    };
    const runtime = createRuntime({
      store,
      artifacts: createArtifactStore({ profile, store }),
      model,
      modelId: 'fixed',
      authorizationCheck: {
        id: 'checker',
        version: '1',
        modelId: 'reviewer',
        model: reviewer,
        timeoutMs: scenario === 'timeout_continue' ? 40 : 1000,
      },
      permissions: createPermissionPolicy({
        readPolicy: () => ({
          mode: 'auto',
          workspaceTrust: true,
          revision: 'stable',
          allowed: [
            { kind: 'model', definitionId: 'fixed', definitionVersion: '1' },
            { kind: 'tool', definitionId: 'fixture.effect', definitionVersion: '1' },
          ],
        }),
        describeCapability: (request) => ({
          kind: request.kind,
          definitionId: request.definitionId,
          definitionVersion: request.definitionVersion,
          revision: 'fixture',
          hardAllowed: true,
          safeRead: false,
          effects: request.kind === 'model' ? [] : ['workspace_write'],
          autoTimeoutScope: 'governed',
        }),
      }),
      extensions: [
        {
          id: 'fixture',
          version: '1',
          apiMajor: 1,
          tools: [
            {
              id: 'fixture.effect',
              version: '1',
              description: 'Local observed effect',
              inputSchema: { type: 'object' },
              async execute() {
                effects++;
                return { outcome: 'succeeded', content: 'Observed effect.' };
              },
            },
          ],
        },
      ],
    });
    const service = await startService({
      runtime,
      profile: { dataRoot: root, name: 'owned', accessKey: 'owned' },
      buildId: 'policy-observation',
      subjectId: 'owner',
      sessionLogs: (query, observer) => readSessionLogs(store, query, observer),
    });
    const client = createClient({
      endpoint: service.endpoint,
      token: service.bootstrap.token,
      bootstrap: service.bootstrap,
      expected: {
        profile: service.bootstrap.profile,
        apiMajor: 1,
        requiredCapabilities: ['session_logs'],
      },
    });
    await client.connect();
    const gateway = await startDevelopmentWeb({ admittedClient: client });
    const document = await fetch(gateway.endpoint);
    await document.body?.cancel();
    const cookie = document.headers.get('set-cookie')!.split(';')[0]!;
    const browser = createBrowserClient({
      origin: gateway.endpoint,
      pageIdentity: gateway.pageIdentity,
      fetch: Object.assign(
        async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
          const headers = new Headers(init?.headers);
          headers.set('cookie', cookie);
          headers.set('origin', gateway.endpoint);
          return fetch(url, { ...init, headers });
        },
        {},
      ),
    });
    try {
      await browser.connect();
      await runtime.createWorkspace({
        expectedStoreId,
        id: 'w',
        name: 'fixture',
        rootUri: pathToFileURL(root).href,
      });
      await runtime.createSession({
        expectedStoreId,
        commandId: 'create',
        sessionId: 's',
        workspaceId: 'w',
        subjectId: 'owner',
        title: 'fixture',
      });
      await runtime.submitCommand({
        expectedStoreId,
        commandId: 'work',
        sessionId: 's',
        subjectId: 'owner',
        request: { kind: 'run.start', content: 'Perform the governed local operation twice.' },
      });
      await runtime.waitForCommand('work');
      expect(effects).toBe(2);
      const actual = (await store.listExecutions('s')).find(
        (e) => e.authorization?.policy?.reason === scenario,
      )!;
      expect(actual).toBeDefined();
      const metadata = await store.getMetadata();
      const native = await client.getExecution(actual.id);
      expect(native?.authorization?.policy).toEqual(actual.authorization!.policy);
      expect(
        (await client.getView('s')).executions.find((e) => e.id === actual.id)!.authorization
          ?.policy,
      ).toEqual(actual.authorization!.policy);
      expect(
        (await browser.getView('s')).executions.find((e) => e.id === actual.id)!.authorization
          ?.policy,
      ).toEqual(actual.authorization!.policy);
      const logs = await client.listSessionLogs('s', { afterCursor: '0' });
      expect(
        await browser.listSessionLogs('s', { afterCursor: '0', upperCursor: logs.upperCursor }),
      ).toEqual(logs);
      const event = logs.entries.find(
        (e) => e.type === 'authorization.policy' && e.objectId === actual.id,
      )!;
      expect(event).toMatchObject({
        category: 'execution',
        recordedStatus: 'planned',
        modelExecutionId: null,
        details: {
          executionId: actual.id,
          policy: {
            targetExecutionId: actual.id,
            reason: scenario,
            policyEvidenceId: actual.authorization!.policy!.evidenceId,
            source: { kind: 'check', id: actual.authorization!.policy!.checkExecutionId },
            requestedScope: null,
            effectiveScope: null,
          },
        },
      });
      expect(await store.getMetadata()).toEqual(metadata);
      expect(JSON.stringify(event)).not.toContain('Exact harmless fixture operation.');
    } finally {
      browser.disposeNetwork();
      gateway.close();
      client.disposeNetwork();
      await service.close();
      await runtime.close();
      await store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
