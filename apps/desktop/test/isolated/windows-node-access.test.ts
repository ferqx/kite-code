import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, normalize } from 'node:path';
import { acquireArtifactAccess } from '@kite-ai/agent/artifact-access';
import { privateDirectory } from '@kite-ai/agent/windows-path-security';
import { loadWindowsAccess } from '../../electron/windows-access';
import { buildWindowsAccess, verifyNodeApiHeaders } from '../../scripts/build-windows-access';

test.skipIf(process.platform !== 'win32')(
  'native closed inventory rejects new files and directories while original candidate handles stay live',
  async () => {
    const root = join(tmpdir(), `kite-node-inventory-${crypto.randomUUID()}`);
    privateDirectory(root);
    try {
      const source = verifyNodeApiHeaders();
      const translation = join(root, 'inventory.cc');
      // An isolated test executable includes the actual private implementation.
      // The normal addon gets no test export, flag or alternate factory.
      writeFileSync(
        translation,
        `#include ${JSON.stringify(join(source, 'access.cc').replaceAll('\\', '/'))}
#include <iostream>
int wmain(int argc,wchar_t** argv) {
 std::unique_ptr<Lease> lease;
 try {
  need(argc==2); const auto root=canonical(argv[1]); lease=std::make_unique<Lease>();
  lease->ancestors(root,true);
  for(const auto& path:{root+L"\\\\nested",root+L"\\\\empty"}) lease->pin(path,false,true);
  lease->pinFile(root+L"\\\\a.txt",false); lease->pinFile(root+L"\\\\nested\\\\b.txt",false);
  lease->candidateRoot=root;
  lease->candidateFiles={root+L"\\\\a.txt",root+L"\\\\nested\\\\b.txt"};
  lease->candidateDirectories={root,root+L"\\\\nested",root+L"\\\\empty"};
  lease->acquire(parent(root)+L"\\\\unit.lock");
  std::cout<<"READY\\n"<<std::flush; std::cin.get();
  lease->verify(); lease->release(); std::cout<<"VERIFIED\\n"; return 0;
 }catch(const std::exception& error){
  if(lease)try{lease->release();}catch(...){return 3;}
  std::cerr<<error.what()<<"\\n";return 2;
 }
}
`,
      );
      const executable = join(root, 'inventory.exe');
      const compiled = spawnSync(
        process.env.KITE_WINDOWS_MSVC!,
        [
          '/nologo',
          '/MT',
          '/O2',
          '/std:c++17',
          '/EHsc',
          '/DUNICODE',
          '/D_UNICODE',
          '/D_WIN32_WINNT=0x0A00',
          `/I${join(source, 'include')}`,
          translation,
          `/Fo${join(root, 'inventory.obj')}`,
          `/Fe${executable}`,
          '/link',
          'advapi32.lib',
          'bcrypt.lib',
        ],
        { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 15000 },
      );
      expect(compiled.status, compiled.stdout + compiled.stderr).toBe(0);
      const security = (
        await import('@kite-ai/agent/windows-path-security')
      ).defaultWindowsPathSecurity()!;
      for (const mode of ['unchanged', 'new-file', 'new-directory', 'declared-empty']) {
        const directory = join(root, mode);
        privateDirectory(directory);
        privateDirectory(join(directory, 'nested'));
        privateDirectory(join(directory, 'empty'));
        security.writePrivateFile(join(directory, 'a.txt'), Buffer.from('a'));
        security.writePrivateFile(join(directory, 'nested/b.txt'), Buffer.from('b'));
        const child = Bun.spawn([executable, directory], {
          cwd: root,
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: 'pipe',
          windowsHide: true,
          timeout: 5000,
        });
        const reader = child.stdout.getReader();
        let stdout = '';
        try {
          while (!stdout.replaceAll('\r\n', '\n').includes('READY\n')) {
            const next = await reader.read();
            expect(next.done).toBe(false);
            stdout += Buffer.from(next.value!).toString('utf8');
            expect(stdout.length).toBeLessThan(4096);
          }
          if (mode === 'new-file')
            security.writePrivateFile(join(directory, 'nested/unknown'), Buffer.from('unknown'));
          if (mode === 'new-directory') privateDirectory(join(directory, 'unknown'));
          if (mode === 'declared-empty')
            security.writePrivateFile(join(directory, 'empty/unknown'), Buffer.from('unknown'));
          await child.stdin.write('\n');
          await child.stdin.end();
          for (;;) {
            const next = await reader.read();
            if (next.done) break;
            stdout += Buffer.from(next.value).toString('utf8');
          }
          const [code, stderr] = await Promise.all([
            child.exited,
            new Response(child.stderr).text(),
          ]);
          expect(code).toBe(mode === 'unchanged' ? 0 : 2);
          expect(stdout.replaceAll('\r\n', '\n')).toBe(
            mode === 'unchanged' ? 'READY\nVERIFIED\n' : 'READY\n',
          );
          expect(stderr.replaceAll('\r\n', '\n')).toBe(
            mode === 'unchanged' ? '' : 'windows_access_denied\n',
          );
        } finally {
          if (child.exitCode === null) child.kill();
          await child.exited;
          reader.releaseLock();
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  30000,
);

test('fixed Windows Node-API headers retain reviewed identity and inert imports grant no authority', async () => {
  const source = verifyNodeApiHeaders();
  expect(source.endsWith(normalize('native/windows-access'))).toBe(true);
  if (process.platform === 'win32') return; // Native factories have separate mandatory cases.
  expect(() =>
    loadWindowsAccess({ path: '/nonexistent/asset.node', sha256: '0'.repeat(64) }),
  ).toThrow('windows_access_platform_unsupported');
  const root = mkdtempSync(join(tmpdir(), 'kite-node-api-contract-'));
  try {
    let error: unknown;
    try {
      await buildWindowsAccess(root);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('windows_access_build_platform_unsupported');
    expect(readdirSync(root)).toEqual([]);
    const fixture = join(root, 'contract.cc');
    writeFileSync(
      fixture,
      '#define NAPI_VERSION 8\n#define NAPI_EXTERN\n#include "node_api.h"\n#include <type_traits>\nstatic_assert(std::is_pointer_v<decltype(&napi_wrap)>);\nstatic_assert(std::is_pointer_v<decltype(&napi_get_value_string_utf16)>);\nstatic_assert(std::is_pointer_v<decltype(&napi_get_global)>);\nstatic_assert(std::is_pointer_v<decltype(&napi_call_function)>);\nstatic_assert(std::is_pointer_v<decltype(&napi_get_property_names)>);\nstatic_assert(std::is_pointer_v<decltype(&napi_is_array)>);\nstatic_assert(std::is_pointer_v<decltype(&napi_create_string_utf8)>);\nstatic_assert(std::is_pointer_v<decltype(&napi_create_string_utf16)>);\nNAPI_MODULE_INIT(){return exports;}\n',
    );
    const checked = spawnSync(
      'c++',
      ['-std=c++17', '-fsyntax-only', `-I${join(source, 'include')}`, fixture],
      { encoding: 'utf8' },
    );
    expect(checked.status).toBe(0);
    expect(checked.stderr).toBe('');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== 'win32')(
  'actual Electron Node private Profile handles support long local paths while device input stays rejected',
  async () => {
    const root = join(tmpdir(), `kite-node-long-path-${crypto.randomUUID()}`);
    privateDirectory(root);
    try {
      const nativeRoot = join(root, 'native');
      privateDirectory(nativeRoot);
      const built = await buildWindowsAccess(nativeRoot);
      const dataRoot = join(
        root,
        ...Array.from({ length: 4 }, (_, i) => `${i}-${'segment'.repeat(10)}`),
      );
      expect(dataRoot.length).toBeGreaterThan(300);
      privateDirectory(dataRoot);
      privateDirectory(join(dataRoot, 'long'));
      const electron = createRequire(join(import.meta.dir, '../../package.json'))(
        'electron',
      ) as string;
      const code = `const assert=require('node:assert/strict'),api=require(${JSON.stringify(join(nativeRoot, built.relativePath))});
const root=${JSON.stringify(dataRoot)};
for(const path of ${JSON.stringify(['relative', `\\\\?\\${dataRoot}`, `${dataRoot}\\.`])})assert.throws(()=>api.profileShared(path,'long'));
const first=api.profileShared(root,'long'),second=api.profileShared(root,'long');
first.preparePrivateUi();first.verifyPrivateUi();second.verify();first.release();second.verify();second.release();second.release();
assert.throws(()=>first.verify());console.log('LONG_LOCAL_PROFILE_CONFIRMED');`;
      const result = spawnSync(electron, ['--eval', code], {
        env: { SystemRoot: process.env.SystemRoot, PATH: '', ELECTRON_RUN_AS_NODE: '1' },
        encoding: 'utf8',
        windowsHide: true,
        timeout: 15000,
      });
      if (result.status !== 0) throw Error(`long_native_profile_failed:${result.stderr}`);
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('LONG_LOCAL_PROFILE_CONFIRMED');
      expect(result.stderr).toBe('');
      expect(existsSync(join(dataRoot, 'long', 'desktop-private'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  30000,
);

test.skipIf(process.platform !== 'win32')(
  'actual Electron metadata recovery backs up before targeted ACL repair and preserves busy, drift, write exposure and original data refusals',
  async () => {
    const root = join(tmpdir(), `kite-profile-permissions-${crypto.randomUUID()}`);
    privateDirectory(root);
    try {
      const nativeRoot = join(root, 'native');
      privateDirectory(nativeRoot);
      const built = await buildWindowsAccess(nativeRoot);
      const fixture = await Bun.build({
        entrypoints: [join(import.meta.dir, '../profile-permissions-native.fixture.ts')],
        target: 'node',
        format: 'cjs',
        outdir: root,
        naming: 'permissions.cjs',
      });
      if (!fixture.success)
        throw new AggregateError(fixture.logs, 'permissions_fixture_build_failed');
      const electron = createRequire(join(import.meta.dir, '../../package.json'))(
        'electron',
      ) as string;
      const result = spawnSync(
        electron,
        [join(root, 'permissions.cjs'), join(nativeRoot, built.relativePath), root],
        {
          env: { SystemRoot: process.env.SystemRoot, PATH: '', ELECTRON_RUN_AS_NODE: '1' },
          encoding: 'utf8',
          windowsHide: true,
          timeout: 45000,
        },
      );
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe('PROFILE_PERMISSIONS_NATIVE_PASS');
      expect(result.stderr).toBe('');
      const security = (
        await import('@kite-ai/agent/windows-path-security')
      ).defaultWindowsPathSecurity()!;
      for (const directory of ['repaired', 'busy', 'file']) {
        const backup = readdirSync(join(root, directory)).find((name) =>
          name.startsWith('permissions-backup-'),
        )!;
        const pin = security.retainPrivateFile(join(root, directory, backup));
        pin.verify();
        pin.close();
        expect(backup).toBeTruthy();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  60000,
);

async function nativeFixture() {
  const { acquireProfileAccess } = await import(
    join(import.meta.dir, '../../../../packages/agent/src/platform/profile.ts')
  );
  const { buildOwnedDefaultArtifactConsumer } = (await import(
    join(
      import.meta.dir,
      '../../../../tests/fixtures/unified-agent/windows-artifact-default/build.ts',
    )
  )) as {
    buildOwnedDefaultArtifactConsumer(root: string): Promise<{ root: string; entry: string }>;
  };
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-windows-main-holder-')));
  const who = spawnSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' });
  const sid = who.stdout.match(/S-1-(?:\d+-)*\d+/)?.[0];
  if (who.status !== 0 || !sid) throw Error('owned_sid_unavailable');
  const acl = spawnSync(
    'icacls.exe',
    [
      root,
      '/inheritance:r',
      '/grant:r',
      `*${sid}:(OI)(CI)(F)`,
      '*S-1-5-18:(OI)(CI)(F)',
      '*S-1-5-32-544:(OI)(CI)(F)',
      '*S-1-1-0:(OI)(CI)(RX)',
    ],
    { encoding: 'utf8' },
  );
  if (acl.status !== 0) throw Error(`owned_public_acl_failed:${acl.stderr}`);
  const compiled = await buildOwnedDefaultArtifactConsumer(root);
  const nativeRoot = join(root, 'native');
  mkdirSync(nativeRoot);
  const native = await buildWindowsAccess(nativeRoot);
  const windowsAsset = { path: join(nativeRoot, native.relativePath), sha256: native.sha256 };
  const roots = [compiled.root, join(compiled.root, 'inner')];
  mkdirSync(roots[1]!);
  const gate = join(root, 'gate'),
    closing = join(root, 'closing'),
    trace = join(root, 'service-trace'),
    workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const helperPath = join(root, 'profile-access.js');
  const helper = await Bun.build({
    entrypoints: [join(import.meta.dir, '../../electron/profile-access-helper.ts')],
    target: 'bun',
    packages: 'bundle',
    outdir: root,
    naming: 'profile-access.js',
  });
  if (!helper.success) throw Error('owned_helper_build_failed');
  const driver = await Bun.build({
    entrypoints: [join(import.meta.dir, '../windows-node-access.fixture.ts')],
    target: 'node',
    format: 'esm',
    packages: 'bundle',
    outdir: compiled.root,
    naming: 'node-holder.mjs',
  });
  if (!driver.success) throw new AggregateError(driver.logs, 'owned_node_holder_build_failed');
  const wrapperSource = join(root, 'wrapper.ts');
  writeFileSync(
    wrapperSource,
    `import {writeFileSync,appendFileSync,existsSync} from 'node:fs';import{acquireArtifactAccess}from '@kite-ai/agent/artifact-access';import{runServiceProcess}from '@kite-ai/service/main';const trace=${JSON.stringify(trace)};writeFileSync(trace,'wrapper-started\\n');process.on('exit',code=>appendFileSync(trace,'exit:'+code+'\\n'));const leases=${JSON.stringify(roots)}.map(root=>acquireArtifactAccess({root,mode:'shared'}));try{await runServiceProcess({beforeResourceClose:async()=>{appendFileSync(trace,'before-close\\n');writeFileSync(${JSON.stringify(closing)},'held');const deadline=Date.now()+10000;while(!existsSync(${JSON.stringify(gate)})){if(Date.now()>deadline)throw Error('owned_close_gate_deadline');await Bun.sleep(10);}}});appendFileSync(trace,'service-returned\\n');}finally{for(const lease of leases.reverse())lease.release();}`,
  );
  const wrapper = await Bun.build({
    entrypoints: [wrapperSource],
    target: 'bun',
    packages: 'external',
    outdir: compiled.root,
    naming: 'service-holder.js',
  });
  if (!wrapper.success) throw new AggregateError(wrapper.logs, 'owned_service_holder_build_failed');
  const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
  const bunExecutable = realpathSync(process.execPath);
  const input = {
    mode: 'parent',
    roots,
    windowsAsset,
    gate,
    workspace,
    profile: { dataRoot: join(root, 'private'), profile: 'owned' },
    service: join(compiled.root, 'service-holder.js'),
    access: {
      bunExecutable,
      bunSha256: sha(bunExecutable),
      helperPath,
      helperSha256: sha(helperPath),
    },
    instanceId: crypto.randomUUID(),
  };
  // Real Electron executable executes its own Node-API and private SQLite, not a Bun proxy.
  const electron = createRequire(join(import.meta.dir, '../../package.json'))('electron') as string;
  const children: ReturnType<typeof Bun.spawn>[] = [];
  const spawn = (value = input) => {
    const child = Bun.spawn(
      [electron, '--expose-gc', join(compiled.root, 'node-holder.mjs'), JSON.stringify(value)],
      {
        cwd: compiled.root,
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          NODE_OPTIONS: '',
          NODE_PATH: '',
          BUN_OPTIONS: '',
        },
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    children.push(child);
    const reader = child.stdout.getReader();
    let pending = '';
    const next = async (phase: string) => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
      try {
        for (;;) {
          const newline = pending.indexOf('\n');
          if (newline >= 0) {
            const record = JSON.parse(pending.slice(0, newline));
            pending = pending.slice(newline + 1);
            if (record.phase === phase) return record;
            continue;
          }
          const chunk = await reader.read();
          if (chunk.done)
            throw Error(`owned_node_holder_closed:${await new Response(child.stderr).text()}`);
          pending += new TextDecoder().decode(chunk.value);
          if (pending.length > 16384) throw Error('owned_node_holder_output_limit');
        }
      } finally {
        clearTimeout(timer);
      }
    };
    return {
      child,
      next,
      send: (line: string) => {
        child.stdin.write(`${line}\n`);
        child.stdin.flush();
      },
    };
  };
  const busy = () => {
    for (const root of roots)
      expect(() => acquireArtifactAccess({ root, mode: 'exclusive' })).toThrow();
    expect(() => acquireProfileAccess(input.profile, 'exclusive')).toThrow();
  };
  const free = () => {
    for (const root of roots) acquireArtifactAccess({ root, mode: 'exclusive' }).release();
    acquireProfileAccess(input.profile, 'exclusive').lock.release();
  };
  return {
    root,
    input,
    roots,
    gate,
    closing,
    trace,
    spawn,
    busy,
    free,
    maintenance: () => acquireProfileAccess(input.profile, 'exclusive'),
    async close() {
      writeFileSync(gate, 'release');
      for (const child of children)
        if (child.exitCode === null) {
          child.kill('SIGKILL');
          await child.exited;
        }
      rmSync(root, { recursive: true, force: true });
    },
  };
}
function originalChildHandle(pid: number, executable: string) {
  const { dlopen, ptr } = require('bun:ffi') as typeof import('bun:ffi');
  const api = dlopen('kernel32.dll', {
    OpenProcess: { args: ['u32', 'bool', 'u32'], returns: 'u64' },
    QueryFullProcessImageNameW: { args: ['u64', 'u32', 'ptr', 'ptr'], returns: 'bool' },
    GetExitCodeProcess: { args: ['u64', 'ptr'], returns: 'bool' },
    WaitForSingleObject: { args: ['u64', 'u32'], returns: 'u32' },
    TerminateProcess: { args: ['u64', 'u32'], returns: 'bool' },
    CloseHandle: { args: ['u64'], returns: 'bool' },
  });
  const handle = api.symbols.OpenProcess(0x101001, false, pid);
  if (!handle) {
    api.close();
    throw Error('owned_process_handle_unavailable');
  }
  try {
    const image = new Uint16Array(32768),
      size = new Uint32Array([image.length]);
    if (!api.symbols.QueryFullProcessImageNameW(handle, 0, ptr(image), ptr(size)))
      throw Error('owned_process_identity_unavailable');
    const path = Buffer.from(image.buffer, 0, size[0]! * 2).toString('utf16le');
    if (realpathSync(path) !== realpathSync(executable))
      throw Error('owned_process_identity_mismatch');
  } catch (error) {
    api.symbols.CloseHandle(handle);
    api.close();
    throw error;
  }
  return {
    state() {
      const result = api.symbols.WaitForSingleObject(handle, 0);
      return result === 0 ? 'dead' : result === 258 ? 'live' : 'uncertain';
    },
    exitCode() {
      const result = new Uint32Array(1);
      if (!api.symbols.GetExitCodeProcess(handle, ptr(result)))
        throw Error('owned_process_exit_unknown');
      return result[0]!;
    },
    async close() {
      let failure: unknown;
      try {
        if (api.symbols.WaitForSingleObject(handle, 0) === 258) {
          if (!api.symbols.TerminateProcess(handle, 1)) throw Error('owned_process_stop_failed');
          const deadline = Date.now() + 5000;
          while (api.symbols.WaitForSingleObject(handle, 0) === 258) {
            if (Date.now() > deadline) throw Error('owned_process_stop_unconfirmed');
            await Bun.sleep(10);
          }
        }
      } catch (error) {
        failure = error;
      }
      if (!api.symbols.CloseHandle(handle)) throw Error('owned_process_close_failed');
      api.close();
      if (failure) throw failure;
    },
  };
}
test.skipIf(process.platform !== 'win32')(
  'actual Electron Node and independent Bun Service hold original Profile and candidate SH through child death and native UI close',
  async () => {
    const f = await nativeFixture();
    try {
      const holder = f.spawn();
      await holder.next('parent-held');
      f.busy();
      const held = await holder.next('paired-held');
      expect(held.electron).toBe('44.3.0');
      expect(held.node).toBe('24.20.0');
      f.busy();
      holder.send('kill-child');
      await holder.next('child-dead-ui-held');
      f.busy();
      holder.send('close');
      await holder.next('closed');
      expect(await holder.child.exited).toBe(0);
      f.free();
      const cold = f.spawn({
        ...f.input,
        mode: 'cold',
        scope: { storeId: held.storeId, workspaceId: 'w', rootSessionId: 's' },
        draft: held.draft,
      } as typeof f.input);
      await cold.next('cold-original');
      expect(await cold.child.exited).toBe(0);
      f.free();
    } finally {
      await f.close();
    }
  },
  60000,
);
test.skipIf(process.platform !== 'win32')(
  'native Main asset mismatch, maintenance SH refusal and journal preserve zero UI creation and original unsafe ACL',
  async () => {
    const f = await nativeFixture();
    try {
      const denied = async (extra: Record<string, unknown>) => {
        const holder = f.spawn({ ...f.input, mode: 'denied', ...extra } as typeof f.input);
        await holder.next('denied');
        expect(await holder.child.exited).toBe(0);
        expect(
          existsSync(join(f.input.profile.dataRoot, 'owned/desktop-private/data.sqlite')),
        ).toBe(false);
      };
      await denied({
        denyKind: 'artifact',
        windowsAsset: { ...f.input.windowsAsset, sha256: '0'.repeat(64) },
        expectedCode: 'native_asset_identity_mismatch',
      });
      const maintenance = f.maintenance();
      try {
        await denied({ expectedCode: 'owner_busy' });
      } finally {
        maintenance.lock.release();
      }
      const journal = join(maintenance.coordinationPath, 'restore-journal.json');
      writeFileSync(journal, '{}', { mode: 0o600 });
      try {
        await denied({ expectedCode: 'restore_reconciliation_required' });
        expect(readFileSync(journal, 'utf8')).toBe('{}');
      } finally {
        unlinkSync(journal);
      }
      const broad = spawnSync('icacls.exe', [f.roots[0]!, '/grant', '*S-1-1-0:(WD)'], {
        encoding: 'utf8',
      });
      expect(broad.status).toBe(0);
      const before = spawnSync('icacls.exe', [f.roots[0]!], { encoding: 'utf8' });
      expect(before.status).toBe(0);
      await denied({ denyKind: 'artifact', expectedCode: 'windows_access_unavailable' });
      expect(spawnSync('icacls.exe', [f.roots[0]!], { encoding: 'utf8' }).stdout).toBe(
        before.stdout,
      );
    } finally {
      await f.close();
    }
  },
  60000,
);
test.skipIf(process.platform !== 'win32')(
  'repairing extra read permission allows a cold Native reopen of the original SQLite draft and Store without replay',
  async () => {
    const f = await nativeFixture();
    try {
      const holder = f.spawn();
      const held = await holder.next('paired-held');
      holder.send('close');
      await holder.next('closed');
      expect(await holder.child.exited).toBe(0);
      const database = join(f.input.profile.dataRoot, 'owned', 'core.db');
      const bytes = readFileSync(database);
      const acl = spawnSync(
        'icacls.exe',
        [f.input.profile.dataRoot, '/grant', '*S-1-1-0:(OI)(CI)(RX)'],
        { encoding: 'utf8' },
      );
      expect(acl.status).toBe(0);
      const repair = f.spawn({ ...f.input, mode: 'repair-permissions' });
      const repaired = await repair.next('permissions-repaired');
      expect(await repair.child.exited).toBe(0);
      expect(readFileSync(repaired.backupPath, 'utf8')).toContain('Owner/Group/DACL:');
      expect(readFileSync(database)).toEqual(bytes);
      const cold = f.spawn({
        ...f.input,
        mode: 'cold',
        reopenService: true,
        scope: { storeId: held.storeId, workspaceId: 'w', rootSessionId: 's' },
        draft: held.draft,
      } as typeof f.input);
      const restored = await cold.next('cold-original');
      expect(restored.draft).toEqual(held.draft);
      expect(await cold.child.exited).toBe(0);
      f.free();
    } finally {
      await f.close();
    }
  },
  60000,
);
test.skipIf(process.platform !== 'win32')(
  'parent-only native termination releases its Windows handles while real child EOF drain keeps EX busy until child exits',
  async () => {
    const f = await nativeFixture();
    let original: ReturnType<typeof originalChildHandle> | undefined;
    let parent: ReturnType<typeof originalChildHandle> | undefined;
    try {
      const holder = f.spawn();
      const held = await holder.next('paired-held');
      original = originalChildHandle(held.childPid, f.input.access.bunExecutable);
      f.busy();
      const electron = createRequire(join(import.meta.dir, '../../package.json'))(
        'electron',
      ) as string;
      parent = originalChildHandle(holder.child.pid, electron);
      await parent.close();
      parent = undefined;
      await holder.child.exited;
      const deadline = Date.now() + 5000;
      while (!existsSync(f.closing)) {
        if (Date.now() > deadline)
          throw Error(
            `owned_child_not_draining:${original.state()}:${original.exitCode()}:${readFileSync(f.trace, 'utf8')}`,
          );
        await Bun.sleep(10);
      }
      f.busy();
      writeFileSync(f.gate, 'release');
      for (;;) {
        try {
          f.free();
          break;
        } catch {
          if (Date.now() > deadline + 5000) throw Error('owned_child_locks_not_released');
          await Bun.sleep(10);
        }
      }
      while (original.state() !== 'dead') {
        if (Date.now() > deadline + 5000) throw Error('owned_child_exit_unconfirmed');
        await Bun.sleep(10);
      }
      expect(original.exitCode()).toBe(0);
      expect(readFileSync(f.trace, 'utf8')).toContain('before-close');
    } finally {
      try {
        await parent?.close();
        await original?.close();
      } finally {
        await f.close();
      }
    }
  },
  60000,
);
test.skipIf(process.platform !== 'win32')(
  'native Node-API GC finalizer closes only its own candidate handles without a persistent helper',
  async () => {
    const f = await nativeFixture();
    try {
      const holder = f.spawn({ ...f.input, mode: 'gc' });
      await holder.next('gc-held');
      expect(() => renameSync(f.roots[0]!, `${f.roots[0]}-moved`)).toThrow();
      expect(() => acquireArtifactAccess({ root: f.roots[0]!, mode: 'exclusive' })).toThrow();
      holder.send('gc');
      await holder.next('gc-requested');
      const deadline = Date.now() + 5000;
      for (;;) {
        try {
          acquireArtifactAccess({ root: f.roots[0]!, mode: 'exclusive' }).release();
          break;
        } catch {
          if (Date.now() > deadline) throw Error('owned_gc_handles_not_released');
          await Bun.sleep(10);
        }
      }
      holder.send('close');
      expect(await holder.child.exited).toBe(0);
    } finally {
      await f.close();
    }
  },
  60000,
);

test.skipIf(process.platform !== 'win32')(
  'native prepared private UI pins original Profile, UI directory and mandatory main DB across SQLite open, checkpoint and attempted same-SID replacement',
  async () => {
    const f = await nativeFixture();
    try {
      const { openSqliteStore } = await import(
        join(import.meta.dir, '../../../../packages/agent/src/sqlite.ts')
      );
      const store = await openSqliteStore(f.input.profile);
      await store.close();
      const profile = join(f.input.profile.dataRoot, f.input.profile.profile),
        ui = join(profile, 'desktop-private'),
        database = join(ui, 'data.sqlite');
      expect(existsSync(database)).toBe(false);
      const holder = f.spawn({ ...f.input, mode: 'ui-proof' });
      await holder.next('ui-unprepared');
      expect(existsSync(database)).toBe(false);
      holder.send('prepare');
      await holder.next('ui-prepared');
      const original = statSync(database, { bigint: true }),
        replacement = join(ui, 'replacement.sqlite');
      writeFileSync(replacement, 'owned replacement same SID');
      const identities = () => {
        const current = statSync(database, { bigint: true });
        expect([current.dev, current.ino]).toEqual([original.dev, original.ino]);
      };
      const attacks = () => {
        expect(() => renameSync(profile, profile + '-moved')).toThrow();
        expect(() => renameSync(ui, ui + '-moved')).toThrow();
        expect(() => unlinkSync(database)).toThrow();
        expect(() => renameSync(replacement, database)).toThrow();
        identities();
        expect(() => f.maintenance()).toThrow();
      };
      attacks();
      holder.send('verify');
      await holder.next('ui-verified');
      holder.send('open');
      await holder.next('ui-opened');
      attacks();
      holder.send('verify');
      await holder.next('ui-verified');
      holder.send('close');
      expect(await holder.child.exited).toBe(0);
      f.maintenance().lock.release();
      renameSync(profile, profile + '-moved');
      renameSync(profile + '-moved', profile);
      renameSync(ui, ui + '-moved');
      renameSync(ui + '-moved', ui);
      renameSync(replacement, database);
      expect(readFileSync(database, 'utf8')).toBe('owned replacement same SID');
    } finally {
      await f.close();
    }
  },
  60000,
);

test.skipIf(process.platform !== 'win32')(
  'candidate lease rejects a matching private marker and helper bytes without the actual owned broker parent',
  async () => {
    const f = await nativeFixture();
    try {
      const { defaultWindowsPathSecurity, privateDirectory } = await import(
        '@kite-ai/agent/windows-path-security'
      );
      const security = defaultWindowsPathSecurity()!;
      const prefix = join(f.root, 'candidate-installation');
      privateDirectory(prefix);
      const id = 'a'.repeat(64),
        candidateRoot = join(prefix, 'releases', id);
      privateDirectory(candidateRoot);
      privateDirectory(join(candidateRoot, 'terminal'));
      privateDirectory(join(prefix, 'bin'));
      const body = Buffer.from('fixture declaration alone grants no broker authority');
      const sha256 = createHash('sha256').update(body).digest('hex');
      const names = ['kite.exe', 'kite-tui.exe', 'kite-desktop.exe', 'native-verifier.exe'];
      for (const name of names) security.writePrivateArtifactFile(join(prefix, 'bin', name), body);
      security.writePrivateFile(
        join(prefix, '.kite-native-install.json'),
        Buffer.from(
          JSON.stringify({
            version: 2,
            root: prefix,
            bootstrap: {
              candidateId: id,
              files: names.map((name) => ({ name, size: body.length, sha256 })),
            },
          }),
        ),
      );
      const normalized = prefix.toLowerCase();
      const coordination = join(
        f.root,
        `.kite-install-coordination-${createHash('sha256').update(normalized).digest('hex')}`,
      );
      privateDirectory(coordination);
      security.writePrivateFile(
        join(coordination, 'installation.json'),
        Buffer.from(JSON.stringify({ version: 1, prefix: normalized })),
      );
      const files: [string, string, string][] = [];
      for (const path of ['native-manifest.json', 'terminal/terminal-manifest.json']) {
        security.writePrivateArtifactFile(join(candidateRoot, path), body);
        files.push([path, sha256, String(body.length)]);
      }
      const holder = f.spawn({
        ...f.input,
        mode: 'candidate-denied',
        candidate: { root: candidateRoot, prefix, id, files },
      } as typeof f.input);
      await holder.next('candidate-denied');
      expect(await holder.child.exited).toBe(0);
      expect(existsSync(join(coordination, `use-${id}.lock`))).toBe(false);
      expect(readFileSync(join(prefix, '.kite-native-install.json'), 'utf8')).toContain(
        'native-verifier.exe',
      );
      renameSync(candidateRoot, `${candidateRoot}-released`);
      renameSync(`${candidateRoot}-released`, candidateRoot);
      expect(readFileSync(join(candidateRoot, 'native-manifest.json'))).toEqual(body);
    } finally {
      await f.close();
    }
  },
  60000,
);

test('formal Windows candidate Main stops before native loading, factories or child launch; local simulated policy and actual Windows mandatory negative', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kite-formal-win-bootstrap-'));
  try {
    const main = join(root, 'main.cjs');
    const built = await Bun.build({
      entrypoints: [join(import.meta.dir, '../../electron/main.ts')],
      target: 'node',
      format: 'cjs',
      packages: 'bundle',
      external: ['electron'],
      outdir: root,
      naming: 'main.cjs',
      define: {
        __KITE_DESKTOP_NATIVE_ASSETS__: JSON.stringify({ kind: 'candidate' }),
        __KITE_DESKTOP_PROFILE_ACCESS__: JSON.stringify({
          relativePath: 'profile-access.js',
          sha256: '0'.repeat(64),
        }),
        __KITE_DESKTOP_WINDOWS_ACCESS__: JSON.stringify({
          relativePath: 'windows-access.node',
          sha256: '0'.repeat(64),
        }),
      },
    });
    expect(built.success).toBe(true);
    const driver = join(root, 'driver.cjs');
    writeFileSync(
      driver,
      `const assert=require('node:assert/strict'),Module=require('node:module'),child=require('node:child_process');let nativeLoads=0,factories=0,children=0,appReads=0;const original=Module._load;Module._load=function(request,...args){if(request==='electron')return{app:{getAppPath(){appReads++;return ${JSON.stringify(join(root, 'untrusted-app'))};}}};if(request.endsWith('.node')){nativeLoads++;return{artifactShared(){factories++;throw Error('unqualified_factory');},profileShared(){factories++;throw Error('unqualified_factory');}};}if(request==='node:sqlite'){nativeLoads++;throw Error('unqualified_sqlite');}return original.call(this,request,...args);};for(const name of ['spawn','exec','execFile','fork'])child[name]=()=>{children++;throw Error('unqualified_child');};const actualPlatform=process.platform;if(actualPlatform!=='win32')Object.defineProperty(process,'platform',{value:'win32'});let failure;try{require(${JSON.stringify(main)});}catch(error){failure=error;}assert.equal(failure?.code,'native_windows_bootstrap_unqualified');assert.deepEqual({nativeLoads,factories,children,appReads},{nativeLoads:0,factories:0,children:0,appReads:0});console.log(JSON.stringify({actualPlatform,negative:'native_windows_bootstrap_unqualified',nativeLoads,factories,children,appReads}));`,
    );
    const node = Bun.which('node');
    if (!node) throw Error('owned_node_unavailable');
    const child = Bun.spawn([node, driver], { stdout: 'pipe', stderr: 'pipe' });
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exit).toBe(0);
    expect(stderr).toBe('');
    const proof = JSON.parse(stdout);
    expect(proof).toEqual({
      actualPlatform: process.platform,
      negative: 'native_windows_bootstrap_unqualified',
      nativeLoads: 0,
      factories: 0,
      children: 0,
      appReads: 0,
    });
    console.log(JSON.stringify(proof));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
