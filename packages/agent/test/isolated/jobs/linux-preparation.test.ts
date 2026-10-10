import { expect, test } from 'bun:test';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JobContext } from '../../../src/extensions';
import {
  captureLinuxLaunch,
  type LinuxLaunch,
  type LinuxPaths,
} from '../../../src/jobs/linux-preparation';

// Only layout/identity preparation runs: no Linux process or sandbox is started.
function fixture(run: (options: LinuxPaths, shell: string) => void) {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'kite-linux-layout-')));
  try {
    const workspace = join(root, 'workspace'),
      cwd = join(workspace, 'skill'),
      protectedRoot = join(workspace, 'profile'),
      runtime = join(root, 'runtime'),
      temporaryRoot = join(root, 'temp');
    for (const path of [workspace, cwd, protectedRoot, runtime, temporaryRoot])
      mkdirSync(path, { recursive: true, mode: 0o700 });
    const shell = join(runtime, 'shell'),
      bubblewrapPath = join(runtime, 'bwrap');
    writeFileSync(shell, 'fixed shell');
    writeFileSync(bubblewrapPath, 'fixed bwrap');
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
    run(
      {
        cwd,
        workspaceRoot: workspace,
        bubblewrapPath,
        protectedRoots: [protectedRoot],
        runtimeReadOnlyRoots: [runtime],
        temporaryRoot,
        filesystemScope: 'workspace_write',
        mode: 'host',
      },
      shell,
    );
  } finally {
    Object.defineProperty(process, 'platform', platform);
    rmSync(root, { recursive: true, force: true });
  }
}
const context = {} as JobContext;
function mount(launch: LinuxLaunch, flag: string, source: string, destination: string) {
  return launch.bubblewrapArgs.some(
    (arg, index, args) =>
      arg === flag && args[index + 1] === source && args[index + 2] === destination,
  );
}
test('host scopes keep the original Workspace write boundary independently of execution cwd and mask private roots last', () =>
  fixture((options, shell) => {
    const prepare = captureLinuxLaunch(options, [shell]);
    const launch = prepare('unused', shell, context);
    try {
      expect(launch.mode).toBe('workspace');
      expect(launch.cwd).toBe(options.cwd);
      expect(mount(launch, '--ro-bind', '/', '/')).toBe(true);
      expect(mount(launch, '--bind', options.workspaceRoot!, options.workspaceRoot!)).toBe(true);
      expect(mount(launch, '--bind', options.cwd, options.cwd)).toBe(false);
      expect(launch.bubblewrapArgs.slice(-2)).toEqual(['--chdir', options.cwd]);
      expect(launch.bubblewrapArgs).toContain('--tmpfs');
      const masked = launch.bubblewrapArgs.indexOf('--tmpfs');
      expect(launch.bubblewrapArgs.slice(masked - 2, masked + 4)).toEqual([
        '--perms',
        '000',
        '--tmpfs',
        options.protectedRoots[0]!,
        '--remount-ro',
        options.protectedRoots[0]!,
      ]);
      expect(lstatSync(launch.temp).mode & 0o777).toBe(0o700);
      expect(launch.noExecPaths).toEqual([launch.temp]);
      expect(launch.identities.length).toBeLessThanOrEqual(200);
      expect(launch.identities.some((fact) => fact.canonical === options.cwd)).toBe(true);
    } finally {
      launch.cleanup();
    }
    expect(existsSync(launch.temp)).toBe(false);
    const full = captureLinuxLaunch({ ...options, filesystemScope: () => 'full_access' }, [shell])(
      'unused',
      shell,
      context,
    );
    try {
      expect(full.mode).toBe('full');
      expect(mount(full, '--bind', '/', '/')).toBe(true);
      expect(
        mount(
          full,
          '--ro-bind',
          options.runtimeReadOnlyRoots![0]!,
          options.runtimeReadOnlyRoots![0]!,
        ),
      ).toBe(true);
      expect(full.preserveHostHome).toBe(true);
    } finally {
      full.cleanup();
    }
  }));
test('strict compensation has no broad root read and carries the exact cwd for native Workspace noexec sealing', () =>
  fixture((options, shell) => {
    expect(() => captureLinuxLaunch({ ...options, mode: 'confined' }, [shell])).toThrow(
      'linux_shell_cwd_outside_workspace',
    );
    const protectedParent = join(options.workspaceRoot!, 'private-parent');
    const nestedProfile = join(protectedParent, 'profile');
    mkdirSync(nestedProfile, { recursive: true });
    const launch = captureLinuxLaunch(
      {
        ...options,
        cwd: options.workspaceRoot!,
        protectedRoots: [nestedProfile],
        mode: 'confined',
      },
      [shell],
    )('unused', shell, context);
    try {
      expect(launch.mode).toBe('confined');
      expect(mount(launch, '--ro-bind', '/', '/')).toBe(false);
      expect(mount(launch, '--bind', '/', '/')).toBe(false);
      expect(launch.bubblewrapArgs).toContain('--unshare-net');
      expect(launch.bubblewrapArgs.slice(-4)).toEqual([
        '--remount-ro',
        '/',
        '--chdir',
        options.workspaceRoot!,
      ]);
      expect(launch.preserveHostHome).toBe(false);
      expect(mount(launch, '--bind', protectedParent, protectedParent)).toBe(true);
      expect(launch.noExecPaths).toEqual([
        launch.temp,
        options.workspaceRoot!,
        protectedParent,
        options.runtimeReadOnlyRoots![0]!,
      ]);
    } finally {
      launch.cleanup();
    }
  }));
