import { expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileRecoveryProfile } from '../fixtures/file-recovery-profile';

const repo = resolve(import.meta.dir, '../../../..');
test('compiled CLI actual argv both restore waits for original independent Ask, persists partial and explicitly continues original Fork', async () => {
  const f = await fileRecoveryProfile();
  try {
    const runner = join(f.root, 'argv.ts');
    writeFileSync(
      runner,
      `import {runCLIProcess} from ${JSON.stringify(join(repo, 'apps/cli/host/main.ts'))};process.exitCode=await runCLIProcess({argv:process.argv.slice(2),artifact:${JSON.stringify(f.artifact)},dataRoot:${JSON.stringify(f.profile.dataRoot)},profile:'owned'});`,
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
    if (done.code !== 0) console.error(done);
    expect(done.code).toBe(0);
    const final = JSON.parse(done.out.trim().split('\n').at(-1)!).intent;
    expect(final.fork.phase).toBe('succeeded');
    expect(final.fork.request.commandId).toBe(intent.fork.request.commandId);
    const again = await run(['files', 'continue', 's', '--input', JSON.stringify(final)]);
    expect(again.code).toBe(0);
    expect(f.calls()).toBe(3);
  } finally {
    f.close();
  }
}, 60000);
for (const scope of ['session', 'code'] as const)
  test(`compiled CLI actual ${scope}-only Files recovery preserves the other scope and repeated continue is readonly`, async () => {
    const f = await fileRecoveryProfile();
    try {
      const runner = join(f.root, 'scope.ts');
      writeFileSync(
        runner,
        `import {runCLIProcess} from ${JSON.stringify(join(repo, 'apps/cli/host/main.ts'))};process.exitCode=await runCLIProcess({argv:process.argv.slice(2),artifact:${JSON.stringify(f.artifact)},dataRoot:${JSON.stringify(f.profile.dataRoot)},profile:'owned'});`,
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
      async function run(args: string[]) {
        const child = Bun.spawn([process.execPath, join(f.root, 'scope.js'), ...args], {
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: 'pipe',
          cwd: f.workspace,
          env: { ...process.env, HOME: f.home },
        });
        let sent = false;
        const error = (async () => {
          let err = '';
          for await (const bytes of child.stderr) {
            err += new TextDecoder().decode(bytes);
            if (!sent && err.includes('Answer approve')) {
              sent = true;
              child.stdin.write('approve\n');
              child.stdin.end();
            }
          }
          return err;
        })();
        const [code, out, err] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          error,
        ]);
        return { code, out, err };
      }
      const restored = await run(['files', 'restore', 's', f.checkpointId, `--scope=${scope}`]);
      if (restored.code !== 0) console.error(restored);
      expect(restored.code).toBe(0);
      const intent = JSON.parse(restored.out.trim().split('\n').at(-1)!).intent;
      expect(intent[scope === 'session' ? 'fork' : 'code'].phase).toBe('succeeded');
      expect(intent[scope === 'session' ? 'code' : 'fork']).toBeNull();
      expect(readFileSync(f.file, 'utf8')).toBe(
        scope === 'session' ? 'actual changed bytes\r\n' : 'original bytes\r\n',
      );
      const again = await run(['files', 'continue', 's', '--input', JSON.stringify(intent)]);
      expect(again.code).toBe(0);
      expect(JSON.parse(again.out.trim().split('\n').at(-1)!).intent).toEqual(intent);
      expect(f.calls()).toBe(3);
    } finally {
      f.close();
    }
  }, 60000);
