import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { serveDevelopmentReload } from '../../../apps/desktop/electron/development';
import {
  buildDevelopmentService,
  createDesktopReloadChannel,
  createDesktopReloadQueue,
  isDevelopmentServiceSource,
  startDesktopControl,
  startDesktopRenderer,
} from '../../../scripts/development/desktop-reload';

test('private loopback control rejects unauthenticated peers and carries reloads independently of GUI stdin', async () => {
  const control = await startDesktopControl();
  const rejected = connect({ host: '127.0.0.1', port: control.configuration.port });
  rejected.on('error', () => {});
  const closed = new Promise<void>((resolve) => rejected.once('close', () => resolve()));
  rejected.write(`${JSON.stringify({ kind: 'desktop.ready', token: '0'.repeat(64) })}\n`);
  await closed;
  const peer = connect({ host: '127.0.0.1', port: control.configuration.port });
  peer.on('error', () => {});
  const calls: string[] = [];
  const stop = serveDevelopmentReload({
    stream: peer,
    reply: (line) => peer.write(line),
    reload: async (request) => {
      calls.push(request.id);
    },
  });
  peer.write(`${JSON.stringify({ kind: 'desktop.ready', token: control.configuration.token })}\n`);
  let finish: ((value: number) => void) | undefined;
  const exited = new Promise<number>((resolve) => {
    finish = resolve;
  });
  const channel = await control.attach(exited);
  try {
    await channel.reload({ id: 'a'.repeat(32), sha256: 'b'.repeat(64) });
    expect(calls).toEqual(['a'.repeat(32)]);
    const end = new Promise<void>((resolve) => peer.once('end', () => resolve()));
    control.stop();
    await end;
    finish!(0);
    await channel.read;
  } finally {
    stop();
    peer.destroy();
    await control.close();
  }
});

test('stop before authentication remains latched for the original authenticated Desktop and fences reloads', async () => {
  for (const phase of ['before-connect', 'during-handshake', 'before-attach'] as const) {
    const control = await startDesktopControl();
    let finish!: (value: number) => void;
    const exited = new Promise<number>((resolve) => {
      finish = resolve;
    });
    if (phase === 'before-connect') {
      control.stop();
      control.stop();
    }
    const rejected = connect({ host: '127.0.0.1', port: control.configuration.port });
    rejected.on('error', () => {});
    const rejectedClosed = new Promise<void>((resolve) => rejected.once('close', () => resolve()));
    rejected.write(`${JSON.stringify({ kind: 'desktop.ready', token: '0'.repeat(64) })}\n`);
    await rejectedClosed;
    const peer = connect({ host: '127.0.0.1', port: control.configuration.port });
    peer.on('error', () => {});
    const ended = new Promise<boolean>((resolve) => peer.once('end', () => resolve(true)));
    let calls = 0;
    const stopReload = serveDevelopmentReload({
      stream: peer,
      reply: (line) => peer.write(line),
      reload: async () => {
        calls++;
      },
    });
    const ready = `${JSON.stringify({ kind: 'desktop.ready', token: control.configuration.token })}\n`;
    try {
      if (phase === 'during-handshake') {
        peer.write(ready.slice(0, 20));
        control.stop();
        control.stop();
        peer.write(ready.slice(20));
      } else {
        peer.write(ready);
        if (phase === 'before-attach') {
          control.stop();
          control.stop();
        }
      }
      const channel = await control.attach(exited);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        expect(
          await Promise.race([
            ended,
            new Promise<boolean>((resolve) => {
              timer = setTimeout(() => resolve(false), 250);
            }),
          ]),
        ).toBe(true);
      } finally {
        clearTimeout(timer);
      }
      await expect(channel.reload({ id: 'a'.repeat(32), sha256: 'b'.repeat(64) })).rejects.toThrow(
        'development_desktop_stopping',
      );
      expect(calls).toBe(0);
      finish(0);
      await channel.read;
    } finally {
      finish(0);
      stopReload();
      rejected.destroy();
      peer.destroy();
      await control.close();
    }
  }
});

