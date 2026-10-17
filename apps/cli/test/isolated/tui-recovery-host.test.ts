import { expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { privateDirectory } from '../../../../tests/fixtures/test-filesystem';
import { compileFileRecoveryTUI } from '../fixtures/file-recovery-profile';
import { recoveryProfile } from '../fixtures/recovery-profile';
import { runRecoveryPTY } from '../fixtures/tui-recovery-pty';

const repo = resolve(import.meta.dir, '../../../..');
for (const mode of ['run', 'interrupt'] as const)
  test(`80x24 actual TUI ${mode} retains original cold intent through lost receipt, Ctrl+C and Ctrl+L`, async () => {
    const f = await recoveryProfile();
    try {
      const runner = join(f.root, 'runner.ts'),
        network = join(f.root, 'network');
      writeFileSync(
        runner,
        `import {appendFileSync,writeFileSync} from 'node:fs';import {runTUIHost} from ${JSON.stringify(pathToFileURL(join(repo, 'apps/cli/host/tui.tsx')).href)};const actual=globalThis.fetch;let saved,lost=false;globalThis.fetch=Object.assign(async(...args:Parameters<typeof fetch>)=>{const options=args[1],path=new URL(String(args[0])).pathname,body=options?.body?JSON.parse(String(options.body)):null;appendFileSync(${JSON.stringify(network)},JSON.stringify({method:options?.method??'GET',path,body})+'\\n');const result=await actual(...args);if(options?.method==='POST'&&['run.resume','session.recover'].includes(body?.kind)){saved=body.commandId;await result.arrayBuffer();throw Error('committed response physically lost');}if(saved&&!lost&&path==='/v1/commands/'+saved){lost=true;await result.arrayBuffer();writeFileSync(${JSON.stringify(join(f.root, 'lost'))},'lost');throw Error('first original GET physically lost');}return result;},{preconnect:actual.preconnect});await runTUIHost({testDiagnostics:true,dataRoot:${JSON.stringify(f.profile.dataRoot)},profile:'owned',thread:'s',cwd:${JSON.stringify(f.workspace)},artifact:${JSON.stringify(f.artifact)},onLaunched:({pid})=>writeFileSync(${JSON.stringify(join(f.root, 'service-pid'))},String(pid))});`,
      );
      const built = await compileFileRecoveryTUI(f.root, runner);
      if (!built.success) throw new AggregateError(built.logs, 'recovery_tui_compile_failed');
      const { out, err, code } = await runRecoveryPTY(
        {
          root: f.root,
          runner: join(f.root, 'runner.js'),
          profilePath: f.profile.profilePath,
          network,
          pidPath: join(f.root, 'service-pid'),
          transcript: join(f.root, 'pty-output'),
          mode,
          runId: f.run.id,
          storeId: f.storeId,
          cardId: f.card.id,
        },
        f.userConfiguration.homeEnvironment,
      );
      if (code !== 0) console.error(err);
      expect(code).toBe(0);
      expect(out).toContain('ORIGINAL_RECOVERY_CONFIRMED');
      const rows = readFileSync(network, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)) as {
        method: string;
        path: string;
        body?: { kind?: string; commandId?: string; runId?: string };
      }[];
      const mutations = rows.filter(
        (row) =>
          row.method === 'POST' && ['run.resume', 'session.recover'].includes(row.body?.kind ?? ''),
      );
      expect(mutations).toHaveLength(1);
      const id = mutations[0]!.body!.commandId!;
      expect(
        rows.filter((row) => row.path === `/v1/commands/${id}` && row.method === 'GET').length,
      ).toBeGreaterThanOrEqual(2);
      expect(rows.filter((row) => row.body?.kind === 'command.cancel')).toHaveLength(0);
      expect(f.rows("SELECT id,origin_command_id,status FROM run WHERE session_id='s'")).toEqual([
        {
          id: f.run.id,
          origin_command_id: 'work',
          status: mode === 'run' ? 'completed' : 'interrupted',
        },
      ]);
      expect(f.reviews).toHaveLength(1);
      expect(f.reviewProof()).toEqual([
        {
          state: 'succeeded',
          outcome: 'succeeded',
          decision: 'ask_user',
          target: (f.reviews[0]!.input.target as { executionId: string }).executionId,
        },
      ]);
      if (mode === 'run') {
        expect(mutations[0]!.body!.runId).toBe(f.run.id);
        expect(readFileSync(join(f.workspace, 'effect'), 'utf8')).toBe('ORIGINAL_EFFECT_ONCE');
        expect(readFileSync(f.ledger, 'utf8')).toBe('decision\ncompletion\n');
      } else {
        expect(f.calls()).toBe(1);
        expect(existsSync(join(f.workspace, 'effect'))).toBe(false);
      }
    } finally {
      f.close();
    }
  }, 30000);

