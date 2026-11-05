import { afterAll, beforeAll, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { createTemporaryCredentialBackend } from '@kite-ai/agent/config';
import type { AuthorizationRequest, PermissionDecision } from '@kite-ai/agent/extensions';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import {
  privateDirectory,
  removeTemporaryDirectory,
  temporaryDirectory,
} from '../../../../tests/fixtures/test-filesystem';
import { createDefaultProcessConfiguration } from '../../src/configuration';
import { initializeLivePermissionFixture } from '../fixtures/live-permission-fixture';

const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
const call = (name: string, input: object): ModelEvent[] => [
  { type: 'tool_call', id: crypto.randomUUID(), name, arguments: JSON.stringify(input) },
  { type: 'finish', reason: 'tool_calls', usage: { inputTokens: 1, outputTokens: 1 } },
];
const modes = ['accept_edits', 'auto', 'full'] as const;
// The explicit legacy POSIX factory is qualified only on macOS. Model-only
// cases exercise the real child binding and permissions on every platform.
const selectedShellTest = process.platform === 'darwin' ? test : test.skip;
let assetRoot: string;
let supervisorPath: string;
beforeAll(async () => {
  if (process.platform !== 'darwin') return;
  assetRoot = temporaryDirectory('kite-shell-model-assets-');
  const built = await Bun.build({
    entrypoints: [
      join(import.meta.dir, '../../../../packages/agent/src/platform/process/shell-supervisor.ts'),
    ],
    target: 'bun',
    outdir: assetRoot,
    naming: 'shell-supervisor.js',
  });
  expect(built.success).toBe(true);
  supervisorPath = built.outputs[0]!.path;
});
afterAll(() => {
  if (assetRoot) removeTemporaryDirectory(assetRoot);
});

async function scenario(input: {
  modelId: string;
  mode: (typeof modes)[number];
  shell: boolean;
  role: 'worker' | 'explore' | 'plan' | 'review';
}) {
  const root = temporaryDirectory('kite-shell-model-identity-');
  let runtime: ReturnType<typeof createRuntime> | undefined;
  let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
  try {
    const workspace = join(root, 'workspace');
    privateDirectory(workspace);
    const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'identity' });
    privateDirectory(profile.profilePath);
    const configPath = join(profile.profilePath, 'config.jsonc');
    writeFileSync(
      configPath,
      JSON.stringify({
        modelId: input.modelId,
        models: [
          {
            id: input.modelId,
            provider: 'compatible',
            model: 'unused-controlled-model',
            baseURL: 'http://127.0.0.1:9/v1',
          },
        ],
        tools: ['task.spawn', ...(input.shell ? ['shell.execute'] : [])].map((id) => ({ id })),
      }),
    );
    const host = createDefaultProcessConfiguration({
      profile,
      userConfigurationPath: configPath,
      localCodex: false,
      credentialBackend: createTemporaryCredentialBackend(),
      ...(input.shell
        ? {
            shell: {
              // Capture real assets and use the production legacy POSIX binding.
              // These identity cases request no Shell execution.
              platform: 'darwin' as const,
              configurationId: 'model-identity-fixture',
              env: {},
              supervisorPath,
              bunExecutable: process.execPath,
              shellExecutable: process.execPath,
            },
          }
        : {}),
    });
    store = await openSqliteStore(profile);
    const expectedStoreId = (await store.getMetadata()).storeId;
    const parent = createFixedModel([
      call('spawn_agent', {
        prompt: 'Inspect the workspace read-only.',
        ...(input.role === 'worker' ? {} : { preset: input.role }),
      }),
      [finish],
    ]);
    const child = createFixedModel([
      [{ type: 'text_delta', text: 'Inspection completed.' }, finish],
    ]);
    const decisions: { request: AuthorizationRequest; decision: PermissionDecision }[] = [];
    const capture = (permissions: NonNullable<typeof host.permissions>) => ({
      ...permissions,
      async authorize(request: AuthorizationRequest) {
        const decision = await permissions.authorize(request);
        decisions.push({ request, decision });
        return decision;
      },
    });
    runtime = createRuntime({
      ...host,
      store,
      permissions: host.permissions!,
      artifacts: createArtifactStore({ profile, store }),
      async resolveRunConfiguration(request) {
        const binding = await host.resolveRunConfiguration!(request);
        return { ...binding, model: parent, permissions: capture(binding.permissions!) };
      },
      async resolveChildRunConfiguration(request) {
        const binding = await host.resolveChildRunConfiguration!(request);
        return { ...binding, model: child, permissions: capture(binding.permissions!) };
      },
    });
    host.permissionManagement!(runtime);
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'owned workspace',
      rootUri: pathToFileURL(workspace).href,
    });
    await runtime.createSession({
      expectedStoreId,
      commandId: 'create',
      sessionId: 'root',
      subjectId: 'owner',
      workspaceId: 'w',
      title: 'Model identity',
    });
    await initializeLivePermissionFixture({
      runtime,
      profile,
      expectedStoreId,
      sessionId: 'root',
      subjectId: 'owner',
      workspaceId: 'w',
      mode: input.mode,
      trusted: true,
      nativeShellRead: input.shell,
    });
    await runtime.submitCommand({
      expectedStoreId,
      commandId: 'work',
      sessionId: 'root',
      subjectId: 'owner',
      request: { kind: 'run.start', content: 'Inspect with a child and report.' },
    });
    await runtime.waitForCommand('work');
    expect(parent.requests).toHaveLength(2);
    const deadline = Date.now() + 5000;
    let carrier: Awaited<ReturnType<typeof store.listExecutions>>[number] | undefined;
    for (;;) {
      carrier = (await store.listExecutions('root')).find(
        (execution) => execution.definitionId === `agent/${input.role}`,
      );
      if (
        carrier?.childSessionId &&
        ['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(carrier.status)
      )
        break;
      if (Date.now() > deadline)
        throw Error(
          `shell_model_identity_child_deadline: ${JSON.stringify(
            (await store.listExecutions('root'))
              .filter((execution) => execution.kind !== 'model')
              .map(({ definitionId, status, result }) => ({ definitionId, status, result })),
          )}`,
        );
      await Bun.sleep(5);
    }
    expect(child.requests).toHaveLength(1);
    expect(carrier.status).toBe('succeeded');
    const childExecutions = await store.listExecutions(carrier.childSessionId!);
    const rootExecutions = await store.listExecutions('root');
    for (const executions of [rootExecutions, childExecutions]) {
      const models = executions.filter((execution) => execution.kind === 'model');
      expect(models.length).toBeGreaterThan(0);
      expect(models.every((execution) => execution.definitionId === input.modelId)).toBe(true);
      expect(models.every((execution) => execution.status === 'succeeded')).toBe(true);
    }
    expect(
      decisions
        .filter(({ request }) => request.kind === 'model')
        .every(({ decision }) => decision.allowed),
    ).toBe(true);
    expect(childExecutions.some((execution) => execution.kind !== 'model')).toBe(false);
    expect(
      (await store.listInteractions({ expectedStoreId, sessionId: 'root', state: 'pending' }))
        .interactions,
    ).toHaveLength(0);
    expect(
      (
        await store.listInteractions({
          expectedStoreId,
          sessionId: carrier.childSessionId!,
          state: 'pending',
        })
      ).interactions,
    ).toHaveLength(0);
  } finally {
    if (runtime) await runtime.close();
    else await store?.close();
    removeTemporaryDirectory(root);
  }
}

for (const mode of modes) {
  for (const [modelId, role] of [
    ['shell.execute', 'explore'],
    ['shell.launch', 'plan'],
    ['shell.command', 'review'],
  ] as const) {
    for (const shell of [false, true])
      (shell ? selectedShellTest : test)(
        `${mode}: Model ${modelId} works at root and in ${role}, Shell ${shell ? 'selected' : 'absent'}`,
        () => scenario({ modelId, role, mode, shell }),
        15000,
      );
  }
  for (const shell of [false, true])
    (shell ? selectedShellTest : test)(
      `${mode}: a same-name Model also works in the ordinary worker control, Shell ${shell ? 'selected' : 'absent'}`,
      () => scenario({ modelId: 'shell.execute', role: 'worker', mode, shell }),
      15000,
    );
}
