import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test.skipIf(process.platform !== 'win32')(
  'Git Bash staging creates and reuses both runtimes, repairs missing assets and preserves changed assets',
  () => {
    const module = fileURLToPath(new URL('../../../src/jobs/windows-git-bash.ts', import.meta.url));
    const owner = fileURLToPath(
      new URL('../../../src/platform/process/windows-owned-child.ts', import.meta.url),
    );
    const jobModule = fileURLToPath(new URL('../../../src/jobs/windows-shell.ts', import.meta.url));
    const code = `
import assert from 'node:assert/strict';
import {mock} from 'bun:test';
import {mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {captureWindowsGitBashRuntime,stageWindowsGitBash} from ${JSON.stringify(module)};

const gitParent = dirname(realpathSync.native(Bun.which('git')));
const source = [dirname(gitParent), dirname(dirname(gitParent))]
  .map(root => join(root, 'usr/bin/msys-2.0.dll')).find(existsSync);
assert.ok(source, 'a real installed MSYS image is required');
const msys = readFileSync(source);
const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'kite-git-staging-')));
const installation = join(root, 'git');
const coreutils = join(root, 'coreutils.exe');
const compatibility = join(root, 'ktipc.dll');
const write = (path, bytes) => { mkdirSync(dirname(path), {recursive:true}); writeFileSync(path, bytes); };
try {
  write(join(installation, 'cmd/git.exe'), 'launcher');
  write(join(installation, 'usr/bin/bash.exe'), 'bash');
  write(join(installation, 'usr/bin/msys-2.0.dll'), msys);
  write(join(installation, 'mingw64/bin/git.exe'), 'git');
  write(join(installation, 'mingw64/libexec/git-core/git-remote-http.exe'), 'helper');
  write(join(installation, 'etc/ssl/certs/ca-bundle.crt'), 'certificate');
  write(coreutils, 'coreutils');
  write(compatibility, 'compatibility');
  Bun.which = command => { assert.equal(command, 'git'); return join(installation, 'cmd/git.exe'); };
  const state = join(root, 'state');
  const staged = await stageWindowsGitBash(state, coreutils, compatibility);
  const runtime = join(dirname(staged.shell), '../..');
  const fullRuntime = join(dirname(staged.fullShell), '../..');
  const manifest = readFileSync(join(runtime, 'manifest.json'));
  assert.equal(readFileSync(staged.shell, 'utf8'), 'bash');
  assert.equal(readFileSync(staged.fullShell, 'utf8'), 'bash');
  assert.deepEqual(readFileSync(join(fullRuntime, 'usr/bin/msys-2.0.dll')), msys);
  assert.ok(readFileSync(join(runtime, 'usr/bin/msys-2.0.dll')).includes(Buffer.from('ktipc.dll\\0')));
  assert.deepEqual(readFileSync(join(installation, 'usr/bin/msys-2.0.dll')), msys);
  for (const base of [runtime, fullRuntime]) {
    assert.equal(readFileSync(join(base, 'mingw64/bin/git.exe'), 'utf8'), 'git');
    assert.equal(readFileSync(join(base, 'mingw64/libexec/git-core/git-remote-http.exe'), 'utf8'), 'helper');
    assert.equal(readFileSync(join(base, 'etc/ssl/certs/ca-bundle.crt'), 'utf8'), 'certificate');
    assert.equal(readFileSync(join(base, 'usr/bin/coreutils.exe'), 'utf8'), 'coreutils');
  }
  assert.deepEqual(await stageWindowsGitBash(state, coreutils, compatibility), staged);
  rmSync(staged.fullShell);
  assert.deepEqual(await stageWindowsGitBash(state, coreutils, compatibility), staged);
  assert.equal(readFileSync(staged.fullShell, 'utf8'), 'bash');
  for (const path of [staged.shell, staged.fullShell]) {
    writeFileSync(path, 'changed');
    await assert.rejects(stageWindowsGitBash(state, coreutils, compatibility), /windows_git_bash_asset_changed/);
    assert.equal(readFileSync(path, 'utf8'), 'changed');
    writeFileSync(path, 'bash');
  }
  assert.deepEqual(await stageWindowsGitBash(state, coreutils, compatibility), staged);
  assert.deepEqual(readFileSync(join(runtime, 'manifest.json')), manifest);
  const verify = captureWindowsGitBashRuntime(staged.shell, staged.fullShell);
  verify(false); verify(true);
  let starts=0,full=false;
  mock.module(${JSON.stringify(owner)},()=>({WindowsOwnedChildStartError:class extends Error{},
    startWindowsOwnedChild:()=>{starts++;throw Error('unexpected_dispatch');}}));
  const {createWindowsShellJob}=await import(${JSON.stringify(jobModule)});
  const control=join(root,'control');mkdirSync(control);
  const job=createWindowsShellJob({cwd:root,controlBase:control,env:{},stateRoot:state,
    supervisorPath:coreutils,shellExecutable:staged.shell,fullShellExecutable:staged.fullShell,
    coreutilsPath:staged.coreutils,executionScope:()=>({filesystem:full?'full_access':'workspace_write',network:'none'})});
  for (const base of [runtime, fullRuntime]) for (const name of ['usr/bin/msys-2.0.dll', 'usr/bin/ktipc.dll', 'mingw64/bin/git.exe', 'etc/ssl/certs/ca-bundle.crt']) {
    const path = join(base, name), original = readFileSync(path);
    writeFileSync(path, 'changed after capture');
    assert.throws(() => verify(base === fullRuntime), /windows_git_bash_asset_changed/);
    full=base===fullRuntime;
    await assert.rejects(job.start({command:'printf forbidden'},{signal:new AbortController().signal,sessionId:'s',executionId:'tampered'}),/windows_git_bash_asset_changed/);
    assert.equal(starts,0,'changed runtime closure must fail before native dispatch');
    writeFileSync(path, original);
    verify(base === fullRuntime);
  }
  writeFileSync(join(runtime, 'manifest.json'), '{}');
  assert.throws(() => verify(false), /confined_launch_changed/);
  writeFileSync(join(runtime, 'manifest.json'), manifest);
  verify(false); verify(true);
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
