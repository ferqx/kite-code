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
import { launchPairedService } from '@kite-ai/service/paired';
import { includeHistoricalResult, lookupContextOutcome, rewindContext, run } from '../src';

test('active include is queued for original Run; actual checkpoint supplies exact source without replay', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-active-context-')));
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'new' });
  const handle = await launchPairedService({
    entrypoint: join(import.meta.dir, 'fixtures/context-active-child.ts'),
    profile,
    instanceId: 'active-context',
    buildId: 'active-context',
    apiMajor: 1,
    requiredCapabilities: ['context', 'commands'],
  });
  const client = handle.client,
    expectedStoreId = handle.bootstrap.storeId!;
  const options = { client, write(_line: string) {}, pollIntervalMs: 5 };
  async function until<T>(read: () => Promise<T>, ready: (v: T) => boolean) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const value = await read();
      if (ready(value)) return value;
      await Bun.sleep(5);
    }
    throw new Error('bounded fixture wait');
  }
  try {
    await client.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'tmp',
      rootUri: `file://${root}`,
    });
    await client.createSession({
      expectedStoreId,
      commandId: 'create',
      sessionId: 's',
      workspaceId: 'w',
      title: 's',
    });
    expect(
      (
        await run(
          's',
          { expectedStoreId, commandId: 'first', kind: 'run.start', content: 'launch' },
          options,
        )
      ).status,
    ).toBe('succeeded');
    writeFileSync(join(profile.profilePath, 'finish-job'), 'end');
    let view = await until(
      () => client.getView('s'),
      (v) => v.executions.some((e) => e.kind === 'job' && e.status === 'succeeded'),
    );
    const job = view.executions.find((e) => e.kind === 'job')!;
    expect(
      (
        await rewindContext(
          's',
          {
            expectedStoreId,
            commandId: 'rewind',
            expectedContextSelectionId: view.session.contextSelectionId,
            boundary: null,
          },
          options,
        )
      ).status,
    ).toBe('applied');
    const work = run(
      's',
      { expectedStoreId, commandId: 'active', kind: 'run.start', content: 'waiting' },
      options,
    );
    view = await until(
      () => client.getView('s'),
      (v) =>
        v.runs.some((r) => r.isActive) &&
        existsSync(join(profile.profilePath, 'models')) &&
        readFileSync(join(profile.profilePath, 'models'), 'utf8').trim().split('\n').length === 3,
    );
    const targetRunId = view.runs.find((r) => r.isActive)!.id;
    const saved = await includeHistoricalResult(
      's',
      job.id,
      {
        expectedStoreId,
        commandId: 'include-active',
        expectedContextSelectionId: view.session.contextSelectionId,
        resultRevision: job.resultRevision,
        targetRunId,
      },
      options,
    );
    expect(saved.status).toBe('queued');
    expect((await lookupContextOutcome(saved, options)).status).toBe('queued');
    expect((await client.getContext('s', { storeId: expectedStoreId })).resultSources).toHaveLength(
      0,
    );
    writeFileSync(join(profile.profilePath, 'finish-model'), 'end');
    expect((await work).status).toBe('succeeded');
    expect((await lookupContextOutcome(saved, options)).status).toBe('applied');
    const context = await client.getContext('s', { storeId: expectedStoreId });
    const source = context.resultSources.find((s) => s.executionId === job.id)!;
    expect(source.resultRevision).toBe(job.resultRevision);
    const requests = readFileSync(join(profile.profilePath, 'models'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(
      requests[2].messages.some((m: { sourceIds?: string[] }) => m.sourceIds?.includes(source.id)),
    ).toBe(false);
    expect(
      requests[3].messages.some(
        (m: { sourceIds?: string[]; content: string }) =>
          m.sourceIds?.includes(source.id) && m.content.includes('historical untrusted data'),
      ),
    ).toBe(true);
    expect(readFileSync(join(profile.profilePath, 'effects'), 'utf8')).toBe('one\n');
    expect(existsSync(join(profile.profilePath, 'stale-effects'))).toBe(false);
  } finally {
    writeFileSync(join(profile.profilePath, 'finish-model'), 'cleanup');
    writeFileSync(join(profile.profilePath, 'finish-job'), 'cleanup');
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);
