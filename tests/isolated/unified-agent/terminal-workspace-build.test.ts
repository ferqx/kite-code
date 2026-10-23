import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildTerminalBundle } from '../../../scripts/release/terminal-bundle';
import { privateDirectory, temporaryDirectory } from '../../fixtures/test-filesystem';

const workspaces = [
  'packages/ai',
  'packages/agent',
  'packages/client',
  'packages/ui',
  'apps/service',
  'apps/cli',
];
type Event = { name: string; phase: string; pid: number; outdir: string; body?: string };

async function fixture(fail: boolean, check: (events: Event[], cause: unknown) => void) {
  const root = temporaryDirectory('kite-terminal-workspace-build-');
  const repository = join(root, 'repository');
  const eventsPath = join(root, 'events.jsonl');
  const buildRoot = join(root, 'build');
  privateDirectory(repository);
  privateDirectory(buildRoot);
  const destination = join(buildRoot, 'candidate');
  const events = (): Event[] =>
    existsSync(eventsPath)
      ? readFileSync(eventsPath, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  let closed = false,
    failed = false,
    businessError: unknown;
  const cleanupErrors: unknown[] = [];
  try {
    for (const [index, workspace] of workspaces.entries()) {
      const source = join(repository, workspace);
      mkdirSync(source, { recursive: true });
      const name = `@fixture/workspace-${index}`;
      writeFileSync(
        join(source, 'package.json'),
        JSON.stringify({
          name,
          version: '1',
          exports: { '.': './src/index.ts' },
          scripts: { build: 'bun build-fixture.ts first dist && bun build-fixture.ts second dist' },
        }),
      );
      writeFileSync(
        join(source, 'build-fixture.ts'),
        `import {appendFileSync,existsSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
const [phase,outdir]=process.argv.slice(2),name=${JSON.stringify(name)},index=${index};
const log=(value)=>appendFileSync(${JSON.stringify(eventsPath)},JSON.stringify({name,phase:value,pid:process.pid,outdir})+'\\n');
log(phase+'_started');
if(${fail}&&index===0){await Bun.sleep(150);log('failed');process.exit(17);}
if(phase==='first'){
  await Bun.sleep(${fail ? 400 : 80});
  if(!existsSync(outdir))throw Error('candidate_removed_while_original_child_live');
  writeFileSync(join(outdir,'index.js'),'export const owner='+JSON.stringify(name)+';');
}else{
  const bytes=readFileSync(join(outdir,'index.js'),'utf8');
  if(bytes!=='export const owner='+JSON.stringify(name)+';')throw Error('workspace_output_changed');
  appendFileSync(${JSON.stringify(eventsPath)},JSON.stringify({name,phase:'original_output',pid:process.pid,outdir,body:bytes})+'\\n');
}
log(phase+'_finished');
if(${fail}&&phase==='second')process.exit(23);
`,
      );
    }
    let cause: unknown;
    try {
      await buildTerminalBundle({ repositoryRoot: repository, destination });
    } catch (error) {
      cause = error;
    }
    const recorded = events();
    expect(cause).toBeDefined();
    expect(existsSync(destination)).toBe(false);
    for (const pid of new Set(recorded.map((event) => event.pid))) {
      let ended: unknown;
      try {
        process.kill(pid, 0);
      } catch (error) {
        ended = error;
      }
      expect(ended).toMatchObject({ code: 'ESRCH' });
    }
    closed = true;
    check(recorded, cause);
  } catch (error) {
    failed = true;
    businessError = error;
  }
  try {
    if (!closed) {
      const until = Date.now() + 3000;
      for (;;) {
        const live = [...new Set(events().map((event) => event.pid))].filter((pid) => {
          try {
            process.kill(pid, 0);
            return true;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
            return false;
          }
        });
        if (!live.length) break;
        if (Date.now() > until) throw Error(`terminal_fixture_children_unconfirmed:${root}`);
        await Bun.sleep(20);
      }
    }
    rmSync(root, { recursive: true, force: false });
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (cleanupErrors.length)
    throw new AggregateError(
      [...(failed ? [businessError] : []), ...cleanupErrors],
      `terminal_fixture_cleanup_unconfirmed:${root}`,
    );
  if (failed) throw businessError;
}

test.skipIf(process.platform !== 'win32')(
  'workspace failure waits for the original sibling segments and stops assigning new outputs before cleanup',
  async () => {
    await fixture(true, (events, cause) => {
      expect(String(cause)).toContain('terminal_build_failed:build-fixture.ts');
      expect([...new Set(events.map((event) => event.name))].sort()).toEqual([
        '@fixture/workspace-0',
        '@fixture/workspace-1',
      ]);
      const phases = events.map((event) => `${event.name}:${event.phase}`);
      expect(phases.indexOf('@fixture/workspace-1:first_started')).toBeLessThan(
        phases.indexOf('@fixture/workspace-0:failed'),
      );
      expect(phases.indexOf('@fixture/workspace-0:failed')).toBeLessThan(
        phases.indexOf('@fixture/workspace-1:first_finished'),
      );
      expect(phases.at(-1)).toBe('@fixture/workspace-1:second_finished');
      expect(events.filter((event) => event.phase === 'original_output')).toHaveLength(1);
    });
  },
  10000,
);

test.skipIf(process.platform !== 'win32')(
  'two workspace builders keep each original output and ordered segments until all exports are checked',
  async () => {
    await fixture(false, (events, cause) => {
      // The six complete fake workspaces intentionally have no Service wrapper.
      // Reaching its rename proves all normal workspace export checks completed.
      expect(String(cause)).toContain('ENOENT');
      expect(String(cause)).toContain('main.js');
      const outputs = events.filter((event) => event.phase === 'original_output');
      expect(outputs).toHaveLength(6);
      expect(new Set(outputs.map((event) => event.outdir)).size).toBe(6);
      for (const [index] of workspaces.entries()) {
        const name = `@fixture/workspace-${index}`;
        expect(events.filter((event) => event.name === name).map((event) => event.phase)).toEqual([
          'first_started',
          'first_finished',
          'second_started',
          'original_output',
          'second_finished',
        ]);
        expect(outputs.find((event) => event.name === name)?.body).toBe(
          `export const owner=${JSON.stringify(name)};`,
        );
      }
      let active = 0;
      let maximum = 0;
      for (const event of events) {
        if (event.phase === 'first_started') active++;
        if (event.phase === 'second_finished') active--;
        maximum = Math.max(maximum, active);
      }
      expect(active).toBe(0);
      expect(maximum).toBe(2);
    });
  },
  10000,
);