test('reload queue coalesces saves, waits for the previous update and recovers from compilation failure', async () => {
  let calls = 0,
    concurrent = 0,
    maximum = 0,
    release: (() => void) | undefined;
  const failures: unknown[] = [];
  const queue = createDesktopReloadQueue({
    debounceMs: 5,
    failed: (error) => failures.push(error),
    async reload() {
      calls++;
      concurrent++;
      maximum = Math.max(maximum, concurrent);
      try {
        if (calls === 1)
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        if (calls === 2) throw Error('compile-failed');
      } finally {
        concurrent--;
      }
    },
  });
  queue.changed();
  queue.changed();
  queue.changed();
  await Bun.sleep(20);
  expect(calls).toBe(1);
  queue.changed();
  queue.changed();
  release!();
  await Bun.sleep(20);
  expect(calls).toBe(2);
  expect(failures).toHaveLength(1);
  queue.changed();
  await Bun.sleep(20);
  expect(calls).toBe(3);
  expect(maximum).toBe(1);
  await queue.close();
  queue.changed();
  await Bun.sleep(10);
  expect(calls).toBe(3);
});

test('only matching reload acknowledgement releases a restart; an unknown outcome fences later reloads', async () => {
  let emit: ReadableStreamDefaultController<Uint8Array> | undefined;
  const writes: string[] = [];
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      emit = controller;
    },
  });
  let exit: ((code: number) => void) | undefined;
  const channel = createDesktopReloadChannel(
    {
      stdin: { write: (value) => writes.push(value), flush: () => undefined },
      stdout,
      exited: new Promise<number>((resolve) => {
        exit = resolve;
      }),
    },
    30,
  );
  const request = { id: 'a'.repeat(32), sha256: 'b'.repeat(64) };
  const original = channel.reload(request);
  emit!.enqueue(
    new TextEncoder().encode(
      `${JSON.stringify({ kind: 'service.reloaded', id: 'c'.repeat(32), ok: true })}\n`,
    ),
  );
  expect(writes).toHaveLength(1);
  await expect(channel.reload(request)).rejects.toThrow('development_service_reload_busy');
  emit!.enqueue(
    new TextEncoder().encode(
      `${JSON.stringify({ kind: 'service.reloaded', id: request.id, ok: true })}\n`,
    ),
  );
  await original;
  await expect(channel.reload({ ...request, id: 'd'.repeat(32) })).rejects.toThrow(
    'development_service_reload_unconfirmed',
  );
  await expect(channel.reload(request)).rejects.toThrow('development_service_reload_unconfirmed');
  expect(writes).toHaveLength(2);
  channel.stop();
  await expect(channel.reload(request)).rejects.toThrow('development_service_reload_unconfirmed');
  expect(writes).toHaveLength(2);
  exit!(0);
  emit!.close();
  await channel.read;
});

test('stopping a pending original reload rejects it immediately and never sends a replacement', async () => {
  let emit!: ReadableStreamDefaultController<Uint8Array>;
  let exit!: (code: number) => void;
  const writes: string[] = [];
  const channel = createDesktopReloadChannel({
    stdin: { write: (value) => writes.push(value), flush: () => undefined },
    stdout: new ReadableStream<Uint8Array>({
      start(controller) {
        emit = controller;
      },
    }),
    exited: new Promise<number>((resolve) => {
      exit = resolve;
    }),
  });
  const request = { id: 'a'.repeat(32), sha256: 'b'.repeat(64) };
  const original = channel.reload(request);
  channel.stop();
  channel.stop();
  await expect(original).rejects.toThrow('development_desktop_stopping');
  emit.enqueue(
    new TextEncoder().encode(
      `${JSON.stringify({ kind: 'service.reloaded', id: request.id, ok: true })}\n`,
    ),
  );
  await expect(channel.reload(request)).rejects.toThrow('development_desktop_stopping');
  expect(writes).toHaveLength(1);
  exit(0);
  emit.close();
  await channel.read;
});

