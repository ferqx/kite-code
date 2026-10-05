import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { lookupRecovery, type RecoveryIntent, submitRecovery } from '../../src/recovery';
import { untilRecovery } from '../fixtures/recovery-profile';
import { recoveryReportProfile } from '../fixtures/recovery-report-profile';

test('actual configured host cold report caller preserves completed parent and original child effect, creating one source-bound report Run', async () => {
  const f = await recoveryReportProfile();
  const service = await f.launch().catch((error) => {
    f.close();
    throw error;
  });
  try {
    expect(f.calls()).toEqual({ parentCalls: 2, childCalls: 1, reviewCalls: 2 });
    expect((await service.client.getRun(f.parentId)).status).toBe('completed');
    expect((await service.client.getCommand(f.reportId)).kind).toBe('job.report');
    const intent: RecoveryIntent = {
      kind: 'report',
      sessionId: 's',
      reportCommandId: f.reportId,
      request: { expectedStoreId: f.storeId, commandId: 'original-report-recovery' },
    };
    const resumed = await submitRecovery(intent, { client: service.client });
    expect(resumed.status).toBe('resumed');
    expect(resumed.run?.originCommandId).toBe(f.reportId);
    await untilRecovery(
      async () => (await service.client.getRun(resumed.run!.id)).status === 'completed',
    );
    const completed = await lookupRecovery(intent, { client: service.client });
    expect(completed.exitCode).toBe(0);
    expect(
      f.rows("SELECT origin_command_id,status FROM run WHERE session_id='s' ORDER BY started_at"),
    ).toEqual([
      { origin_command_id: 'work', status: 'completed' },
      { origin_command_id: f.reportId, status: 'completed' },
    ]);
    expect(
      f.rows(
        `SELECT state,attempt,result_revision,delivery FROM execution WHERE id='${f.executionId}'`,
      ),
    ).toEqual([{ state: 'succeeded', attempt: 1, result_revision: 1, delivery: 'consumed' }]);
    expect(f.calls()).toEqual({ parentCalls: 3, childCalls: 1, reviewCalls: 2 });
    expect(
      readFileSync(f.ledger, 'utf8')
        .split('\n')
        .filter((line) => line !== 'review')
        .join('\n'),
    ).toBe('parent-start\nparent-complete\nchild\nreport\n');
    expect((await submitRecovery(intent, { client: service.client })).command?.id).toBe(
      intent.request.commandId,
    );
    expect(f.calls()).toEqual({ parentCalls: 3, childCalls: 1, reviewCalls: 2 });
  } finally {
    await service.close();
    f.close();
  }
}, 30000);

test('compiled paired CLI report recovery and journal reference lookup preserve original completed parent and unique report Run', async () => {
  const { writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const f = await recoveryReportProfile();
  try {
    const source = join(f.root, 'artifact/cli-report.ts'),
      network = join(f.root, 'cli-report-network');
    writeFileSync(
      source,
      `import {appendFileSync} from 'node:fs';import {runCLIProcess} from ${JSON.stringify(new URL('../../host/main.ts', import.meta.url).pathname)};const actual=globalThis.fetch;globalThis.fetch=Object.assign(async(...args:Parameters<typeof fetch>)=>{appendFileSync(${JSON.stringify(network)},JSON.stringify({method:args[1]?.method??'GET',path:new URL(String(args[0])).pathname})+'\\n');return actual(...args);},{preconnect:actual.preconnect});process.exitCode=await runCLIProcess({profile:'owned',argv:process.argv.slice(2),resolveArtifact:()=>(${JSON.stringify(f.artifact)})});`,
    );
    const built = await Bun.build({
      entrypoints: [source],
      target: 'bun',
      packages: 'external',
      outdir: join(f.root, 'artifact'),
    });
    expect(built.success).toBe(true);
    const invoke = async (action: 'report' | 'lookup') => {
      const child = Bun.spawn(
        [
          process.execPath,
          join(f.root, 'artifact/cli-report.js'),
          'recovery',
          action,
          's',
          ...(action === 'report' ? [f.reportId] : []),
          '--data-root',
          f.profile.dataRoot,
          '--input',
          JSON.stringify({ expectedStoreId: f.storeId, commandId: 'compiled-report-recovery' }),
        ],
        { cwd: f.workspace, stdout: 'pipe', stderr: 'pipe' },
      );
      try {
        const [out, err, exit] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect(err).toBe('');
        expect(exit).toBe(0);
        const fact = JSON.parse(out.trim().split('\n').at(-1)!);
        expect(fact.status).toBe('resumed');
        expect(fact.run.originCommandId).toBe(f.reportId);
        expect(fact.run.status).toBe('completed');
        return fact;
      } finally {
        if (child.exitCode === null) {
          child.kill('SIGKILL');
          await child.exited;
        }
      }
    };
    const first = await invoke('report'),
      second = await invoke('lookup');
    expect(second.run.id).toBe(first.run.id);
    expect(
      f.rows("SELECT origin_command_id,status FROM run WHERE session_id='s' ORDER BY started_at"),
    ).toEqual([
      { origin_command_id: 'work', status: 'completed' },
      { origin_command_id: f.reportId, status: 'completed' },
    ]);
    expect(f.calls()).toEqual({ parentCalls: 3, childCalls: 1, reviewCalls: 2 });
    const requests = readFileSync(network, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(
      requests.filter(
        (row) =>
          row.method === 'POST' && row.path === `/v1/sessions/s/job-reports/${f.reportId}/resume`,
      ),
    ).toHaveLength(1);
    expect(
      requests.filter(
        (row) => row.path === '/v1/commands/compiled-report-recovery' && row.method === 'GET',
      ),
    ).toHaveLength(1);
  } finally {
    f.close();
  }
}, 30000);
