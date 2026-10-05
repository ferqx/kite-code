import { expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileRecoveryProfile } from '../fixtures/file-recovery-profile';

const repo = resolve(import.meta.dir, '../../../..');
async function wait(check: () => boolean) {
  const end = Date.now() + 20000;
  while (!check()) {
    if (Date.now() > end) throw Error('file_caller_window_deadline');
    await Bun.sleep(10);
  }
}
for (const window of ['before_post', 'between_legs'] as const)
  test(`compiled CLI SIGKILL ${window} keeps original IDs and cold lookup issues zero recovery POST`, async () => {
    const f = await fileRecoveryProfile();
    try {
      const runner = join(f.root, 'crash.ts'),
        network = join(f.root, 'network'),
        marker = join(f.root, 'marker');
      writeFileSync(
        runner,
        `import {appendFileSync,writeFileSync} from 'node:fs';import {runCLIProcess} from ${JSON.stringify(join(repo, 'apps/cli/host/main.ts'))};const original=globalThis.fetch;globalThis.fetch=Object.assign(async(...args:Parameters<typeof fetch>)=>{const opts=args[1],url=new URL(String(args[0])),body=opts?.body?JSON.parse(String(opts.body)):null;appendFileSync(${JSON.stringify(network)},JSON.stringify({method:opts?.method??'GET',path:url.pathname,body})+'\\n');if(process.env.WINDOW==='before_post'&&opts?.method==='POST'&&body?.kind==='extension.invoke'){writeFileSync(${JSON.stringify(marker)},'prepared');await new Promise(()=>{});}return original(...args);},{preconnect:original.preconnect});const code=await runCLIProcess({argv:process.argv.slice(2),artifact:${JSON.stringify(f.artifact)},dataRoot:${JSON.stringify(f.profile.dataRoot)},profile:'owned'});if(process.env.WINDOW==='between_legs'){writeFileSync(${JSON.stringify(marker)},'between');await new Promise(()=>{});}process.exitCode=code;`,
      );
      expect(
        (
          await Bun.build({
            entrypoints: [runner],
            outdir: f.root,
            target: 'bun',
            external: ['react-devtools-core'],
          })
        ).success,
      ).toBe(true);
      function spawn(args: string[], mode?: string, answer = '') {
        const child = Bun.spawn([process.execPath, join(f.root, 'crash.js'), ...args], {
          cwd: f.workspace,
          env: { ...process.env, HOME: f.home, ...(mode ? { WINDOW: mode } : {}) },
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: 'pipe',
        });
        if (!answer) child.stdin.end();
        const output = new Response(child.stdout).text();
        const error = (async () => {
          let all = '',
            sent = false;
          for await (const bytes of child.stderr) {
            all += new TextDecoder().decode(bytes);
            if (answer && !sent && all.includes('Answer approve')) {
              sent = true;
              child.stdin.write(answer);
              child.stdin.end();
            }
          }
          return all;
        })();
        return { child, output, error };
      }
      const directory = spawn(['files', 'checkpoints', 's']);
      expect(await directory.child.exited).toBe(0);
      const point = JSON.parse(await directory.output).payload.items[0].checkpoint.id;
      await directory.error;
      const owned = spawn(
        ['files', 'restore', 's', point, '--scope=both'],
        window,
        window === 'between_legs' ? 'approve\n' : '',
      );
      await wait(() => existsSync(marker));
      const journalPath = join(f.profile.profilePath, 'ui/file-recovery-intents.json'),
        before = JSON.parse(readFileSync(journalPath, 'utf8')).records[0];
      expect(before.code.phase).toBe(window === 'before_post' ? 'submitting' : 'succeeded');
      expect(before.fork.phase).toBe('not_started');
      owned.child.kill('SIGKILL');
      await owned.child.exited;
      await Promise.all([owned.output, owned.error]);
      const wireBefore = readFileSync(network, 'utf8').trim().split('\n').length;
      let cold: ReturnType<typeof spawn> | undefined;
      const end = Date.now() + 20000;
      for (;;) {
        cold = spawn(['files', 'lookup', 's', '--input', JSON.stringify(before)]);
        const code = await cold.child.exited;
        const err = await cold.error;
        if (code === 2) break;
        await cold.output;
        if (Date.now() > end) throw Error(`cold_start_failed:${err}`);
        await Bun.sleep(50);
      }
      const outcome = JSON.parse((await cold.output).trim().split('\n').at(-1)!).intent;
      expect(outcome.code.phase).toBe(window === 'before_post' ? 'unknown' : 'succeeded');
      expect(outcome.fork.phase).toBe('not_started');
      const after = readFileSync(network, 'utf8')
        .trim()
        .split('\n')
        .slice(wireBefore)
        .map((l) => JSON.parse(l));
      expect(after.filter((row) => row.method === 'POST')).toHaveLength(0);
      expect(outcome.code.request.commandId).toBe(before.code.request.commandId);
      expect(outcome.fork.request.commandId).toBe(before.fork.request.commandId);
      expect(outcome.fork.request.newSessionId).toBe(before.fork.request.newSessionId);
      expect(readFileSync(f.file, 'utf8')).toBe(
        window === 'before_post' ? 'actual changed bytes\r\n' : 'original bytes\r\n',
      );
      expect(f.calls()).toBe(3);
    } finally {
      f.close();
    }
  }, 65000);
