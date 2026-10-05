import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import type { Extension, Json } from '@kite-ai/agent/extensions';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createWorkspaceAssembly } from '../../src/assembly';
import { readSkillSelection } from '../../src/child-configuration';
import { createDefaultProcessConfiguration } from '../../src/configuration';

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw Error('skill_selection_deadline');
    await Bun.sleep(5);
  }
}
async function fixture(runlessTools = false, nested = true) {
  const root = mkdtempSync('/private/tmp/kite-run-skills-');
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'test' });
  const store = await openSqliteStore(profile);
  for (const [id, name] of [
    ['alpha', 'AlphaGuide'],
    ['beta', 'alpha'],
  ]) {
    mkdirSync(join(workspace, id!));
    writeFileSync(
      join(workspace, id!, 'SKILL.md'),
      `---\nname: ${name}\ndescription: guidance\n---\n${id} knowledge; never execute ./effect.sh\n`,
    );
    writeFileSync(join(workspace, id!, 'effect.sh'), `touch ${join(root, 'script-effect')}\n`);
  }
  let requests = 0,
    credentialReads = 0;
  const records: { model: string; messages: unknown[] }[] = [];
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as {
        model: string;
        messages: { role: string; content: unknown }[];
      };
      records.push(body);
      requests++;
      const shouldDelegate =
        ['parent', 'child'].includes(body.model) &&
        body.messages.some((v) => v.role === 'user' && String(v.content).includes('delegate')) &&
        !body.messages.some((v) => v.role === 'tool');
      const delta = shouldDelegate
        ? {
            tool_calls: [
              {
                index: 0,
                id: 'delegate',
                type: 'function',
                function: { name: 'fixture.delegate', arguments: '{}' },
              },
            ],
          }
        : { content: `${body.model} complete` };
      return new Response(
        `data: ${JSON.stringify({ id: 'fixed', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: shouldDelegate ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const config = {
    modelId: 'parent',
    models: ['parent', 'child', 'grand'].map((id) => ({
      id,
      provider: 'compatible',
      model: id,
      baseURL: `${provider.url.href}v1`,
      credentialRef: 'credential:11111111-1111-4111-8111-111111111111',
    })),
    tools: [{ id: 'fixture.delegate' }, { id: 'skills.load' }],
    skills: [
      { id: 'alpha', path: 'alpha' },
      { id: 'beta', path: 'beta' },
    ],
  };
  writeFileSync(join(profile.profilePath, 'config.jsonc'), JSON.stringify(config));
  const host = createDefaultProcessConfiguration({
    profile,
    knownToolIds: ['fixture.delegate'],
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'trusted' };
      },
    },
    credentialBackend: {
      kind: 'temporary',
      async put() {},
      async resolve() {
        credentialReads++;
        return 'owned-fixture-secret';
      },
      async remove() {},
    },
    child: [
      {
        id: 'worker',
        version: '1',
        modelId: 'child',
        toolIds: runlessTools ? ['fixture.delegate'] : ['fixture.delegate', 'skills.load'],
      },
      { id: 'grand', version: '1', modelId: 'grand', toolIds: runlessTools ? [] : ['skills.load'] },
    ],
  });
  const children: string[] = [];
  const delegate: Extension = {
    id: 'fixture',
    version: '1',
    apiMajor: 1,
    actions: [
      {
        id: 'fixture.runless',
        version: '1',
        description: 'owned runless Tool bridge',
        inputSchema: { type: 'object', additionalProperties: false },
        async prepare() {
          return {};
        },
        async execute(_input, context) {
          await context.operations.ensure({
            key: 'runless-tool',
            request: {
              kind: 'tool',
              definitionId: 'fixture.delegate',
              definitionVersion: '1',
              input: {},
            },
            cancellation: 'detached',
          });
          return { outcome: 'succeeded', content: 'runless Tool accepted' };
        },
      },
    ],
    tools: [
      {
        id: 'fixture.delegate',
        version: '1',
        description: 'owned test delegation',
        inputSchema: { type: 'object', additionalProperties: false },
        async execute(_input, context) {
          if (!nested && context.sessionId !== 's')
            return { outcome: 'succeeded', content: 'leaf worker complete' };
          const child = await context.operations.ensure({
            key: 'child',
            request: {
              kind: 'agent',
              configurationId: context.sessionId === 's' ? 'worker' : 'grand',
              input: { content: 'delegate child' },
            },
            cancellation: 'detached',
          });
          children.push(child.childSessionId!);
          return { outcome: 'succeeded', content: 'delegated' };
        },
      },
    ],
  };
  const runtime = createRuntime({
    ...host,
    store,
    permissions: host.permissions!,
    extensions: [...host.extensions!, delegate],
  });
  const storeId = (await store.getMetadata()).storeId;
  await runtime.createWorkspace({
    expectedStoreId: storeId,
    id: 'w',
    name: 'owned',
    rootUri: `file://${workspace}`,
  });
  await runtime.createSession({
    expectedStoreId: storeId,
    subjectId: 'owner',
    commandId: 'create',
    sessionId: 's',
    workspaceId: 'w',
    title: 'root',
  });
  const base = { expectedStoreId: storeId, subjectId: 'owner', sessionId: 's' };
  return {
    root,
    workspace,
    profile,
    store,
    runtime,
    host,
    base,
    config,
    children,
    records,
    counts: () => ({ requests, credentialReads }),
    async close() {
      await runtime.close();
      provider.stop(true);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('per-Run root, child and grandchild seal exact inherited IDs despite name collisions; public followup chooses independently', async () => {
  const f = await fixture();
  try {
    await f.runtime.submitCommand({
      ...f.base,
      commandId: 'root-work',
      request: {
        kind: 'run.start',
        content: 'delegate root',
        selectedSkills: ['AlphaGuide', 'AlphaGuide'],
      },
    });
    const rootCommand = await f.runtime.waitForCommand('root-work');
    expect(rootCommand.status).toBe('applied');
    await until(
      async () => Promise.all(f.children.map((id) => f.store.getView(id))),
      (views) =>
        views.length === 2 &&
        views.every((view) => view.runs.some((run) => run.status === 'completed')),
    );
    const root = (await f.store.getView('s')).runs[0]!;
    expect(readSkillSelection(root.configuration)).toEqual({
      requested: ['AlphaGuide', 'AlphaGuide'],
      resolvedIds: ['alpha'],
    });
    for (const id of f.children)
      expect(readSkillSelection((await f.store.getView(id)).runs[0]!.configuration)).toEqual({
        requested: ['AlphaGuide', 'AlphaGuide'],
        resolvedIds: ['alpha'],
      });
    expect(
      f.records
        .filter((v) => v.model !== 'parent')
        .every(
          (v) =>
            JSON.stringify(v.messages).includes('AlphaGuide') &&
            !JSON.stringify(v.messages).includes('"id":"beta"'),
        ),
    ).toBe(true);
    const selection = (await f.store.getView('s')).session.contextSelectionId;
    await f.runtime.submitCommand({
      ...f.base,
      commandId: 'fresh-followup',
      request: {
        kind: 'input.follow_up',
        content: 'fresh independent',
        afterRunId: root.id,
        contextSelectionId: selection,
        selectedSkills: ['beta'],
      },
    });
    await f.runtime.waitForCommand('fresh-followup');
    const second = (await f.store.getView('s')).runs[1]!;
    expect(readSkillSelection(second.configuration)).toEqual({
      requested: ['beta'],
      resolvedIds: ['beta'],
    });
    await f.runtime.submitCommand({
      ...f.base,
      commandId: 'omitted-followup',
      request: {
        kind: 'input.follow_up',
        content: 'default independent',
        afterRunId: second.id,
        contextSelectionId: selection,
      },
    });
    await f.runtime.waitForCommand('omitted-followup');
    expect(readSkillSelection((await f.store.getView('s')).runs[2]!.configuration)).toEqual({
      requested: null,
      resolvedIds: expect.arrayContaining(['alpha', 'beta']),
    });
    expect((await f.store.getView('s')).runs[0]!.configuration).toEqual(root.configuration);
    expect(existsSync(join(f.root, 'script-effect'))).toBe(false);
  } finally {
    await f.close();
  }
}, 15000);

test('empty and unavailable selectors persist original facts before credentials or Provider; startup selection is rejected', async () => {
  const f = await fixture();
  try {
    await f.runtime.submitCommand({
      ...f.base,
      commandId: 'empty',
      request: { kind: 'run.start', content: 'empty guidance', selectedSkills: [] },
    });
    const emptyCommand = await f.runtime.waitForCommand('empty');
    expect(emptyCommand.status).toBe('applied');
    expect(readSkillSelection((await f.store.getView('s')).runs[0]!.configuration)).toEqual({
      requested: [],
      resolvedIds: [],
    });
    const before = f.counts();
    for (const [id, selectors, reason] of [
      ['unknown', ['missing'], 'skill_not_discovered'],
      ['ambiguous', ['alpha'], 'skill_selection_ambiguous'],
    ] as const) {
      await f.runtime.submitCommand({
        ...f.base,
        commandId: id,
        request: { kind: 'run.start', content: 'must reject', selectedSkills: [...selectors] },
      });
      const command = await f.runtime.waitForCommand(id);
      expect(command.status).toBe('rejected');
      expect(command.receipt).toMatchObject({ reason });
    }
    expect(f.counts()).toEqual(before);
    expect(() =>
      createDefaultProcessConfiguration({
        profile: f.profile,
        hostConfiguration: { selectedSkills: ['alpha'] },
      }),
    ).toThrow();
    expect(existsSync(join(f.root, 'script-effect'))).toBe(false);
  } finally {
    await f.close();
  }
});

test('parent marker is closed and exact inherited IDs never reinterpret a matching name or widen missing entries', async () => {
  const f = await fixture();
  try {
    const markers: (Json | undefined)[] = [
      undefined,
      null,
      { requested: [], resolvedIds: ['alpha', 'alpha'] },
      { requested: null, resolvedIds: [], extra: true },
    ];
    for (const marker of markers)
      expect(() =>
        readSkillSelection({ snapshot: marker === undefined ? {} : { skillSelection: marker } }),
      ).toThrow();
    const assembly = await createWorkspaceAssembly({
      workspaceRoot: f.workspace,
      profile: f.profile,
      toolIds: [],
      skills: f.config.skills,
      selectedSkills: ['alpha'],
      inheritedSkillIds: ['alpha'],
    });
    try {
      expect(assembly.snapshotFacts.skills.map((v) => v.id)).toEqual(['alpha']);
    } finally {
      await assembly.dispose();
    }
    await expect(
      createWorkspaceAssembly({
        workspaceRoot: f.workspace,
        profile: f.profile,
        toolIds: [],
        skills: f.config.skills,
        inheritedSkillIds: ['missing'],
      }),
    ).rejects.toMatchObject({ code: 'skill_not_discovered' });
    await expect(
      createWorkspaceAssembly({
        workspaceRoot: f.workspace,
        profile: f.profile,
        toolIds: [],
        skills: f.config.skills.map((v) => ({ ...v, enabled: false })),
        inheritedSkillIds: ['alpha'],
      }),
    ).rejects.toMatchObject({ code: 'skill_not_discovered' });
    await f.runtime.submitCommand({
      ...f.base,
      commandId: 'parent',
      request: { kind: 'run.start', content: 'parent facts', selectedSkills: [] },
    });
    await f.runtime.waitForCommand('parent');
    const parent = await f.store.getView('s');
    const command = (await f.store.getCommand('parent'))!;
    const workspace = (await f.store.getWorkspace('w'))!;
    const before = f.counts();
    await expect(
      f.host.resolveChildRunConfiguration!({
        configurationId: 'worker',
        parentExecution: parent.executions[0]!,
        parentRun: { ...parent.runs[0]!, configuration: {} },
        records: {
          forExtension() {
            throw Error('unexpected_record_read');
          },
        },
        parentSession: parent.session,
        workspace,
        command,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'child_skill_selection_unavailable' });
    expect(f.counts()).toEqual(before);
  } finally {
    await f.close();
  }
});

test('a trusted truly runless Action Tool bridge keeps explicit role model and normal catalogue for descendants', async () => {
  const f = await fixture(true);
  try {
    await f.runtime.submitCommand({
      ...f.base,
      commandId: 'runless',
      request: {
        kind: 'extension.invoke',
        extensionId: 'fixture',
        actionId: 'fixture.runless',
        definitionVersion: '1',
        input: {},
      },
    });
    await f.runtime.waitForCommand('runless');
    await until(
      async () => Promise.all(f.children.map((id) => f.store.getView(id))),
      (views) =>
        views.length === 2 &&
        views.every((view) => view.runs.some((run) => run.status === 'completed')),
    ).catch(async () => {
      const snapshots = await Promise.all(['s', ...f.children].map((id) => f.store.getView(id)));
      const executions = await Promise.all(
        snapshots.flatMap((view) => view.executions.map((item) => f.store.getExecution(item.id))),
      );
      const commands = await Promise.all(
        [...new Set(executions.flatMap((item) => (item ? [item.originCommandId] : [])))].map((id) =>
          f.store.getCommand(id),
        ),
      );
      throw Error(
        `runless_child_diagnostic:${JSON.stringify({
          storeId: f.base.expectedStoreId,
          sessions: snapshots.map((view) => ({ session: view.session, runs: view.runs })),
          executions,
          commands,
          provider: f.counts(),
        })}`,
      );
    });
    expect((await f.store.getView('s')).runs).toEqual([]);
    for (const id of f.children)
      expect(readSkillSelection((await f.store.getView(id)).runs[0]!.configuration)).toEqual({
        requested: null,
        resolvedIds: expect.arrayContaining(['alpha', 'beta']),
      });
    expect(f.records.some((record) => record.model === 'parent')).toBe(false);
    expect(existsSync(join(f.root, 'script-effect'))).toBe(false);
  } finally {
    await f.close();
  }
}, 10000);

test('a runless Action cannot give a child per-Run tools absent from its actual captured directory', async () => {
  const f = await fixture();
  try {
    await f.runtime.submitCommand({
      ...f.base,
      commandId: 'runless-denied',
      request: {
        kind: 'extension.invoke',
        extensionId: 'fixture',
        actionId: 'fixture.runless',
        definitionVersion: '1',
        input: {},
      },
    });
    await f.runtime.waitForCommand('runless-denied');
    const view = await until(
      () => f.store.getView('s'),
      (value) =>
        value.executions.some(
          (item) => item.kind === 'tool' && ['failed', 'outcome_unknown'].includes(item.status),
        ),
    );
    expect(JSON.stringify(view.executions)).toContain('child_tool_scope_exceeds_parent');
    expect(f.children).toEqual([]);
    expect(f.counts().requests).toBe(0);
    expect(view.runs).toEqual([]);
    expect(existsSync(join(f.root, 'script-effect'))).toBe(false);
  } finally {
    await f.close();
  }
}, 10000);

test('real default Run and descendants keep 301 resolved Skills while unselected bad rows never gate binding; explicit bad refuses before credentials', async () => {
  const f = await fixture(false, false);
  try {
    const skills: Array<{ id: string; path: string; enabled?: boolean; options?: { x: boolean } }> =
      [];
    for (let i = 0; i < 301; i++) {
      const id = `many-${String(i).padStart(3, '0')}`;
      mkdirSync(join(f.workspace, id));
      writeFileSync(
        join(f.workspace, id, 'SKILL.md'),
        `---\nname: ${id}\ndescription: valid metadata\n---\nprivate-body-${i}`,
      );
      skills.push({ id, path: id });
    }
    skills.push(
      { id: 'bad', path: 'absent' },
      { id: 'disabled', path: '/outside/secret', enabled: false },
      { id: 'bad-options', path: 'many-000', options: { x: true } },
    );
    mkdirSync(join(f.workspace, 'needs'));
    writeFileSync(
      join(f.workspace, 'needs', 'SKILL.md'),
      '---\nname: Needs\ndescription: missing ability\nrequired-capabilities: unavailable.tool\n---\nprivate body',
    );
    skills.push({ id: 'needs', path: 'needs' });
    writeFileSync(
      join(f.profile.profilePath, 'config.jsonc'),
      JSON.stringify({ ...f.config, skills }),
    );
    await f.runtime.submitCommand({
      ...f.base,
      commandId: 'explicit-bad',
      request: { kind: 'run.start', content: 'must refuse', selectedSkills: ['bad-options'] },
    });
    const denied = await f.runtime.waitForCommand('explicit-bad');
    expect(denied.status).toBe('rejected');
    expect(JSON.stringify(denied.receipt)).toContain('unsupported_skill_options');
    expect(f.counts()).toEqual({ requests: 0, credentialReads: 0 });
    await f.runtime.submitCommand({
      ...f.base,
      commandId: 'default-many',
      request: { kind: 'run.start', content: 'delegate root' },
    });
    expect((await f.runtime.waitForCommand('default-many')).status).toBe('applied');
    await until(
      async () => Promise.all(f.children.map((id) => f.store.getView(id))),
      (views) =>
        views.length === 1 && views.every((v) => v.runs.some((r) => r.status === 'completed')),
    );
    const run = (await f.store.getView('s')).runs.at(-1)!;
    const expected = skills.slice(0, 301).map((s) => s.id);
    expect(readSkillSelection(run.configuration)).toEqual({
      requested: null,
      resolvedIds: expected,
    });
    for (const id of f.children)
      expect(readSkillSelection((await f.store.getView(id)).runs[0]!.configuration)).toEqual({
        requested: null,
        resolvedIds: expected,
      });
    expect(f.records).toHaveLength(4);
    expect(
      f.records.every(
        (r) =>
          JSON.stringify(r.messages).includes('many-300') &&
          !JSON.stringify(r.messages).includes('bad-options'),
      ),
    ).toBe(true);
  } finally {
    await f.close();
  }
}, 15000);
