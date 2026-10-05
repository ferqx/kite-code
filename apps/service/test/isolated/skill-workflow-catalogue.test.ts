import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { startService } from '../../src';
import { createDefaultProcessConfiguration } from '../../src/configuration';
import type { SkillCataloguePage } from '../../src/skill-catalogue';

function manifest(name: string) {
  return {
    name,
    version: '1.0.0',
    description: 'compiled workflow',
    invocation: { allow_manual: true, allow_implicit: false },
    context: { mode: 'inline', agent: 'code' },
    input_schema: { type: 'object', additionalProperties: false },
    output_schema: { type: 'object', additionalProperties: false },
    capabilities: { require: ['files.read'], deny: [] },
    effects: { filesystem: 'read', network: 'none', external_state: 'none' },
    approval: { minimum: 'user' },
    execution: { timeout_ms: 5000, max_attempts: 1 },
    verification: { mode: 'required' },
    recovery: { retry: 'never' },
  };
}
test('manual Workflow HTTP projection is same-source, independently unavailable, complete and read only', async () => {
  const root = realpathSync(mkdtempSync('/private/tmp/kite-workflow-catalogue-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'owned' });
  mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
  const skills: { id: string; path: string; enabled?: boolean }[] = [];
  const write = (id: string, value: unknown) => {
    const location = join(workspace, id);
    mkdirSync(location, { recursive: true });
    writeFileSync(
      join(location, 'SKILL.md'),
      `---\n${JSON.stringify(value)}\n---\nPRIVATE WORKFLOW BODY\n`,
    );
  };
  for (let i = 0; i < 270; i++) {
    const id = `good-${String(i).padStart(3, '0')}`;
    write(id, manifest(id));
    skills.push({ id, path: id });
  }
  write('bad', { ...manifest('bad'), output_schema: { $async: true, type: 'object' } });
  write('manual-denied', {
    ...manifest('manual-denied'),
    invocation: { allow_manual: false, allow_implicit: false },
  });
  write('input-required', {
    ...manifest('input-required'),
    input_schema: {
      type: 'object',
      required: ['value'],
      properties: { value: { type: 'string' } },
      additionalProperties: false,
    },
  });
  write('fork-missing', {
    ...manifest('fork-missing'),
    context: { mode: 'fork', agent: 'missing' },
  });
  write('dependency-missing', {
    ...manifest('dependency-missing'),
    capabilities: { require: ['files.write'], deny: [] },
  });
  write('script-missing', {
    ...manifest('script-missing'),
    verification: { mode: 'required', strategy: 'script', entrypoint: 'verify.ts' },
  });
  writeFileSync(join(workspace, 'script-missing', 'verify.ts'), 'throw Error("NEVER EXECUTE")');
  for (const id of [
    'bad',
    'manual-denied',
    'input-required',
    'fork-missing',
    'dependency-missing',
    'script-missing',
  ])
    skills.push({ id, path: id });
  skills.push({ id: 'disabled', path: '/outside/never-read', enabled: false });
  const config = {
    models: [
      {
        id: 'fixed',
        provider: 'compatible',
        baseURL: 'http://127.0.0.1:1/v1',
        model: 'fixed',
        credentialRef: 'credential:11111111-1111-1111-1111-111111111111',
      },
    ],
    modelId: 'fixed',
    tools: [{ id: 'files.read' }],
    skills,
  };
  const configPath = join(profile.profilePath, 'config.jsonc');
  writeFileSync(configPath, JSON.stringify(config));
  const flagsPath = join(profile.profilePath, 'skill-workflow.jsonc');
  const flags = { skillActivation: true, skillWorkflow: true, verification: true };
  writeFileSync(flagsPath, JSON.stringify({ version: 1, features: flags }));
  let vault = 0,
    resolvers = 0;
  const host = createDefaultProcessConfiguration({
    profile,
    credentialBackend: {
      kind: 'temporary',
      async put() {
        vault++;
      },
      async remove() {
        vault++;
      },
      async resolve() {
        vault++;
        return 'secret';
      },
    },
  });
  const store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
  const runtime = createRuntime({
    store,
    permissions: host.permissions!,
    resolveRunConfiguration: async (input) => {
      resolvers++;
      return host.resolveRunConfiguration!(input);
    },
  });
  const permissions = host.permissionManagement!(runtime);
  const storeId = (await runtime.getMetadata()).storeId;
  const identity = { expectedStoreId: storeId, subjectId: 'owner' };
  await runtime.createWorkspace({
    expectedStoreId: storeId,
    id: 'w',
    name: 'fixture',
    rootUri: `file://${workspace}`,
  });
  const trust = await permissions.readTrust({ ...identity, workspaceId: 'w' });
  await permissions.setTrust({
    ...identity,
    workspaceId: 'w',
    commandId: 'trust',
    trusted: true,
    canonicalIdentity: trust.canonicalIdentity,
    externalReadScopeDigest: trust.externalReadScopeDigest,
    ifRevision: trust.revision,
  });
  const service = await startService({
    runtime,
    skillCatalogue: host.skillCatalogue,
    permissionManagement: permissions,
    subjectId: 'owner',
    buildId: 'workflow-catalogue',
    profile: {
      dataRoot: profile.dataRoot,
      name: profile.profile,
      accessKey: profile.profileAccessKey,
    },
  });
  const get = async (query = '') => {
    const response = await fetch(
      `${service.endpoint}/v1/workspaces/w/skills?storeId=${storeId}${query}`,
      { headers: { authorization: `Bearer ${service.bootstrap.token}` } },
    );
    return { status: response.status, body: (await response.json()) as SkillCataloguePage };
  };
  try {
    const before = await runtime.getChanges({ after: '0' });
    const knowledge = await get('&limit=37');
    expect(knowledge.status).toBe(200);
    expect(knowledge.body.entries.every((row) => !('workflow' in row))).toBe(true);
    let page = await get('&workflow=manual&limit=37');
    expect(page.status).toBe(200);
    const first = page.body;
    const entries = [...first.entries];
    while (!page.body.complete) {
      page = await get(
        `&workflow=manual&limit=37&revision=${first.revision}&afterId=${page.body.nextAfterId}`,
      );
      expect(page.status).toBe(200);
      entries.push(...page.body.entries);
    }
    expect(entries).toHaveLength(277);
    expect(new Set(entries.map((row) => row.id)).size).toBe(277);
    expect(entries.find((row) => row.id === 'good-269')!.workflow).toMatchObject({
      state: 'available',
      skillId: 'skill:good-269',
      name: 'good-269',
      manualAllowed: true,
      emptyInputValid: true,
      contextMode: 'inline',
      reason: null,
    });
    for (const [id, reason] of [
      ['bad', 'workflow_contract_unavailable'],
      ['manual-denied', 'workflow_manual_not_allowed'],
      ['input-required', 'workflow_input_required'],
      ['fork-missing', 'workflow_fork_unavailable'],
      ['dependency-missing', 'workflow_dependency_unavailable'],
      ['script-missing', 'workflow_verifier_unavailable'],
    ]) {
      const row = entries.find((row) => row.id === id)!;
      expect(row.state).toBe('available');
      expect(row.workflow).toMatchObject({ state: 'unavailable', reason });
    }
    expect(entries.find((row) => row.id === 'disabled')).toMatchObject({
      name: null,
      state: 'disabled',
      workflow: { state: 'disabled', reason: 'workflow_disabled', skillId: null },
    });
    expect(JSON.stringify(entries.map((row) => row.workflow))).not.toContain(
      'PRIVATE WORKFLOW BODY',
    );
    expect(JSON.stringify(entries)).not.toContain(root);
    expect(vault).toBe(0);
    expect(resolvers).toBe(0);
    expect(await runtime.getChanges({ after: '0' })).toEqual(before);
    writeFileSync(
      flagsPath,
      JSON.stringify({ version: 1, features: { ...flags, skillActivation: false } }),
    );
    expect(
      (
        await get(
          `&workflow=manual&limit=37&revision=${first.revision}&afterId=${first.nextAfterId}`,
        )
      ).status,
    ).toBe(409);
    const disabled = await get('&workflow=manual&limit=1');
    expect(disabled.body.entries[0]!.workflow).toMatchObject({
      state: 'disabled',
      reason: 'workflow_disabled',
    });
    expect((await get('&limit=37')).body).toEqual(knowledge.body);
    writeFileSync(flagsPath, JSON.stringify({ version: 1, features: flags }));
    write('good-000', { ...manifest('good-000'), description: 'changed source' });
    expect(
      (await get(`&workflow=manual&revision=${first.revision}&afterId=${first.nextAfterId}`))
        .status,
    ).toBe(409);
    const changed = await get('&workflow=manual&limit=37');
    expect(changed.body.revision).not.toBe(first.revision);
    writeFileSync(
      configPath,
      JSON.stringify({
        ...config,
        tools: [{ id: 'files.read', definitionVersion: 'unavailable' }],
      }),
    );
    expect(
      (
        await get(
          `&workflow=manual&revision=${changed.body.revision}&afterId=${changed.body.nextAfterId}`,
        )
      ).status,
    ).toBe(409);
    const unavailable = await get('&workflow=manual&limit=1');
    expect(unavailable.body.entries[0]!.workflow!.reason).toBe(
      'workflow_configuration_unavailable',
    );
    expect(vault).toBe(0);
    expect(resolvers).toBe(0);
    expect(await runtime.getChanges({ after: '0' })).toEqual(before);
    expect(await runtime.listSessions()).toHaveLength(0);
    // Only after proving every GET was read-only, compare its descriptor with an actual
    // accepted original command bound by the normal default Service configuration factory.
    writeFileSync(configPath, JSON.stringify(config));
    const latest = await get('&workflow=manual');
    await runtime.createSession({
      ...identity,
      commandId: 'create',
      sessionId: 's',
      workspaceId: 'w',
      title: 'binding only',
    });
    const command = await store.acceptCommand({
      ...identity,
      commandId: 'original',
      sessionId: 's',
      request: {
        kind: 'run.start',
        content: 'explicit original',
        extensionInputs: [
          {
            extensionId: 'builtin.skill-workflow',
            definitionVersion: '1',
            input: { activations: [{ key: 'initial', skillId: 'skill:good-000', input: {} }] },
          },
        ],
      },
    });
    const binding = await host.resolveRunConfiguration!({
      command,
      session: (await runtime.getSession('s'))!,
      workspace: (await runtime.getWorkspace('w'))!,
    });
    try {
      const snapshot = binding.snapshot as {
        skillWorkflow: { entries: { descriptor: { capabilityId: string; revision: string } }[] };
      };
      const original = snapshot.skillWorkflow.entries.find(
        (entry) => entry.descriptor.capabilityId === 'skill:good-000',
      )!;
      expect(original.descriptor.revision).toBe(
        latest.body.entries.find((entry) => entry.id === 'good-000')!.workflow!.revision!,
      );
      expect(vault).toBe(1);
      expect(resolvers).toBe(0);
      expect((await store.getView('s')).runs).toHaveLength(0);
      expect(await store.listExecutions('s')).toHaveLength(0);
    } finally {
      await binding.dispose?.();
    }
  } finally {
    await service.close();
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
