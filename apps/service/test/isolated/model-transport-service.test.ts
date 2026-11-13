import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleepTimer } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { RunRecord } from '@kite-ai/agent/storage';
import { privateDirectory } from '@kite-ai/agent/windows-path-security';
import { expect, mock, test } from '#kite-test';
import { serve as fixtureServe } from '../../../../scripts/tooling/http';
import { temporaryDirectory } from '../../../../tests/fixtures/test-filesystem';
import { userConfigurationPath } from '../../src/user-configuration-path';
import { encodeFrames, responseFrames } from '../fixtures/responses-wire';

// Keep the Service import isolated so its ESM dependency first loads after the proxy mock.
test('default Service model binding uses system proxy without proxy environment or project network configuration', async () => {
  const proxyVariables = [
    'http_proxy',
    'HTTP_PROXY',
    'https_proxy',
    'HTTPS_PROXY',
    'all_proxy',
    'ALL_PROXY',
    'no_proxy',
    'NO_PROXY',
  ];
  const previousProxyEnvironment = new Map(proxyVariables.map((key) => [key, process.env[key]]));
  for (const key of proxyVariables) delete process.env[key];
  try {
    const actual = await import('../../src/web-fetch-proxy');
    const requests: string[] = [];
    const proxy = await fixtureServe({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        requests.push(request.url);
        await request.json();
        return new Response(
          encodeFrames(
            responseFrames({ id: 'service-proxy', model: 'fixture', text: ['service proxy ok'] }),
          ),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
    });
    let selectedProxy = proxy.url.origin;
    const mockProxy = mock.module('../../src/web-fetch-proxy', () => ({
      ...actual,
      systemWebProxy: async () => ({ http: selectedProxy }),
    }));
    const root = temporaryDirectory('kite-model-system-proxy-');
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'test' });
    privateDirectory(profile.profilePath);
    privateDirectory(join(root, '.kite-code'));
    const file = userConfigurationPath(root);
    writeFileSync(
      file,
      JSON.stringify({
        modelId: 'fixture',
        models: [
          {
            id: 'fixture',
            provider: 'compatible',
            protocol: 'responses',
            model: 'fixture',
            baseURL: 'http://unresolvable-service-model.invalid/v1',
          },
        ],
        tools: [],
      }),
    );
    const { createDefaultProcessConfiguration } = await import('../../src/configuration');
    const host = createDefaultProcessConfiguration({
      profile,
      userConfigurationPath: file,
      permissions: { authorize: async () => ({ allowed: true, revision: 'fixture' }) },
    });
    const store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
    const runtime = createRuntime({
      ...host,
      store,
      artifacts: createArtifactStore({ profile, store }),
      permissions: host.permissions!,
    });
    host.permissionManagement!(runtime);
    try {
      const expectedStoreId = (await store.getMetadata()).storeId;
      const base = { expectedStoreId, sessionId: 's', subjectId: 'fixture' };
      await runtime.createWorkspace({
        expectedStoreId,
        id: 'w',
        rootUri: pathToFileURL(workspace).href,
        name: 'fixture',
      });
      await runtime.createSession({
        ...base,
        commandId: 'create',
        workspaceId: 'w',
        title: 'fixture',
      });
      await runtime.submitCommand({
        ...base,
        commandId: 'proxy-run',
        request: { kind: 'run.start', content: 'hello' },
      });
      const deadline = Date.now() + 7000;
      let completed: RunRecord | undefined;
      do {
        const next = await runtime.getView('s');
        completed = next.runs.find((run) => run.originCommandId === 'proxy-run');
        if (completed && !completed.isActive) break;
        await sleepTimer(5);
      } while (Date.now() < deadline);
      expect(completed?.status).toBe('completed');
      expect(requests).toEqual(['http://unresolvable-service-model.invalid/v1/responses']);
      expect(completed?.configuration).toMatchObject({
        snapshot: { modelTransport: { digest: expect.stringMatching(/^[a-f0-9]{64}$/) } },
      });
      const recovery = {
        command: (await store.getCommand('proxy-run'))!,
        run: (await store.getRun(completed!.id))!,
        session: (await store.getSession('s'))!,
        workspace: (await store.getWorkspace('w'))!,
        signal: new AbortController().signal,
      };
      const reopened = await host.resolveRecoveryRunConfiguration!(recovery);
      await reopened.dispose?.();
      const originalConfiguration = JSON.parse(JSON.stringify(recovery.run.configuration));
      expect(originalConfiguration.snapshot.browser).toBeNull();
      const legacyConfiguration = structuredClone(originalConfiguration);
      delete legacyConfiguration.snapshot.browser;
      const legacyReopened = await host.resolveRecoveryRunConfiguration!({
        ...recovery,
        run: { ...recovery.run, configuration: legacyConfiguration },
      });
      expect(legacyReopened.snapshot).not.toHaveProperty('browser');
      const { authorizationCheck: _check, ...legacySnapshot } = legacyConfiguration.snapshot;
      expect(legacyReopened.snapshot).toEqual(legacySnapshot);
      await legacyReopened.dispose?.();
      expect(reopened.snapshot).toHaveProperty('browser', null);
      selectedProxy = 'http://127.0.0.1:1';
      await expect(host.resolveRecoveryRunConfiguration!(recovery)).rejects.toMatchObject({
        code: 'recovery_configuration_changed',
      });
      expect(requests).toHaveLength(1);
    } finally {
      await runtime.close();
      await proxy.stop(true);
      rmSync(root, { recursive: true, force: true });
      mockProxy.restore();
    }
  } finally {
    for (const [key, value] of previousProxyEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}, 15000);
