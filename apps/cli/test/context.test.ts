import { expect, test } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectProfile } from '@kite-ai/agent/profile';
import type { ModelRequest } from '@kite-ai/ai';
import { createDesktopController } from '@kite-ai/desktop';
import { launchPairedService } from '@kite-ai/service/paired';
import { getContext, includeHistoricalResult, rewindContext, run } from '../src';

test('actual paired Context rewind/include saves exact source without replay; only explicit next Run sees source', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-client-context-')));
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'new' });
  const handle = await launchPairedService({
    entrypoint: join(import.meta.dir, 'fixtures/context-child.ts'),
    profile,
    instanceId: 'context-client',
    buildId: 'context-client',
    apiMajor: 1,
    requiredCapabilities: ['context', 'commands'],
  });
  const client = handle.client;
  const expectedStoreId = handle.bootstrap.storeId!;
  const lines: string[] = [];
  const options = { client, write: (line: string) => lines.push(line), pollIntervalMs: 5 };
  const models = () =>
    readFileSync(join(profile.profilePath, 'models'), 'utf8')
      .trim()
      .split('\n')
      .map((value) => JSON.parse(value) as ModelRequest);
  try {
    await client.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'temporary',
      rootUri: `file://${root}`,
    });
    await client.createSession({
      expectedStoreId,
      commandId: 'create',
      sessionId: 's',
      workspaceId: 'w',
      title: 'context',
    });
    expect(
      (
        await run(
          's',
          { expectedStoreId, commandId: 'work', kind: 'run.start', content: 'launch' },
          options,
        )
      ).status,
    ).toBe('succeeded');
    writeFileSync(join(profile.profilePath, 'finish-job'), 'end');
    const deadline = Date.now() + 4000;
    let job: import('@kite-ai/client').Execution | undefined;
    let observedJobs: import('@kite-ai/client').Execution[] = [];
    while (Date.now() < deadline) {
      observedJobs = (await client.getView('s')).executions.filter((value) => value.kind === 'job');
      job = observedJobs.find((value) => value.status === 'succeeded');
      if (job) break;
      await Bun.sleep(5);
    }
    if (!job)
      console.error(
        JSON.stringify({
          fixture: 'context_job_completion_unobserved',
          releaseExists: existsSync(join(profile.profilePath, 'finish-job')),
          jobs: observedJobs.map(({ id, status, resultRevision, delivery }) => ({
            id,
            status,
            resultRevision,
            delivery,
          })),
          diagnostics: handle.diagnostics,
        }),
      );
    expect(job).toBeDefined();
    expect(job!.delivery).toBe('pending');
    expect(models()).toHaveLength(2);
    const context = await getContext('s', { storeId: expectedStoreId }, options);
    const rewind = {
      expectedStoreId,
      commandId: 'rewind',
      expectedContextSelectionId: context.selection.id,
      boundary: null,
    };
    const one = rewindContext('s', rewind, options);
    const duplicate = rewindContext('s', rewind, options);
    expect(duplicate).toBe(one);
    expect((await one).status).toBe('applied');
    const selected = await client.getContext('s', { storeId: expectedStoreId });
    expect(selected.messages).toEqual([]);
    expect(selected.resultSources).toEqual([]);
    const historical = await client.getExecution(job!.id);
    expect(historical.delivery).toBe('suppressed');
    expect(historical.deliveryReason).toBe('context_rewound');
    const desktop = createDesktopController({ admittedClient: client, onSnapshot() {} });
    await desktop.selectSession('s');
    const include = desktop.includeHistoricalResult(historical);
    const same = desktop.includeHistoricalResult(historical);
    expect(same).toBe(include);
    expect((await include).status).toBe('applied');
    const withSource = await client.getContext('s', { storeId: expectedStoreId });
    const source = withSource.resultSources[0]!;
    expect(source.executionId).toBe(job!.id);
    expect(source.resultRevision).toBe(job!.resultRevision);
    expect(source.originStoreId).toBe(expectedStoreId);
    expect(source.inclusion).toBe('explicit');
    expect(models()).toHaveLength(2);
    expect(readFileSync(join(profile.profilePath, 'effects'), 'utf8')).toBe('one\n');
    const secondInclude = await includeHistoricalResult(
      's',
      job!.id,
      {
        expectedStoreId,
        commandId: 'repeat-explicit',
        expectedContextSelectionId: withSource.selection.id,
        resultRevision: job!.resultRevision,
      },
      options,
    );
    expect(secondInclude.status).toBe('applied');
    expect(
      (await client.getContext('s', { storeId: expectedStoreId })).resultSources.map(
        (value) => value.id,
      ),
    ).toEqual([source.id]);
    expect(
      (
        await run(
          's',
          {
            expectedStoreId,
            commandId: 'new-work',
            kind: 'run.start',
            content: 'use selected context',
          },
          options,
        )
      ).status,
    ).toBe('succeeded');
    expect(models()).toHaveLength(3);
    const message = models()[2]!.messages.find((value) => value.sourceIds?.includes(source.id));
    expect(message?.role).toBe('user');
    expect(message?.content).toContain(job!.id);
    expect(readFileSync(join(profile.profilePath, 'effects'), 'utf8')).toBe('one\n');
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);

test('unknown CLI Context receipt queries only saved command and explicit lookup keeps exact identity', async () => {
  const { lookupContextOutcome } = await import('../src');
  let mutations = 0;
  let reads = 0;
  const identities: string[] = [];
  const client = {
    async rewind(session: string, input: { commandId: string }) {
      expect(session).toBe('original');
      expect(input.commandId).toBe('same');
      mutations++;
      throw new Error('lost');
    },
    async getCommand(id: string) {
      identities.push(id);
      reads++;
      if (reads === 1) throw new Error('unknown');
      return {
        id,
        sessionId: 'original',
        originStoreId: 'old-store',
        status: 'applied',
        kind: 'context.select',
        receipt: {},
        cancelRequestedAt: null,
      };
    },
  } as unknown as import('@kite-ai/client').AgentClient;
  const options = { client, write() {} };
  const request = {
    expectedStoreId: 'old-store',
    commandId: 'same',
    expectedContextSelectionId: 'original-selection',
    boundary: null,
  };
  const unknown = await rewindContext('original', request, options);
  expect(unknown.status).toBe('outcome_unknown');
  request.expectedContextSelectionId = 'changed';
  const applied = await lookupContextOutcome(unknown, options);
  expect(applied.status).toBe('applied');
  expect(applied.request.expectedContextSelectionId).toBe('original-selection');
  expect(applied.sessionId).toBe('original');
  expect(mutations).toBe(1);
  expect(identities).toEqual(['same', 'same']);
});