for (const kind of ['run', 'interrupt'] as const)
  test(`80x24 TUI host SIGKILL restores durable ${kind} unknown and performs only the original GET`, async () => {
    const f = await recoveryProfile();
    const transcript = `${f.root}-cold-${kind}.pty.log`;
    try {
      const runner = join(f.root, 'cold-runner.ts'),
        network = join(f.root, 'cold-network'),
        pidPath = join(f.root, 'service-pid');
      writeFileSync(
        runner,
        `import {appendFileSync,writeFileSync} from 'node:fs';import {runTUIHost} from ${JSON.stringify(pathToFileURL(join(repo, 'apps/cli/host/tui.tsx')).href)};const actual=globalThis.fetch;let saved,lost=false;globalThis.fetch=Object.assign(async(...args:Parameters<typeof fetch>)=>{const options=args[1],path=new URL(String(args[0])).pathname,body=options?.body?JSON.parse(String(options.body)):null;appendFileSync(${JSON.stringify(network)},JSON.stringify({pid:process.pid,method:options?.method??'GET',path,body})+'\\n');const result=await actual(...args);if(options?.method==='POST'&&['run.resume','session.recover'].includes(body?.kind)){saved=body.commandId;await result.arrayBuffer();throw Error('committed recovery response lost');}if(saved&&!lost&&path==='/v1/commands/'+saved){lost=true;await result.arrayBuffer();throw Error('original GET lost');}return result;},{preconnect:actual.preconnect});await runTUIHost({testDiagnostics:true,dataRoot:${JSON.stringify(f.profile.dataRoot)},profile:'owned',thread:'s',cwd:${JSON.stringify(f.workspace)},artifact:${JSON.stringify(f.artifact)},onLaunched:({pid})=>writeFileSync(${JSON.stringify(pidPath)},String(pid))});`,
      );
      const built = await compileFileRecoveryTUI(f.root, runner);
      if (!built.success) throw new AggregateError(built.logs, 'recovery_tui_compile_failed');
      const { out, err, code } = await runRecoveryPTY(
        {
          root: f.root,
          runner: join(f.root, 'cold-runner.js'),
          profilePath: f.profile.profilePath,
          network,
          pidPath,
          transcript,
          mode: kind,
          cold: true,
          runId: f.run.id,
          storeId: f.storeId,
        },
        f.userConfiguration.homeEnvironment,
      );
      console.log('PTY transcript', transcript);
      if (code !== 0) console.error(err);
      expect(code).toBe(0);
      expect(out).toContain('COLD_ORIGINAL_JOURNAL_ONLY_GET');
      expect(f.rows("SELECT id,origin_command_id FROM run WHERE session_id='s'")).toEqual([
        { id: f.run.id, origin_command_id: 'work' },
      ]);
      expect(f.calls()).toBe(1);
      expect(f.reviews).toHaveLength(1);
      expect(f.reviewProof()).toEqual([
        {
          state: 'succeeded',
          outcome: 'succeeded',
          decision: 'ask_user',
          target: (f.reviews[0]!.input.target as { executionId: string }).executionId,
        },
      ]);
      expect(existsSync(join(f.workspace, 'effect'))).toBe(false);
      expect(f.rows("SELECT kind FROM command WHERE kind='command.cancel'")).toEqual([]);
      const journal = JSON.parse(
        readFileSync(join(f.profile.profilePath, 'ui/recovery.json'), 'utf8'),
      );
      expect(journal.records).toHaveLength(1);
      expect(journal.records[0].phase).toBe(kind === 'run' ? 'resumed' : 'interrupted');
      expect(JSON.stringify(journal)).not.toMatch(/token|generation|lease/);
    } finally {
      f.close();
    }
  }, 30000);

