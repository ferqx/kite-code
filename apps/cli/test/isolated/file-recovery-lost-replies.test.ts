import { expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileRecoveryProfile } from '../fixtures/file-recovery-profile';

const repo = resolve(import.meta.dir, '../../../..');
test('compiled CLI physical POST and first GET lost replies retain both exact original identities and cold only GET', async () => {
  const f = await fileRecoveryProfile();
  try {
    const runner = join(f.root, 'argv.ts');
    writeFileSync(
      runner,
      `import {appendFileSync} from 'node:fs';const actual=globalThis.fetch;let saved:string|undefined,lost=false;globalThis.fetch=Object.assign(async(...args:Parameters<typeof fetch>)=>{const opts=args[1],path=new URL(String(args[0])).pathname,body=opts?.body?JSON.parse(String(opts.body)):null;appendFileSync(${JSON.stringify(join(f.root, 'wire'))},JSON.stringify({method:opts?.method??'GET',path,body})+'\\n');const response=await actual(...args);if(opts?.method==='POST'&&(body?.kind==='extension.invoke'||(path.endsWith('/fork')&&body?.newSessionId))){saved=body.commandId;await response.arrayBuffer();throw Error('committed POST response physically lost');}if(saved&&!lost&&path==='/v1/commands/'+saved){lost=true;const text=await response.text();return new Response(text.slice(0,Math.max(1,Math.floor(text.length/2))),{status:response.status,headers:response.headers});}return response;},{preconnect:actual.preconnect});import {runCLIProcess} from ${JSON.stringify(join(repo, 'apps/cli/host/main.ts'))};process.exitCode=await runCLIProcess({argv:process.argv.slice(2),artifact:${JSON.stringify(f.artifact)},dataRoot:${JSON.stringify(f.profile.dataRoot)},profile:'owned'});`,
    );
    const built = await Bun.build({
      entrypoints: [runner],
      outdir: f.root,
      target: 'bun',
      external: ['react-devtools-core'],
    });
    expect(built.success).toBe(true);
    async function run(args: string[], answer = '') {
      const child = Bun.spawn([process.execPath, join(f.root, 'argv.js'), ...args], {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        cwd: f.workspace,
        env: { ...process.env, HOME: f.home },
      });
      if (!answer) child.stdin.end();
      const [code, out, err] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        (async () => {
          let err = '',
            sent = false;
          for await (const bytes of child.stderr) {
            err += new TextDecoder().decode(bytes);
            if (answer && !sent && err.includes('Answer approve')) {
              sent = true;
              child.stdin.write(answer);
              child.stdin.end();
            }
          }
          return err;
        })(),
      ]);
      return { code, out, err };
    }
    const directory = await run(['files', 'checkpoints', 's']);
    if (directory.code !== 0) console.error(directory);
    expect(directory.code).toBe(0);
    const point = JSON.parse(directory.out).payload.items[0].checkpoint.id;
    const first = await run(['files', 'restore', 's', point, '--scope=both'], 'approve\n');
    if (first.code !== 2) console.error(first);
    expect(first.code).toBe(2);
    expect(first.err).toContain('once');
    const outcomes = first.out
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const intent = outcomes.find((o) => o.kind === 'files.outcome').intent;
    expect(intent.code.phase).toBe('succeeded');
    expect(intent.fork.phase).toBe('not_started');
    expect(readFileSync(f.file, 'utf8')).toBe('original bytes\r\n');
    const cold = await run(['files', 'lookup', 's', '--input', JSON.stringify(intent)]);
    expect(cold.code).toBe(2);
    expect(JSON.parse(cold.out.trim().split('\n').at(-1)!).intent.fork.phase).toBe('not_started');
    const done = await run(['files', 'continue', 's', '--input', JSON.stringify(intent)]);
    if (done.code !== 2) console.error(done);
    expect(done.code).toBe(2);
    const final = JSON.parse(done.out.trim().split('\n').at(-1)!).intent;
    expect(final.fork.phase).toBe('unknown');
    expect(final.fork.request.commandId).toBe(intent.fork.request.commandId);
    const again = await run(['files', 'continue', 's', '--input', JSON.stringify(final)]);
    expect(again.code).toBe(0);
    expect(f.calls()).toBe(3);
    const confirmed = JSON.parse(again.out.trim().split('\n').at(-1)!).intent;
    expect(confirmed.fork.phase).toBe('succeeded');
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
    expect(codePosts[0].body.commandId).toBe(intent.code.request.commandId);
    expect(forkPosts[0].body.commandId).toBe(intent.fork.request.commandId);
    expect(
      wires.filter(
        (r) => r.method === 'GET' && r.path === `/v1/commands/${intent.fork.request.commandId}`,
      ).length,
    ).toBeGreaterThanOrEqual(2);
  } finally {
    f.close();
  }
}, 60000);
