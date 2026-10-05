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
import { join } from 'node:path';
import { acquireArtifactAccess } from '@kite-ai/agent/artifact-access';
import { loadWindowsAccess } from '../../electron/windows-access';
import { buildWindowsAccess, verifyNodeApiHeaders } from '../../scripts/build-windows-access';

test('fixed Windows Node-API headers retain reviewed identity and inert imports grant no authority', async () => {
  const source = verifyNodeApiHeaders();
  expect(source.endsWith('native/windows-access')).toBe(true);
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
      '#define NAPI_VERSION 8\n#define NAPI_EXTERN\n#include "node_api.h"\n#include <type_traits>\nstatic_assert(std::is_pointer_v<decltype(&napi_wrap)>);\nstatic_assert(std::is_pointer_v<decltype(&napi_get_value_string_utf16)>);\nNAPI_MODULE_INIT(){return exports;}\n',
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
    `import {writeFileSync,existsSync} from 'node:fs';import{acquireArtifactAccess}from '@kite-ai/agent/artifact-access';import{runServiceProcess}from '@kite-ai/service/main';const leases=${JSON.stringify(roots)}.map(root=>acquireArtifactAccess({root,mode:'shared'}));try{await runServiceProcess({beforeResourceClose:async()=>{writeFileSync(${JSON.stringify(closing)},'held');const deadline=Date.now()+10000;while(!existsSync(${JSON.stringify(gate)})){if(Date.now()>deadline)throw Error('owned_close_gate_deadline');await Bun.sleep(10);}}});}finally{for(const lease of leases.reverse())lease.release();}`,
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
  'parent SIGKILL releases only parent Windows handles while real child EOF drain keeps EX busy until child exits',
  async () => {
    const f = await nativeFixture();
    let original: ReturnType<typeof originalChildHandle> | undefined;
    try {
      const holder = f.spawn();
      const held = await holder.next('paired-held');
      original = originalChildHandle(held.childPid, f.input.access.bunExecutable);
      f.busy();
      holder.child.kill('SIGKILL');
      await holder.child.exited;
      const deadline = Date.now() + 5000;
      while (!existsSync(f.closing)) {
        if (Date.now() > deadline) throw Error('owned_child_not_draining');
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
    } finally {
      try {
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