test('80x24 configured-host TUI original report ID creates one source-bound report Run after lost receipt and original GET', async () => {
  const { recoveryReportProfile } = await import('../fixtures/recovery-report-profile');
  const f = await recoveryReportProfile();
  const transcript = `${f.root}-report.pty.log`;
  try {
    privateDirectory(join(f.profile.profilePath, 'ui'));
    writeFileSync(join(f.profile.profilePath, 'ui/preferences.jsonc'), '{"language":"en-US"}', {
      mode: 0o600,
    });
    const runner = join(f.root, 'tui-report.ts'),
      network = join(f.root, 'report-network');
    writeFileSync(
      runner,
      `import {appendFileSync,writeFileSync} from 'node:fs';import {runTUIHost} from ${JSON.stringify(pathToFileURL(join(repo, 'apps/cli/host/tui.tsx')).href)};const actual=globalThis.fetch;let saved,lost=false;globalThis.fetch=Object.assign(async(...args:Parameters<typeof fetch>)=>{const options=args[1],path=new URL(String(args[0])).pathname,body=options?.body?JSON.parse(String(options.body)):null;appendFileSync(${JSON.stringify(network)},JSON.stringify({method:options?.method??'GET',path,body})+'\\n');const result=await actual(...args);if(options?.method==='POST'&&path===${JSON.stringify(`/v1/sessions/s/job-reports/${f.reportId}/resume`)}){saved=body.commandId;await result.arrayBuffer();throw Error('committed original report recovery response lost');}if(saved&&!lost&&path==='/v1/commands/'+saved){lost=true;await result.arrayBuffer();throw Error('first original report recovery GET lost');}return result;},{preconnect:actual.preconnect});await runTUIHost({testDiagnostics:true,dataRoot:${JSON.stringify(f.profile.dataRoot)},profile:'owned',thread:'s',cwd:${JSON.stringify(f.workspace)},artifact:${JSON.stringify(f.artifact)},onLaunched:({pid})=>writeFileSync(${JSON.stringify(join(f.root, 'service-pid'))},String(pid))});`,
    );
    const built = await compileFileRecoveryTUI(f.root, runner);
    if (!built.success) throw new AggregateError(built.logs, 'recovery_tui_compile_failed');
    const { out, err, code } = await runRecoveryPTY({
      root: f.root,
      runner: join(f.root, 'tui-report.js'),
      profilePath: f.profile.profilePath,
      network,
      pidPath: join(f.root, 'service-pid'),
      transcript,
      mode: 'report',
      reportId: f.reportId,
    });
    console.log('PTY transcript', transcript);
    if (code !== 0) console.error(err);
    expect(code).toBe(0);
    expect(out).toContain('ORIGINAL_REPORT_RUN_CONFIRMED');
    const rows = readFileSync(network, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line)) as {
      method: string;
      path: string;
      body?: { commandId?: string; kind?: string };
    }[];
    const posts = rows.filter(
      (row) =>
        row.method === 'POST' && row.path === `/v1/sessions/s/job-reports/${f.reportId}/resume`,
    );
    expect(posts).toHaveLength(1);
    const original = posts[0]!.body!.commandId!;
    expect(
      rows.filter((row) => row.method === 'GET' && row.path === `/v1/commands/${original}`).length,
    ).toBeGreaterThanOrEqual(2);
    expect(rows.filter((row) => row.body?.kind === 'command.cancel')).toHaveLength(0);
    expect(
      f.rows("SELECT origin_command_id,status FROM run WHERE session_id='s' ORDER BY started_at"),
    ).toEqual([
      { origin_command_id: 'work', status: 'completed' },
      { origin_command_id: f.reportId, status: 'completed' },
    ]);
    expect(f.calls()).toEqual({ parentCalls: 3, childCalls: 1, reviewCalls: 2 });
    expect(
      f.rows(
        `SELECT state,attempt,result_revision,delivery FROM execution WHERE id='${f.executionId}'`,
      ),
    ).toEqual([{ state: 'succeeded', attempt: 1, result_revision: 1, delivery: 'consumed' }]);
  } finally {
    f.close();
  }
}, 30000);
