import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from '#kite-test';
import { testRuntimeFlags } from '../../../../../scripts/tooling/test-command';

test.skipIf(process.platform !== 'win32')(
  'Git Bash staging creates and reuses both runtimes, repairs missing assets and preserves changed assets',
  () => {
    const module = fileURLToPath(new URL('../../../src/jobs/windows-git-bash.ts', import.meta.url));
    const owner = fileURLToPath(
      new URL('../../../src/platform/process/windows-owned-child.ts', import.meta.url),
    );
    const jobModule = fileURLToPath(new URL('../../../src/jobs/windows-shell.ts', import.meta.url));
    const code = `import {which as findExecutable} from ${JSON.stringify(new URL('../../../../../scripts/tooling/process.ts', import.meta.url).href)};

import assert from 'node:assert/strict';
import {mock} from '#kite-test';
import {mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {captureWindowsGitBashRuntime,stageWindowsGitBash} from ${JSON.stringify(module)};

const gitParent = dirname(realpathSync.native(findExecutable('git')));
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
  write(join(installation, 'mingw64/bin/git.exe'), 'git');
  write(join(installation, 'mingw64/libexec/git-core/git-remote-http.exe'), 'helper');
  write(join(installation, 'etc/ssl/certs/ca-bundle.crt'), 'certificate');
  write(compatibility, 'compatibility');
  process.env.PATH = join(installation, 'cmd');
  const state = join(root, 'state');
  const staged = await stageWindowsGitBash(state, compatibility);
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
    assert.equal(readFileSync(join(base, 'usr/bin/ls.exe'), 'utf8'), 'ls');
  }
  assert.deepEqual(await stageWindowsGitBash(state, compatibility), staged);
  rmSync(staged.fullShell);
  assert.deepEqual(await stageWindowsGitBash(state, compatibility), staged);
  assert.equal(readFileSync(staged.fullShell, 'utf8'), 'bash');
  for (const path of [staged.shell, staged.fullShell]) {
    writeFileSync(path, 'changed');
    await assert.rejects(stageWindowsGitBash(state, compatibility), /windows_git_bash_asset_changed/);
    assert.equal(readFileSync(path, 'utf8'), 'changed');
    writeFileSync(path, 'bash');
  }
  assert.deepEqual(await stageWindowsGitBash(state, compatibility), staged);
  assert.deepEqual(readFileSync(join(runtime, 'manifest.json')), manifest);
  const verify = await captureWindowsGitBashRuntime(staged.shell, staged.fullShell);
  await verify(false); await verify(true);
  let starts=0,full=false;
  mock.module(${JSON.stringify(owner)},()=>({WindowsOwnedChildStartError:class extends Error{},
    startWindowsOwnedChild:()=>{starts++;throw Error('unexpected_dispatch');}}));
  const {createWindowsShellJob}=await import(${JSON.stringify(jobModule)});
  const control=join(root,'control');mkdirSync(control);
  const job=await createWindowsShellJob({cwd:root,controlBase:control,env:{},stateRoot:state,
    supervisorPath:compatibility,shellExecutable:staged.shell,fullShellExecutable:staged.fullShell,
    executionScope:()=>({filesystem:full?'full_access':'workspace_write',network:'none'})});
  for (const base of [runtime, fullRuntime]) for (const name of ['usr/bin/ls.exe', 'usr/bin/msys-2.0.dll', 'usr/bin/ktipc.dll', 'mingw64/bin/git.exe', 'etc/ssl/certs/ca-bundle.crt']) {
    const path = join(base, name), original = readFileSync(path);
    writeFileSync(path, 'changed after capture');
    await assert.rejects(verify(base === fullRuntime), /windows_git_bash_asset_changed/);
    full=base===fullRuntime;
    await assert.rejects(job.start({command:'printf forbidden'},{signal:new AbortController().signal,sessionId:'s',executionId:'tampered'}),/windows_git_bash_asset_changed/);
    assert.equal(starts,0,'changed runtime closure must fail before native dispatch');
    writeFileSync(path, original);
    await verify(base === fullRuntime);
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
    const child = spawnSync(
      process.execPath,
      [...testRuntimeFlags, '--input-type=module-typescript', '--eval', code],
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 20000,
      },
    );
    expect({ status: child.status, error: child.error?.message, stderr: child.stderr }).toEqual({
      status: 0,
      error: undefined,
      stderr: '',
    });
  },
  25000,
);
