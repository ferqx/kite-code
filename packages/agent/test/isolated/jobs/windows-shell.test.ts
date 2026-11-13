import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleepTimer } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { expect, test } from '#kite-test';
import { spawn as spawnProcess } from '../../../../../scripts/tooling/process';
import { testRuntimeFlags } from '../../../../../scripts/tooling/test-command';
import {
  privateDirectory,
  removeTemporaryDirectory,
  temporaryDirectory,
} from '../../../../../tests/fixtures/test-filesystem';
import type { JobContext, ToolResult } from '../../../src/extensions';
import { JobStartError } from '../../../src/extensions';
import { withBundledRipgrep } from '../../../src/jobs/ripgrep';
import { msysCompatibilityImage } from '../../../src/jobs/windows-git-bash';
import { discoverWindowsPowerShell } from '../../../src/jobs/windows-powershell';
import { createWindowsShellJob } from '../../../src/jobs/windows-shell';
import { retainWindowsOwnedProcessObservation } from '../../../src/platform/process/windows-owned-child';
import { windowsShellFixture } from '../../fixtures/windows-shell-runtime';

const native = process.platform === 'win32' ? test : test.skip;
native(
  'a stalled Windows admission stops within the startup window and a late READY cannot execute',
  () => {
    const ownerModule = fileURLToPath(
      new URL('../../../src/platform/process/windows-owned-child.ts', import.meta.url),
    );
    const jobModule = fileURLToPath(new URL('../../../src/jobs/windows-shell.ts', import.meta.url));
    const code = `import {setTimeout as sleepTimer} from 'node:timers/promises';

import {mock} from '#kite-test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,mkdtempSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const root=mkdtempSync(join(tmpdir(),'kite-windows-admission-'));
const control=join(root,'control');mkdirSync(control);
writeFileSync(join(root,'runner.exe'),'fixture');
const files=['bash.exe','ls.exe','msys-2.0.dll','ktipc.dll'].map(name=>({name:'usr/bin/'+name,
 sourceSha256:createHash('sha256').update('fixture').digest('hex'),sha256:createHash('sha256').update('fixture').digest('hex')}));
for(const base of [root,join(root,'full')]){mkdirSync(join(base,'usr/bin'),{recursive:true});for(const file of files)writeFileSync(join(base,file.name),'fixture');}
writeFileSync(join(root,'manifest.json'),JSON.stringify({identity:createHash('sha256').update(JSON.stringify(files)).digest('hex'),files}));
let request,finish,unblock,lateFrame,closed=0,stopCalls=0;
const writes=[];
const exited=new Promise(resolve=>finish=resolve);
const ready=new Promise(resolve=>unblock=resolve);
const evidence={job:{treeStopped:true},closed:false,closeUnknown:false};
mock.module(${JSON.stringify(ownerModule)},()=>({
 WindowsOwnedChildStartError:class extends Error{},
 startWindowsOwnedChild:()=>({pid:42,exited,
  stdout:(async function*(){await ready;yield lateFrame;})(),
  stderr:(async function*(){})(),
  async writeStdin(bytes){const frame=JSON.parse(Buffer.from(bytes).subarray(4).toString());writes.push(frame.type);
   if(frame.type==='request')request=JSON.parse(Buffer.from(frame.payloadBase64,'base64').toString());
   if(frame.type==='go')writeFileSync(join(root,'unexpected-effect'),'bad');},
  async endStdin(){},
  async stop(){if(stopCalls++===0){
   const payload={invocationName:request.invocationName,runtimeValidated:true};
   const body=Buffer.from(JSON.stringify({type:'ready',version:7,invocationId:request.invocationName,
    peerId:'runner',sequence:0,payloadBase64:Buffer.from(JSON.stringify(payload)).toString('base64')}));
   lateFrame=Buffer.alloc(body.length+4);lateFrame.writeUInt32LE(body.length);body.copy(lateFrame,4);
   unblock();finish(1);
  }return evidence;},
  async close(){closed++;},readEvidence:()=>evidence,
 })
}));
try{
 const {createWindowsShellJob}=await import(${JSON.stringify(jobModule)});
 const job=await createWindowsShellJob({cwd:root,controlBase:control,env:{},stateRoot:root,
  supervisorPath:join(root,'runner.exe'),shellExecutable:join(root,'usr/bin/bash.exe'),
  fullShellExecutable:join(root,'full/usr/bin/bash.exe'),
  executionScope:()=>({filesystem:'workspace_write',network:'none'})});
 const started=Date.now();
 let resolved=false;
 const starting=job.start({command:'printf should-not-run'},{signal:new AbortController().signal,
  executionId:'admission',sessionId:'test'}).then(()=>{resolved=true;throw Error('unconfirmed start returned');},error=>error);
 await sleepTimer(30);assert.equal(resolved,false);assert.deepEqual(writes,['request']);
 const failure=await starting;assert.equal(failure.name,'JobStartError');const handle=failure.handle;
 const events=[];for await(const event of job.observe(handle))events.push(event);
 assert.ok(Date.now()-started<9000,'admission must not hang');
 assert.deepEqual(writes,['request']);assert.equal(existsSync(join(root,'unexpected-effect')),false);
 assert.equal(events.length,1);assert.equal(events[0].type,'terminal');
 assert.equal(events[0].result.outcome,'outcome_unknown');assert.equal(events[0].supervision,'unknown');
 assert.equal(closed,0);assert.equal(readdirSync(control).length,1);
 await assert.rejects(job.dispose(handle),/windows_shell_cleanup_unconfirmed/);
 assert.equal(events.length,1);
}finally{rmSync(root,{recursive:true,force:true});}
`;
    const child = spawnSync(
      process.execPath,
      [...testRuntimeFlags, '--input-type=module-typescript', '--eval', code],
      {
        encoding: 'utf8',
        timeout: 12000,
        windowsHide: true,
      },
    );
    expect({ status: child.status, error: child.error?.message, stderr: child.stderr }).toEqual({
      status: 0,
      error: undefined,
      stderr: '',
    });
  },
  15000,
);
test('MSYS compatibility refuses arbitrary or truncated files without changing the input', () => {
  for (const input of [Buffer.alloc(0), Buffer.from('ntdll.dll\0'.repeat(50)), Buffer.alloc(256)]) {
    const before = Buffer.from(input);
    expect(() => msysCompatibilityImage(input)).toThrow('windows_msys_compatibility_image_invalid');
    expect(input).toEqual(before);
  }
});
native(
  'Windows PowerShell directly owns UTF-8 output, filesystem scope and the original Job',
  async () => {
    const root = temporaryDirectory('kite-windows-powershell-');
    try {
      const workspace = join(root, '中文 工作区');
      const outside = join(root, 'outside');
      const controlBase = join(root, 'control');
      const stateRoot = join(root, 'sandbox');
      for (const directory of [workspace, outside, controlBase, stateRoot])
        privateDirectory(directory);
      const link = join(workspace, 'linked');
      symlinkSync(outside, link, 'junction');
      const powerShell = await discoverWindowsPowerShell();
      const run = async (
        command: string,
        filesystem: 'read_only' | 'workspace_write' | 'full_access',
        cwd = workspace,
      ) => {
        const job = await createWindowsShellJob({
          kind: 'powershell',
          powerShell,
          cwd,
          workspaceRoot: workspace,
          controlBase,
          stateRoot,
          shellExecutable: powerShell.executable.canonical,
          supervisorPath: resolve(
            import.meta.dirname,
            '../../../dist/platform/process/windows-shell/kite-windows-runner.exe',
          ),
          env: { PATH: powerShell.systemDirectory, USERPROFILE: root },
          executionScope: () => ({ filesystem, network: 'none' }),
        });
        const context = {
          executionId: crypto.randomUUID(),
          sessionId: 'powershell',
          signal: AbortSignal.timeout(8000),
        };
        const handle = await job.start({ command }, context as JobContext);
        let result: ToolResult | undefined;
        let output = '';
        for await (const event of job.observe(handle)) {
          if (event.type === 'output' && event.stream === 'stdout') output += event.content;
          if (event.type === 'terminal') result = event.result;
        }
        await job.dispose(handle);
        expect(result?.details).toMatchObject({ cleanupConfirmed: true, processTreeStopped: true });
        expect(readdirSync(controlBase)).toEqual([]);
        return { result, output };
      };
      const wrote = await run(
        "Set-Content -LiteralPath '中文.txt' -Value '你好' -Encoding utf8; rg.exe --no-config '你好' '中文.txt'",
        'workspace_write',
      );
      expect(wrote.result?.outcome).toBe('succeeded');
      expect(wrote.output).toContain('你好');
      const read = await run(
        "Get-Content -LiteralPath '中文.txt'; Set-Content -LiteralPath 'blocked.txt' -Value blocked",
        'read_only',
      );
      expect(read.result?.outcome).toBe('failed');
      expect(read.output).toContain('你好');
      expect(existsSync(join(workspace, 'blocked.txt'))).toBeFalse();
      const junction = await run(
        "Set-Content -LiteralPath 'linked\\blocked.txt' -Value blocked",
        'workspace_write',
      );
      expect(junction.result?.outcome).toBe('failed');
      const relocated = await run(
        "Set-Content -LiteralPath 'blocked.txt' -Value blocked",
        'workspace_write',
        outside,
      );
      expect(relocated.result?.outcome).toBe('failed');
      expect(existsSync(join(outside, 'blocked.txt'))).toBeFalse();
      const approved = await run(
        "Set-Content -LiteralPath 'approved.txt' -Value allowed",
        'full_access',
        outside,
      );
      expect(approved.result?.outcome).toBe('succeeded');
      expect(readFileSync(join(outside, 'approved.txt'), 'utf8').trim()).toBe('allowed');
    } finally {
      removeTemporaryDirectory(root);
    }
  },
  25000,
);
native(
  'Windows unelevated Git Bash runs bundled rg, forks and pipelines with empty ambient PATH while external writes require Full',
  async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'kite-windows-shell-')));
    const cwd = join(root, 'workspace'),
      control = join(root, 'control'),
      privateRoot = join(cwd, 'private');
    for (const path of [cwd, control, privateRoot]) mkdirSync(path);
    writeFileSync(join(cwd, 'source.txt'), 'bundled-rg-needle\n');
    writeFileSync(join(privateRoot, 'secret.txt'), 'private-needle');
    writeFileSync(join(root, 'external.txt'), 'external-needle');
    const runtime = await windowsShellFixture();
    const built = runtime.built;
    const environment = withBundledRipgrep({
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      ),
      PATH: '',
    });
    const execute = async (
      command: string,
      full = false,
      onOutput?: (text: string) => void,
      inheritedEnvironment: Readonly<Record<string, string>> = environment.env,
    ) => {
      const controller = new AbortController();
      const job = await createWindowsShellJob({
        cwd,
        controlBase: control,
        env: inheritedEnvironment,
        supervisorPath: join(built, 'kite-windows-runner.exe'),
        shellExecutable: runtime.shell,
        fullShellExecutable: runtime.fullShell,
        stateRoot: runtime.stateRoot,
        executionScope: () => ({
          filesystem: full ? 'full_access' : 'workspace_write',
          network: full ? 'internet' : 'none',
        }),
      });
      const handle = await job.start({ command }, {
        signal: controller.signal,
        executionId: crypto.randomUUID(),
        sessionId: 's',
      } as JobContext);
      let output = '',
        result: ToolResult | undefined;
      for await (const event of job.observe(handle)) {
        if (event.type === 'output') {
          output += event.content;
          onOutput?.(output);
        }
        if (event.type === 'terminal') result = event.result;
      }
      await job.dispose?.(handle);
      return { output, result, handle };
    };
    try {
      for (const key of ['Path', 'pAtH']) {
        const inherited = Object.fromEntries(
          Object.entries(environment.env).filter(([name]) => name.toUpperCase() !== 'PATH'),
        );
        const pipeline = await execute(
          'set -e -o pipefail; printf case-path | sed s/case/tool/ | tr a-z A-Z > path.txt; cat path.txt',
          false,
          undefined,
          { ...inherited, [key]: '' },
        );
        expect(pipeline.result?.outcome, pipeline.output).toBe('succeeded');
        expect(pipeline.output).toBe('TOOL-PATH');
        expect(readFileSync(join(cwd, 'path.txt'), 'utf8')).toBe('TOOL-PATH');
      }
      const denied = await execute('printf forbidden > ../outside.txt');
      expect(denied.result?.outcome).toBe('failed');
      expect(existsSync(join(root, 'outside.txt'))).toBe(false);
      expect(readdirSync(control)).toEqual([]);
      const cancelledJob = await createWindowsShellJob({
        cwd,
        controlBase: control,
        env: environment.env,
        supervisorPath: runtime.runner,
        shellExecutable: runtime.shell,
        fullShellExecutable: runtime.fullShell,
        stateRoot: runtime.stateRoot,
        executionScope: () => ({ filesystem: 'workspace_write', network: 'none' }),
      });
      const startupAbort = new AbortController();
      const cancelledStart = cancelledJob.start({ command: 'printf forbidden > cancelled.txt' }, {
        signal: startupAbort.signal,
        executionId: crypto.randomUUID(),
        sessionId: 's',
      } as JobContext);
      startupAbort.abort();
      const startFailure = await cancelledStart.catch((error: unknown) => error);
      expect(startFailure).toBeInstanceOf(JobStartError);
      // Cancellation during async verification has not created a native owner.
      expect((startFailure as JobStartError).handle).toBeUndefined();
      expect(readdirSync(control)).toEqual([]);
      expect(existsSync(join(cwd, 'cancelled.txt'))).toBe(false);
      const ordinary = await execute(
        [
          'set -e -o pipefail',
          'for tool in ls cp mv head wc; do test "$(type -P "$tool")" -ef "/usr/bin/$tool.exe"; done',
          'rg --no-config --version',
          'rg --no-config bundled-rg-needle source.txt',
          'cp -- source.txt "中文 copy.txt"',
          'mv -- "中文 copy.txt" "中文 result.txt"',
          'ls -- "中文 result.txt"',
          'test "$(head -n 1 "中文 result.txt" | wc -l)" -eq 1',
          'for i in 1 2 3; do printf "%s\\n" "$i"; done | sed -n 2p',
          'printf workspace-write > written.txt',
        ].join('\n'),
      );
      expect(ordinary.result?.outcome, ordinary.output + JSON.stringify(ordinary.result)).toBe(
        'succeeded',
      );
      expect(ordinary.output).toContain('ripgrep');
      expect(ordinary.output).toContain('bundled-rg-needle');
      expect(ordinary.output).toContain('中文 result.txt');
      expect(readFileSync(join(cwd, '中文 result.txt'), 'utf8')).toBe('bundled-rg-needle\n');
      expect(readFileSync(join(cwd, 'written.txt'), 'utf8')).toBe('workspace-write');
      expect(ordinary.result?.details).toMatchObject({
        cleanupConfirmed: true,
        ownedProcesses: { closed: true, closeUnknown: false },
      });
      expect(ordinary.output).toContain('2\n');
      const absent = await execute('rg --no-config absent-needle source.txt');
      expect(absent.result?.details).toMatchObject({ exitCode: 1, cleanupConfirmed: true });
      expect(absent.output).toBe('');
      const readable = await execute('cat private/secret.txt; cat ../external.txt');
      expect(readable.result?.outcome).toBe('succeeded');
      expect(readable.output).toContain('private-needle');
      expect(readable.output).toContain('external-needle');
      const repo = await execute(
        "set -e; git init -q; git -c alias.kite-check='!printf git-child-shell' kite-check",
      );
      expect(repo.result?.outcome, repo.output + JSON.stringify(repo.result)).toBe('succeeded');
      expect(repo.output).toContain('git-child-shell');
      expect(existsSync(join(cwd, '.git', 'HEAD'))).toBe(true);
      const full = await execute(
        'set -e; test "$(type -P cat)" -ef /usr/bin/cat.exe; cat private/secret.txt; cat ../external.txt; printf full-write > ../outside.txt',
        true,
      );
      expect(full.result?.outcome).toBe('succeeded');
      expect(full.output).toContain('private-needle');
      expect(full.output).toContain('external-needle');
      expect(readFileSync(join(root, 'outside.txt'), 'utf8')).toBe('full-write');
      const narrowed = await execute('printf forbidden > ../outside.txt');
      expect(narrowed.result?.outcome).toBe('failed');
      expect(readFileSync(join(root, 'outside.txt'), 'utf8')).toBe('full-write');
      let release!: () => void;
      const ready = new Promise<void>((resolve) => {
        release = resolve;
      });
      const busyFull = execute(
        'printf full-ready; until test -f parallel-release; do sleep 0.05; done',
        true,
        (output) => {
          if (output.includes('full-ready')) release();
        },
      );
      try {
        await ready;
        const parallel = await execute(
          'printf restricted-parallel; printf release > parallel-release',
        );
        expect(parallel.result?.outcome, parallel.output).toBe('succeeded');
        expect(parallel.output).toBe('restricted-parallel');
      } finally {
        writeFileSync(join(cwd, 'parallel-release'), 'release');
        expect((await busyFull).result?.outcome).toBe('succeeded');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  30000,
);

native(
  'Windows original Job stops nested descendants on host EOF and abrupt host death',
  async () => {
    for (const abrupt of [false, true]) {
      const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'kite-windows-shell-owner-')));
      mkdirSync(join(root, 'workspace'));
      mkdirSync(join(root, 'control'));
      const child = spawnProcess(
        [
          process.execPath,
          ...testRuntimeFlags,
          join(import.meta.dirname, '../../fixtures/windows-shell-owner-child.ts'),
          root,
        ],
        { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      );
      const diagnostics = new Response(child.stderr).text();
      const observations: ReturnType<typeof retainWindowsOwnedProcessObservation>[] = [];
      try {
        const reader = child.stdout.getReader();
        let buffer = '';
        while (!buffer.includes('\n')) {
          const item = await reader.read();
          if (item.done) throw Error(`owner_fixture_not_ready:${await diagnostics}`);
          buffer += new TextDecoder().decode(item.value);
        }
        reader.releaseLock();
        const { pids } = JSON.parse(buffer.split('\n')[0]!) as { pids: number[] };
        expect(pids).toHaveLength(2);
        for (const pid of pids) {
          const observed = retainWindowsOwnedProcessObservation(pid);
          expect(observed.inspect()).toBe('alive');
          observations.push(observed);
        }
        if (abrupt) child.kill('SIGKILL');
        else child.stdin.end();
        await child.exited;
        const deadline = Date.now() + 5000;
        while (observations.some((item) => item.inspect() !== 'dead')) {
          if (Date.now() > deadline) throw Error('owned_descendant_remained_alive');
          await sleepTimer(10);
        }
        expect(observations.map((item) => item.inspect())).toEqual(['dead', 'dead']);
      } finally {
        if (child.exitCode === null) child.kill('SIGKILL');
        await child.exited;
        await diagnostics;
        for (const observation of observations) observation.close();
        rmSync(root, { recursive: true, force: true });
      }
    }
  },
  30000,
);

