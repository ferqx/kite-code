import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { selectProfile } from '@kite-ai/agent/profile';
import { launchPairedService } from '@kite-ai/service/paired';
import { buildOwnedDaemon } from '../fixtures/daemon-host-build';
import { ptyDeadline, spawnTuiPTY, terminateTuiTree } from '../fixtures/tui-pty';

const repository = resolve(import.meta.dir, '../../../..');
test('ordinary render failure waits for explicit exit and closes the actual owned Service with nonzero status', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-tui-render-failure-'))),
    workspace = join(root, 'workspace'),
    profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'owned' });
  mkdirSync(workspace);
  let pty: ReturnType<typeof spawnTuiPTY> | undefined;
  let servicePid: number | undefined;
  try {
    await buildOwnedDaemon(join(root, 'artifact'));
    const entrypoint = join(root, 'artifact/node_modules/@kite-ai/service/main.js'),
      executable = realpathSync(process.execPath),
      hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex'),
      artifact = {
        entrypoint,
        executable,
        entrypointSha256: hash(entrypoint),
        executableSha256: hash(executable),
        apiMajor: 1,
        buildId: 'owned-render-failure',
      };
    const runner = join(root, 'runner.ts'),
      pidFile = join(root, 'service.pid');
    // Fault injection replaces only the renderer leaf. The actual Host, Client,
    // Service process, Store and shutdown path all remain production instances.
    writeFileSync(
      runner,
      `import{mock}from'bun:test';import{writeFileSync}from'node:fs';const actual=await import(${JSON.stringify(pathToFileURL(join(repository, 'packages/ui/src/tui/index.tsx')).href)});function Broken(){throw new Error('OWNED_RENDER_FAILURE\\x1b[31m unsafe');}mock.module(${JSON.stringify(join(repository, 'packages/ui/src/tui/index.tsx'))},()=>({...actual,TuiSession:Broken}));const{runTUIHost}=await import(${JSON.stringify(pathToFileURL(join(repository, 'apps/cli/host/tui.tsx')).href)});process.exitCode=await runTUIHost({artifact:${JSON.stringify(artifact)},dataRoot:${JSON.stringify(profile.dataRoot)},profile:'owned',workspace:${JSON.stringify(workspace)},cwd:${JSON.stringify(workspace)},onLaunched:({pid})=>writeFileSync(${JSON.stringify(pidFile)},String(pid))});`,
    );
    pty = spawnTuiPTY({ cmd: [process.execPath, '--no-install', runner], cwd: repository });
    const deadline = Date.now() + 15000;
    for (;;) {
      const frame = await pty.projection();
      if (frame.fresh && frame.text.includes('Press Enter or Esc to exit')) break;
      if (pty.ended || Date.now() > deadline)
        throw Error(`error page unavailable: ${pty.text().slice(-2500)}`);
      await Bun.sleep(25);
    }
    servicePid = Number(readFileSync(pidFile, 'utf8'));
    expect(Number.isSafeInteger(servicePid)).toBe(true);
    process.kill(servicePid, 0);
    expect(pty.text()).toContain('OWNED_RENDER_FAILURE\\u001b[31m unsafe');
    expect(pty.text()).not.toContain('at Broken');
    expect(pty.text()).toContain('\x1b[>1u');
    expect(pty.ended).toBe(false);
    process.kill(servicePid, 0);
    await pty.key('\r');
    const [exit] = await ptyDeadline(
      Promise.all([pty.host.exited, pty.eof]),
      6000,
      'failed renderer host remained alive',
    );
    expect(exit).toBe(1);
    expect(() => process.kill(servicePid!, 0)).toThrow();
    await pty.drain();
    expect(pty.text()).toContain('\x1b[<u');
    const db = new Database(profile.databasePath, { readonly: true });
    try {
      expect(db.query('SELECT count(*) AS n FROM run').get()).toEqual({ n: 0 });
      expect(db.query('SELECT count(*) AS n FROM execution').get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
    const reopened = await launchPairedService({
      profile,
      ...artifact,
      instanceId: crypto.randomUUID(),
      requiredCapabilities: ['sessions'],
    });
    try {
      expect(reopened.bootstrap.dataAvailability).toBe('available');
    } finally {
      await reopened.close();
    }
  } finally {
    if (pty) {
      if (!pty.ended)
        await terminateTuiTree(pty, {
          servicePid,
          requireServiceAlive: false,
          exitTimeoutMs: 3000,
        });
      await pty.drain();
      pty.close();
    }
    rmSync(root, { recursive: true, force: true });
  }
}, 35000);
