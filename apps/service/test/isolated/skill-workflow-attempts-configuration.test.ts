import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import type { Json } from '@kite-ai/agent/extensions';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createDefaultProcessConfiguration } from '../../src/configuration';

async function until<T>(read: () => Promise<T>, predicate: (value: T) => boolean) {
  const end = Date.now() + 5000;
  for (;;) {
    const value = await read();
    if (predicate(value)) return value;
    if (Date.now() > end) throw Error('workflow_attempts_fixture_deadline');
    await Bun.sleep(5);
  }
}
test('default Service seals trusted Workflow decision policy and rejects cold policy drift before vault or Model', async () => {
  const root = realpathSync(mkdtempSync('/private/tmp/kite-workflow-attempts-service-'));
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'owned' });
  mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
  const skill = join(root, 'skill');
  mkdirSync(skill);
  const manifest = {
    name: 'fixture',
    version: '1.0.0',
    description: 'fixture',
    invocation: { allow_manual: true, allow_implicit: false },
    context: { mode: 'inline', agent: 'code' },
    input_schema: { type: 'object', additionalProperties: false },
    output_schema: { type: 'object', additionalProperties: false },
    capabilities: { require: [], deny: [] },
    effects: { filesystem: 'none', network: 'none', external_state: 'none' },
    approval: { minimum: 'none' },
    execution: { timeout_ms: 5000, max_attempts: 1 },
    verification: { mode: 'required' },
    recovery: { retry: 'never' },
  };
  writeFileSync(
    join(skill, 'SKILL.md'),
    `---\n${JSON.stringify(manifest)}\n---\nOriginal immutable workflow instructions\n`,
  );
  writeFileSync(
    join(profile.profilePath, 'skill-workflow.jsonc'),
    JSON.stringify({
      version: 1,
      features: { skillActivation: true, skillWorkflow: true, verification: true },
    }),
  );
  let models = 0,
    vault = 0;
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch() {
      models++;
      const delta =
        models === 1
          ? {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'complete',
                  type: 'function',
                  function: {
                    name: 'complete_skill',
                    arguments: JSON.stringify({
                      activation_id: 'original',
                      output: {},
                    }),
                  },
                },
              ],
            }
          : { role: 'assistant', content: 'Complete' };
      return new Response(
        `data: ${JSON.stringify({ id: 'fixed', object: 'chat.completion.chunk', created: 0, model: 'fixed', choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'fixed', object: 'chat.completion.chunk', created: 0, model: 'fixed', choices: [{ index: 0, delta: {}, finish_reason: models === 1 ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  writeFileSync(
    join(profile.profilePath, 'config.jsonc'),
    JSON.stringify({
      modelId: 'fixed',
      models: [
        {
          id: 'fixed',
          provider: 'compatible',
          model: 'fixed',
          baseURL: `${provider.url.href}v1`,
          credentialRef: 'credential:11111111-1111-4111-8111-111111111111',
        },
      ],
      tools: [],
      skills: [{ id: 'configured', path: 'skill' }],
    }),
  );
  const backend = {
    kind: 'temporary' as const,
    async put() {},
    async remove() {},
    async resolve() {
      vault++;
      return 'fixed-nonsecret';
    },
  };
  const permissions = {
    async authorize() {
      return { allowed: true, revision: 'trusted-fixture' };
    },
  };
  const userDecisions = { version: '1' as const, allowWaiver: true, allowReplan: true };
  const host = createDefaultProcessConfiguration({
    profile,
    credentialBackend: backend,
    permissions,
    skillWorkflow: { userDecisions },
  });
  // Later mutation of the trusted caller's object cannot replace the admitted policy.
  userDecisions.allowWaiver = false;
  userDecisions.allowReplan = false;
  const store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
  const runtime = createRuntime({
    store,
    artifacts: createArtifactStore({ profile, store }),
    permissions: host.permissions!,
    extensions: host.extensions,
    resolveRunConfiguration: host.resolveRunConfiguration,
    supportsExtensionInputs: true,
  });
  host.permissionManagement?.(runtime);
  const expectedStoreId = (await runtime.getMetadata()).storeId;
  const base = { expectedStoreId, subjectId: 'owner', sessionId: 's' };
  try {
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'fixture',
      rootUri: `file://${root}`,
    });
    await runtime.createSession({
      ...base,
      commandId: 'create',
      workspaceId: 'w',
      title: 'fixture',
    });
    await runtime.submitCommand({
      ...base,
      commandId: 'original',
      request: {
        kind: 'run.start',
        content: 'explicit',
        extensionInputs: [
          {
            extensionId: 'builtin.skill-workflow',
            definitionVersion: '1',
            input: { activations: [{ key: 'original', skillId: 'skill:fixture', input: {} }] },
          },
        ],
      },
    });
    const originalCommand = await runtime.waitForCommand('original', { timeoutMs: 5000 });
    if (originalCommand.status === 'rejected')
      throw Error(`workflow_original_rejected:${JSON.stringify(originalCommand.receipt)}`);
    expect(originalCommand.status).toBe('applied');
    const view = await until(
      () => store.getView('s'),
      (view) => view.runs.some((run) => run.originCommandId === 'original' && !run.isActive),
    );
    const run = view.runs.find((run) => run.originCommandId === 'original')!;
    expect(run.status).toBe('completed');
    expect(models).toBe(2);
    expect(vault).toBe(1);
    const config = run.configuration as { snapshot: { skillWorkflow: { userDecisions: Json } } };
    expect(config.snapshot.skillWorkflow.userDecisions).toEqual({
      version: '1',
      allowWaiver: true,
      allowReplan: true,
    });
    const changed = createDefaultProcessConfiguration({
      profile,
      credentialBackend: backend,
      permissions,
      skillWorkflow: { userDecisions: { version: '1', allowWaiver: false, allowReplan: true } },
    });
    await expect(
      changed.resolveRecoveryRunConfiguration!({
        command: (await store.getCommand('original'))!,
        run,
        session: (await store.getSession('s'))!,
        workspace: (await store.getWorkspace('w'))!,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('recovery_configuration_changed');
    expect(vault).toBe(1);
    expect(models).toBe(2);
    const original = await host.resolveRecoveryRunConfiguration!({
      command: (await store.getCommand('original'))!,
      run,
      session: (await store.getSession('s'))!,
      workspace: (await store.getWorkspace('w'))!,
      signal: new AbortController().signal,
    });
    try {
      expect(
        (original.snapshot as { skillWorkflow: { userDecisions: Json } }).skillWorkflow
          .userDecisions,
      ).toEqual(config.snapshot.skillWorkflow.userDecisions);
      expect(vault).toBe(2);
      expect(models).toBe(2);
    } finally {
      await original.dispose?.();
    }
  } finally {
    await runtime.close();
    provider.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});
