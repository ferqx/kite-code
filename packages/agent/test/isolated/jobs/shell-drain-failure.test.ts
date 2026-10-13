import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { JobEvent, JobHandle } from '@kite-ai/agent/extensions';
import { createShellJob } from '../../../src/jobs/shell';

const posixTest = ['darwin', 'linux'].includes(process.platform) ? test : test.skip;

posixTest.each(['stdout', 'stderr'] as const)(
  'private Shell %s drain failure reports failed and confirms original group cleanup',
  async (stream) => {
    const root = mkdtempSync(join(tmpdir(), 'kite-shell-drain-failure-'));
    try {
      const built = await Bun.build({
        entrypoints: [join(import.meta.dir, '../../../src/platform/process/shell-supervisor.ts')],
        outdir: root,
        target: 'bun',
        naming: 'guardian.js',
      });
      expect(built.success).toBe(true);
      const preload = join(root, `${stream}-preload.js`);
      // Only this private guardian child receives the preload. Its control stdin
      // keeps the real iterator; the selected spawned output rejects during drain.
      writeFileSync(
        preload,
        `import { Readable } from 'node:stream';
const original = Readable.prototype[Symbol.asyncIterator];
let output = 0;
Readable.prototype[Symbol.asyncIterator] = function () {
  if (this !== process.stdin && ++output === ${stream === 'stdout' ? 1 : 2}) {
    return (async function* () { throw new Error('fixture_${stream}_drain_failed'); })();
  }
  return original.call(this);
};
`,
      );
      const child = Bun.spawn([process.execPath, '--preload', preload, built.outputs[0]!.path], {
        cwd: root,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const stdout = new Response(child.stdout).text();
      const stderr = new Response(child.stderr).text();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        child.stdin.write(
          `${JSON.stringify({ type: 'start', nonce: `drain-${stream}`, executable: '/bin/sh', argv: ['-c', 'exec sleep 20'], cwd: root, env: { PATH: '/usr/bin:/bin' }, graceMs: 200 })}\n`,
        );
        await Promise.race([
          child.exited,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error('guardian_terminal_timeout')), 8000);
          }),
        ]);
        const frames = (await stdout)
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line));
        const ready = frames.find((frame) => frame.type === 'ready');
        const terminal = frames.find((frame) => frame.type === 'terminal');
        expect(ready?.processGroupId).toBeGreaterThan(0);
        expect(terminal?.groupStopped).toBe(true);
        expect(terminal?.outcome).toBe('failed');
        expect(terminal?.failureCode).toBe(`fixture_${stream}_drain_failed`);
        expect(terminal?.failureErrno).toBeNull();
        expect(await child.exited).toBe(125);
      } finally {
        if (timeout) clearTimeout(timeout);
        if (child.exitCode === null) {
          child.stdin.write(`${JSON.stringify({ type: 'cancel', nonce: `drain-${stream}` })}\n`);
          child.stdin.end();
          await child.exited;
        }
        child.stdin.end();
        await Promise.all([stdout, stderr]);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  20000,
);