test('changed binaries and overlapping protected/temp paths reject before allocating runtime temp', () =>
  fixture((options, shell) => {
    expect(() => captureLinuxLaunch({ ...options, temporaryRoot: options.cwd }, [shell])).toThrow(
      'linux_shell_workspace_protected',
    );
    expect(() =>
      captureLinuxLaunch({ ...options, protectedRoots: [options.workspaceRoot!] }, [shell]),
    ).toThrow('linux_shell_workspace_protected');
    expect(() =>
      captureLinuxLaunch({ ...options, protectedRoots: [options.runtimeReadOnlyRoots![0]!] }, [
        shell,
      ]),
    ).toThrow('linux_shell_asset_protected');
    const prepare = captureLinuxLaunch(options, [shell]);
    writeFileSync(shell, 'changed shell');
    expect(() => prepare('unused', shell, context)).toThrow('confined_launch_changed');
  }));
test('nested Profile coordination and executable aliases share the exact visible native protocol', () =>
  fixture((options, shell) => {
    const nested = join(options.protectedRoots[0]!, '.coordination');
    mkdirSync(nested);
    const shellAlias = join(options.runtimeReadOnlyRoots![0]!, 'shell-alias');
    symlinkSync(shell, shellAlias);
    const externalSkill = join(options.temporaryRoot!, '..', 'external-skill');
    mkdirSync(externalSkill);
    const launch = captureLinuxLaunch(
      { ...options, cwd: externalSkill, protectedRoots: [nested, options.protectedRoots[0]!] },
      [shellAlias],
    )('unused', shellAlias, context);
    try {
      expect(launch.cwd).toBe(realpathSync.native(externalSkill));
      expect(mount(launch, '--bind', options.workspaceRoot!, options.workspaceRoot!)).toBe(true);
      expect(mount(launch, '--bind', launch.cwd, launch.cwd)).toBe(false);
      expect(launch.maskedRoots).toEqual([options.protectedRoots[0]!]);
      expect(launch.bubblewrapArgs.filter((arg) => arg === '--tmpfs')).toHaveLength(1);
      expect(launch.identities.some((fact) => fact.path === nested)).toBe(true);
      expect(launch.identities.some((fact) => fact.path === shellAlias)).toBe(true);
      expect(launch.executablePaths).toEqual([shell]);
      expect(launch.trustedExecutableFiles).toEqual([options.bubblewrapPath, shell]);
      expect(mount(launch, '--ro-bind', shell, shell)).toBe(true);
      expect(launch.trustedExecutableFiles).not.toContain(shellAlias);
    } finally {
      launch.cleanup();
    }
  }));
test('trusted Profile Skill projection retains canonical cwd while exposing only a private readonly noexec ancestor chain', () =>
  fixture((options, shell) => {
    const profile = join(options.temporaryRoot!, '..', 'outside-profile');
    const control = join(profile, '.coordination');
    const skill = join(profile, 'skills', 'original');
    mkdirSync(control, { recursive: true });
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, 'verify.sh'), 'original source');
    const projected = {
      ...options,
      cwd: skill,
      controlBase: control,
      protectedRoots: [profile],
      readOnlySourceRoot: skill,
    };
    const prepare = captureLinuxLaunch(projected, [shell]);
    const launch = prepare('unused', shell, context);
    try {
      expect(launch.cwd).toBe(skill);
      expect(mount(launch, '--bind', options.workspaceRoot!, options.workspaceRoot!)).toBe(true);
      expect(launch.sourceProjection).toEqual({
        root: skill,
        device: lstatSync(skill, { bigint: true }).dev.toString(),
        inode: lstatSync(skill, { bigint: true }).ino.toString(),
        scaffolds: [profile, join(profile, 'skills')],
      });
      expect(launch.maskedRoots).toEqual([]);
      expect(launch.noExecPaths).toEqual([launch.temp, profile, join(profile, 'skills'), skill]);
      expect(mount(launch, '--ro-bind', skill, skill)).toBe(true);
      expect(mount(launch, '--bind', skill, skill)).toBe(false);
      for (const path of launch.sourceProjection!.scaffolds) {
        const index = launch.bubblewrapArgs.indexOf(
          path,
          launch.bubblewrapArgs.lastIndexOf('--dev'),
        );
        expect(launch.bubblewrapArgs.slice(index - 3, index + 1)).toEqual([
          '--perms',
          '700',
          '--tmpfs',
          path,
        ]);
      }
      expect(launch.identities.some((fact) => fact.canonical === control)).toBe(true);
      expect(launch.identities.some((fact) => fact.canonical === skill)).toBe(true);
      expect(launch.bubblewrapArgs.slice(-2)).toEqual(['--chdir', skill]);
    } finally {
      launch.cleanup();
    }
    expect(() =>
      captureLinuxLaunch({ ...projected, readOnlySourceRoot: control }, [shell]),
    ).toThrow('shell_readonly_source_invalid');
    expect(() => captureLinuxLaunch({ ...projected, controlBase: undefined }, [shell])).toThrow(
      'shell_readonly_source_invalid',
    );
    expect(() => captureLinuxLaunch({ ...projected, workspaceRoot: skill }, [shell])).toThrow(
      'shell_readonly_source_invalid',
    );
    expect(() =>
      captureLinuxLaunch({ ...projected, runtimeReadOnlyRoots: [profile] }, [shell]),
    ).toThrow('linux_shell_asset_protected');
    const nested = join(skill, 'nested');
    mkdirSync(nested);
    expect(() =>
      captureLinuxLaunch({ ...projected, protectedRoots: [profile, nested] }, [shell]),
    ).toThrow('shell_readonly_source_invalid');
    // Retain the original inode at another name so this is not an inode-reuse lottery.
    renameSync(skill, join(profile, 'original-moved'));
    mkdirSync(skill);
    expect(() => prepare('unused', shell, context)).toThrow('confined_launch_changed');
  }));