test('actual source rebuild creates independent immutable versions; syntax failure leaves the running version bytes unchanged', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-development-service-build-')));
  try {
    const source = join(root, 'apps/service/src');
    mkdirSync(source, { recursive: true });
    const entry = join(source, 'main.ts');
    writeFileSync(entry, 'export const revision = 1;');
    const first = await buildDevelopmentService(root, join(root, 'output'));
    const firstPath = join(root, 'output/services', first.id, 'main.js');
    const bytes = readFileSync(firstPath);
    expect(first.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    writeFileSync(entry, 'export const revision = 2;');
    const next = await buildDevelopmentService(root, join(root, 'output'));
    expect(next.id).not.toBe(first.id);
    expect(next.sha256).not.toBe(first.sha256);
    writeFileSync(entry, 'export const revision = ;');
    await expect(buildDevelopmentService(root, join(root, 'output'))).rejects.toThrow(
      'development_service_build_failed',
    );
    expect(readFileSync(firstPath)).toEqual(bytes);
    expect(isDevelopmentServiceSource(root, entry)).toBe(true);
    expect(isDevelopmentServiceSource(root, join(root, 'apps/service/dist/main.js'))).toBe(false);
    expect(
      isDevelopmentServiceSource(root, join(root, '.kite-code/development/profile.json')),
    ).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('development rebuild preserves the built Shell locator module URL including spaces and Unicode paths', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-shell 开发-')));
  try {
    const source = join(root, 'apps/service/src');
    const jobs = join(root, 'packages/agent/dist/jobs');
    mkdirSync(source, { recursive: true });
    mkdirSync(jobs, { recursive: true });
    writeFileSync(
      join(source, 'main.ts'),
      `import {shellSupervisorAsset,linuxShellInitAsset} from '@kite-ai/agent/jobs/shell';
console.log(JSON.stringify([shellSupervisorAsset(),linuxShellInitAsset()]));`,
    );
    // These locators depend on their original built module location, like the real asset owner.
    writeFileSync(
      join(jobs, 'shell.js'),
      `export const shellSupervisorAsset=()=>import.meta.url;
export const linuxShellInitAsset=()=>new URL('../platform/process/linux-shell-init',import.meta.url).href;`,
    );
    for (let revision = 0; revision < 2; revision++) {
      const built = await buildDevelopmentService(root, join(root, 'output'));
      const child = Bun.spawn(
        [process.execPath, join(root, 'output/services', built.id, 'main.js')],
        { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
      );
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
      expect(JSON.parse(stdout)).toEqual([
        pathToFileURL(join(jobs, 'shell.js')).href,
        pathToFileURL(join(root, 'packages/agent/dist/platform/process/linux-shell-init')).href,
      ]);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Vite serves a nonce-bearing hot renderer on loopback, rejects development profile files and closes its listener', async () => {
  // Vite's raw filesystem middleware serves the current drive on Windows.
  // Keep the fixture on that drive so the request exercises a real file, not SPA fallback.
  const fixtures = join(import.meta.dir, '../../../.cache');
  mkdirSync(fixtures, { recursive: true });
  const root = realpathSync(mkdtempSync(join(fixtures, 'kite-development-renderer-')));
  let renderer: Awaited<ReturnType<typeof startDesktopRenderer>> | undefined;
  try {
    mkdirSync(join(root, 'apps/desktop'), { recursive: true });
    writeFileSync(
      join(root, 'apps/desktop/index.html'),
      '<html><head></head><body>hot renderer</body></html>',
    );
    writeFileSync(join(root, 'apps/desktop/public-probe.txt'), 'public-renderer-sentinel');
    const privateDirectories = ['.git', '.kite-code', '.cache', '.aws', '.codex', '.agents'];
    for (const directory of privateDirectories) {
      mkdirSync(join(root, directory), { recursive: true });
      writeFileSync(join(root, directory, 'private.txt'), 'private-profile-sentinel');
    }
    renderer = await startDesktopRenderer(root);
    const html = await (await fetch(renderer.configuration.rendererUrl)).text();
    expect(html).toContain('/@vite/client');
    expect(html).toContain(`nonce="${renderer.configuration.cspNonce}"`);
    const publicFile = await fetch(
      `${renderer.configuration.rendererUrl}@fs/${join(root, 'apps/desktop/public-probe.txt').replaceAll('\\', '/')}`,
    );
    expect(publicFile.status).toBe(200);
    expect(await publicFile.text()).toBe('public-renderer-sentinel');
    for (const directory of privateDirectories) {
      const denied = await fetch(
        `${renderer.configuration.rendererUrl}@fs/${join(root, directory, 'private.txt').replaceAll('\\', '/')}`,
      );
      expect(denied.status).toBe(403);
      expect(await denied.text()).not.toContain('private-profile-sentinel');
    }
    await renderer.server.close();
    await expect(fetch(renderer.configuration.rendererUrl)).rejects.toThrow();
  } finally {
    await renderer?.server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
