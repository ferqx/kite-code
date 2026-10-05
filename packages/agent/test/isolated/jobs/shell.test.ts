import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JobDefinition, JobEvent, JobHandle } from '@kite-ai/agent/extensions';
import { createShellJob } from '../../../src/jobs/shell';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function fixture(maxQueuedBytes?: number) {
  const root = mkdtempSync(join(tmpdir(), 'kite-shell-job-'));
  roots.push(root);
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, '../../../src/platform/process/shell-supervisor.ts')],
    outdir: join(root, 'platform/process'),
    target: 'bun',
    naming: 'shell-supervisor.js',
  });
  expect(result.success).toBe(true);
  const path = result.outputs[0]!.path;
  const job = createShellJob({
    cwd: root,
    env: { PATH: '/usr/bin:/bin', FIXTURE_ENV: 'selected' },
    supervisorPath: path,
    maxQueuedBytes,
  });
  const start = (command: string) =>
    job.start(
      { command },
      { sessionId: 's', executionId: crypto.randomUUID(), signal: new AbortController().signal },
    );
  return { root, path, job, start };
}
async function collect(job: JobDefinition, handle: JobHandle): Promise<JobEvent[]> {
  const events: JobEvent[] = [];
  for await (const event of job.observe(handle)) events.push(event);
  return events;
}
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function until(condition: () => boolean, timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition_timeout');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

const posix = process.platform === 'darwin' || process.platform === 'linux';
const posixTest = posix ? test : test.skip;
posixTest('shell job normal terminal confirms group and uses selected cwd/env', async () => {
  const f = await fixture();
  const handle = await f.start('printf "%s\\n%s\\n" "$PWD" "$FIXTURE_ENV"; printf stderr >&2');
  try {
    const events = await collect(f.job, handle);
    expect(
      events
        .filter((event) => event.type === 'output')
        .map((event) => event.content)
        .join(''),
    ).toContain('selected');
    expect(events.at(-1)).toMatchObject({
      type: 'terminal',
      result: { outcome: 'succeeded', details: { exitCode: 0, groupStopped: true } },
    });
    expect((await f.job.cancel(handle)).status).toBe('already_finished');
    await f.job.dispose(handle);
    await f.job.dispose(handle);
  } finally {
    await f.job.dispose(handle);
  }
});

posixTest(
  'cancel confirms descendant group termination without killing unrelated process',
  async () => {
    const f = await fixture();
    const unrelated = Bun.spawn(['/bin/sleep', '30'], { stdout: 'ignore', stderr: 'ignore' });
    const pidFile = join(f.root, 'descendant.pid');
    const handle = await f.start(`sleep 30 & echo $! > ${quote(pidFile)}; wait`);
    try {
      await until(() => {
        try {
          return Number(readFileSync(pidFile, 'utf8')) > 1;
        } catch {
          return false;
        }
      });
      const descendant = Number(readFileSync(pidFile, 'utf8'));
      expect(alive(descendant)).toBe(true);
      const observed = collect(f.job, handle);
      const confirmation = await f.job.cancel(handle);
      expect(confirmation.status).toBe('stopped');
      await until(() => !alive(descendant));
      expect(alive(unrelated.pid)).toBe(true);
      expect((await observed).at(-1)).toMatchObject({
        type: 'terminal',
        result: { outcome: 'cancelled', details: { groupStopped: true } },
      });
    } finally {
      unrelated.kill('SIGKILL');
      await unrelated.exited;
      await f.job.dispose(handle);
    }
  },
);

posixTest('slow observation drains output with bounded chunks and explicit loss gap', async () => {
  const f = await fixture(32 * 1024);
  const handle = await f.start('dd if=/dev/zero bs=32768 count=64 2>/dev/null | tr "\\000" x');
  try {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const events = await collect(f.job, handle);
    const output = events.filter((event) => event.type === 'output');
    const dropped = events.filter((event) => event.type === 'output_dropped');
    expect(output.every((event) => Buffer.byteLength(event.content) <= 32 * 1024)).toBe(true);
    expect(
      output.reduce((sum, event) => sum + Buffer.byteLength(event.content), 0),
    ).toBeLessThanOrEqual(32 * 1024);
    expect(dropped.reduce((sum, event) => sum + BigInt(event.bytes), 0n)).toBeGreaterThan(0n);
    expect(events.at(-1)).toMatchObject({ type: 'terminal', result: { outcome: 'succeeded' } });
    await expect(collect(f.job, handle)).rejects.toThrow('shell_observer_already_attached');
  } finally {
    await f.job.dispose(handle);
  }
});

posixTest(
  'built shell leaf resolves packaged guardian after artifact leaves source tree',
  async () => {
    const f = await fixture();
    const built = await Bun.build({
      entrypoints: [join(import.meta.dir, '../../../src/jobs/shell.ts')],
      outdir: join(f.root, 'jobs'),
      target: 'bun',
      packages: 'external',
      naming: 'shell.js',
    });
    expect(built.success).toBe(true);
    const leaf = (await import(built.outputs[0]!.path)) as {
      createShellJob: typeof createShellJob;
      shellSupervisorAsset(): string;
    };
    expect(realpathSync(leaf.shellSupervisorAsset())).toBe(realpathSync(f.path));
    const job = leaf.createShellJob({ cwd: f.root, env: { PATH: '/usr/bin:/bin' } });
    const handle = await job.start(
      { command: 'printf packaged' },
      { sessionId: 's', executionId: 'built', signal: new AbortController().signal },
    );
    try {
      expect((await collect(job, handle)).at(-1)).toMatchObject({
        type: 'terminal',
        result: { outcome: 'succeeded' },
      });
    } finally {
      await job.dispose(handle);
    }
  },
);

for (const exitMode of ['parent_eof', 'parent_sigkill'] as const)
  posixTest(
    `${exitMode} guardian clears real descendants while unrelated process remains alive`,
    async () => {
      const f = await fixture();
      const pidFile = join(f.root, 'orphan-descendant.pid');
      const entry = join(f.root, 'host.ts');
      writeFileSync(
        entry,
        `import { createShellJob } from ${JSON.stringify(join(import.meta.dir, '../../../src/jobs/shell.ts'))};
const job = createShellJob({cwd:process.argv[3]!,env:{PATH:'/usr/bin:/bin'},supervisorPath:process.argv[2]!});
const handle = await job.start({command:${JSON.stringify(`sleep 30 & echo $! > ${quote(pidFile)}; wait`)}},{sessionId:'s',executionId:'parent-lifetime',signal:new AbortController().signal});
process.stdout.write(JSON.stringify(handle.reference)+'\\n');
process.stdin.resume(); process.stdin.on('end',()=>process.exit(0));`,
      );
      const built = await Bun.build({
        entrypoints: [entry],
        outdir: join(f.root, 'host'),
        target: 'bun',
        naming: 'host.js',
      });
      expect(built.success).toBe(true);
      const parent = Bun.spawn([process.execPath, built.outputs[0]!.path, f.path, f.root], {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const unrelated = Bun.spawn(['/bin/sleep', '30'], { stdout: 'ignore', stderr: 'ignore' });
      let groupId: number | undefined;
      let supervisorPid: number | undefined;
      try {
        const reader = parent.stdout.getReader();
        let text = '';
        while (!text.includes('\n')) {
          const chunk = await reader.read();
          if (chunk.done) throw new Error('fixture_parent_failed');
          text += new TextDecoder().decode(chunk.value);
        }
        const reference = JSON.parse(text.split('\n')[0]!) as {
          processGroupId: number;
          supervisorPid: number;
        };
        groupId = reference.processGroupId;
        supervisorPid = reference.supervisorPid;
        await until(() => {
          try {
            return Number(readFileSync(pidFile, 'utf8')) > 1;
          } catch {
            return false;
          }
        });
        const descendant = Number(readFileSync(pidFile, 'utf8'));
        expect(alive(descendant)).toBe(true);
        if (exitMode === 'parent_eof') parent.stdin.end();
        else parent.kill('SIGKILL');
        await parent.exited;
        await until(() => !alive(descendant) && !alive(groupId!) && !alive(supervisorPid!));
        expect(alive(descendant)).toBe(false);
        expect(alive(groupId)).toBe(false);
        expect(alive(supervisorPid)).toBe(false);
        expect(alive(unrelated.pid)).toBe(true);
        reader.releaseLock();
      } finally {
        parent.kill('SIGKILL');
        await parent.exited;
        if (groupId && alive(groupId)) {
          try {
            process.kill(-groupId, 'SIGKILL');
          } catch {}
        }
        if (supervisorPid && alive(supervisorPid)) {
          try {
            process.kill(supervisorPid, 'SIGTERM');
          } catch {}
        }
        unrelated.kill('SIGKILL');
        await unrelated.exited;
      }
    },
  );

posixTest(
  'TERM-ignoring process group requires force and reports confirmed group stop',
  async () => {
    const f = await fixture();
    const pidFile = join(f.root, 'ignoring.pid');
    const handle = await f.start(`trap '' TERM; sleep 30 & echo $! > ${quote(pidFile)}; wait`);
    try {
      await until(() => {
        try {
          return Number(readFileSync(pidFile, 'utf8')) > 1;
        } catch {
          return false;
        }
      });
      const descendant = Number(readFileSync(pidFile, 'utf8'));
      const observed = collect(f.job, handle);
      expect((await f.job.cancel(handle)).status).toBe('stopped');
      expect((await observed).at(-1)).toMatchObject({
        type: 'terminal',
        result: { outcome: 'cancelled', details: { forced: true, groupStopped: true } },
      });
      expect(alive(descendant)).toBe(false);
    } finally {
      await f.job.dispose(handle);
    }
  },
);

posixTest(
  'naturally exited shell cleans background descendants before reporting success',
  async () => {
    const f = await fixture();
    const pidFile = join(f.root, 'natural-background.pid');
    const handle = await f.start(`sleep 30 & echo $! > ${quote(pidFile)}; exit 0`);
    try {
      const events = await collect(f.job, handle);
      const descendant = Number(readFileSync(pidFile, 'utf8'));
      expect(alive(descendant)).toBe(false);
      expect(events.at(-1)).toMatchObject({
        type: 'terminal',
        result: { outcome: 'succeeded', details: { groupStopped: true } },
      });
    } finally {
      await f.job.dispose(handle);
    }
  },
);

posixTest(
  'cancel joins natural cleanup without repeating termination or the terminal',
  async () => {
    const f = await fixture();
    const signalsPath = join(f.root, 'signals.txt');
    const guardian = Bun.spawn([process.execPath, f.path], {
      cwd: f.root,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const frames: Record<string, unknown>[] = [];
    const output = (async () => {
      const reader = guardian.stdout.getReader();
      const decoder = new TextDecoder();
      let buffered = '';
      for (;;) {
        const { value, done } = await reader.read();
        buffered += decoder.decode(value, { stream: !done });
        while (buffered.includes('\n')) {
          const boundary = buffered.indexOf('\n');
          frames.push(JSON.parse(buffered.slice(0, boundary)));
          buffered = buffered.slice(boundary + 1);
        }
        if (done) break;
      }
      expect(buffered).toBe('');
    })();
    const errors = new Response(guardian.stderr).text();
    const nonce = crypto.randomUUID();
    const pidFile = join(f.root, 'overlap-background.pid');
    const readyFile = join(f.root, 'background.ready');
    const background = `trap ${quote(`printf 'term\\n' >> ${quote(signalsPath)}`)} TERM; printf ready > ${quote(readyFile)}; i=0; while [ "$i" -lt 100 ]; do /bin/sleep 0.02; i=$((i + 1)); done`;
    guardian.stdin.write(
      `${JSON.stringify({
        type: 'start',
        nonce,
        executable: '/bin/sh',
        argv: [
          '-c',
          `/bin/sh -c ${quote(background)} & echo $! > ${quote(pidFile)}; while [ ! -f ${quote(readyFile)} ]; do /bin/sleep 0.01; done; exit 0`,
        ],
        cwd: f.root,
        env: { PATH: '/usr/bin:/bin' },
        graceMs: 500,
      })}\n`,
    );
    let groupId: number | undefined;
    let descendant: number | undefined;
    try {
      await until(() => {
        const ready = frames.find((frame) => frame.type === 'ready');
        if (!ready) return false;
        groupId = Number(ready.processGroupId);
        try {
          descendant = Number(readFileSync(pidFile, 'utf8'));
          return (
            groupId > 1 &&
            descendant > 1 &&
            alive(descendant) &&
            readFileSync(signalsPath, 'utf8') === 'term\n'
          );
        } catch {
          return false;
        }
      });
      // Before any cancel, the real descendant's TERM proves natural cleanup began.
      // macOS deliberately keeps the exited original root unreaped until this cleanup ends.
      guardian.stdin.write(`${JSON.stringify({ type: 'cancel', nonce })}\n`);
      await until(() => guardian.exitCode !== null);
      expect(await guardian.exited).toBe(0);
      await output;
      expect(await errors).toBe('');
      expect(alive(descendant!)).toBe(false);
      expect(readFileSync(signalsPath, 'utf8').trim().split('\n')).toEqual(['term']);
      expect(frames.filter((frame) => frame.type === 'terminal')).toEqual([
        expect.objectContaining({
          nonce,
          outcome: 'succeeded',
          exitCode: 0,
          groupStopped: true,
          forced: true,
        }),
      ]);
    } finally {
      if (guardian.exitCode === null) guardian.stdin.end();
      await until(() => guardian.exitCode !== null);
      await guardian.exited;
      await output;
      await errors;
      if (descendant) await until(() => !alive(descendant!));
    }
  },
);

posixTest(
  'unconfirmed terminal cannot report success; later stop proof does not rewrite unknown effect',
  async () => {
    const f = await fixture();
    const helper = join(f.root, 'late-proof.js');
    writeFileSync(
      helper,
      `import {spawn} from 'node:child_process';
let nonce,child,buffer='';process.stdin.setEncoding('utf8');
function send(frame){process.stdout.write(JSON.stringify({nonce,...frame})+'\\n');}
process.stdin.on('data',chunk=>{buffer+=chunk;while(buffer.includes('\\n')){const p=buffer.indexOf('\\n');const frame=JSON.parse(buffer.slice(0,p));buffer=buffer.slice(p+1);if(frame.type==='start'){nonce=frame.nonce;child=spawn('/bin/sleep',['30'],{detached:true,stdio:'ignore'});child.once('spawn',()=>{send({type:'ready',processGroupId:child.pid});send({type:'terminal',outcome:'succeeded',groupStopped:false,exitCode:0});});}else{process.kill(-child.pid,'SIGTERM');child.once('close',()=>{send({type:'terminal',outcome:'succeeded',groupStopped:true,exitCode:0});process.exit(0);});}}});
process.stdin.on('end',()=>{if(child){try{process.kill(-child.pid,'SIGKILL')}catch{}}process.exit(0)});`,
    );
    const job = createShellJob({
      cwd: f.root,
      env: { PATH: '/usr/bin:/bin' },
      supervisorPath: helper,
    });
    const handle = await job.start(
      { command: 'unused' },
      { sessionId: 's', executionId: 'late-proof', signal: new AbortController().signal },
    );
    try {
      const events = await collect(job, handle);
      expect(events.at(-1)).toMatchObject({
        type: 'terminal',
        supervision: 'unknown',
        result: { outcome: 'outcome_unknown' },
      });
      expect((await job.cancel(handle)).status).toBe('stopped');
      expect((await job.cancel(handle)).status).toBe('already_finished');
      expect(events.at(-1)).toMatchObject({
        type: 'terminal',
        supervision: 'unknown',
        result: { outcome: 'outcome_unknown' },
      });
    } finally {
      await job.dispose(handle);
    }
  },
);
