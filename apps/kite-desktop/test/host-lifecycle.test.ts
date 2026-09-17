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
      platform: 'darwin',
      serviceManifest: manifest,
      createPeer: (_options, version) => {
        const peer = new FakePeer(version);
        peers.push(peer);
        return peer;
      },
    });

    const selected = await host.rememberPickedWorkspace(workspace);
    const otherWorkspace = join(home, 'other-workspace');
    mkdirSync(otherWorkspace);
    await host.rememberPickedWorkspace(otherWorkspace);
    const orderBeforeActivation = host.listProjects().map((project) => project.path);
    await host.activateWorkspace(selected);
    expect(host.listProjects().map((project) => project.path)).toEqual(orderBeforeActivation);
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

test('quit retains a Service whose cleanup failed and retries the same owner', async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'kite-electron-quit-owner-')));
  try {
    const home = join(root, 'home');
    const serviceDirectory = join(root, 'service');
    mkdirSync(home);
    mkdirSync(serviceDirectory);
    const executable = join(serviceDirectory, 'kite-service');
    writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    const buildId = 'quit-owner-test';
    const peer = new FakePeer(`kite-app-server-v1-${digest(buildId)}`);
    let failClose = true;
    peer.close = async () => {
      peer.closeCount++;
      if (failClose) throw new Error('cleanup still pending');
      peer.finished = true;
    };
    let created = 0;
    const host = new DesktopHost({
      appDataDirectory: join(root, 'data'),
      homeDirectory: home,
      serviceDirectory,
      platform: 'darwin',
      serviceManifest: {
        buildId,
        environmentKeys: [],
        executableSha256: digest(readFileSync(executable)),
        expectedServerVersion: peer.serverVersion,
      },
      createPeer: () => {
        created++;
        return peer;
      },
    });
    const opened = await host.runtimeOpen();
    const quitting = host.quit();
    expect(host.runtimeStartupStatus().message).toContain('正在等待会话数据安全取消或提交结算');
    await expect(quitting).rejects.toThrow('cleanup still pending');
    expect((await host.runtimeStatus()).connectionId).toBe(opened.connectionId);
    await host.runtimeOpen();
    expect(created).toBe(1);
    failClose = false;
    await host.quit();
    expect(peer.closeCount).toBe(2);
    expect((await host.runtimeStatus()).connectionId).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('quit requested while runtimeOpen holds the lock closes its peer before returning', async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'kite-electron-opening-quit-')));
  try {
    const home = join(root, 'home');
    const serviceDirectory = join(root, 'service');
    mkdirSync(home);
    mkdirSync(serviceDirectory);
    const executable = join(serviceDirectory, 'kite-service');
    writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    const buildId = 'opening-quit-test';
    const peer = new FakePeer(`kite-app-server-v1-${digest(buildId)}`);
    let releaseAttach!: () => void;
    const attaching = new Promise<void>((resolve) => {
      releaseAttach = resolve;
    });
    let enteredAttach!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredAttach = resolve;
    });
    peer.attach = async (generation) => {
      peer.attachments.push(generation);
      enteredAttach();
      await attaching;
    };
    const host = new DesktopHost({
      appDataDirectory: join(root, 'data'),
      homeDirectory: home,
      serviceDirectory,
      platform: 'darwin',
      serviceManifest: {
        buildId,
        environmentKeys: [],
        executableSha256: digest(readFileSync(executable)),
        expectedServerVersion: peer.serverVersion,
      },
      createPeer: () => peer,
    });
    const opening = host.runtimeOpen();
    await entered;
    const quitting = host.quit();
    releaseAttach();
    await expect(opening).rejects.toThrow('应用正在退出');
    await quitting;
    expect(peer.closeCount).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Desktop source and installed clients use the canonical config Store root', async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'kite-electron-canonical-store-')));
  try {
    const home = join(root, 'home');
    const serviceDirectory = join(root, 'service');
    mkdirSync(home);
    mkdirSync(serviceDirectory);
    const executable = join(serviceDirectory, 'kite-service');
    writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    const manifest = {
      buildId: 'source-profile-test',
      environmentKeys: [],
      executableSha256: digest(readFileSync(executable)),
      expectedServerVersion: `kite-app-server-v1-${digest('source-profile-test')}`,
    };
    let runtimeRoot: string | undefined;
    const host = new DesktopHost({
      appDataDirectory: join(root, 'data'),
      homeDirectory: home,
      serviceDirectory,
      platform: 'darwin',
      serviceManifest: manifest,
      createPeer: (options, version) => {
        runtimeRoot = options.runtimeRoot;
        return new FakePeer(version);
      },
    });
    await host.runtimeOpen();
    const canonicalHome = realpathSync.native(join(home, '.kite-code'));
    expect(runtimeRoot).toBe(canonicalHome);
    await host.quit();
    const secondHost = new DesktopHost({
      appDataDirectory: join(root, 'data'),
      homeDirectory: home,
      serviceDirectory,
      platform: 'darwin',
      serviceManifest: manifest,
      createPeer: (_options, version) => new FakePeer(version),
    });
    await secondHost.runtimeOpen();
    await secondHost.quit();
    expect(
      () =>
        new DesktopHost({
          appDataDirectory: join(root, 'data'),
          homeDirectory: home,
          serviceDirectory,
          platform: 'darwin',
          serviceManifest: { ...manifest, storeFormatEpoch: 'untrusted-archive-value' },
        }),
    ).toThrow('服务制品清单无效');
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
