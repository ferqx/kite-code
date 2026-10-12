import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileFileRecoveryTUI, fileRecoveryProfile } from '../fixtures/file-recovery-profile';
import { runFileRecoveryPTY } from '../fixtures/file-recovery-pty';

const repo = resolve(import.meta.dir, '../../../..');
test('compiled actual TUI lost Code and Fork receipts query only original IDs after independent Ask', async () => {
  const f = await fileRecoveryProfile();
  try {
    const runner = join(f.root, 'tui.ts');
    writeFileSync(
      runner,
      `import {appendFileSync,writeFileSync} from 'node:fs';const actual=globalThis.fetch;let saved:string|undefined,lost=false;globalThis.fetch=Object.assign(async(...args:Parameters<typeof fetch>)=>{const opts=args[1],path=new URL(String(args[0])).pathname,body=opts?.body?JSON.parse(String(opts.body)):null;appendFileSync(${JSON.stringify(join(f.root, 'wire'))},JSON.stringify({method:opts?.method??'GET',path,body})+'\\n');const response=await actual(...args);if(opts?.method==='POST'&&(body?.kind==='extension.invoke'||(path.endsWith('/fork')&&body?.newSessionId))){saved=body.commandId;lost=false;await response.arrayBuffer();throw Error('committed POST response physically lost');}if(saved&&!lost&&path==='/v1/commands/'+saved){lost=true;const text=await response.text();return new Response(text.slice(0,Math.max(1,Math.floor(text.length/2))),{status:response.status,headers:response.headers});}return response;},{preconnect:actual.preconnect});import {runTUIHost} from ${JSON.stringify(pathToFileURL(join(repo, 'apps/cli/host/tui.tsx')).href)};await runTUIHost({dataRoot:${JSON.stringify(f.profile.dataRoot)},profile:'owned',thread:'s',cwd:${JSON.stringify(f.workspace)},artifact:${JSON.stringify(f.artifact)},onLaunched:({pid})=>writeFileSync(${JSON.stringify(join(f.root, 'service.pid'))},String(pid),{mode:0o600})});`,
    );
    expect((await compileFileRecoveryTUI(f.root, runner)).success).toBe(true);
    const transcript = join(tmpdir(), `kite-file-recovery-lost-${randomUUID()}.pty.log`);
    const { code, out, err } = await runFileRecoveryPTY(f, { mode: 'lost', transcript });
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
    const wires = readFileSync(join(f.root, 'wire'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const codePosts = wires.filter(
      (r) => r.method === 'POST' && r.body?.kind === 'extension.invoke',
    );
    const forkPosts = wires.filter((r) => r.method === 'POST' && r.body?.newSessionId);
    expect(codePosts).toHaveLength(1);
    expect(forkPosts).toHaveLength(1);
    expect(codePosts[0].body.commandId).toBe(journal.records[0].code.request.commandId);
    expect(forkPosts[0].body.commandId).toBe(journal.records[0].fork.request.commandId);
  } finally {
    f.close();
  }
}, 70000);