native(
  'Windows unelevated offline controls constrain ordinary commands without claiming a firewall or expanding network approval into filesystem authority',
  async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'kite-windows-shell-network-')));
    const cwd = join(root, 'workspace'),
      control = join(root, 'control');
    for (const path of [cwd, control]) mkdirSync(path);
    let accepted = 0;
    const { createServer } = await import('node:net');
    const server = createServer((socket) => {
      accepted++;
      socket.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const runtime = await windowsShellFixture();
    const built = runtime.built;
    const env = withBundledRipgrep(
      Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] =>
            typeof entry[1] === 'string' && !/^(all|https?|no)_proxy$/i.test(entry[0]),
        ),
      ),
    ).env;
    const shell = runtime.shell;
    const script = `$c=New-Object Net.Sockets.TcpClient;try{$t=$c.ConnectAsync("127.0.0.1",${port});if(!$t.Wait(1500)){exit 12};if(!$c.Connected){exit 13};exit 0}catch{exit 14}finally{$c.Dispose()}`;
    const powershell = join(
      process.env.SystemRoot!,
      'System32/WindowsPowerShell/v1.0/powershell.exe',
    ).replaceAll('\\', '/');
    try {
      for (const [filesystem, network] of [
        ['workspace_write', 'none'],
        ['full_access', 'none'],
        ['workspace_write', 'internet'],
        ['full_access', 'internet'],
      ] as const) {
        const job = await createWindowsShellJob({
          cwd,
          controlBase: control,
          env,
          supervisorPath: join(built, 'kite-windows-runner.exe'),
          shellExecutable: shell,
          fullShellExecutable: runtime.fullShell,
          stateRoot: runtime.stateRoot,
          executionScope: () => ({ filesystem, network }),
        });
        const started = job.start(
          {
            command:
              network === 'none'
                ? 'printf "%s|%s\\n" "$NPM_CONFIG_OFFLINE" "$CARGO_NET_OFFLINE"; curl --noproxy "" --connect-timeout 2 http://127.0.0.1:' +
                  port
                : `'${powershell}' -NoProfile -NonInteractive -Command '${script}'${filesystem === 'workspace_write' ? '; if (printf forbidden > ../network-outside.txt) 2>/dev/null; then exit 88; fi' : ''}`,
          },
          {
            signal: new AbortController().signal,
            executionId: crypto.randomUUID(),
            sessionId: 's',
          } as JobContext,
        );
        const handle = await started;
        let result: ToolResult | undefined,
          output = '';
        for await (const event of job.observe(handle))
          if (event.type === 'terminal') result = event.result;
          else if (event.type === 'output') output += event.content;
        await job.dispose?.(handle);
        if (network === 'none') {
          expect(result?.outcome).toBe('failed');
          expect(output, JSON.stringify(result)).toContain('true|true');
          expect(accepted).toBe(0);
        } else {
          expect(result?.outcome).toBe('succeeded');
          expect(accepted).toBe(filesystem === 'workspace_write' ? 1 : 2);
          expect(existsSync(join(root, 'network-outside.txt'))).toBe(false);
        }
        expect(readdirSync(control)).toEqual([]);
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  },
  30000,
);

