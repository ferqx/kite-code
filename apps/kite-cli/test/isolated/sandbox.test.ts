import { afterAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import {
  buildEnvExportSnippet,
  buildEnvStripSnippet,
  buildHardenedEnv,
  buildPolicyProvenReadOnlyEnv,
  buildUlimitPreamble,
  buildWorkspaceExcludedPath,
  checkDangerousPaths,
  checkDangerousSearchRoot,
  cleanupSandboxRuntimeDirNoSpawn,
  cleanupWindowsSandboxRuntimeDirNoSpawn,
  createSandboxRuntimeDirForPreparation,
  createWindowsSandboxRuntimeDirForPreparation,
  DEFAULT_RESOURCE_LIMITS,
  detectSandboxBackend,
  findApplySeccomp,
  generateBwrapArgs,
  generateSandboxProfile,
  isSandboxAvailable,
  projectApprovedProxyEnvironment,
  resolveSandboxExitCode,
  resolveSeccompPath,
} from '@kite-ai/builtin-runtime/sandbox';
import { buildPosixSupervisorEnvironment } from '@kite-ai/runtime-host';
import { createSandboxExecutor } from '../../../../tests/helpers/sandbox-executor';
import { shellTool } from '../../../../tests/helpers/shell-executor';
import { parseArgs } from '../../src/cli/index';

function createTestRuntimeDir(workspace: string, label: string): string {
  const preparationDigest = `sandbox-test:${label}:${randomUUID()}`;
  return process.platform === 'win32'
    ? createWindowsSandboxRuntimeDirForPreparation(workspace, preparationDigest)
    : createSandboxRuntimeDirForPreparation(workspace, preparationDigest);
}

function cleanupTestRuntimeDir(runtimeDir: string): boolean {
  return process.platform === 'win32'
    ? cleanupWindowsSandboxRuntimeDirNoSpawn(runtimeDir)
    : cleanupSandboxRuntimeDirNoSpawn(runtimeDir);
}

function seatbeltString(path: string): string {
  return path.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

function seatbeltSubpath(path: string): string {
  return `(subpath "${seatbeltString(path)}")`;
}

function seatbeltLiteral(path: string): string {
  return `(literal "${seatbeltString(path)}")`;
}

function seatbeltLiteralPrefixRegex(path: string): string {
  const regex = `^${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*$`;
  return `(regex #"${regex.replaceAll('"', '\\"')}")`;
}

function directoryLinkType(): 'dir' | 'junction' {
  return process.platform === 'win32' ? 'junction' : 'dir';
}

// 验证沙箱 profile 结构 / Validate sandbox profile structure
describe('sandbox profile generation', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'sandbox-profile-test-'));
  const canonicalWorkspace = realpathSync.native(workspace);
  afterAll(() => rmSync(workspace, { recursive: true, force: true }));

  test('profile includes deny-default posture', () => {
    const profile = generateSandboxProfile(workspace);
    expect(profile).toContain('(deny default)');
  });

  test('profile includes version marker', () => {
    const profile = generateSandboxProfile(workspace);
    expect(profile).toContain('(version 1)');
  });

  test('profile allows process execution and forking', () => {
    const profile = generateSandboxProfile(workspace);
    expect(profile).toContain('(allow process-exec)');
    expect(profile).toContain('(allow process-fork)');
  });

  test('profile writes are limited to the canonical workspace', () => {
    const profile = generateSandboxProfile(workspace);
    expect(profile).toContain(seatbeltSubpath(canonicalWorkspace));
    expect(profile).not.toContain('(subpath "/")');
  });

  test('profile denies network by default', () => {
    const profile = generateSandboxProfile(workspace);
    expect(profile).toContain('(deny network*)');
  });

  test('profile explicitly grants network access when allow_all is selected', () => {
    const profile = generateSandboxProfile(workspace, { network: 'allow_all' });
    expect(profile).toContain('(allow network*)');
  });

  test('approved filesystem scope keeps Seatbelt active while widening file rules', () => {
    const profile = generateSandboxProfile(workspace, { filesystemScope: 'full_access' });
    expect(profile).toContain('(deny default)');
    expect(profile).toContain('(allow file-read* file-read-metadata file-map-executable)');
    expect(profile).toContain('(allow file-write* file-write-create file-write-unlink file-ioctl)');
    expect(profile).toContain('(deny network*)');
    expect(profile).not.toContain('(deny file-read* file-map-executable file-write*');
  });

  test('approved filesystem scope does not re-deny external credentials', () => {
    const profile = generateSandboxProfile(workspace, { filesystemScope: 'full_access' });
    expect(profile).not.toContain(seatbeltSubpath(join(homedir(), '.ssh')));
  });

  test('approved filesystem scope still excludes the complete Host-control base', () => {
    const controlBase = mkdtempSync(join(tmpdir(), 'approved-seatbelt-control-'));
    try {
      const profile = generateSandboxProfile(workspace, {
        filesystemScope: 'full_access',
        sandboxControlBase: controlBase,
      });
      expect(profile).toContain(
        '(deny file-read* file-read-metadata file-map-executable file-write*',
      );
      expect(profile).toContain(seatbeltSubpath(realpathSync.native(controlBase)));
      expect(profile).not.toContain(seatbeltSubpath(join(homedir(), '.ssh')));
    } finally {
      rmSync(controlBase, { recursive: true, force: true });
    }
  });

  test('profile imports system.sb as base', () => {
    const profile = generateSandboxProfile(workspace);
    expect(profile).toContain('(import "system.sb")');
  });

  test('profile limits reads to workspace and explicit system runtime roots', () => {
    const profile = generateSandboxProfile(workspace);
    if (existsSync('/System')) expect(profile).toContain('(subpath "/System")');
    if (existsSync('/usr/bin')) expect(profile).toContain('(subpath "/usr/bin")');
    expect(profile).not.toContain('(subpath "/usr")');
    expect(profile).not.toContain('(subpath "/")');
  });

  test('profile does not make data-only roots executable', () => {
    const profile = generateSandboxProfile(workspace);
    const executableSection = profile.slice(
      profile.indexOf('(allow file-map-executable'),
      profile.indexOf(';; Writes are limited'),
    );
    expect(executableSection).not.toContain('/private/etc/ssl');
    expect(executableSection).not.toContain('/usr/share');
    expect(executableSection).not.toContain('/opt/homebrew/share');
  });

  test('profile does not deny any path inside the canonical Workspace', () => {
    const profile = generateSandboxProfile(workspace);
    expect(profile).not.toContain(seatbeltSubpath(join(canonicalWorkspace, '.git')));
    expect(profile).not.toContain(seatbeltLiteral(join(canonicalWorkspace, '.env')));
    expect(profile).not.toContain(seatbeltLiteralPrefixRegex(join(canonicalWorkspace, '.env.')));
    expect(profile).not.toContain('(deny file-read* file-map-executable file-write*');
  });

  test('profile default admits Workspace git metadata', () => {
    const profile = generateSandboxProfile(workspace);
    expect(profile).not.toContain(seatbeltSubpath(join(canonicalWorkspace, '.git')));
  });

  test('brokered revision does not reintroduce a Workspace metadata deny', () => {
    const profile = generateSandboxProfile(workspace, { gitAccess: 'deny' });
    const metadata = seatbeltSubpath(join(canonicalWorkspace, '.git'));
    expect(profile).not.toContain(metadata);
  });

  test('git access allows CLT developer dir and user git config reads', () => {
    const profile = generateSandboxProfile(workspace, { gitAccess: 'allow' });
    if (existsSync('/private/var/select/developer_dir')) {
      expect(profile).toContain('(literal "/private/var/select/developer_dir")');
    }
    const home = process.env.HOME;
    if (home && existsSync(join(home, '.gitconfig'))) {
      expect(profile).toContain(`(literal "${join(home, '.gitconfig')}")`);
    }
  });

  test('git config opt-in does not change complete Workspace admission', () => {
    const profile = generateSandboxProfile(workspace, { gitAccess: 'allow' });
    for (const path of ['.git', '.ssh', '.git-credentials', '.env']) {
      expect(profile).not.toContain(seatbeltString(join(canonicalWorkspace, path)));
    }
    expect(profile).not.toContain('(deny file-read* file-map-executable file-write*');
  });

  test('read-only scope omits workspace from writable filters', () => {
    const profile = generateSandboxProfile(workspace, { filesystemScope: 'read_only' });
    const writeSection = profile.slice(profile.indexOf(';; Writes are limited'));
    expect(writeSection).not.toContain(seatbeltSubpath(canonicalWorkspace));
  });

  test('canonicalizes a symlinked workspace before emitting rules', () => {
    const parent = mkdtempSync(join(tmpdir(), 'sandbox-profile-link-test-'));
    const link = join(parent, 'workspace-link');
    symlinkSync(workspace, link, directoryLinkType());
    try {
      const profile = generateSandboxProfile(link);
      expect(profile).toContain(seatbeltSubpath(canonicalWorkspace));
      expect(profile).not.toContain(seatbeltSubpath(link));
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});

describe('approved filesystem execution lane', () => {
  test('keeps bubblewrap namespaces while projecting the approved filesystem', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'approved-bwrap-filesystem-'));
    const controlBase = mkdtempSync(join(tmpdir(), 'approved-bwrap-control-'));
    try {
      writeFileSync(join(workspace, '.env'), 'workspace-owned');
      const args = generateBwrapArgs(workspace, {
        filesystemScope: 'full_access',
        sandboxControlBase: controlBase,
      });
      expect(args).toContain('--unshare-pid');
      expect(args).toContain('--unshare-net');
      expect(args).toEqual(expect.arrayContaining(['--bind', '/', '/']));
      expect(args).not.toEqual(expect.arrayContaining(['--tmpfs', '/tmp']));
      const canonicalControlBase = realpathSync.native(controlBase);
      expect(args).toEqual(
        expect.arrayContaining([
          '--tmpfs',
          canonicalControlBase,
          '--remount-ro',
          canonicalControlBase,
        ]),
      );
      expect(args).not.toEqual(
        expect.arrayContaining(['--ro-bind', '/dev/null', join(workspace, '.env')]),
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(controlBase, { recursive: true, force: true });
    }
  });
});

