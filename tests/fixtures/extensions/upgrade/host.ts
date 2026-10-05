import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createFixedModel, type ModelAdapter } from '@kite-ai/ai';
import { createClient } from '@kite-ai/client';
import { startService } from '@kite-ai/service';

const [root, mode, v1Path, v2Path] = process.argv.slice(2);
if (!root || !mode || !v1Path || !v2Path) throw Error('fixture_arguments');
mkdirSync(root, { recursive: true, mode: 0o700 });
const store = await openSqliteStore({
  dataRoot: join(root, 'data'),
  profile: 'upgrade',
  ...(mode === 'cold' ? { mode: 'readonly' as const } : {}),
});
const storeId = (await store.getMetadata()).storeId;
const artifacts = createArtifactStore({
  profile: { dataRoot: join(root, 'data'), profile: 'upgrade' },
  store,
});
let selected = '1',
  calls = 0;
const modulePaths = { '1': v1Path, '2': v2Path }; // Trusted artifact selection, never Model input.
const runtime = createRuntime({
  store,
  artifacts,
  permissions: { authorize: async () => ({ allowed: true, revision: 'owned-fixture' }) },
  resolveRunConfiguration: async ({ command }) => {
    const source = selected as '1' | '2';
    const module = await import(modulePaths[source]);
    const bundle = module.createUpgrade(root, command.id);
    const input = command.request as { content: string };
    const fixed = createFixedModel([
      [
        {
          type: 'tool_call',
          id: `call-${command.id}`,
          name: 'fixture.upgrade.work',
          arguments: JSON.stringify({ mode: input.content }),
        },
        { type: 'finish', reason: 'tool_calls', usage: { inputTokens: 1, outputTokens: 1 } },
      ],
      [{ type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } }],
    ]);
    const model: ModelAdapter = {
      async *stream(...args) {
        calls++;
        yield* fixed.stream(...args);
      },
    };
    return {
      model,
      modelId: 'fixed-upgrade',
      extensions: [bundle.extension],
      dispose: bundle.dispose,
      snapshot: { artifactVersion: source },
      permissions: { authorize: async () => ({ allowed: true, revision: 'owned-fixture' }) },
    };
  },
});
const savedPath = join(root, 'original.json');
if (mode === 'cold') {
  const original = JSON.parse(readFileSync(savedPath, 'utf8'));
  const before = await store.getMetadata();
  const records = await Promise.all(
    original.reads.map(
      (read: { sessionId: string; runId: string; extensionId: string; key: string }) =>
        runtime.readRunExtensionRecord(read),
    ),
  );
  const executions = await Promise.all(
    original.executionIds.map((id: string) => runtime.getExecution(id)),
  );
  const after = await store.getMetadata();
  console.log(
    JSON.stringify({
      storeId,
      calls,
      records,
      executions,
      before: before.lastChangeCursor,
      after: after.lastChangeCursor,
      effects: readFileSync(join(root, 'effects'), 'utf8'),
    }),
  );
  await runtime.close();
  process.exit(0);
}
const service = await startService({
  runtime,
  profile: { dataRoot: join(root, 'data'), name: 'upgrade', accessKey: 'owned-upgrade' },
  buildId: 'stable-upgrade-host',
  subjectId: 'owner',
});
const client = createClient({
  endpoint: service.endpoint,
  token: service.bootstrap.token,
  expected: {
    apiMajor: 1,
    profile: service.bootstrap.profile,
    requiredCapabilities: ['commands', 'sessions'],
  },
});
async function until<T>(read: () => Promise<T>, predicate: (value: T) => boolean) {
  const deadline = Date.now() + 20000;
  for (;;) {
    const value = await read();
    if (predicate(value)) return value;
    if (Date.now() > deadline) throw Error(`fixture_deadline:${JSON.stringify(value)}`);
    await Bun.sleep(5);
  }
}
async function run(sessionId: string, commandId: string, content: string) {
  await client.startRun(sessionId, {
    kind: 'run.start',
    expectedStoreId: storeId,
    commandId,
    content,
  });
  const command = await until(
    () => client.getCommand(commandId),
    (c) => c.status === 'applied' || c.status === 'rejected',
  );
  if (command.status !== 'applied') throw Error(`rejected:${JSON.stringify(command)}`);
  const runId = (command.receipt as { runId: string }).runId;
  const run = await until(
    () => client.getRun(runId),
    (r) => ['completed', 'failed', 'interrupted', 'cancelled'].includes(r.status),
  );
  if (run.status !== 'completed')
    throw Error(`run_failed:${JSON.stringify(await client.getView(sessionId))}`);
  return runId;
}
const lifecycle = () =>
  readFileSync(join(root, 'lifecycle'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
try {
  await client.connect();
  await client.createWorkspace({
    expectedStoreId: storeId,
    id: 'w',
    rootUri: `file://${root}`,
    name: 'Owned upgrade',
  });
  for (const s of ['a', 'b'])
    await client.createSession({
      expectedStoreId: storeId,
      commandId: `create-${s}`,
      sessionId: s,
      workspaceId: 'w',
      title: s,
    });
  const firstRun = await run('a', 'old-work', 'work');
  await until(
    () => client.getView('a'),
    (v) => v.executions.some((e) => e.kind === 'job' && e.status === 'running'),
  );
  const activeOld = lifecycle();
  selected = '2';
  writeFileSync(join(root, 'release-new-work'), 'release');
  const secondRun = await run('b', 'new-work', 'work');
  await until(
    () => client.getView('b'),
    (v) => v.executions.some((e) => e.kind === 'job' && e.status === 'succeeded'),
  );
  await until(
    async () => lifecycle(),
    (events) =>
      events.some((event) => event.scope === 'new-work' && event.kind === 'scope-dispose'),
  );
  const replacement = lifecycle();
  writeFileSync(join(root, 'release-old-work'), 'release');
  await until(
    () => client.getView('a'),
    (v) => v.executions.some((e) => e.kind === 'job' && e.status === 'succeeded'),
  );
  await until(
    async () => lifecycle(),
    (v) => v.some((e) => e.scope === 'old-work' && e.kind === 'scope-dispose'),
  );
  const futureRun = await run('a', 'future-work', 'future');
  const futureBefore = await runtime.readRunExtensionRecord({
    sessionId: 'a',
    runId: futureRun,
    extensionId: 'fixture.upgrade',
    key: 'future',
  });
  selected = '1';
  await run('a', 'inspect-work', 'inspect');
  const futureAfter = await runtime.readRunExtensionRecord({
    sessionId: 'a',
    runId: futureRun,
    extensionId: 'fixture.upgrade',
    key: 'future',
  });
  const reads = [
    { sessionId: 'a', runId: firstRun, extensionId: 'fixture.upgrade', key: 'original' },
    { sessionId: 'a', runId: futureRun, extensionId: 'fixture.upgrade', key: 'future' },
  ];
  const records = await Promise.all(reads.map((r) => runtime.readRunExtensionRecord(r)));
  const viewA = await client.getView('a'),
    viewB = await client.getView('b');
  const executionIds = [...viewA.executions, ...viewB.executions].map((e) => e.id);
  writeFileSync(savedPath, JSON.stringify({ reads, executionIds }));
  console.log(
    JSON.stringify({
      pid: process.pid,
      instanceId: service.bootstrap.instanceId,
      storeId,
      calls,
      firstRun,
      secondRun,
      futureRun,
      activeOld,
      replacement,
      lifecycle: lifecycle(),
      records,
      futureBefore,
      futureAfter,
      executions: [...viewA.executions, ...viewB.executions],
      effects: readFileSync(join(root, 'effects'), 'utf8'),
    }),
  );
} finally {
  await service.close();
  await runtime.close();
}