native(
  'Windows cancels Workspace preparation while another owner holds its ACL lock and later executes a compound write',
  async () => {
    const root = temporaryDirectory('kite-windows-shell-preparation-');
    const cwd = join(root, 'workspace'),
      control = join(root, 'control'),
      stateRoot = join(root, 'state'),
      outside = join(root, 'outside');
    for (const path of [cwd, control, stateRoot, outside]) mkdirSync(path);
    writeFileSync(join(outside, 'keep.txt'), 'original');
    symlinkSync(outside, join(cwd, 'outside-link'), 'junction');
    const ready = join(root, 'mutex-ready');
    const canonical = cwd.startsWith('\\\\?\\') ? cwd : `\\\\?\\${cwd}`;
    const mutex = `Local\\KiteCode.RestrictedToken.${createHash('sha256').update(canonical.toLowerCase()).digest('hex')}`;
    const powershell = join(
      process.env.SystemRoot!,
      'System32/WindowsPowerShell/v1.0/powershell.exe',
    );
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    const holder = spawnProcess(
      [
        powershell,
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$m=[Threading.Mutex]::new($false,${quote(mutex)});$null=$m.WaitOne();[IO.File]::WriteAllText(${quote(ready)},'ready');$null=[Console]::ReadLine();$m.ReleaseMutex();$m.Dispose()`,
      ],
      { stdin: 'pipe', stdout: 'ignore', stderr: 'pipe', windowsHide: true },
    );
    const diagnostics = new Response(holder.stderr).text();
    try {
      const deadline = Date.now() + 5000;
      while (!existsSync(ready) && Date.now() < deadline) await sleepTimer(10);
      expect(existsSync(ready)).toBe(true);
      const runtime = await windowsShellFixture();
      const job = await createWindowsShellJob({
        cwd,
        controlBase: control,
        stateRoot,
        env: { SystemRoot: process.env.SystemRoot!, Path: '' },
        supervisorPath: runtime.runner,
        shellExecutable: runtime.shell,
        fullShellExecutable: runtime.fullShell,
        executionScope: () => ({ filesystem: 'workspace_write', network: 'none' }),
      });
      const context = () =>
        ({
          signal: new AbortController().signal,
          executionId: crypto.randomUUID(),
          sessionId: 's',
        }) as JobContext;
      const handle = await job.start(
        { command: 'printf forbidden > should-not-run.txt' },
        context(),
      );
      await sleepTimer(750);
      expect(existsSync(join(cwd, 'should-not-run.txt'))).toBe(false);
      const stopping = job.cancel!(handle);
      let result: ToolResult | undefined;
      for await (const event of job.observe(handle))
        if (event.type === 'terminal') result = event.result;
      expect(await stopping).toEqual({ status: 'stopped' });
      expect(result?.outcome).toBe('cancelled');
      expect(result?.details).toMatchObject({ cleanupConfirmed: true, processTreeStopped: true });
      expect(existsSync(join(cwd, 'should-not-run.txt'))).toBe(false);
      expect(readdirSync(control)).toEqual([]);
      await job.dispose?.(handle);
      holder.stdin.end();
      expect(await holder.exited, await diagnostics).toBe(0);
      const resumed = await job.start(
        {
          command:
            'set -e -o pipefail; printf resumed > written.txt; cat written.txt | sed s/resumed/verified/; if (printf forbidden > outside-link/keep.txt) 2>/dev/null; then exit 99; fi',
        },
        context(),
      );
      let output = '';
      for await (const event of job.observe(resumed)) {
        if (event.type === 'output') output += event.content;
        if (event.type === 'terminal') result = event.result;
      }
      expect(result?.outcome, output).toBe('succeeded');
      expect(output).toBe('verified');
      expect(readFileSync(join(cwd, 'written.txt'), 'utf8')).toBe('resumed');
      expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('original');
      await job.dispose?.(resumed);
    } finally {
      holder.stdin.end();
      holder.kill();
      await holder.exited;
      await diagnostics;
      removeTemporaryDirectory(root);
    }
  },
  20000,
);

native(
  'Windows cancel acknowledges the original owned Job after its background descendant has stopped',
  async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'kite-windows-shell-cancel-')));
    const cwd = join(root, 'workspace'),
      control = join(root, 'control');
    for (const path of [cwd, control]) mkdirSync(path);
    const runtime = await windowsShellFixture();
    const built = runtime.built;
    const job = await createWindowsShellJob({
      cwd,
      controlBase: control,
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      ),
      supervisorPath: join(built, 'kite-windows-runner.exe'),
      shellExecutable: runtime.shell,
      fullShellExecutable: runtime.fullShell,
      stateRoot: runtime.stateRoot,
      executionScope: () => ({ filesystem: 'workspace_write', network: 'none' }),
    });
    try {
      const powershell = join(
        process.env.SystemRoot!,
        'System32/WindowsPowerShell/v1.0/powershell.exe',
      ).replaceAll('\\', '/');
      const script = `$p=Start-Process -FilePath "${powershell}" -ArgumentList "-NoProfile -NonInteractive -Command Start-Sleep -Seconds 60" -PassThru -NoNewWindow;Write-Output child-started;Start-Sleep -Seconds 60`;
      const handle = await job.start(
        { command: `'${powershell}' -NoProfile -NonInteractive -Command '${script}'` },
        {
          signal: new AbortController().signal,
          executionId: crypto.randomUUID(),
          sessionId: 's',
        } as JobContext,
      );
      const events = job.observe(handle)[Symbol.asyncIterator]();
      let started = false,
        result: ToolResult | undefined,
        startupOutput = '';
      while (!started) {
        const item = await events.next();
        if (item.done)
          throw Error(`child_start_missing: ${startupOutput} ${JSON.stringify(result)}`);
        if (item.value.type === 'output') startupOutput += item.value.content;
        if (item.value.type === 'terminal') result = item.value.result;
        started = startupOutput.includes('child-started');
      }
      const cancelled = job.cancel!(handle);
      for (;;) {
        const item = await events.next();
        if (item.done) break;
        if (item.value.type === 'terminal') result = item.value.result;
      }
      expect(await cancelled).toEqual({ status: 'stopped' });
      expect(result?.outcome).toBe('cancelled');
      expect(result?.details).toMatchObject({ cleanupConfirmed: true, processTreeStopped: true });
      await job.dispose?.(handle);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  15000,
);
