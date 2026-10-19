import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  linkSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { ensureWindowsElectronPermissions } from '../../../scripts/development/windows-electron-permissions';
import { directoryLink, temporaryDirectory } from '../../fixtures/test-filesystem';

const windows = test.skipIf(process.platform !== 'win32');
const targetSid = 'S-1-15-2-2';
type Rule = {
  sid: string;
  rights: number;
  type: number;
  inherit: number;
  propagation: number;
  inherited: boolean;
};
type Acl = {
  path: string;
  sddl: string;
  owner: string;
  group: string;
  protected: boolean;
  rules: Rule[];
};

// These mutations belong only to owned test fixtures, never the installed runtime.
function fixtureAcl(
  paths: string[],
  operation: 'prepare' | 'inherit' | 'deny' | 'inspect' = 'inspect',
): Acl[] {
  const program = `
$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$inputValue=[Console]::In.ReadToEnd() | ConvertFrom-Json
$sid=[Security.Principal.SecurityIdentifier]::new('${targetSid}')
$records=@(foreach($path in $inputValue.paths) {
  $directory=([IO.File]::GetAttributes($path) -band [IO.FileAttributes]::Directory) -ne 0
  $acl=if($directory){[IO.Directory]::GetAccessControl($path)}else{[IO.File]::GetAccessControl($path)}
  if($inputValue.operation -ne 'inspect') {
    $acl.SetAccessRuleProtection(($inputValue.operation -ne 'inherit'),$true)
    foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
      if($rule.IdentityReference.Value -eq $sid.Value){$acl.RemoveAccessRuleSpecific($rule)}
    }
    $custom=[Security.Principal.SecurityIdentifier]::new('S-1-5-21-100-200-300-1234')
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($custom,[Security.AccessControl.FileSystemRights]::Read,[Security.AccessControl.AccessControlType]::Allow))
    if($inputValue.operation -eq 'deny') {
      $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::Read,[Security.AccessControl.AccessControlType]::Deny))
    }
    if($directory){[IO.Directory]::SetAccessControl($path,$acl)}else{[IO.File]::SetAccessControl($path,$acl)}
    $acl=if($directory){[IO.Directory]::GetAccessControl($path)}else{[IO.File]::GetAccessControl($path)}
  }
  $rules=@(foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
    @{sid=$rule.IdentityReference.Value;rights=[int]$rule.FileSystemRights;type=[int]$rule.AccessControlType;inherit=[int]$rule.InheritanceFlags;propagation=[int]$rule.PropagationFlags;inherited=$rule.IsInherited}
  })
  @{path=$path;sddl=$acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::All);owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value;group=$acl.GetGroup([Security.Principal.SecurityIdentifier]).Value;protected=$acl.AreAccessRulesProtected;rules=$rules}
})
[Console]::WriteLine((ConvertTo-Json -InputObject $records -Depth 5 -Compress))`;
  const result = spawnSync(
    join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(program, 'utf16le').toString('base64'),
    ],
    {
      input: JSON.stringify({ paths, operation }),
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000,
    },
  );
  if (result.error || result.status !== 0) throw Error(`fixture_acl_failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

function fixture() {
  const root = temporaryDirectory('kite-electron-permissions-');
  const packageDirectory = join(root, '带 空格 [包] & runtime');
  const runtime = join(packageDirectory, 'dist');
  const locale = join(runtime, 'locales');
  mkdirSync(locale, { recursive: true });
  writeFileSync(
    join(packageDirectory, 'package.json'),
    JSON.stringify({ name: 'electron', version: '44.3.0' }),
  );
  const executable = join(runtime, 'electron.exe');
  writeFileSync(executable, 'fixture-binary');
  writeFileSync(join(runtime, 'version'), 'v44.3.0\n');
  writeFileSync(join(locale, 'zh-CN.pak'), 'fixture-locale');
  const outside = join(root, 'project-and-user-data');
  mkdirSync(outside);
  const marker = join(outside, 'user.db');
  writeFileSync(marker, 'private-data');
  const entries = [
    runtime,
    locale,
    executable,
    join(runtime, 'version'),
    join(locale, 'zh-CN.pak'),
  ];
  return { root, packageDirectory, runtime, executable, outside, marker, entries };
}

test('other platforms skip Electron ACL inspection and process execution', () => {
  for (const platform of ['linux', 'darwin'] as const)
    expect(
      ensureWindowsElectronPermissions({
        executable: '/absent',
        packageDirectory: '/absent',
        platform,
        run() {
          throw Error('must not run');
        },
      }),
    ).toEqual({ checked: 0, repaired: 0 });
});

windows(
  'repair only adds runtime RX, preserves original ACLs and bytes, and is idempotent after reinstall',
  () => {
    const f = fixture();
    try {
      for (let installation = 0; installation < 2; installation++) {
        // Re-extraction creates fresh objects with missing AppContainer permissions.
        if (installation) {
          rmSync(f.runtime, { recursive: true });
          mkdirSync(join(f.runtime, 'locales'), { recursive: true });
          writeFileSync(f.executable, 'fixture-binary');
          writeFileSync(join(f.runtime, 'version'), 'v44.3.0\n');
          writeFileSync(join(f.runtime, 'locales/zh-CN.pak'), 'fixture-locale');
        }
        const before = fixtureAcl(f.entries, installation ? 'inherit' : 'prepare');
        const outside = fixtureAcl([f.root, f.packageDirectory, f.outside, f.marker]);
        const bytes = f.entries.slice(2).map((path) => readFileSync(path));
        expect(ensureWindowsElectronPermissions(f)).toEqual({ checked: 5, repaired: 5 });
        const after = fixtureAcl(f.entries);
        after.forEach((acl, index) => {
          const prior = before[index]!;
          expect(acl.owner).toBe(prior.owner);
          expect(acl.group).toBe(prior.group);
          expect(acl.protected).toBe(prior.protected);
          expect(acl.rules.filter((rule) => rule.sid !== targetSid)).toEqual(prior.rules);
          const grants = acl.rules.filter((rule) => rule.sid === targetSid);
          expect(grants).toHaveLength(1);
          expect(grants[0]).toMatchObject({
            type: 0,
            inherit: 0,
            propagation: 0,
            inherited: false,
          });
          expect(grants[0]!.rights & 0x200a9).toBe(0x200a9); // ReadAndExecute
          expect(grants[0]!.rights & 0xd0156).toBe(0); // Write/delete/change owner or ACL
        });
        expect(fixtureAcl([f.root, f.packageDirectory, f.outside, f.marker])).toEqual(outside);
        expect(readFileSync(f.marker, 'utf8')).toBe('private-data');
        expect(f.entries.slice(2).map((path) => readFileSync(path))).toEqual(bytes);
        expect(ensureWindowsElectronPermissions(f)).toEqual({ checked: 5, repaired: 0 });
        expect(fixtureAcl(f.entries)).toEqual(after);
      }
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  },
  30000,
);

windows(
  'directory junctions and hard links stop before any runtime or external ACL mutation',
  () => {
    for (const kind of ['junction', 'hardlink'] as const) {
      const f = fixture();
      const alias = join(f.runtime, 'outside-alias');
      let linked = false;
      try {
        const before = fixtureAcl(f.entries, 'prepare');
        const outside = fixtureAcl([f.outside, f.marker]);
        if (kind === 'junction') directoryLink(f.outside, alias);
        else linkSync(f.marker, alias);
        linked = true;
        expect(() => ensureWindowsElectronPermissions(f)).toThrow(
          'development_electron_runtime_scope_invalid',
        );
        expect(fixtureAcl(f.entries)).toEqual(before);
        expect(fixtureAcl([f.outside, f.marker])).toEqual(outside);
        expect(readFileSync(f.marker, 'utf8')).toBe('private-data');
      } finally {
        if (linked) {
          if (kind === 'junction') rmdirSync(alias);
          else unlinkSync(alias);
        }
        expect(realpathSync(f.outside)).toBe(f.outside);
        rmSync(f.root, { recursive: true, force: true });
      }
    }
  },
  20000,
);

windows(
  'explicit AppContainer deny stops the entire preflight without replacing permissions',
  () => {
    const f = fixture();
    try {
      fixtureAcl(f.entries, 'prepare');
      fixtureAcl([f.executable], 'deny');
      const before = fixtureAcl(f.entries);
      expect(() => ensureWindowsElectronPermissions(f)).toThrow(
        'development_electron_permissions_denied',
      );
      expect(fixtureAcl(f.entries)).toEqual(before);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  },
  15000,
);

windows(
  'invalid package/runtime identity fails before spawning; subprocess failures expose finite diagnostics',
  () => {
    const f = fixture();
    try {
      const neverRun = () => {
        throw Error('must not run');
      };
      expect(() =>
        ensureWindowsElectronPermissions({ ...f, executable: f.marker, run: neverRun }),
      ).toThrow('development_electron_runtime_scope_invalid');
      writeFileSync(join(f.runtime, 'version'), '43.0.0');
      expect(() => ensureWindowsElectronPermissions({ ...f, run: neverRun })).toThrow(
        'development_electron_runtime_scope_invalid',
      );
      writeFileSync(join(f.runtime, 'version'), '44.3.0');
      for (const stdout of [
        '',
        'private diagnostic',
        '{"ok":true,"checked":1,"repaired":2}',
        '{"ok":true,"checked":1,"repaired":0,"extra":true}',
      ])
        expect(() =>
          ensureWindowsElectronPermissions({ ...f, run: () => ({ status: 0, stdout }) }),
        ).toThrow('development_electron_permissions_failed');
      for (const code of ['private path or exception', 'development_electron_permissions_denied'])
        expect(() =>
          ensureWindowsElectronPermissions({
            ...f,
            run: () => ({ status: 1, stdout: JSON.stringify({ ok: false, code }) }),
          }),
        ).toThrow(
          code.startsWith('development_') ? code : 'development_electron_permissions_failed',
        );
      expect(
        ensureWindowsElectronPermissions({
          ...f,
          run(command, args, data) {
            expect(command).toEndWith('WindowsPowerShell\\v1.0\\powershell.exe');
            expect(args).not.toContain('-ExecutionPolicy');
            expect(args).not.toContain(f.packageDirectory);
            expect(JSON.parse(data)).toEqual({
              executable: f.executable,
              packageDirectory: f.packageDirectory,
            });
            return { status: 0, stdout: '{"ok":true,"checked":5,"repaired":0}' };
          },
        }),
      ).toEqual({ checked: 5, repaired: 0 });
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  },
);
