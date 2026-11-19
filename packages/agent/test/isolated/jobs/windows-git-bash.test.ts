import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

for (const layout of ['mingw64', 'ucrt64', 'alternate-runtime']) {
  test.skipIf(process.platform !== 'win32')(
    `Git Bash verifies the restricted copy and the original ${layout} installation`,
    () => {
      const module = fileURLToPath(
        new URL('../../../src/jobs/windows-git-bash.ts', import.meta.url),
      );
      const owner = fileURLToPath(
        new URL('../../../src/platform/process/windows-owned-child.ts', import.meta.url),
      );
      const jobModule = fileURLToPath(
        new URL('../../../src/jobs/windows-shell.ts', import.meta.url),
      );
      const code = `
import assert from 'node:assert/strict';
import {mock} from 'bun:test';
import {mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {captureWindowsGitBashRuntime,stageWindowsGitBash,windowsGitProgram} from ${JSON.stringify(module)};

const layout = ${JSON.stringify(layout)};
const program = layout + '/bin/git.exe';
const helper = layout + '/libexec/git-core/git-remote-http.exe';
const sharedData = 'usr/share/misc/signatures/formats.dat';
const gitParent = dirname(realpathSync.native(Bun.which('git')));
const source = [dirname(gitParent), dirname(dirname(gitParent))]
  .map(root => join(root, 'usr/bin/msys-2.0.dll')).find(existsSync);
assert.ok(source, 'a real installed MSYS image is required');
const msys = readFileSync(source);
const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'kite-git-staging-')));
const installation = join(root, 'git');
const compatibility = join(root, 'ktipc.dll');
const write = (path, bytes) => { mkdirSync(dirname(path), {recursive:true}); writeFileSync(path, bytes); };
try {
  write(join(installation, 'cmd/git.exe'), 'launcher');
  write(join(installation, 'usr/bin/bash.exe'), 'bash');
  write(join(installation, 'usr/bin/ls.exe'), 'ls');
  write(join(installation, 'usr/bin/msys-2.0.dll'), msys);
  write(join(installation, program), 'git');
  write(join(installation, helper), 'helper');
  write(join(installation, 'incomplete/bin/git.exe'), 'not an installed runtime');
  write(join(installation, 'etc/ssl/certs/ca-bundle.crt'), 'certificate');
  write(join(installation, sharedData), 'format signatures');
  write(compatibility, 'compatibility');
  Bun.which = command => { assert.equal(command, 'git'); return join(installation, 'cmd/git.exe'); };
  assert.equal(windowsGitProgram(Bun.which('git')), join(installation, program));
  assert.equal(windowsGitProgram(join(installation, program)), join(installation, program));
  const state = join(root, 'state');
  const staged = await stageWindowsGitBash(state, compatibility);
  const runtime = join(dirname(staged.shell), '../..');
  const fullRuntime = installation;
  const manifest = readFileSync(join(runtime, 'manifest.json'));
  assert.equal(staged.fullShell, realpathSync.native(join(installation, 'usr/bin/bash.exe')));
  assert.equal(existsSync(join(runtime, 'full')), false);
  assert.equal(readFileSync(staged.shell, 'utf8'), 'bash');
  assert.equal(readFileSync(staged.fullShell, 'utf8'), 'bash');
  assert.deepEqual(readFileSync(join(fullRuntime, 'usr/bin/msys-2.0.dll')), msys);
  assert.ok(readFileSync(join(runtime, 'usr/bin/msys-2.0.dll')).includes(Buffer.from('ktipc.dll\\0')));
  assert.deepEqual(readFileSync(join(installation, 'usr/bin/msys-2.0.dll')), msys);
  for (const base of [runtime, fullRuntime]) {
    assert.equal(readFileSync(join(base, program), 'utf8'), 'git');
    assert.equal(readFileSync(join(base, helper), 'utf8'), 'helper');
    assert.equal(readFileSync(join(base, 'etc/ssl/certs/ca-bundle.crt'), 'utf8'), 'certificate');
    assert.equal(readFileSync(join(base, sharedData), 'utf8'), 'format signatures');
    assert.equal(readFileSync(join(base, 'usr/bin/ls.exe'), 'utf8'), 'ls');
  }
  assert.deepEqual(await stageWindowsGitBash(state, compatibility), staged);
  rmSync(staged.shell);
  assert.deepEqual(await stageWindowsGitBash(state, compatibility), staged);
  assert.equal(readFileSync(staged.shell, 'utf8'), 'bash');
  writeFileSync(staged.shell, 'changed');
  await assert.rejects(stageWindowsGitBash(state, compatibility), /windows_git_bash_asset_changed/);
  assert.equal(readFileSync(staged.shell, 'utf8'), 'changed');
  writeFileSync(staged.shell, 'bash');
  assert.deepEqual(await stageWindowsGitBash(state, compatibility), staged);
  assert.deepEqual(readFileSync(join(runtime, 'manifest.json')), manifest);
  const { git, fullGit, verify } = await captureWindowsGitBashRuntime(staged.shell, staged.fullShell);
  assert.equal(git, join(runtime, program));
  assert.equal(fullGit, join(fullRuntime, program));
  const otherBash = join(root, 'other/usr/bin/bash.exe');
  write(otherBash, 'bash');
  await assert.rejects(captureWindowsGitBashRuntime(staged.shell, otherBash), /windows_git_bash_asset_invalid/);
  await verify(false); await verify(true);
  let starts=0,full=false;
  mock.module(${JSON.stringify(owner)},()=>({WindowsOwnedChildStartError:class extends Error{},
    startWindowsOwnedChild:()=>{starts++;throw Error('unexpected_dispatch');}}));
  const {createWindowsShellJob}=await import(${JSON.stringify(jobModule)});
  const control=join(root,'control');mkdirSync(control);
  const job=await createWindowsShellJob({cwd:root,controlBase:control,env:{},stateRoot:state,
    supervisorPath:compatibility,shellExecutable:staged.shell,fullShellExecutable:staged.fullShell,
    executionScope:()=>({filesystem:full?'full_access':'workspace_write',network:'none'})});
  for (const base of [runtime, fullRuntime]) {
    const assets = ['usr/bin/ls.exe', 'usr/bin/msys-2.0.dll', program, helper, 'etc/ssl/certs/ca-bundle.crt', sharedData];
    if (base === runtime) assets.push('usr/bin/ktipc.dll');
    for (const name of assets) {
      const path = join(base, name), original = readFileSync(path);
      writeFileSync(path, 'changed after capture');
      await assert.rejects(verify(base === fullRuntime), /windows_git_bash_asset_changed/);
      full=base===fullRuntime;
      await assert.rejects(job.start({command:'printf forbidden'},{signal:new AbortController().signal,sessionId:'s',executionId:'tampered'}),/windows_git_bash_asset_changed/);
      assert.equal(starts,0,'changed runtime closure must fail before native dispatch');
      writeFileSync(path, original);
      await verify(base === fullRuntime);
    }
  }
  writeFileSync(join(runtime, 'manifest.json'), '{}');
  await assert.rejects(verify(false), /confined_launch_changed/);
  writeFileSync(join(runtime, 'manifest.json'), manifest);
  await verify(false); await verify(true);
} finally {
  assert.equal(realpathSync.native(root), root);
  rmSync(root, {recursive:true,force:true});
}
`;
      const child = spawnSync(process.execPath, ['--eval', code], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 20000,
      });
      expect({ status: child.status, error: child.error?.message, stderr: child.stderr }).toEqual({
        status: 0,
        error: undefined,
        stderr: '',
      });
    },
    25000,
  );
}
