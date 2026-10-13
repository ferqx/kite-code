import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileFileRecoveryTUI, fileRecoveryProfile } from '../fixtures/file-recovery-profile';
import { runFileRecoveryPTY } from '../fixtures/file-recovery-pty';

const repo = resolve(import.meta.dir, '../../../..');
test('80x24 actual TUI Files directory both independent Ask and explicit second leg switches only to original new Session', async () => {
  const f = await fileRecoveryProfile();
  try {
    const runner = join(f.root, 'tui.ts');
    writeFileSync(
      runner,
      `import {appendFileSync,writeFileSync} from 'node:fs';const actual=globalThis.fetch;globalThis.fetch=Object.assign(async(...args:Parameters<typeof fetch>)=>{const opts=args[1];appendFileSync(${JSON.stringify(join(f.root, 'wire'))},JSON.stringify({method:opts?.method??'GET',path:new URL(String(args[0])).pathname})+'\\n');const start=Date.now();try{const response=await actual(...args);appendFileSync(${JSON.stringify(join(f.root, 'wire'))},JSON.stringify({done:true,status:response.status,path:new URL(String(args[0])).pathname,ms:Date.now()-start})+'\\n');return response;}catch(error){appendFileSync(${JSON.stringify(join(f.root, 'wire'))},JSON.stringify({failed:String(error),path:new URL(String(args[0])).pathname})+'\\n');throw error;}},{preconnect:actual.preconnect});import {runTUIHost} from ${JSON.stringify(pathToFileURL(join(repo, 'apps/cli/host/tui.tsx')).href)};await runTUIHost({testDiagnostics:true,dataRoot:${JSON.stringify(f.profile.dataRoot)},profile:'owned',thread:'s',cwd:${JSON.stringify(f.workspace)},artifact:${JSON.stringify(f.artifact)},onLaunched:({pid})=>writeFileSync(${JSON.stringify(join(f.root, 'service.pid'))},String(pid),{mode:0o600})});`,
    );
    expect((await compileFileRecoveryTUI(f.root, runner)).success).toBe(true);
    const transcript = join(tmpdir(), `kite-file-recovery-both-${randomUUID()}.pty.log`);
    const { code, out, err } = await runFileRecoveryPTY(f, { mode: 'both', transcript });
    if (code !== 0) {
      console.error(err);
      console.error('PTY_TRANSCRIPT', transcript);
      console.error(readFileSync(join(f.root, 'wire'), 'utf8'));
    }
    expect(code).toBe(0);
    expect(out).toContain('FILE_BOTH_ORIGINAL_CONFIRMED');
    expect(readFileSync(f.file, 'utf8')).toBe('original bytes\r\n');
    expect(f.calls()).toBe(3);
    const journal = JSON.parse(
      readFileSync(join(f.profile.profilePath, 'ui/file-recovery-intents.json'), 'utf8'),
    );
    expect(journal.records).toHaveLength(1);
    expect(journal.records[0].code.phase).toBe('succeeded');
    expect(journal.records[0].fork.phase).toBe('succeeded');
  } finally {
    f.close();
  }
}, 70000);
