import { expect, spyOn, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { createTemporaryCredentialBackend } from '@kite-ai/agent/config';
import type { Json } from '@kite-ai/agent/extensions';
import * as mcp from '@kite-ai/agent/mcp';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { createClient } from '@kite-ai/client';
import {
  privateDirectory,
  removeTemporaryDirectory,
  temporaryDirectory,
} from '../../../../tests/fixtures/test-filesystem';
import { startService } from '../../src';
import { createWorkspaceAssembly } from '../../src/assembly';
import { createDefaultProcessConfiguration } from '../../src/configuration';
import { initializeLivePermissionFixture } from '../fixtures/live-permission-fixture';

const object = (value: Json | undefined) => value as Record<string, Json>;
const finish: Extract<ModelEvent, { type: 'finish' }> = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
const call = (name: string, input: object): ModelEvent[] => [
  { type: 'tool_call', id: crypto.randomUUID(), name, arguments: JSON.stringify(input) },
  { ...finish, reason: 'tool_calls' },
];

function fixture() {
  const root = temporaryDirectory('kite-child-skill-capabilities-');
  const workspace = join(root, 'workspace');
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'test' });
  privateDirectory(workspace);
  privateDirectory(profile.profilePath);
  return { root, workspace, profile };
}

test('automatic inherited skills intersect the actual child capabilities without widening the parent fence', async () => {
  const f = fixture();
  const base = {
    workspaceRoot: f.workspace,
    profile: f.profile,
    toolIds: ['skills.load', 'skills.resource'],
    knownToolIds: ['browser.execute'],
    allowedCapabilities: [],
  };
  try {
    const child = await createWorkspaceAssembly({ ...base, inheritedSkillIds: ['computer-use'] });
    try {
      expect(child.snapshotFacts.skills).toEqual([]);
      expect(child.snapshotFacts.tools.some((tool) => tool.id === 'browser.execute')).toBe(false);
    } finally {
      await child.dispose();
    }
    const empty = await createWorkspaceAssembly({
      ...base,
      toolIds: [...base.toolIds, 'browser.execute'],
      allowedCapabilities: ['browser.execute'],
      inheritedSkillIds: [],
    });
    try {
      expect(empty.snapshotFacts.skills).toEqual([]);
    } finally {
      await empty.dispose();
    }
  } finally {
    removeTemporaryDirectory(f.root);
  }
});

test('explicit inherited requirements and unknown inherited IDs still fail before preparing a child', async () => {
  const f = fixture();
  const base = {
    workspaceRoot: f.workspace,
    profile: f.profile,
    toolIds: ['skills.load', 'skills.resource'],
    inheritedSkillIds: ['computer-use'],
  };
  try {
    await expect(
      createWorkspaceAssembly({ ...base, selectedSkills: ['computer-use'] }),
    ).rejects.toMatchObject({ code: 'skill_capability_missing' });
    await expect(
      createWorkspaceAssembly({ ...base, inheritedSkillIds: ['not-a-selected-skill'] }),
    ).rejects.toMatchObject({ code: 'skill_not_discovered' });
  } finally {
    removeTemporaryDirectory(f.root);
  }
});

