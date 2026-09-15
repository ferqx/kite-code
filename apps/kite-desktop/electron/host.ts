import { createHash } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  type Stats,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import type {
  BranchSnapshot,
  DesktopConnectionInfo,
  DesktopEditor,
  DesktopProject,
  DesktopRuntimeStatus,
} from '../src/bridge';
import { AsyncMutex } from './async-mutex';
import { editorFileTarget, openEditor } from './editor';
import { queryBranch, switchBranch } from './git';
import {
  canonicalProject,
  knownProject,
  readProjectDisplay,
  readProjects,
  rememberProject,
} from './projects';
import { RendererConnection } from './runtime/renderer-connection';
import { ServiceProcess, type ServiceProcessOptions } from './runtime/service-process';

interface ServiceManifest {
  buildId: string;
  executableSha256: string;
  expectedServerVersion: string;
  environmentKeys: string[];
}

interface RuntimePeer {
  readonly serverVersion: string;
  readonly finished: boolean;
  attach(generation: number): Promise<void>;
  send(generation: number, frame: string): Promise<void>;
  receive(generation: number): Promise<string>;
  close(): Promise<void>;
}

export interface DesktopHostOptions {
  appDataDirectory: string;
  homeDirectory: string;
  serviceDirectory: string;
  repositoryDirectory: string;
  debug: boolean;
  serviceManifest: unknown;
  platform?: NodeJS.Platform;
  createPeer?: (options: ServiceProcessOptions, serverVersion: string) => RuntimePeer;
}

/** Native filesystem, Git and exact paired Service authority for one Electron app instance. */
export class DesktopHost {
  readonly #options: DesktopHostOptions;
  readonly #manifest: ServiceManifest;
  readonly #lock = new AsyncMutex();
  #workspace?: string;
  #generation = 0;
  #process?: RuntimePeer;
  #quitting = false;

  constructor(options: DesktopHostOptions) {
    this.#options = options;
    if (!isManifest(options.serviceManifest)) throw new Error('服务制品清单无效。');
    this.#manifest = structuredClone(options.serviceManifest);
  }

