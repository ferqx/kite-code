import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesktopHost, ensurePrivateDirectory } from '../electron/host';

class FakePeer {
  readonly serverVersion: string;
  readonly attachments: number[] = [];
  readonly sent: Array<{ generation: number; frame: string }> = [];
  finished = false;
  closeCount = 0;

  constructor(serverVersion: string) {
    this.serverVersion = serverVersion;
  }

  async attach(generation: number): Promise<void> {
    this.attachments.push(generation);
  }

  async send(generation: number, frame: string): Promise<void> {
    this.sent.push({ generation, frame });
  }

  async receive(generation: number): Promise<string> {
    return JSON.stringify({ generation });
  }

  async close(): Promise<void> {
    this.closeCount += 1;
    this.finished = true;
  }
}

test('host preserves the Service across renderer generations and fences stale close', async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'kite-electron-host-')));
  try {
    const home = join(root, 'home');
    const workspace = join(home, 'workspace');
    const serviceDirectory = join(root, 'service');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(serviceDirectory);
    const executable = join(serviceDirectory, 'kite-service');
    writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    const buildId = 'host-test-build';
    const manifest = {
      buildId,
      environmentKeys: [],
      executableSha256: digest(readFileSync(executable)),
      expectedServerVersion: `kite-app-server-v1-${digest(buildId)}`,
    };
    const peers: FakePeer[] = [];
    const host = new DesktopHost({
      appDataDirectory: join(root, 'data'),
      homeDirectory: home,
      serviceDirectory,
      repositoryDirectory: root,
      debug: false,
      platform: 'darwin',
      serviceManifest: manifest,
      createPeer: (_options, version) => {
        const peer = new FakePeer(version);
        peers.push(peer);
        return peer;
      },
    });

    const selected = await host.rememberPickedWorkspace(workspace);
    await host.activateWorkspace(selected);
    const first = await host.runtimeOpen();
    expect(first).toMatchObject({ connectionId: 1, workspace });
    expect(peers).toHaveLength(1);
    expect(peers[0]?.attachments).toEqual([1]);

    await host.detachRenderer();
    const second = await host.runtimeOpen();
    expect(second.connectionId).toBe(2);
    expect(peers).toHaveLength(1);
    expect(peers[0]?.attachments).toEqual([1, 0, 2]);
    await expect(host.runtimeClose(first.connectionId)).rejects.toThrow('连接已被替换。');
    expect(peers[0]?.closeCount).toBe(0);

    await host.runtimeDetach(second.connectionId);
    expect(peers[0]?.attachments.at(-1)).toBe(0);
    const third = await host.runtimeOpen();
    expect(third.connectionId).toBe(3);
    expect(peers).toHaveLength(1);
    await host.runtimeClose(third.connectionId);
    expect(peers[0]?.closeCount).toBe(1);

    // The runtime manifest is the constructor-pinned build input. A mutable
    // desktop.json beside the executable is never consulted at open time.
    writeFileSync(
      join(serviceDirectory, 'desktop.json'),
      JSON.stringify({ buildId: 'replacement' }),
    );
    const fourth = await host.runtimeOpen();
    expect(fourth.expectedServerVersion).toBe(manifest.expectedServerVersion);
    await host.runtimeClose(fourth.connectionId);

    writeFileSync(executable, 'tampered');
    await expect(host.runtimeOpen()).rejects.toThrow('服务制品校验失败');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('private runtime directories reject symlinks and are forced to owner-only mode', () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'kite-electron-private-')));
  try {
    const target = join(root, 'target');
    mkdirSync(target, { mode: 0o755 });
    const linked = join(root, 'linked');
    symlinkSync(target, linked);
    expect(() => ensurePrivateDirectory(linked, root, 'darwin')).toThrow('类型或所有者');
    expect(statSync(target).mode & 0o777).toBe(0o755);
    const privateDirectory = join(root, 'private');
    ensurePrivateDirectory(privateDirectory, root, 'darwin');
    expect(statSync(privateDirectory).mode & 0o777).toBe(0o700);
    chmodSync(privateDirectory, 0o755);
    ensurePrivateDirectory(privateDirectory, root, 'darwin');
    expect(statSync(privateDirectory).mode & 0o777).toBe(0o700);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