// Real default Browser registrations and packaged dependencies are available on macOS.
// The endpoint is owned and inert: this scenario must not launch or control a browser.
async function defaultScenario(selectedSkills?: string[], childBrowserAvailable = true) {
  const f = fixture();
  writeFileSync(join(f.workspace, 'source.txt'), 'unchanged fixture source\n');
  const configPath = join(f.profile.profilePath, 'config.jsonc');
  writeFileSync(
    configPath,
    JSON.stringify({
      modelId: 'fixture',
      models: [
        {
          id: 'fixture',
          provider: 'compatible',
          model: 'unused',
          baseURL: 'http://127.0.0.1:9/v1',
        },
      ],
    }),
  );
  let browserRequests = 0;
  const endpoint = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch() {
      browserRequests++;
      return new Response('No browser operation belongs to this test.', { status: 500 });
    },
  });
  // The source-only resolver deliberately rejects .ts callers. Resolve the actual
  // packaged guardian, without replacing a capability, controller or permission.
  const packagedMcpPath = join(import.meta.dir, '../../../../packages/agent/dist/mcp/index.js');
  const packagedMcp = (await import(packagedMcpPath)) as typeof mcp;
  const guardianAsset = spyOn(mcp, 'mcpStdioGuardianAsset').mockImplementation(
    packagedMcp.mcpStdioGuardianAsset,
  );
  const hostOptions = {
    profile: f.profile,
    userConfigurationPath: configPath,
    ordinaryHostTools: true as const,
    localCodex: false as const,
    credentialBackend: createTemporaryCredentialBackend(),
    desktopBrowser: { endpoint: new URL('/kite-page', endpoint.url).href, token: 'a'.repeat(72) },
  };
  const host = createDefaultProcessConfiguration(hostOptions);
  const childHost = childBrowserAvailable
    ? host
    : createDefaultProcessConfiguration({ ...hostOptions, browser: false });
  const roles = !childBrowserAvailable
    ? ['general']
    : selectedSkills === undefined
      ? ['explore', 'general']
      : ['explore'];
  const parents = new Map(
    roles.map((role) => [
      role,
      createFixedModel([
        call('spawn_agent', {
          prompt: 'Read source.txt and report it without modifying anything.',
          ...(role === 'general' ? {} : { preset: role }),
        }),
        [finish],
        [finish],
      ]),
    ]),
  );
  const children = new Map(
    roles.map((role) => [
      role,
      createFixedModel([call('read_file', { path: 'source.txt' }), [finish]]),
    ]),
  );
  const preparationFailures: unknown[] = [];
  const store = await openSqliteStore(f.profile);
  let runtime: ReturnType<typeof createRuntime> | undefined;
  let service: Awaited<ReturnType<typeof startService>> | undefined;
  let client: ReturnType<typeof createClient> | undefined;
  try {
    const storeId = (await store.getMetadata()).storeId;
    runtime = createRuntime({
      ...host,
      store,
      permissions: host.permissions!,
      artifacts: createArtifactStore({ profile: f.profile, store }),
      async resolveRunConfiguration(input) {
        const binding = await host.resolveRunConfiguration!(input);
        return {
          ...binding,
          model: parents.get(input.session.id)!,
        };
      },
      async resolveChildRunConfiguration(input) {
        try {
          const binding = await childHost.resolveChildRunConfiguration!(input);
          return {
            ...binding,
            model: children.get(input.configurationId)!,
          };
        } catch (error) {
          preparationFailures.push(error);
          throw error;
        }
      },
    });
    if (childHost !== host) childHost.permissionManagement!(runtime);
    service = await startService({
      runtime,
      permissionManagement: host.permissionManagement!(runtime),
      subjectId: 'owner',
      buildId: 'child-skill-capabilities',
      profile: {
        dataRoot: f.profile.dataRoot,
        name: f.profile.profile,
        accessKey: f.profile.profileAccessKey,
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
    await client.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      name: 'fixture',
      rootUri: pathToFileURL(f.workspace).href,
    });
    for (const role of roles) {
      await client.createSession({
        expectedStoreId: storeId,
        sessionId: role,
        workspaceId: 'w',
        commandId: `create-${role}`,
        title: role,
      });
      await initializeLivePermissionFixture({
        runtime,
        profile: f.profile,
        expectedStoreId: storeId,
        subjectId: 'owner',
        sessionId: role,
        workspaceId: 'w',
        mode: 'full',
        trusted: true,
      });
      await client.startRun(role, {
        expectedStoreId: storeId,
        commandId: `work-${role}`,
        kind: 'run.start',
        content: 'Delegate the source read.',
        ...(selectedSkills === undefined ? {} : { selectedSkills }),
      });
      await runtime.waitForCommand(`work-${role}`, { timeoutMs: 5000 });
      const command = (await store.getCommand(`work-${role}`))!;
      const parentRun = (await store.getRun((command.receipt as { runId: string }).runId))!;
      const parentSnapshot = object(object(parentRun.configuration).snapshot);
      expect(parentSnapshot.skillSelection).toEqual({
        requested: selectedSkills ?? null,
        resolvedIds: selectedSkills?.length === 0 ? [] : ['computer-use'],
      });
      const parentFacts = object(parentSnapshot.actualCapabilities);
      expect(
        (parentFacts.tools as { id: string }[]).some((tool) => tool.id === 'browser.execute'),
      ).toBe(true);
      expect(parents.get(role)!.requests.length).toBeGreaterThanOrEqual(2);
      expect(
        (await store.listExecutions(role)).filter(
          (execution) => execution.definitionId === 'task.spawn',
        ),
      ).toHaveLength(1);
      if (selectedSkills?.length || !childBrowserAvailable) {
        expect(preparationFailures).toHaveLength(1);
        expect(preparationFailures[0]).toMatchObject({
          code: childBrowserAvailable ? 'skill_capability_missing' : 'child_tool_unavailable',
        });
        expect(children.get(role)!.requests).toHaveLength(0);
        expect(
          (await store.listExecutions(role)).filter(
            (execution) => execution.childSessionId !== null,
          ),
        ).toEqual([]);
        continue;
      }
      const deadline = Date.now() + 5000;
      let carrier: Awaited<ReturnType<typeof store.listExecutions>>[number] | undefined;
      for (;;) {
        carrier = (await store.listExecutions(role)).find(
          (execution) =>
            execution.definitionId === `agent/${role}` && execution.status === 'succeeded',
        );
        if (carrier?.childSessionId) break;
        if (Date.now() > deadline) {
          const executions = await store.listExecutions(role);
          const child = executions.find((execution) => execution.childSessionId !== null);
          throw Error(
            `child_skill_deadline:${role}:${JSON.stringify({
              parent: executions.map(({ definitionId, status, result }) => ({
                definitionId,
                status,
                result,
              })),
              child: child?.childSessionId
                ? (await store.listExecutions(child.childSessionId)).map(
                    ({ definitionId, status }) => ({ definitionId, status }),
                  )
                : [],
            })}`,
          );
        }
        await Bun.sleep(5);
      }
      expect(children.get(role)!.requests).toHaveLength(2);
      const childExecutions = await store.listExecutions(carrier.childSessionId!);
      expect(
        childExecutions.filter(
          (execution) =>
            execution.definitionId === 'files.read' && execution.status === 'succeeded',
        ),
      ).toHaveLength(1);
      const childRun = (await store.getRun(
        childExecutions.find((execution) => execution.kind === 'model')!.runId!,
      ))!;
      const childSnapshot = object(object(childRun.configuration).snapshot);
      const binding = object(childSnapshot.configuration);
      const readonly = role === 'explore';
      for (const tool of object(binding.actualCapabilities).tools as Json[])
        expect(parentFacts.tools as Json[]).toContainEqual(tool);
      expect(childSnapshot.skillSelection).toEqual({
        requested: selectedSkills ?? null,
        resolvedIds: readonly || selectedSkills?.length === 0 ? [] : ['computer-use'],
      });
      expect(
        (object(binding.actualCapabilities).tools as { id: string }[]).some(
          (tool) => tool.id === 'browser.execute',
        ),
      ).toBe(!readonly);
      expect(object(binding.actualCapabilities).skills).toEqual(
        readonly || selectedSkills?.length === 0 ? [] : parentFacts.skills,
      );
      for (const request of children.get(role)!.requests)
        expect(
          request.tools.filter((tool) => tool.id.startsWith('browser_')).map((tool) => tool.id),
        ).toEqual(readonly ? [] : ['browser_execute']);
    }
    expect(browserRequests).toBe(0);
    expect(await Bun.file(join(f.workspace, 'source.txt')).text()).toBe(
      'unchanged fixture source\n',
    );
  } finally {
    client?.disposeNetwork();
    if (service) await service.close();
    else if (runtime) await runtime.close();
    else await store.close();
    await endpoint.stop(true);
    guardianAsset.mockRestore();
    removeTemporaryDirectory(f.root);
  }
}

test.skipIf(process.platform !== 'darwin')(
  'default browser-capable parent starts explore without inherited browser skill; general retains it',
  () => defaultScenario(),
  20000,
);
test.skipIf(process.platform !== 'darwin')(
  'an explicit browser skill requirement still rejects a read-only child before it starts',
  () => defaultScenario(['computer-use']),
  20000,
);
test.skipIf(process.platform !== 'darwin')(
  'an explicit empty parent skill selection remains empty in the real child',
  () => defaultScenario([]),
  20000,
);
test.skipIf(process.platform !== 'darwin')(
  'a browser-capable parent cannot bypass the current child host browser ceiling',
  () => defaultScenario(undefined, false),
  20000,
);
