import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { launchPairedService } from '../../src/paired';

interface AssemblyObservation {
  stage(phase: string): void;
  pending(phase: string): void;
  observed(facts: Record<string, unknown>): void;
  failed(error: unknown): void;
}
function assemblyObservation(requestCount: () => number, started: number): AssemblyObservation {
  let phase = 'test.begin',
    facts: Record<string, unknown> = {},
    previous = '';
  const emit = (errorCode?: string) => {
    console.error(
      JSON.stringify({
        observation: 'assembly_source_freshness',
        phase,
        elapsedMs: performance.now() - started,
        providerRequests: requestCount(),
        ...facts,
        ...(errorCode ? { errorCode } : {}),
      }),
    );
  };
  return {
    stage(next) {
      phase = next;
      emit();
    },
    pending(next) {
      phase = next;
    },
    observed(next) {
      facts = { ...facts, ...next };
      const current = JSON.stringify({ ...facts, providerRequests: requestCount() });
      if (current !== previous) {
        previous = current;
        emit();
      }
    },
    failed(error) {
      const value = error as { code?: unknown; message?: unknown } | null;
      const code = value?.code ?? value?.message;
      emit(typeof code === 'string' && /^[a-z][a-z0-9_]{0,80}$/.test(code) ? code : 'unknown');
    },
  };
}