  async rememberPickedWorkspace(selected: string): Promise<string> {
    return this.#lock.run(() => {
      const path = canonicalProject(selected);
      rememberProject(this.#options.appDataDirectory, path);
      return path;
    });
  }

  listProjects(): DesktopProject[] {
    return readProjectDisplay(this.#options.appDataDirectory);
  }

  async activateWorkspace(value: string): Promise<string> {
    return this.#lock.run(() => {
      if (this.#quitting) throw new Error('应用正在退出。');
      const path = knownProject(this.#options.appDataDirectory, value);
      this.#workspace = path;
      return path;
    });
  }

  checkWorkspace(value: string): void {
    knownProject(this.#options.appDataDirectory, value);
  }

  queryWorkspaceBranch(workspace: string): Promise<BranchSnapshot> {
    const path = knownProject(this.#options.appDataDirectory, workspace);
    return queryBranch(path);
  }

  async switchWorkspaceBranch(expected: BranchSnapshot, branch: string): Promise<BranchSnapshot> {
    return this.#lock.run(async () => {
      if (this.#process || this.#quitting) throw new Error('请先关闭项目服务并等待清理完成。');
      if (!this.#workspace) throw new Error('请先选择项目。');
      if (this.#workspace !== expected.workspace) throw new Error('项目已切换，请重新读取分支。');
      return switchBranch(this.#workspace, branch, expected);
    });
  }

  async runtimeStatus(): Promise<DesktopRuntimeStatus> {
    return this.#lock.run(() => ({
      workspace: this.#workspace ?? null,
      connectionId: this.#process ? this.#generation : null,
    }));
  }

  async runtimeOpen(): Promise<DesktopConnectionInfo> {
    return this.#lock.run(async () => {
      if (this.#quitting) throw new Error('应用正在退出。');
      if (this.#workspace === undefined) {
        try {
          this.#workspace = readProjects(this.#options.appDataDirectory)[0]?.path;
        } catch {
          this.#workspace = undefined;
        }
      }
      const workspace = this.#workspace ?? '';
      if (this.#process?.finished) this.#process = undefined;
      if (this.#process) {
        const generation = this.#nextGeneration();
        await this.#process.attach(generation);
        return {
          connectionId: generation,
          workspace,
          expectedServerVersion: this.#process.serverVersion,
        };
      }

      const manifest = this.#manifest;
      const executable = join(
        this.#options.serviceDirectory,
        (this.#options.platform ?? process.platform) === 'win32'
          ? 'kite-service.exe'
          : 'kite-service',
      );
      verifyExecutable(executable, manifest.executableSha256);
      const expectedVersion = `kite-app-server-v1-${sha256(manifest.buildId)}`;
      if (expectedVersion !== manifest.expectedServerVersion)
        throw new Error('服务版本清单不一致。');

      let home: string;
      try {
        home = realpathSync.native(this.#options.homeDirectory);
      } catch {
        throw new Error('用户目录不可用。');
      }
      const configRoot = join(home, '.kite-code');
      ensurePrivateDirectory(configRoot, home, this.#options.platform ?? process.platform);
      let runtimeRoot = configRoot;
      if (this.#options.debug) {
        let repository: string;
        try {
          repository = realpathSync.native(this.#options.repositoryDirectory);
        } catch {
          throw new Error('源码工作区不可用。');
        }
        const canonicalConfig = realpathSync.native(configRoot);
        const digest = sha256(
          `kite-source-runtime-profile\0${canonicalConfig}\0${repository}`,
        ).slice(0, 32);
        const parent = join(canonicalConfig, 'source-profiles');
        ensurePrivateDirectory(parent, home, this.#options.platform ?? process.platform);
        runtimeRoot = join(parent, digest);
        ensurePrivateDirectory(runtimeRoot, home, this.#options.platform ?? process.platform);
      }
      const processOptions: ServiceProcessOptions = {
        executable,
        workspace,
        home,
        runtimeRoot,
        buildId: manifest.buildId,
        environmentKeys: manifest.environmentKeys,
      };
      const peer = this.#options.createPeer
        ? this.#options.createPeer(processOptions, manifest.expectedServerVersion)
        : new RendererConnection(
            await ServiceProcess.start(processOptions),
            manifest.expectedServerVersion,
          );
      const generation = this.#nextGeneration();
      await peer.attach(generation);
      this.#process = peer;
      return {
        connectionId: generation,
        workspace,
        expectedServerVersion: manifest.expectedServerVersion,
      };
    });
  }

  async runtimeSend(connectionId: number, frame: string): Promise<void> {
    const process = await this.#connection(connectionId);
    await process.send(connectionId, frame);
  }

  async runtimeReceive(connectionId: number): Promise<string> {
    const process = await this.#connection(connectionId);
    return process.receive(connectionId);
  }

  async runtimeClose(connectionId: number): Promise<void> {
    await this.#lock.run(async () => {
      if (connectionId !== this.#generation) throw new Error('连接已被替换。');
      try {
        await this.#process?.close();
      } finally {
        this.#process = undefined;
      }
    });
  }

  async runtimeDetach(connectionId: number): Promise<void> {
    await this.#lock.run(async () => {
      if (connectionId !== this.#generation) return;
      await this.#process?.attach(0);
    });
  }

  /** Renderer document/process loss detaches the view but preserves the Service. */
  async detachRenderer(): Promise<void> {
    await this.#lock.run(async () => {
      await this.#process?.attach(0);
    });
  }

  async openEditor(connectionId: number, path: string, editor: DesktopEditor): Promise<void> {
    await this.#lock.run(async () => {
      if (connectionId !== this.#generation || !this.#process || this.#quitting)
        throw new Error('文件所属项目连接已改变，请重新查看。');
      if (!this.#workspace) throw new Error('请先连接项目。');
      const target = editorFileTarget(this.#workspace, path);
      await openEditor(editor, target);
    });
  }

  async quit(): Promise<void> {
    await this.#lock.run(async () => {
      this.#quitting = true;
      const process = this.#process;
      this.#process = undefined;
      try {
        await process?.close();
      } catch (error) {
        this.#quitting = false;
        throw error;
      }
    });
  }

  cancelQuit(): void {
    this.#quitting = false;
  }

  async #connection(connectionId: number): Promise<RuntimePeer> {
    return this.#lock.run(() => {
      if (connectionId !== this.#generation) throw new Error('连接已被替换。');
      if (!this.#process) throw new Error('连接已关闭。');
      return this.#process;
    });
  }

  #nextGeneration(): number {
    if (this.#generation >= Number.MAX_SAFE_INTEGER) throw new Error('页面连接代次已耗尽。');
    this.#generation += 1;
    return this.#generation;
  }
}

function verifyExecutable(executable: string, expectedDigest: string): void {
  let metadata: Stats;
  try {
    metadata = lstatSync(executable);
  } catch {
    throw new Error('配套服务缺失。');
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('服务制品必须是普通文件。');
  let bytes: Buffer;
  try {
    bytes = readFileSync(executable);
  } catch {
    throw new Error('服务制品无法读取。');
  }
  if (sha256(bytes) !== expectedDigest) throw new Error('服务制品校验失败，请重新安装。');
}

export function ensurePrivateDirectory(
  path: string,
  home: string,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === 'win32') throw new Error('此平台的桌面数据目录保护尚未实现。');
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if (!isNodeError(error, 'EEXIST')) throw new Error('无法创建本机私有数据目录。');
  }
  let metadata: Stats;
  let owner: number;
  try {
    metadata = lstatSync(path);
    owner = statSync(home).uid;
  } catch {
    throw new Error('无法验证本机数据目录。');
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== owner)
    throw new Error('本机数据目录的类型或所有者不符合要求。');
  try {
    chmodSync(path, 0o700);
  } catch {
    throw new Error('无法保护本机数据目录。');
  }
}

function isManifest(value: unknown): value is ServiceManifest {
  if (
    !isExactRecord(value, [
      'buildId',
      'environmentKeys',
      'executableSha256',
      'expectedServerVersion',
    ])
  )
    return false;
  return (
    typeof value.buildId === 'string' &&
    value.buildId.length > 0 &&
    value.buildId.length <= 1024 &&
    typeof value.executableSha256 === 'string' &&
    /^[a-f0-9]{64}$/u.test(value.executableSha256) &&
    typeof value.expectedServerVersion === 'string' &&
    value.expectedServerVersion.length > 0 &&
    Array.isArray(value.environmentKeys) &&
    value.environmentKeys.length <= 128 &&
    value.environmentKeys.every(
      (key) => typeof key === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(key),
    )
  );
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
