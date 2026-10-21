import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { mcpCanonical } from '@kite-ai/agent/config';
import type { Extension, Json, Permissions } from '@kite-ai/agent/extensions';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { temporaryDirectory } from '../../../../tests/fixtures/test-filesystem';
import { createWorkspaceAssembly } from '../../src/assembly';
import { readSkillSelection } from '../../src/child-configuration';
import { createDefaultProcessConfiguration } from '../../src/configuration';
import {
  createMcpSourceConfiguration,
  type McpSelectedSourceSnapshot,
} from '../../src/mcp-source-configuration';
import { initializeLivePermissionFixture } from '../fixtures/live-permission-fixture';

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
  const root = temporaryDirectory('kite-run-skills-');
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
    userConfigurationPath: profile.profilePath + '/config.jsonc',
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
  // These two callbacks belong only to this fixture; the default host still
  // authorizes every builtin, model and child scope through its original policy.
  const fixturePermissions = (original: Permissions): Permissions => ({
    ...original,
    async authorize(request) {
      const decision = await original.authorize(request);
      const fixtureCapability =
        request.definitionVersion === '1' &&
        ((request.kind === 'tool' && request.definitionId === 'fixture.delegate') ||
          (request.kind === 'job' && request.definitionId === 'fixture/fixture.runless'));
      if (!fixtureCapability) return decision;
      expect(decision.revision).toBeString();
      expect(decision.controlReads).toHaveLength(3);
      return {
        allowed: true,
        revision: decision.revision,
        controlReads: decision.controlReads,
        snapshot: decision.snapshot,
      };
    },
  });
  const runtime = createRuntime({
    ...host,
    store,
    permissions: fixturePermissions(host.permissions!),
    async resolveRunConfiguration(input) {
      const configuration = await host.resolveRunConfiguration!(input);
      return {
        ...configuration,
        permissions: fixturePermissions(configuration.permissions ?? host.permissions!),
      };
    },
    async resolveChildRunConfiguration(input) {
      const configuration = await host.resolveChildRunConfiguration!(input);
      return {
        ...configuration,
        permissions: fixturePermissions(configuration.permissions ?? host.permissions!),
      };
    },
    extensions: [...host.extensions!, delegate],
  });
  const storeId = (await store.getMetadata()).storeId;
  await runtime.createWorkspace({
    expectedStoreId: storeId,
    id: 'w',
    name: 'owned',
    rootUri: pathToFileURL(workspace).href,
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
  host.permissionManagement?.(runtime);
  await initializeLivePermissionFixture({
    runtime,
    profile,
    ...base,
    workspaceId: 'w',
    mode: 'full',
    trusted: true,
  });
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
        content: 'New task: fresh independent',
        afterRunId: root.id,
        contextSelectionId: selection,
        selectedSkills: ['beta'],
      },
    });
    const fresh = await f.runtime.waitForCommand('fresh-followup');
    const freshReceipt = fresh.receipt as { businessCommandId: string; runId: string };
    expect(fresh.status).toBe('applied');
    const second = (await f.store.getRun(freshReceipt.runId))!;
    expect(second).toMatchObject({
      originCommandId: freshReceipt.businessCommandId,
      rootWorkCommandId: fresh.id,
      status: 'completed',
    });
    expect(
      (await f.store.listExecutions('s')).find(
        (execution) => execution.kind === 'model' && execution.runId === second.id,
      ),
    ).toMatchObject({
      originCommandId: freshReceipt.businessCommandId,
      rootWorkCommandId: fresh.id,
    });
    expect(readSkillSelection(second.configuration)).toEqual({
      requested: ['beta'],
      resolvedIds: ['beta'],
    });
    await f.runtime.submitCommand({
      ...f.base,
      commandId: 'omitted-followup',
      request: {
        kind: 'input.follow_up',
        content: 'New task: default independent',
        afterRunId: second.id,
        contextSelectionId: selection,
      },
    });
    const omitted = await f.runtime.waitForCommand('omitted-followup');
    const omittedReceipt = omitted.receipt as { businessCommandId: string; runId: string };
    expect(omitted.status).toBe('applied');
    const third = (await f.store.getRun(omittedReceipt.runId))!;
    expect(third).toMatchObject({
      originCommandId: omittedReceipt.businessCommandId,
      rootWorkCommandId: omitted.id,
      status: 'completed',
    });
    expect(
      (await f.store.listExecutions('s')).find(
        (execution) => execution.kind === 'model' && execution.runId === third.id,
      ),
    ).toMatchObject({
      originCommandId: omittedReceipt.businessCommandId,
      rootWorkCommandId: omitted.id,
    });
    expect(readSkillSelection(third.configuration)).toEqual({
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
        request: {
          kind: 'run.start',
          content: 'New task: must reject',
          selectedSkills: [...selectors],
        },
      });
      const command = await f.runtime.waitForCommand(id);
      expect(command.status).toBe('rejected');
      expect(command.receipt).toMatchObject({ reason });
    }
    expect(f.counts()).toEqual(before);
    expect(() =>
      createDefaultProcessConfiguration({
        userConfigurationPath: f.profile.profilePath + '/config.jsonc',
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
        parentTools: [],
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
    const workerSession = (await f.store.getSession(f.children[0]!))!;
    const workerRun = (await f.store.getView(workerSession.id)).runs[0]!;
    const grandRun = (await f.store.getView(f.children[1]!)).runs[0]!;
    const marker = (configuration: Json) =>
      (
        configuration as unknown as {
          snapshot: { configuration: { mcp: { sources: McpSelectedSourceSnapshot } } };
        }
      ).snapshot.configuration.mcp.sources;
    const workerSources = marker(workerRun.configuration);
    expect(workerSources).toMatchObject({
      servers: [],
      readSet: null,
      selection: { present: false, serverIds: [] },
      inheritance: { parentRunId: null, parentSessionId: 's', rootWorkCommandId: 'runless' },
    });
    expect(marker(grandRun.configuration).inheritance).toMatchObject({
      parentRunId: workerRun.id,
      parentSnapshot: workerSources,
    });
    const rootExecutions = await f.store.listExecutions('s');
    const rootTool = rootExecutions.find((execution) => execution.kind === 'tool')!;
    const carrier = rootExecutions.find(
      (execution) => execution.childSessionId === workerSession.id,
    )!;
    const workerTool = (await f.store.listExecutions(workerSession.id)).find(
      (execution) => execution.kind === 'tool',
    )!;
    const workspace = (await f.store.getWorkspace('w'))!;
    const sources = createMcpSourceConfiguration({
      profile: f.profile,
      runtime: () => f.runtime,
      credentialVault: {
        async resolve() {
          throw Error('unexpected_runless_mcp_credential');
        },
      },
    });
    const parent = async () => ({
      parentExecution: (await f.store.getExecution(workerTool.id))!,
      parentRun: (await f.store.getRun(workerRun.id))!,
      parentSession: workerSession,
      workspace,
      command: (await f.store.getCommand(workerTool.originCommandId))!,
    });
    const before = f.counts();
    const omitted = await sources.deriveChildSelection(
      { ...(await parent()), parentRun: null },
      { present: false, configurations: [] },
    );
    expect(omitted.snapshot).toMatchObject({ servers: [], readSet: null });
    expect(omitted.snapshot.inheritance).toBeUndefined();
    expect(
      (await sources.deriveChildSelection(await parent(), { present: false, configurations: [] }))
        .servers,
    ).toEqual([]);
    const db = new Database(f.profile.databasePath);
    db.run('PRAGMA busy_timeout=1000');
    const saved = {
      run: db.query('SELECT config_json FROM run WHERE id=?').get(workerRun.id) as {
        config_json: string;
      },
      tool: db
        .query('SELECT intent_json,parent_execution_id FROM execution WHERE id=?')
        .get(rootTool.id) as { intent_json: string; parent_execution_id: string },
      command: db
        .query(
          'SELECT request_json,request_digest,subject_id,root_work_command_id FROM command WHERE id=?',
        )
        .get(rootTool.originCommandId) as {
        request_json: string;
        request_digest: string;
        subject_id: string;
        root_work_command_id: string;
      },
      root: db.query('SELECT request_json FROM command WHERE id=?').get('runless') as {
        request_json: string;
      },
      start: db
        .query('SELECT request_json FROM command WHERE id=?')
        .get(workerRun.originCommandId) as { request_json: string },
      carrier: db
        .query('SELECT child_configuration_json FROM execution WHERE id=?')
        .get(carrier.id) as { child_configuration_json: string },
      carrierCommand: db
        .query('SELECT request_json,request_digest FROM command WHERE id=?')
        .get(carrier.originCommandId) as { request_json: string; request_digest: string },
    };
    const restore = () => {
      db.query('UPDATE run SET config_json=? WHERE id=?').run(saved.run.config_json, workerRun.id);
      db.query('UPDATE execution SET intent_json=?,parent_execution_id=? WHERE id=?').run(
        saved.tool.intent_json,
        saved.tool.parent_execution_id,
        rootTool.id,
      );
      db.query(
        'UPDATE command SET request_json=?,request_digest=?,subject_id=?,root_work_command_id=? WHERE id=?',
      ).run(
        saved.command.request_json,
        saved.command.request_digest,
        saved.command.subject_id,
        saved.command.root_work_command_id,
        rootTool.originCommandId,
      );
      db.query('UPDATE command SET request_json=? WHERE id=?').run(
        saved.root.request_json,
        'runless',
      );
      db.query('UPDATE command SET request_json=? WHERE id=?').run(
        saved.start.request_json,
        workerRun.originCommandId,
      );
      db.query('UPDATE execution SET child_configuration_json=? WHERE id=?').run(
        saved.carrier.child_configuration_json,
        carrier.id,
      );
      db.query('UPDATE command SET request_json=?,request_digest=? WHERE id=?').run(
        saved.carrierCommand.request_json,
        saved.carrierCommand.request_digest,
        carrier.originCommandId,
      );
    };
    const changedMarker = (
      change: (snapshot: McpSelectedSourceSnapshot) => void,
      coherent = false,
    ) => {
      const configuration = JSON.parse(saved.run.config_json) as Json;
      change(marker(configuration));
      db.query('UPDATE run SET config_json=? WHERE id=?').run(
        mcpCanonical(configuration),
        workerRun.id,
      );
      if (coherent) {
        const sealed = JSON.parse(saved.carrier.child_configuration_json);
        sealed.snapshot = configuration;
        const request = JSON.parse(saved.carrierCommand.request_json);
        request.childConfiguration = sealed;
        db.query('UPDATE execution SET child_configuration_json=? WHERE id=?').run(
          mcpCanonical(sealed),
          carrier.id,
        );
        db.query('UPDATE command SET request_json=?,request_digest=? WHERE id=?').run(
          mcpCanonical(request),
          createHash('sha256').update(mcpCanonical(request)).digest('hex'),
          carrier.originCommandId,
        );
      }
    };
    const corruptions = [
      () =>
        db
          .query('UPDATE execution SET intent_json=? WHERE id=?')
          .run('{"forged":true}', rootTool.id),
      () => db.query('UPDATE execution SET parent_execution_id=NULL WHERE id=?').run(rootTool.id),
      () =>
        db
          .query('UPDATE command SET subject_id=? WHERE id=?')
          .run('foreign', rootTool.originCommandId),
      () =>
        db
          .query('UPDATE command SET root_work_command_id=? WHERE id=?')
          .run('foreign', rootTool.originCommandId),
      () =>
        db
          .query('UPDATE command SET request_json=? WHERE id=?')
          .run(
            JSON.stringify({ ...JSON.parse(saved.root.request_json), input: { forged: true } }),
            'runless',
          ),
      () =>
        db.query('UPDATE command SET request_json=? WHERE id=?').run(
          JSON.stringify({
            ...JSON.parse(saved.start.request_json),
            parentExecutionId: 'foreign',
          }),
          workerRun.originCommandId,
        ),
      () =>
        changedMarker((snapshot) => {
          snapshot.scope.storeId = 'foreign';
        }),
      () =>
        changedMarker((snapshot) => {
          snapshot.servers = [{} as McpSelectedSourceSnapshot['servers'][number]];
        }, true),
      () =>
        changedMarker((snapshot) => {
          snapshot.selection.serverIds = ['foreign'];
        }, true),
      () =>
        changedMarker((snapshot) => {
          snapshot.readSet = {} as NonNullable<McpSelectedSourceSnapshot['readSet']>;
        }, true),
    ];
    try {
      for (const corrupt of corruptions) {
        restore();
        corrupt();
        let rejected: unknown;
        try {
          await sources.deriveChildSelection(await parent(), {
            present: false,
            configurations: [],
          });
        } catch (error) {
          rejected = error;
        }
        expect(rejected).toMatchObject({ code: 'mcp_source_scope_invalid' });
        expect(f.counts()).toEqual(before);
      }
    } finally {
      restore();
      db.close();
    }
    expect(
      (await sources.deriveChildSelection(await parent(), { present: false, configurations: [] }))
        .servers,
    ).toEqual([]);
    expect(f.counts()).toEqual(before);
    const cold = await openSqliteStore({ ...f.profile, mode: 'readonly' });
    try {
      const reads = new Set([
        'getMetadata',
        'getSession',
        'getWorkspace',
        'getExecution',
        'getRun',
        'getView',
        'getCommand',
      ]);
      const host = new Proxy(f.runtime, {
        get(target, key) {
          const owner = typeof key === 'string' && reads.has(key) ? cold : target;
          const value = Reflect.get(owner, key, owner);
          return typeof value === 'function' ? value.bind(owner) : value;
        },
      });
      const restored = createMcpSourceConfiguration({
        profile: f.profile,
        runtime: () => host,
        credentialVault: {
          async resolve() {
            throw Error('unexpected_cold_runless_mcp_credential');
          },
        },
      });
      const cursor = (await cold.getMetadata()).lastChangeCursor;
      const derived = await restored.deriveChildSelection(await parent(), {
        present: false,
        configurations: [],
      });
      expect(derived.snapshot.inheritance?.parentSnapshot).toEqual(workerSources);
      expect(derived.servers).toEqual([]);
      expect((await cold.getMetadata()).lastChangeCursor).toBe(cursor);
      expect(f.counts()).toEqual(before);
    } finally {
      await cold.close();
    }
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
      request: { kind: 'run.start', content: 'New task: delegate root' },
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