function endpoint(calls: ({ name: string; input: unknown } | undefined)[]) {
  const requests: Record<string, unknown>[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as Record<string, unknown>;
      requests.push(body);
      const call = calls[requests.length - 1];
      const payload = {
        id: 'response',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'local',
        choices: [
          {
            index: 0,
            delta: call
              ? {
                  tool_calls: [
                    {
                      index: 0,
                      id: `call-${requests.length}`,
                      type: 'function',
                      function: { name: call.name, arguments: JSON.stringify(call.input) },
                    },
                  ],
                }
              : { content: 'done' },
            finish_reason: null,
          },
        ],
      };
      const finish = {
        ...payload,
        choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }],
      };
      return new Response(
        `data: ${JSON.stringify(payload)}\n\ndata: ${JSON.stringify(finish)}\n\ndata: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  return {
    requests,
    baseURL: `http://127.0.0.1:${server.port}/v1`,
    close() {
      server.stop(true);
    },
  };
}
async function setup(
  provider: ReturnType<typeof endpoint>,
  tools: string[],
  skills: unknown[] = [],
  gate = false,
  observation?: AssemblyObservation,
) {
  observation?.stage('setup.begin');
  const root = mkdtempSync(join(tmpdir(), 'kite-assembly-http-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'test' });
  mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(profile.profilePath, 'config.jsonc'),
    JSON.stringify({
      modelId: 'local',
      models: [{ id: 'local', provider: 'compatible', model: 'local', baseURL: provider.baseURL }],
      tools: tools.map((id) => ({ id })),
      skills,
    }),
  );
  if (gate) writeFileSync(join(profile.profilePath, 'gate-enabled'), 'enabled');
  observation?.stage('setup.service');
  const handle = await launchPairedService({
    entrypoint: join(import.meta.dir, '../fixtures/assembled-child.ts'),
    profile,
    instanceId: 'assembled',
    buildId: 'assembled-test',
    apiMajor: 1,
    requiredCapabilities: ['commands'],
  });
  const storeId = handle.bootstrap.storeId!;
  observation?.stage('setup.workspace');
  await handle.client.createWorkspace({
    id: 'workspace',
    rootUri: `file://${workspace}`,
    name: 'Assembly',
    expectedStoreId: storeId,
  });
  observation?.stage('setup.session');
  await handle.client.createSession({
    sessionId: 'session',
    workspaceId: 'workspace',
    commandId: 'create',
    title: 'Assembly',
    expectedStoreId: storeId,
  });
  observation?.stage('setup.readonly_store');
  const store = await openSqliteStore({
    dataRoot: profile.dataRoot,
    profile: 'test',
    mode: 'readonly',
  });
  observation?.stage('setup.complete');
  return {
    root,
    workspace,
    profile,
    handle,
    store,
    storeId,
    async close() {
      observation?.stage('cleanup.store');
      await store.close();
      observation?.stage('cleanup.service');
      await handle.close();
      observation?.stage('cleanup.files');
      rmSync(root, { recursive: true, force: true });
      observation?.stage('cleanup.complete');
    },
  };
}
async function until(read: () => Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (!(await read())) {
    if (Date.now() > deadline) throw new Error('assembly_deadline');
    await Bun.sleep(5);
  }
}
async function run(f: Awaited<ReturnType<typeof setup>>) {
  await f.handle.client.startRun('session', {
    commandId: 'run',
    kind: 'run.start',
    content: 'Harmless scoped operation',
    expectedStoreId: f.storeId,
  });
}
async function finished(f: Awaited<ReturnType<typeof setup>>, observation?: AssemblyObservation) {
  observation?.stage('finished.begin');
  await until(async () => {
    observation?.pending('finished.command');
    const command = await f.handle.client.getCommand('run');
    observation?.observed({ commandStatus: command.status });
    if (command.status === 'rejected') return true;
    observation?.pending('finished.view');
    const view = await f.handle.client.getView('session');
    observation?.observed({
      runs: view.runs.map(({ id, isActive, originCommandId }) => ({
        id,
        isActive,
        originCommandId,
      })),
      executions: view.executions.map(({ id, kind, status }) => ({ id, kind, status })),
    });
    return view.runs.some((run) => !run.isActive);
  });
  observation?.stage('finished.final_view');
  return f.handle.client.getView('session');
}

test('paired default assembly binds real files/source freshness and never dispatches old arguments after permission wait', async () => {
  const started = performance.now();
  const provider = endpoint([
    { name: 'files.write', input: { path: 'nested/output.txt', content: 'old', base: null } },
    { name: 'files.write', input: { path: 'nested/output.txt', content: 'new', base: null } },
  ]);
  const observation = assemblyObservation(() => provider.requests.length, started);
  observation.stage('test.begin');
  const f = await setup(provider, ['files.write'], [], true, observation).catch((error) => {
    observation.failed(error);
    throw error;
  });
  try {
    mkdirSync(join(f.workspace, 'nested'));
    writeFileSync(join(f.workspace, 'AGENTS.md'), 'old decision instruction');
    observation.stage('run.begin');
    await run(f);
    observation.stage('permission.wait');
    await until(async () => existsSync(join(f.profile.profilePath, 'permission-entered')));
    observation.stage('permission.entered');
    expect(existsSync(join(f.workspace, 'nested/output.txt'))).toBe(false);
    writeFileSync(join(f.workspace, 'AGENTS.md'), 'new decision instruction');
    writeFileSync(join(f.workspace, 'nested/AGENTS.md'), 'new nested instruction');
    writeFileSync(join(f.profile.profilePath, 'permission-release'), 'release');
    observation.stage('permission.released');
    const view = await finished(f, observation);
    observation.stage('finished.complete');
    expect(view.runs).toHaveLength(1);
    expect(readFileSync(join(f.workspace, 'nested/output.txt'), 'utf8')).toBe('new');
    expect(provider.requests).toHaveLength(3);
    expect(JSON.stringify(provider.requests[1]!.messages)).toContain('new decision instruction');
    expect(JSON.stringify(provider.requests[1]!.messages)).toContain('new nested instruction');
    const tools = view.executions.filter((execution) => execution.kind === 'tool');
    expect(tools).toHaveLength(2);
    expect(tools[0]!.status).toBe('failed');
    expect(tools[1]!.status).toBe('succeeded');
    expect(JSON.stringify(view.runs[0]!.configuration)).toContain('files.write');
  } catch (error) {
    observation.failed(error);
    throw error;
  } finally {
    observation.stage('cleanup.begin');
    writeFileSync(join(f.profile.profilePath, 'permission-release'), 'release');
    await f.close();
    provider.close();
    observation.stage('provider.closed');
  }
});

test('paired Skills load/resource are ordinary Tools and knowledge/source IDs never execute linked scripts', async () => {
  const provider = endpoint([
    { name: 'skills.load', input: { id: 'guide' } },
    { name: 'skills.resource', input: { id: 'guide', path: 'scripts/helper.sh' } },
  ]);
  const f = await setup(provider, ['skills.load', 'skills.resource'], []);
  try {
    const skill = join(f.workspace, 'skills/guide');
    mkdirSync(join(skill, 'scripts'), { recursive: true });
    writeFileSync(
      join(skill, 'SKILL.md'),
      '---\nname: Guide\ndescription: summary-only-marker\n---\nbody-on-demand-marker\n[helper](scripts/helper.sh)\n',
    );
    writeFileSync(
      join(skill, 'scripts/helper.sh'),
      `echo harmless > ${join(f.workspace, 'must-not-run')}\n`,
    );
    const file = join(f.profile.profilePath, 'config.jsonc');
    const config = JSON.parse(readFileSync(file, 'utf8'));
    config.skills = [{ id: 'guide', path: 'skills/guide' }];
    writeFileSync(file, JSON.stringify(config));
    await run(f);
    const view = await finished(f);
    expect(provider.requests).toHaveLength(3);
    expect(JSON.stringify(provider.requests[0]!.messages)).toContain('summary-only-marker');
    expect(JSON.stringify(provider.requests[0]!.messages)).not.toContain('body-on-demand-marker');
    expect(JSON.stringify(provider.requests[1]!.messages)).toContain('body-on-demand-marker');
    expect(JSON.stringify(provider.requests[2]!.messages)).toContain('must-not-run');
    expect(existsSync(join(f.workspace, 'must-not-run'))).toBe(false);
    expect(
      view.executions
        .filter((execution) => execution.kind === 'tool')
        .map((execution) => execution.status),
    ).toEqual(['succeeded', 'succeeded']);
    const modelExecutions = (await f.store.getView('session')).executions.filter(
      (execution) => execution.kind === 'model',
    );
    expect(JSON.stringify(modelExecutions[1]!.decisionSource)).toContain('skill.body:guide');
    expect(JSON.stringify(modelExecutions[2]!.decisionSource)).toContain('skill.resource:guide:');
  } finally {
    await f.close();
    provider.close();
  }
});

test('Skill dependency claims do not grant a host capability and unknown selected Tool refuses only its Run', async () => {
  const provider = endpoint([{ name: 'skills.load', input: { id: 'guide' } }]);
  const f = await setup(provider, ['skills.load'], []);
  try {
    const skill = join(f.workspace, 'skill');
    mkdirSync(skill);
    writeFileSync(
      join(skill, 'SKILL.md'),
      '---\nname: Guide\ndescription: knowledge\nrequired-capabilities: files.write\n---\nrequires-file-write\n',
    );
    const file = join(f.profile.profilePath, 'config.jsonc');
    const config = JSON.parse(readFileSync(file, 'utf8'));
    config.skills = [{ id: 'guide', path: 'skill' }];
    writeFileSync(file, JSON.stringify(config));
    await run(f);
    const view = await finished(f);
    expect(view.executions.filter((execution) => execution.kind === 'tool')).toHaveLength(1);
    expect(
      JSON.stringify(view.executions.find((execution) => execution.kind === 'tool')!.result),
    ).toContain('skill_capability_missing');
    expect(JSON.stringify(view.runs[0]!.configuration)).toContain(
      '"allowedCapabilities":["skills.load"]',
    );
    config.tools = [{ id: 'unknown.tool' }];
    writeFileSync(file, JSON.stringify(config));
    await f.handle.client.startRun('session', {
      commandId: 'unknown',
      kind: 'run.start',
      content: 'Refuse unknown Tool',
      expectedStoreId: f.storeId,
    });
    await until(async () => (await f.handle.client.getCommand('unknown')).status === 'rejected');
    expect(JSON.stringify(await f.handle.client.getCommand('unknown'))).toContain(
      'tool_definition_unavailable',
    );
    expect(provider.requests).toHaveLength(2);
    expect((await f.handle.client.getView('session')).runs).toHaveLength(1);
  } finally {
    await f.close();
    provider.close();
  }
});

test('a newly disabled file capability affects the next Run while an admitted waiting Run retains its original binding', async () => {
  const provider = endpoint([
    { name: 'files.write', input: { path: 'old.txt', content: 'old binding', base: null } },
    undefined,
    {
      name: 'files.write',
      input: { path: 'future.txt', content: 'must not dispatch', base: null },
    },
  ]);
  const f = await setup(provider, ['files.write'], [], true);
  try {
    await run(f);
    await until(async () => existsSync(join(f.profile.profilePath, 'permission-entered')));
    const file = join(f.profile.profilePath, 'config.jsonc');
    const config = JSON.parse(readFileSync(file, 'utf8'));
    config.tools = [{ id: 'files.write', enabled: false }];
    writeFileSync(file, JSON.stringify(config));
    writeFileSync(join(f.profile.profilePath, 'permission-release'), 'release');
    const old = await finished(f);
    expect(readFileSync(join(f.workspace, 'old.txt'), 'utf8')).toBe('old binding');
    const original = JSON.stringify(old.runs[0]!.configuration);
    await f.handle.client.startRun('session', {
      commandId: 'future',
      kind: 'run.start',
      content: 'Future config',
      expectedStoreId: f.storeId,
    });
    await until(async () =>
      (await f.handle.client.getView('session')).runs.some(
        (run) => run.originCommandId === 'future' && !run.isActive,
      ),
    );
    const current = await f.handle.client.getView('session');
    expect(existsSync(join(f.workspace, 'future.txt'))).toBe(false);
    expect(
      JSON.stringify(current.runs.find((run) => run.originCommandId === 'run')!.configuration),
    ).toBe(original);
    const future = current.runs.find((run) => run.originCommandId === 'future')!;
    expect(future.configuration).toMatchObject({
      tools: [{ id: 'ask_user', version: '1' }],
    });
    expect(
      current.executions.filter(
        (execution) => execution.runId === future.id && execution.kind === 'tool',
      ),
    ).toHaveLength(0);
    expect(provider.requests).toHaveLength(3);
    expect(provider.requests[2]!.tools).toEqual([
      expect.objectContaining({
        type: 'function',
        function: expect.objectContaining({ name: 'ask_user' }),
      }),
    ]);
    expect(JSON.stringify(provider.requests[0]!.tools)).toContain('files.write');
  } finally {
    writeFileSync(join(f.profile.profilePath, 'permission-release'), 'release');
    await f.close();
    provider.close();
  }
});
