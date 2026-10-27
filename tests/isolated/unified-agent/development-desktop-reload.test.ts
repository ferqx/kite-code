import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
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
  isDevelopmentServiceSourceEvent,
  startDesktopControl,
  startDesktopRenderer,
  startDevelopmentServiceWatcher,
} from '../../../scripts/development/desktop-reload';

test('runtime workspace exports are checked before publishing a development Service version', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-development-exports-')));
  try {
    const source = join(root, 'apps/service/src');
    const agent = join(root, 'packages/agent/src');
    const dependency = join(root, 'node_modules/@kite-ai/agent');
    for (const directory of [source, agent, dependency]) mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(dependency, 'package.json'),
      JSON.stringify({ type: 'module', main: 'index.ts' }),
    );
    writeFileSync(
      join(dependency, 'index.ts'),
      "export * from '../../../packages/agent/src/index.ts';",
    );
    writeFileSync(join(agent, 'model-result.ts'), 'export const available = 1;');
    writeFileSync(join(agent, 'index.ts'), 'export const revision = 1;');
    writeFileSync(
      join(source, 'main.ts'),
      "import {revision} from '@kite-ai/agent'; export {revision};",
    );
    const output = join(root, 'output');
    const first = await buildDevelopmentService(root, output);
    const firstPath = join(output, 'services', first.id, 'main.js');
    const bytes = readFileSync(firstPath);
    writeFileSync(
      join(agent, 'index.ts'),
      "import {formatFileListResult} from './model-result'; export const revision = formatFileListResult();",
    );
    await expect(buildDevelopmentService(root, output)).rejects.toMatchObject({
      code: 'development_service_load_failed',
      message: expect.stringContaining('formatFileListResult'),
    });
    expect(readFileSync(firstPath)).toEqual(bytes);
    writeFileSync(join(agent, 'index.ts'), 'export const revision = 2;');
    const repaired = await buildDevelopmentService(root, output);
    expect(repaired.sha256).toBe(first.sha256);
    expect(repaired.sourceSha256).not.toBe(first.sourceSha256);
    const unchanged = await buildDevelopmentService(root, output);
    expect(unchanged.sourceSha256).toBe(repaired.sourceSha256);
    for (const path of [
      'packages/agent/src/tools/files-tools.ts',
      'packages/ai/src/sdk.ts',
      'packages/client/src/generated/validators.js',
    ])
      expect(isDevelopmentServiceSource(root, join(root, path))).toBe(true);
    expect(
      isDevelopmentServiceSource(root, join(root, 'packages/ui/src/desktop/Composer.tsx')),
    ).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a connected Desktop is not ready until Service startup succeeds; authenticated startup failure reaches the parent', async () => {
  const control = await startDesktopControl();
  const peer = connect({ host: '127.0.0.1', port: control.configuration.port });
  peer.on('error', () => {});
  let ready = false;
  let finish!: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    finish = resolve;
  });
  const attached = control.attach(exited);
  void attached.then(
    () => {
      ready = true;
    },
    () => {},
  );
  try {
    await new Promise<void>((resolve) => peer.once('connect', resolve));
    await Bun.sleep(5);
    expect(ready).toBe(false);
    peer.write(
      `${JSON.stringify({ kind: 'desktop.failed', token: control.configuration.token, code: 'required_capability_missing' })}\n`,
    );
    await expect(attached).rejects.toThrow('required_capability_missing');
    expect(ready).toBe(false);
  } finally {
    finish(1);
    peer.destroy();
    await control.close();
  }
});

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
    const signalListeners = process.listenerCount('SIGTERM');
    const stdinListeners = process.stdin.listenerCount('end');
    renderer = await startDesktopRenderer(root);
    expect(process.listenerCount('SIGTERM')).toBe(signalListeners);
    expect(process.stdin.listenerCount('end')).toBe(stdinListeners);
    const html = await (await fetch(renderer.configuration.rendererUrl)).text();
    expect(html).toContain('/@vite/client');
    expect(html).toContain(`nonce="${renderer.configuration.cspNonce}"`);
    const client = await (await fetch(`${renderer.configuration.rendererUrl}@vite/client`)).text();
    expect(Number(/const hmrPort = (\d+);/.exec(client)?.[1])).toBe(
      Number(new URL(renderer.configuration.rendererUrl).port),
    );
    const token = /const wsToken = "([^"]+)";/.exec(client)?.[1];
    expect(token).toBeTruthy();
    const socket = new WebSocket(
      `${renderer.configuration.rendererUrl.replace('http:', 'ws:')}?token=${token}`,
      'vite-hmr',
    );
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const connected = await new Promise<boolean>((resolve, reject) => {
        timeout = setTimeout(() => reject(Error('development_hmr_timeout')), 2000);
        socket.onmessage = (event) => {
          if (JSON.parse(String(event.data)).type === 'connected') resolve(true);
        };
        socket.onerror = () => reject(Error('development_hmr_unavailable'));
      });
      expect(connected).toBe(true);
    } finally {
      clearTimeout(timeout);
      socket.close();
    }
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
    await renderer.close();
    await expect(fetch(renderer.configuration.rendererUrl)).rejects.toThrow();
  } finally {
    await renderer?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a fresh Service watcher finishes its own scan before immediate writes and follows new source directories', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-development-source-watch-')));
  let renderer: Awaited<ReturnType<typeof startDesktopRenderer>> | undefined;
  let watcher: Awaited<ReturnType<typeof startDevelopmentServiceWatcher>> | undefined;
  try {
    mkdirSync(join(root, 'apps/desktop'), { recursive: true });
    writeFileSync(join(root, 'apps/desktop/index.html'), '<!doctype html><p>watch fixture</p>');
    const source = join(root, 'apps/service/src');
    mkdirSync(source, { recursive: true });
    mkdirSync(join(root, 'packages/agent/src'), { recursive: true });
    const existing = join(source, 'main.ts');
    writeFileSync(existing, 'export const value = 1;');
    renderer = await startDesktopRenderer(root);
    const template = renderer.server.watcher;
    const events: { event: string; file: string }[] = [];
    const failures: Error[] = [];
    const roots = ['apps/service', 'packages/agent', 'packages/ai', 'packages/client'].map((path) =>
      join(root, path, 'src'),
    );
    watcher = await startDevelopmentServiceWatcher({
      template,
      roots,
      changed(event, file) {
        if (isDevelopmentServiceSourceEvent(root, event, file)) events.push({ event, file });
      },
      failed: (error) => failures.push(error),
    });
    // No sleep or task yield between the helper's own ready and this first edit.
    writeFileSync(existing, 'export const value = 2;');
    const observed = async (file: string) => {
      const deadline = Date.now() + 2000;
      while (!events.some((event) => event.file === file) && Date.now() < deadline)
        await Bun.sleep(5);
      expect(events.some((event) => event.file === file)).toBe(true);
    };
    await observed(existing);
    const nested = join(source, 'nested');
    mkdirSync(nested);
    writeFileSync(join(nested, 'new.ts'), 'export const fresh = true;');
    await observed(join(nested, 'new.ts'));
    const missing = join(root, 'packages/client/src');
    mkdirSync(missing, { recursive: true });
    writeFileSync(join(missing, 'observation.ts'), 'export const observation = 2;');
    await observed(join(missing, 'observation.ts'));
    expect(isDevelopmentServiceSourceEvent(root, 'unlinkDir', nested)).toBe(true);
    expect(isDevelopmentServiceSourceEvent(root, 'addDir', join(root, 'packages/ai'))).toBe(true);
    expect(isDevelopmentServiceSourceEvent(root, 'change', join(source, 'theme.css'))).toBe(false);
    expect(isDevelopmentServiceSourceEvent(root, 'addDir', join(root, 'packages/ui/src'))).toBe(
      false,
    );
    expect(renderer.server.watcher).toBe(template);
    await watcher.close();
    const before = events.length;
    writeFileSync(existing, 'export const value = 3;');
    await Bun.sleep(30);
    expect(events).toHaveLength(before);
    expect(failures).toEqual([]);
  } finally {
    await watcher?.close();
    await renderer?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('owned Service watcher waits for its first ready and releases partial startup, abort and runtime errors', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-development-watch-lifecycle-')));
  type Template = Parameters<typeof startDevelopmentServiceWatcher>[0]['template'];
  class Watcher extends EventEmitter {
    options: Template['options'];
    roots: readonly string[] = [];
    closed = 0;
    static last: Watcher;
    static addFailure = false;
    constructor(options: Template['options'] = {}) {
      super();
      this.options = options;
      Watcher.last = this;
    }
    add(roots: readonly string[]) {
      this.roots = roots;
      if (Watcher.addFailure) throw Error('fixture_add_failed');
      return this;
    }
    getWatched() {
      return {};
    }
    async close() {
      this.closed++;
    }
  }
  try {
    mkdirSync(join(root, 'packages'));
    for (const phase of [
      'ready',
      'startup-error',
      'abort',
      'add-error',
      'runtime-error',
    ] as const) {
      const template = new Watcher();
      Watcher.addFailure = phase === 'add-error';
      const abort = new AbortController();
      const failures: Error[] = [];
      let changes = 0;
      let admitted = false;
      const pending = startDevelopmentServiceWatcher({
        template: template as unknown as Template,
        roots: [join(root, 'packages/agent/src'), join(root, 'packages/client/src')],
        changed: () => {
          changes++;
        },
        failed: (error) => failures.push(error),
        signal: abort.signal,
      });
      void pending.then(
        () => {
          admitted = true;
        },
        () => {},
      );
      const owned = Watcher.last;
      expect(owned).not.toBe(template);
      expect(owned.roots).toEqual([join(root, 'packages')]);
      await Promise.resolve();
      expect(admitted).toBe(false);
      if (phase === 'startup-error') owned.emit('error', Error('fixture_startup_error'));
      else if (phase === 'abort') abort.abort();
      else if (phase !== 'add-error') owned.emit('ready');
      if (phase === 'ready' || phase === 'runtime-error') {
        const started = await pending;
        expect(admitted).toBe(true);
        if (phase === 'runtime-error') owned.emit('error', Error('fixture_runtime_error'));
        else owned.emit('all', 'change', 'main.ts');
        await started.close();
        owned.emit('all', 'change', 'late.ts');
        expect(changes).toBe(phase === 'ready' ? 1 : 0);
      } else
        await expect(pending).rejects.toThrow(
          phase === 'add-error'
            ? 'fixture_add_failed'
            : phase === 'abort'
              ? 'development_service_watcher_closed'
              : 'fixture_startup_error',
        );
      expect(owned.closed).toBe(1);
      expect(template.closed).toBe(0);
      expect(failures.map((error) => error.message)).toEqual(
        phase === 'startup-error'
          ? ['fixture_startup_error']
          : phase === 'runtime-error'
            ? ['fixture_runtime_error']
            : [],
      );
    }
    const invalid = { constructor: Object } as unknown as Template;
    await expect(
      startDevelopmentServiceWatcher({
        template: invalid,
        roots: [root],
        changed() {},
        failed() {},
      }),
    ).rejects.toThrow('development_service_watcher_unavailable');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
