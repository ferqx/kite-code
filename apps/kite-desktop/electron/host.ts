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
import {
  type PairedDesktopServiceManifest,
  pairedDesktopManifestDigest,
  parsePairedDesktopServiceManifest,
} from '@kite-ai/kite-local-runtime/desktop-manifest';
import {
  describeServiceStartupProgress,
  formatServiceStartupReport,
  type ServiceStartupDiagnostic,
  type ServiceStartupPhase,
} from '@kite-ai/kite-local-runtime/startup-diagnostic';
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
  serviceManifest: unknown;
  sourceRepositoryRoot?: string;
  platform?: NodeJS.Platform;
  createPeer?: (options: ServiceProcessOptions, serverVersion: string) => RuntimePeer;
}

/** Native filesystem, Git and exact paired Service authority for one Electron app instance. */
export class DesktopHost {
  readonly #options: DesktopHostOptions;
  readonly #manifest: PairedDesktopServiceManifest;
  readonly #lock = new AsyncMutex();
  #workspace?: string;
  #generation = 0;
  #process?: RuntimePeer;
  #openingProcess?: ServiceProcess;
  #quitting = false;
  #startupPhase: ServiceStartupPhase | null = null;
  #startupDiagnostic: ServiceStartupDiagnostic | null = null;

  constructor(options: DesktopHostOptions) {
    this.#options = options;
    try {
      this.#manifest = parsePairedDesktopServiceManifest(options.serviceManifest);
    } catch {
      throw new Error('服务制品清单无效。');
    }
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

  /** Independent of the Runtime peer lock, which is held while a child is opening. */
  runtimeStartupStatus(): {
    phase: ServiceStartupPhase | null;
    message: string | null;
    diagnosticAvailable: boolean;
  } {
    const waitingForSafeExit = this.#quitting && (this.#openingProcess || this.#process);
    return {
      phase: this.#startupPhase,
      message: waitingForSafeExit
        ? '已请求退出，正在等待会话数据安全取消或提交结算。'
        : this.#startupPhase
          ? describeServiceStartupProgress({ phase: this.#startupPhase })
          : null,
      diagnosticAvailable: this.#startupDiagnostic !== null,
    };
  }

  /** The native save dialog receives only the validated fixed-field report. */
  startupDiagnosticReport(): string | null {
    return this.#startupDiagnostic ? formatServiceStartupReport(this.#startupDiagnostic) : null;
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

      this.#startupPhase = null;
      this.#startupDiagnostic = null;

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
      const runtimeRoot = realpathSync.native(configRoot);
      const processOptions: ServiceProcessOptions = {
        executable,
        workspace,
        home,
        runtimeRoot,
        buildId: manifest.buildId,
        environmentKeys: manifest.environmentKeys,
        pairedManifestSha256: pairedDesktopManifestDigest(manifest),
        onStartupPhase: (phase) => {
          this.#startupPhase = phase;
        },
        onStartupDiagnostic: (diagnostic) => {
          this.#startupDiagnostic = diagnostic;
        },
        ...(this.#options.sourceRepositoryRoot
          ? { sourceRepositoryRoot: this.#options.sourceRepositoryRoot }
          : {}),
      };
      let peer: RuntimePeer | undefined;
      try {
        peer = this.#options.createPeer
          ? this.#options.createPeer(processOptions, manifest.expectedServerVersion)
          : new RendererConnection(
              await ServiceProcess.start(processOptions, (created) => {
                this.#openingProcess = created;
                if (this.#quitting) created.requestStartupCancellation();
              }),
              manifest.expectedServerVersion,
            );
        const generation = this.#nextGeneration();
        await peer.attach(generation);
        if (this.#quitting) throw new Error('应用正在退出。');
        this.#process = peer;
        this.#openingProcess = undefined;
        return {
          connectionId: generation,
          workspace,
          expectedServerVersion: manifest.expectedServerVersion,
        };
      } catch (error) {
        if (peer) {
          try {
            await peer.close();
            this.#openingProcess = undefined;
          } catch {
            // Preserve the owner so a later quit can retry or report the incomplete cleanup.
            this.#process = peer;
          }
        } else if (this.#openingProcess?.finished) {
          this.#openingProcess = undefined;
        }
        throw error;
      }
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
      await this.#process?.close();
      this.#process = undefined;
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
    this.#quitting = true;
    this.#openingProcess?.requestStartupCancellation();
    await this.#lock.run(async () => {
      const process = this.#process;
      const opening = this.#openingProcess;
      try {
        await process?.close();
        await opening?.close();
        this.#process = undefined;
        this.#openingProcess = undefined;
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

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