posixTest(
  'public Shell Job preserves drain failure through observation and idempotent cleanup',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'kite-shell-drain-adapter-'));
    let handle: JobHandle | undefined;
    let job: ReturnType<typeof createShellJob> | undefined;
    try {
      const built = await Bun.build({
        entrypoints: [join(import.meta.dir, '../../../src/platform/process/shell-supervisor.ts')],
        outdir: root,
        target: 'bun',
        naming: 'guardian.js',
      });
      expect(built.success).toBe(true);
      const preload = join(root, 'output-preload.js');
      writeFileSync(
        preload,
        `import { Readable } from 'node:stream';
const original = Readable.prototype[Symbol.asyncIterator];
let injected = false;
Readable.prototype[Symbol.asyncIterator] = function () {
  if (this !== process.stdin && !injected) {
    injected = true;
    return (async function* () {
      throw Object.assign(new Error('fixture_stdout_drain_failed'), { errno: -5 });
    })();
  }
  return original.call(this);
};
`,
      );
      const wrapper = join(root, 'private-guardian.js');
      writeFileSync(
        wrapper,
        `await import(${JSON.stringify(pathToFileURL(preload).href)});
await import(${JSON.stringify(pathToFileURL(built.outputs[0]!.path).href)});
`,
      );
      job = createShellJob({
        cwd: root,
        env: { PATH: '/usr/bin:/bin' },
        supervisorPath: wrapper,
      });
      const controller = new AbortController();
      handle = await job.start(
        { command: 'exec sleep 20' },
        { sessionId: 'drain-adapter', executionId: crypto.randomUUID(), signal: controller.signal },
      );
      const events: JobEvent[] = [];
      for await (const event of job.observe(handle)) events.push(event);
      const terminals = events.filter((event) => event.type === 'terminal');
      expect(terminals).toHaveLength(1);
      const terminal = terminals[0]!;
      expect(terminal.type).toBe('terminal');
      if (terminal.type !== 'terminal') throw new Error('terminal_missing');
      expect(terminal.supervision).toBe('ended');
      expect(terminal.result.outcome).toBe('failed');
      expect(terminal.result.content).toBe('Shell failed');
      expect(terminal.result.details).toMatchObject({
        groupStopped: true,
        supervisorFailure: 'fixture_stdout_drain_failed',
        supervisorErrno: -5,
      });
      expect(controller.signal.aborted).toBe(false);
      expect((await job.cancel(handle)).status).toBe('already_finished');
      expect((await job.cancel(handle)).status).toBe('already_finished');
      await job.dispose(handle);
      await job.dispose(handle);
      expect(terminal.result.outcome).toBe('failed');
    } finally {
      if (job && handle) {
        await job.cancel(handle);
        await job.dispose(handle);
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
  20000,
);

posixTest(
  'late stdout drain failure overrides natural exit without losing its exit code',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'kite-shell-late-drain-'));
    try {
      const built = await Bun.build({
        entrypoints: [join(import.meta.dir, '../../../src/platform/process/shell-supervisor.ts')],
        outdir: root,
        target: 'bun',
        naming: 'guardian.js',
      });
      expect(built.success).toBe(true);
      const preload = join(root, 'late-preload.js');
      writeFileSync(
        preload,
        `import { Readable } from 'node:stream';
const original = Readable.prototype[Symbol.asyncIterator];
let injected = false;
Readable.prototype[Symbol.asyncIterator] = function () {
  if (this !== process.stdin && !injected) {
    injected = true;
    const iterator = original.call(this);
    return (async function* () {
      for await (const chunk of iterator) yield chunk;
      await new Promise(resolve => setTimeout(resolve, 100));
      throw new Error('fixture_late_stdout_drain_failed');
    })();
  }
  return original.call(this);
};
`,
      );
      const child = Bun.spawn([process.execPath, '--preload', preload, built.outputs[0]!.path], {
        cwd: root,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const stdout = new Response(child.stdout).text();
      const stderr = new Response(child.stderr).text();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        child.stdin.write(
          `${JSON.stringify({ type: 'start', nonce: 'late-drain', executable: '/bin/sh', argv: ['-c', 'exec /usr/bin/true'], cwd: root, env: { PATH: '/usr/bin:/bin' }, graceMs: 200 })}\n`,
        );
        await Promise.race([
          child.exited,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error('guardian_terminal_timeout')), 8000);
          }),
        ]);
        const frames = (await stdout)
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line));
        const ready = frames.find((frame) => frame.type === 'ready');
        const terminal = frames.find((frame) => frame.type === 'terminal');
        expect(ready?.processGroupId).toBeGreaterThan(0);
        expect(terminal?.groupStopped).toBe(true);
        expect(terminal?.exitCode).toBe(0);
        expect(terminal?.outcome).toBe('failed');
        expect(terminal?.failureCode).toBe('fixture_late_stdout_drain_failed');
        expect(terminal?.failureErrno).toBeNull();
        expect(await child.exited).toBe(125);
      } finally {
        if (timeout) clearTimeout(timeout);
        if (child.exitCode === null) {
          child.stdin.write(`${JSON.stringify({ type: 'cancel', nonce: 'late-drain' })}\n`);
          child.stdin.end();
          await child.exited;
        }
        child.stdin.end();
        await Promise.all([stdout, stderr]);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  20000,
);