// 验证 shell wrapper 工具函数 / Validate shell wrapper utility functions
describe('shell wrapper utilities', () => {
  test('ulimit preamble includes working resource limits', () => {
    const preamble = buildUlimitPreamble();
    expect(preamble).toContain(`ulimit -t ${DEFAULT_RESOURCE_LIMITS.cpuTime}`);
    expect(preamble).toContain(`ulimit -f ${DEFAULT_RESOURCE_LIMITS.fileSize}`);
    expect(preamble).toContain(`ulimit -n ${DEFAULT_RESOURCE_LIMITS.fileDescriptors}`);
    // -v and -u 默认关闭（macOS 不兼容）/ disabled by default (macOS incompatible)
    expect(preamble).not.toContain('ulimit -v');
    expect(preamble).not.toContain('ulimit -u');
  });

  test('ulimit preamble merges custom resource limits', () => {
    const preamble = buildUlimitPreamble({ cpuTime: 30, processes: 16 });
    expect(preamble).toContain('ulimit -t 30');
    expect(preamble).toContain('ulimit -u 16');
    expect(preamble).toContain(`ulimit -f ${DEFAULT_RESOURCE_LIMITS.fileSize}`);
  });

  test('hardened env retains safe variables', () => {
    const ws = mkdtempSync(join(tmpdir(), 'sandbox-test-'));
    const runtimeDir = createTestRuntimeDir(ws, 'hardened-env');
    try {
      process.env.TEST_KEEP_VAR = 'keep-me';
      const env = buildHardenedEnv(ws, runtimeDir);
      // PATH and HOME should be inherited from parent
      expect(env.PATH).toBeDefined();
      expect(env.HOME).toBe(process.env.HOME as string);
    } finally {
      rmSync(ws, { recursive: true, force: true });
      rmSync(runtimeDir, { recursive: true, force: true });
      delete process.env.TEST_KEEP_VAR;
    }
  });

  test('approved POSIX network supervisor projects proxy settings only at spawn', () => {
    const ws = mkdtempSync(join(tmpdir(), 'sandbox-proxy-env-test-'));
    const runtimeDir = createTestRuntimeDir(ws, 'proxy-env');
    try {
      const source = {
        HTTP_PROXY: 'http://proxy.example.test:8080',
        no_proxy: 'localhost,127.0.0.1',
      };
      const offline = buildPosixSupervisorEnvironment(
        runtimeDir,
        projectApprovedProxyEnvironment({ networkMode: 'disabled', source }),
      );
      const approved = buildPosixSupervisorEnvironment(
        runtimeDir,
        projectApprovedProxyEnvironment({ networkMode: 'allow_all', source }),
      );
      expect(offline.HTTP_PROXY).toBeUndefined();
      expect(offline.no_proxy).toBeUndefined();
      expect(approved.HTTP_PROXY).toBe('http://proxy.example.test:8080');
      expect(approved.no_proxy).toBe('localhost,127.0.0.1');
    } finally {
      rmSync(ws, { recursive: true, force: true });
      rmSync(runtimeDir, { recursive: true, force: true });
    }
  });

  test('hardened env redirects temp and cache paths to sandbox runtime dir', () => {
    const ws = mkdtempSync(join(tmpdir(), 'sandbox-test-'));
    const runtimeDir = createTestRuntimeDir(ws, 'redirected-env');
    try {
      const env = buildHardenedEnv(ws, runtimeDir);
      // HOME is inherited from parent (real user home), not redirected
      if (process.env.HOME !== undefined) {
        expect(env.HOME).toBe(process.env.HOME);
      }
      // Temp and cache paths are redirected to sandbox runtime dir in system temp
      const canonicalRuntimeDir = realpathSync.native(runtimeDir);
      expect(env.TMPDIR).toBe(join(canonicalRuntimeDir, 'tmp'));
      expect(env.TMP).toBe(join(canonicalRuntimeDir, 'tmp'));
      expect(env.TEMP).toBe(join(canonicalRuntimeDir, 'tmp'));
    } finally {
      rmSync(ws, { recursive: true, force: true });
      rmSync(runtimeDir, { recursive: true, force: true });
    }
  });

  test('runtime directories are private and unique per invocation', () => {
    const ws = mkdtempSync(join(tmpdir(), 'sandbox-runtime-test-'));
    const first = createTestRuntimeDir(ws, 'unique-first');
    const second = createTestRuntimeDir(ws, 'unique-second');
    try {
      expect(first).not.toBe(second);
      if (process.platform !== 'win32') {
        expect(statSync(first).mode & 0o777).toBe(0o700);
        expect(statSync(second).mode & 0o777).toBe(0o700);
      }
    } finally {
      rmSync(first, { recursive: true, force: true });
      rmSync(second, { recursive: true, force: true });
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test.skipIf(
    process.platform === 'win32' ||
      (process.platform === 'linux' && detectSandboxBackend() !== 'bubblewrap'),
  )('runtime cleanup recovers nested hostile modes without following symlinks', () => {
    const ws = mkdtempSync(join(tmpdir(), 'sandbox-runtime-cleanup-test-'));
    const external = mkdtempSync(join(tmpdir(), 'sandbox-runtime-external-test-'));
    const runtimeDir = createTestRuntimeDir(ws, 'hostile-modes');
    const nested = join(runtimeDir, 'nested');
    const deeper = join(nested, 'deeper');
    const flagged = join(deeper, 'flagged');
    mkdirSync(deeper, { recursive: true });
    writeFileSync(flagged, 'flagged');
    chmodSync(external, 0o755);
    symlinkSync(external, join(deeper, 'external-link'), directoryLinkType());
    if (process.platform === 'darwin') {
      expect(Bun.spawnSync(['/usr/bin/chflags', 'uchg,uappnd', flagged]).exitCode).toBe(0);
    }
    chmodSync(deeper, 0o000);
    expect(statSync(deeper).mode & 0o777).toBe(0o000);
    if (process.platform === 'darwin') {
      expect(Bun.spawnSync(['/usr/bin/chflags', 'uchg,uappnd', deeper]).exitCode).toBe(0);
    }
    chmodSync(nested, 0o000);
    expect(statSync(nested).mode & 0o777).toBe(0o000);
    if (process.platform === 'darwin') {
      expect(Bun.spawnSync(['/usr/bin/chflags', 'uchg,uappnd', nested]).exitCode).toBe(0);
    }
    chmodSync(runtimeDir, 0o000);
    try {
      expect(cleanupTestRuntimeDir(runtimeDir)).toBe(true);
      expect(existsSync(runtimeDir)).toBe(false);
      expect(existsSync(external)).toBe(true);
      expect(statSync(external).mode & 0o777).toBe(0o755);
    } finally {
      cleanupTestRuntimeDir(runtimeDir);
      rmSync(external, { recursive: true, force: true });
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test('runtime cleanup unlinks a dangling root symlink without touching its former target', () => {
    const ws = mkdtempSync(join(tmpdir(), 'sandbox-runtime-link-cleanup-test-'));
    const external = join(tmpdir(), `sandbox-runtime-missing-target-${process.pid}-${Date.now()}`);
    const runtimeDir = createTestRuntimeDir(ws, 'dangling-link');
    rmSync(runtimeDir, { recursive: true, force: true });
    symlinkSync(external, runtimeDir, directoryLinkType());
    try {
      expect(cleanupTestRuntimeDir(runtimeDir)).toBe(true);
      expect(existsSync(runtimeDir)).toBe(false);
      expect(existsSync(external)).toBe(false);
    } finally {
      rmSync(runtimeDir, { recursive: true, force: true });
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test('runtime cleanup unlinks a valid root symlink without traversing its target', () => {
    const ws = mkdtempSync(join(tmpdir(), 'sandbox-runtime-root-link-test-'));
    const external = mkdtempSync(join(tmpdir(), 'sandbox-runtime-root-target-test-'));
    const marker = join(external, 'keep.txt');
    const runtimeDir = createTestRuntimeDir(ws, 'root-link');
    writeFileSync(marker, 'keep');
    chmodSync(external, 0o755);
    rmSync(runtimeDir, { recursive: true, force: true });
    symlinkSync(external, runtimeDir, directoryLinkType());
    try {
      expect(cleanupTestRuntimeDir(runtimeDir)).toBe(true);
      expect(existsSync(runtimeDir)).toBe(false);
      expect(existsSync(marker)).toBe(true);
      if (process.platform !== 'win32') {
        expect(statSync(external).mode & 0o777).toBe(0o755);
      }
    } finally {
      rmSync(runtimeDir, { recursive: true, force: true });
      rmSync(external, { recursive: true, force: true });
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test('runtime cleanup rejects paths outside its private base', () => {
    const outside = mkdtempSync(join(tmpdir(), 'sandbox-cleanup-reject-test-'));
    try {
      expect(cleanupTestRuntimeDir(outside)).toBe(false);
      expect(existsSync(outside)).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('env strip snippet unsets dangerous variables', () => {
    const snippet = buildEnvStripSnippet();
    expect(snippet).toContain('unset LD_PRELOAD');
    expect(snippet).toContain('unset DYLD_INSERT_LIBRARIES');
    expect(snippet).toContain('unset DYLD_LIBRARY_PATH');
    expect(snippet).toContain('unset NODE_OPTIONS');
    expect(snippet).toContain('unset RIPGREP_CONFIG_PATH');
  });

  test('env export snippet quotes values', () => {
    const snippet = buildEnvExportSnippet({ FOO: 'bar', BAZ: '/path/to/dir' });
    expect(snippet).toContain("export FOO='bar'");
    expect(snippet).toContain("export BAZ='/path/to/dir'");
  });

  test('env export snippet escapes single quotes in values', () => {
    const snippet = buildEnvExportSnippet({ MSG: "it's working" });
    expect(snippet).toContain("export MSG='it'\\''s working'");
  });
});

describe('policy-proven read-only executable environment', () => {
  test('canonicalizes PATH and removes relative and Workspace-controlled entries', () => {
    const root = mkdtempSync(join(tmpdir(), 'kite-readonly-path-'));
    const workspace = join(root, 'workspace');
    const safeBin = join(root, 'safe-bin');
    const workspaceAlias = join(root, 'workspace-alias');
    mkdirSync(join(workspace, 'bin'), { recursive: true });
    mkdirSync(safeBin);
    symlinkSync(workspace, workspaceAlias, directoryLinkType());
    try {
      const resolved = buildWorkspaceExcludedPath(workspace, {
        pathValue: [workspace, join(workspace, 'bin'), workspaceAlias, '.', safeBin].join(
          delimiter,
        ),
      });
      expect(resolved.split(delimiter)).toEqual([realpathSync.native(safeBin)]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('uses a minimal environment and drops shell startup injection variables', () => {
    const root = mkdtempSync(join(tmpdir(), 'kite-readonly-env-'));
    const workspace = join(root, 'workspace');
    const safeBin = join(root, 'safe-bin');
    mkdirSync(workspace);
    mkdirSync(safeBin);
    try {
      const env = buildPolicyProvenReadOnlyEnv(workspace, {
        env: {
          PATH: `${workspace}${delimiter}${safeBin}`,
          HOME: '/safe-home',
          BASH_ENV: join(workspace, 'inject.sh'),
          ENV: join(workspace, 'inject.sh'),
          RIPGREP_CONFIG_PATH: join(workspace, 'rg.config'),
          OPENAI_API_KEY: 'secret',
        },
      });
      expect(env.PATH).toBe(realpathSync.native(safeBin));
      expect(env.HOME).toBe('/safe-home');
      expect(env.BASH_ENV).toBeUndefined();
      expect(env.ENV).toBeUndefined();
      expect(env.SHELL).toBeUndefined();
      expect(env.SSH_AUTH_SOCK).toBeUndefined();
      expect(env.RIPGREP_CONFIG_PATH).toBeUndefined();
      expect(env.OPENAI_API_KEY).toBeUndefined();
      expect(env.GIT_CONFIG_NOSYSTEM).toBe('1');
      expect(env.GIT_CONFIG_GLOBAL).toBe('/dev/null');
      expect(env.GIT_OPTIONAL_LOCKS).toBe('0');
      expect(env.GIT_CONFIG_KEY_0).toBe('core.fsmonitor');
      expect(env.GIT_CONFIG_VALUE_0).toBe('false');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// 验证危险文件路径检测 / Validate dangerous file path detection
describe('dangerous path detection', () => {
  test('detects shell config files in redirects', () => {
    expect(checkDangerousPaths("echo 'alias ls=evil' >> .bashrc")).toBe('.bashrc');
    expect(checkDangerousPaths('cat payload > ~/.zshrc')).toBe('.zshrc');
    expect(checkDangerousPaths('tee -a .profile < payload')).toBe('.profile');
  });

  test('detects git hooks and config', () => {
    expect(checkDangerousPaths('cp script .git/hooks/pre-commit')).toBe('.git/hooks/');
    expect(checkDangerousPaths("echo '[user]' >> .git/config")).toBe('.git/config');
  });

  test('detects SSH authorized_keys tampering', () => {
    expect(checkDangerousPaths('cat key.pub >> .ssh/authorized_keys')).toBe('.ssh/authorized_keys');
    expect(checkDangerousPaths('echo key >> ~/.ssh/authorized_keys2')).toBe(
      '.ssh/authorized_keys2',
    );
  });

  test('detects IDE/agent config tampering', () => {
    expect(checkDangerousPaths('rm .claude/settings.json')).toBe('.claude/settings.json');
    expect(checkDangerousPaths('echo task >> .vscode/tasks.json')).toBe('.vscode/tasks.json');
  });

  test('detects credential file access', () => {
    expect(checkDangerousPaths('cat .env')).toBe('.env');
    expect(checkDangerousPaths('cp .env .env.local')).toBe('.env');
    expect(checkDangerousPaths('printf secret > .env.staging')).toBe('.env.staging');
    expect(checkDangerousPaths('cat ~/.aws/credentials')).toBe('.aws/credentials');
    expect(checkDangerousPaths('cat .npmrc')).toBe('.npmrc');
  });

  test('does not classify paths inside an admitted Workspace as dangerous', () => {
    expect(checkDangerousPaths('cat .env', { workspace: process.cwd() })).toBeNull();
    expect(checkDangerousPaths('printf x > .git/config', { workspace: process.cwd() })).toBeNull();
    expect(checkDangerousPaths('ls .agents', { workspace: process.cwd() })).toBeNull();
    expect(checkDangerousPaths('cat ~/.ssh/id_ed25519', { workspace: process.cwd() })).toBe(
      '.ssh/id_ed25519',
    );
    expect(checkDangerousPaths('cat .env ~/.env', { workspace: process.cwd() })).toBe('.env');
  });

  test('classifies external search roots that can traverse sensitive identities', () => {
    expect(checkDangerousSearchRoot(homedir(), process.cwd())).not.toBeNull();
    if (process.platform !== 'win32') {
      expect(checkDangerousSearchRoot('/etc', process.cwd())).not.toBeNull();
      const neutralSearchRoot = mkdtempSync(join(tmpdir(), 'sandbox-neutral-search-root-'));
      try {
        expect(checkDangerousSearchRoot(neutralSearchRoot, process.cwd())).toBeNull();
      } finally {
        rmSync(neutralSearchRoot, { recursive: true, force: true });
      }
    }
    expect(checkDangerousSearchRoot(process.cwd(), process.cwd())).toBeNull();
  });

  test('detects system config tampering', () => {
    expect(checkDangerousPaths("echo 'evil' >> /etc/crontab")).toBe('/etc/crontab');
    expect(checkDangerousPaths("echo 'evil' >> /etc/passwd")).toBe('/etc/passwd');
    expect(checkDangerousPaths("echo 'evil' >> /etc/sudoers")).toBe('/etc/sudoers');
    expect(checkDangerousPaths('cat /private/etc/hosts')).toBe('/private/etc/hosts');
    expect(checkDangerousPaths('type C:\\Windows\\System32\\drivers\\etc\\hosts')).toBe(
      'Windows/System32/drivers/etc/hosts',
    );
  });

  test('detects simple shell quote concatenation in protected paths', () => {
    expect(checkDangerousPaths('cat /e"tc/pa"sswd')).toBe('/etc/passwd');
    expect(checkDangerousPaths('cat ~/.ss"h/id_r"sa')).toBe('.ssh/id_rsa');
  });

  test('allows safe commands with similar-looking paths', () => {
    expect(checkDangerousPaths('cat package.json')).toBeNull();
    expect(checkDangerousPaths('cat src/config/env.ts')).toBeNull();
    expect(checkDangerousPaths('git status')).toBeNull();
    expect(checkDangerousPaths('bun test')).toBeNull();
    expect(checkDangerousPaths("echo 'hello world'")).toBeNull();
  });

  test('returns null for safe commands', () => {
    expect(checkDangerousPaths('ls -la')).toBeNull();
    expect(checkDangerousPaths('pwd')).toBeNull();
    expect(checkDangerousPaths('cat README.md')).toBeNull();
  });

  // ── 持久化机制 / Persistence mechanisms ──
  test('detects macOS LaunchAgents tampering', () => {
    // 绝对路径 /Library/LaunchAgents 和 ~/Library/LaunchAgents 都会被捕获
    expect(checkDangerousPaths('cp evil.plist ~/Library/LaunchAgents/evil.plist')).toBe(
      'Library/LaunchAgents/',
    );
    expect(checkDangerousPaths('echo plist > /Library/LaunchAgents/com.attacker.plist')).toBe(
      'Library/LaunchAgents/',
    );
    expect(checkDangerousPaths('rm /Library/LaunchDaemons/system.plist')).toBe(
      'Library/LaunchDaemons/',
    );
  });

  test('detects systemd user unit tampering', () => {
    expect(checkDangerousPaths('echo unit > ~/.config/systemd/user/evil.service')).toBe(
      '.config/systemd/user/',
    );
    expect(checkDangerousPaths('cp evil.service /etc/systemd/system/evil.service')).toBe(
      '/etc/systemd/system/',
    );
  });

  test('detects XDG autostart tampering', () => {
    expect(checkDangerousPaths('echo desktop > ~/.config/autostart/evil.desktop')).toBe(
      '.config/autostart/',
    );
  });

  test('detects Docker config tampering', () => {
    expect(checkDangerousPaths('cat ~/.docker/config.json')).toBe('.docker/config.json');
    expect(checkDangerousPaths("echo '{}' > .docker/daemon.json")).toBe('.docker/daemon.json');
  });

  test('detects SSH daemon config tampering', () => {
    expect(checkDangerousPaths('echo PermitRootLogin yes >> /etc/ssh/sshd_config')).toBe(
      '/etc/ssh/sshd_config',
    );
    expect(checkDangerousPaths('cat /etc/ssh/ssh_config')).toBe('/etc/ssh/ssh_config');
  });
});

// 验证平台检测 / Validate platform detection
describe('sandbox platform detection', () => {
  test('detectSandboxBackend returns a valid backend type', () => {
    const backend = detectSandboxBackend();
    expect(['seatbelt', 'bubblewrap', 'windows_restricted_token', 'none']).toContain(backend);
  });

  test('detectSandboxBackend matches platform', () => {
    const backend = detectSandboxBackend();
    if (process.platform === 'darwin') {
      expect(backend).toBe('seatbelt');
    } else if (process.platform === 'linux') {
      expect(['bubblewrap', 'none']).toContain(backend);
    } else {
      expect(['none', 'windows_restricted_token']).toContain(backend);
    }
  });

  test("isSandboxAvailable matches detectSandboxBackend !== 'none'", () => {
    expect(isSandboxAvailable()).toBe(detectSandboxBackend() !== 'none');
  });
});

// 验证 Bubblewrap 参数生成 / Validate Bubblewrap argument generation
describe('bwrap argument generation', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'bwrap-args-test-'));
  const canonicalWorkspace = realpathSync.native(workspace);
  afterAll(() => rmSync(workspace, { recursive: true, force: true }));

  test('includes workspace bind mount', () => {
    const args = generateBwrapArgs(workspace);
    expect(args).toContain('--bind');
    expect(args).toContain(canonicalWorkspace);
  });

  test('uses a canonical read-only workspace bind when requested', () => {
    const parent = mkdtempSync(join(tmpdir(), 'bwrap-link-test-'));
    const link = join(parent, 'workspace-link');
    symlinkSync(workspace, link, directoryLinkType());
    try {
      const args = generateBwrapArgs(link, { filesystemScope: 'read_only' });
      const bindIndex = args.findIndex(
        (value, index) => value === '--ro-bind' && args[index + 1] === canonicalWorkspace,
      );
      expect(bindIndex).toBeGreaterThanOrEqual(0);
      expect(args.slice(bindIndex, bindIndex + 3)).toEqual([
        '--ro-bind',
        canonicalWorkspace,
        canonicalWorkspace,
      ]);
      expect(args).not.toContain(link);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test('does not add a special mask for Workspace git metadata', () => {
    mkdirSync(join(workspace, '.git'), { recursive: true });
    const args = generateBwrapArgs(workspace);
    const workspaceIndex = args.findIndex(
      (value, index) => value === '--bind' && args[index + 1] === canonicalWorkspace,
    );
    const gitIndex = args.findIndex(
      (value, index) => value === '--tmpfs' && args[index + 1] === join(canonicalWorkspace, '.git'),
    );
    expect(workspaceIndex).toBeGreaterThanOrEqual(0);
    expect(gitIndex).toBe(-1);
  });

  test('includes essential isolation flags', () => {
    const args = generateBwrapArgs(workspace);
    expect(args).toContain('--unshare-pid');
    expect(args).toContain('--die-with-parent');
    expect(args).toContain('--new-session');
  });

  test('includes minimal /dev and /proc', () => {
    const args = generateBwrapArgs(workspace);
    expect(args).toContain('--dev');
    expect(args).toContain('--proc');
  });

  test('includes tmpfs /tmp', () => {
    const args = generateBwrapArgs(workspace);
    expect(args).toContain('--tmpfs');
    expect(args).toContain('/tmp');
  });

  test('mounts /tmp before Workspace and runtime child binds', () => {
    const runtimeDir = createTestRuntimeDir(workspace, 'bwrap-mount');
    try {
      const args = generateBwrapArgs(workspace, { sandboxRuntimeDir: runtimeDir });
      const tmpfsIndex = args.findIndex(
        (value, index) => value === '--tmpfs' && args[index + 1] === '/tmp',
      );
      const workspaceIndex = args.findIndex(
        (value, index) => value === '--bind' && args[index + 1] === canonicalWorkspace,
      );
      const canonicalRuntime = realpathSync.native(runtimeDir);
      const runtimeIndex = args.findIndex(
        (value, index) => value === '--bind' && args[index + 1] === canonicalRuntime,
      );
      expect(tmpfsIndex).toBeGreaterThanOrEqual(0);
      expect(workspaceIndex).toBeGreaterThan(tmpfsIndex);
      expect(runtimeIndex).toBeGreaterThan(tmpfsIndex);
    } finally {
      cleanupTestRuntimeDir(runtimeDir);
    }
  });

  test('includes system paths as read-only', () => {
    const args = generateBwrapArgs(workspace);
    if (process.platform === 'linux') {
      expect(args).toContain('--ro-bind');
      // 至少包含 /usr 或 /bin（取决于系统）
      const hasSystemPath = args.includes('/usr') || args.includes('/bin');
      expect(hasSystemPath).toBe(true);
    }
  });

  test('can disable network namespace', () => {
    const args = generateBwrapArgs(workspace, { network: 'disabled' });
    expect(args).toContain('--unshare-net');
  });

  test('disables the network namespace by default', () => {
    const args = generateBwrapArgs(workspace);
    expect(args).toContain('--unshare-net');
  });
});

// 验证 executor 工厂回退行为 / Validate executor factory fallback behavior
describe('sandbox executor factory', () => {
  test('uses a stable non-zero exit code when process cleanup is unconfirmed', () => {
    expect(
      resolveSandboxExitCode(0, {
        timedOut: false,
        cancelled: false,
        processCleanupConfirmed: false,
      }),
    ).toBe(-1);
  });

  test('returns shellTool when disabled', () => {
    const executor = createSandboxExecutor({
      enabled: false,
      workspace: '/tmp/test',
    });
    // When disabled, should return the exact shellTool reference
    expect(executor).toBe(shellTool);
  });

  test('fails closed instead of returning bare shell when production fallback is fail', async () => {
    const executor = createSandboxExecutor({
      enabled: false,
      workspace: '/tmp/test',
      unavailableFallback: 'fail',
    });
    expect(executor).not.toBe(shellTool);
    await expect(executor({ workspace: '/tmp/test', command: 'echo bypass' })).resolves.toEqual({
      ok: false,
      command: 'echo bypass',
      exitCode: -1,
      stdout: '',
      stderr: 'Sandbox unavailable (sandbox_disabled); refusing unsandboxed shell execution.',
      terminationReason: 'sandbox_denied',
    });
  });

  test('controlled fallback sentinel is triggerable but fail-closed denial never invokes it', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kite-sandbox-sentinel-'));
    const marker = join(workspace, 'fallback-invoked');
    let calls = 0;
    const sentinel = async (input: { command: string }) => {
      calls += 1;
      writeFileSync(marker, input.command);
      return {
        ok: true,
        command: input.command,
        exitCode: 0,
        stdout: 'sentinel',
        stderr: '',
      };
    };
    try {
      const bare = createSandboxExecutor(
        { enabled: false, workspace, unavailableFallback: 'bare_shell' },
        sentinel,
      );
      await expect(bare({ workspace, command: 'first' })).resolves.toMatchObject({
        stdout: 'sentinel',
      });
      expect(calls).toBe(1);
      expect(existsSync(marker)).toBe(true);

      rmSync(marker);
      const denied = createSandboxExecutor(
        { enabled: false, workspace, unavailableFallback: 'fail' },
        sentinel,
      );
      await expect(denied({ workspace, command: 'second' })).resolves.toMatchObject({
        ok: false,
        terminationReason: 'sandbox_denied',
      });
      expect(calls).toBe(1);
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

// Service cutover keeps legacy local sandbox flags fail-closed at the CLI edge.
describe('cli sandbox flag cutover', () => {
  test('sandbox is enabled by default', () => {
    const args = parseArgs(['run', '--task', 'hello']);
    expect(args.sandbox).toBe(true);
  });

  test('--no-sandbox is rejected instead of being silently ignored', () => {
    expect(() => parseArgs(['run', '--task', 'hello', '--no-sandbox'])).toThrow(
      "Unsupported CLI option '--no-sandbox'",
    );
  });

  test('resume rejects the removed approval flags', () => {
    expect(() => parseArgs(['resume', '--approve'])).toThrow("Unsupported CLI option '--approve'");
  });

  test('resume rejects the removed sandbox flag', () => {
    expect(() => parseArgs(['resume', '--no-sandbox'])).toThrow(
      "Unsupported CLI option '--no-sandbox'",
    );
  });
});

// 验证 seccomp 二进制查找和路径解析 / Validate seccomp binary lookup and path resolution
describe('seccomp resolution', () => {
  test('findApplySeccomp returns a path on supported architectures', () => {
    const path = findApplySeccomp();
    // x64 / arm64 至少一个存在 / at least one is present
    if (process.arch === 'x64' || process.arch === 'arm64') {
      expect(path).toBeString();
      expect(path?.replace(/\\/g, '/')).toContain('vendor/seccomp');
    } else {
      expect(path).toBeNull();
    }
  });

  test('resolveSeccompPath returns null for null input', () => {
    expect(resolveSeccompPath(null, '/tmp/ws', '/tmp/runtime')).toBeNull();
  });

  test('resolveSeccompPath returns same path when binary is within workspace', () => {
    const ws = '/tmp/my-workspace';
    const binary = '/tmp/my-workspace/vendor/seccomp/arm64/apply-seccomp';
    expect(resolveSeccompPath(binary, ws, '/tmp/runtime')).toBe(binary);
  });

  test('resolveSeccompPath copies binary when outside workspace', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'seccomp-test-'));
    const srcDir = mkdtempSync(join(tmpdir(), 'seccomp-src-'));
    const runtimeDir = createTestRuntimeDir(ws, 'seccomp');
    try {
      const srcBinary = join(srcDir, 'apply-seccomp');
      await Bun.write(srcBinary, '#!/bin/sh\necho fake');
      chmodSync(srcBinary, 0o755);

      const resolved = resolveSeccompPath(srcBinary, ws, runtimeDir);
      expect(resolved).toBe(join(runtimeDir, 'apply-seccomp'));
      expect(existsSync(resolved!)).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
      rmSync(srcDir, { recursive: true, force: true });
      rmSync(runtimeDir, { recursive: true, force: true });
    }
  });
});
