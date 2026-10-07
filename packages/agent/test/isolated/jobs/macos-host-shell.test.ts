import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import type { JobDefinition, JobEvent, JobHandle } from '../../../src/extensions';
import { launchIdentity } from '../../../src/jobs/launch-identity';
import { createMacosHostShellJob } from '../../../src/jobs/shell';
import { removeLaunchdRegistration } from '../../../src/platform/process/darwin-launchd-supervisor';

const macTest = process.platform === 'darwin' ? test : test.skip;
let root: string;
let workspace: string;
let control: string;
let assets: string;
let tempBase: string;
let guardian: string;
let tree: string;
const source = `
#include <unistd.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
int main(int argc,char **argv) {
  if(argc!=3)return 90; alarm(12);
  pid_t child=fork(); if(child<0)return 91;
  if(child==0) {
    if(setsid()<0)_exit(92);signal(SIGTERM,SIG_IGN);
    pid_t grand=fork();if(grand<0)_exit(93);
    if(grand==0){alarm(12);close(0);close(1);close(2);for(;;)pause();}
    FILE *f=fopen(argv[2],"w");if(!f)_exit(94);
    fprintf(f,"%d %d %d",getpid(),grand,getsid(0));fclose(f);
    close(0);close(1);close(2);for(;;)pause();
  }
  for(int i=0;i<100 && access(argv[2],F_OK);i++)usleep(10000);
  if(access(argv[2],F_OK))return 95;
  printf("root=%d child=%d\\n",getpid(),child);fflush(stdout);
  if(!strcmp(argv[1],"natural"))return 0;
  signal(SIGTERM,SIG_IGN);for(;;)pause();
}
`;
beforeAll(async () => {
  if (process.platform !== 'darwin') return;
  root = realpathSync.native(mkdtempSync('/private/tmp/kite-host-shell-'));
  workspace = join(root, 'workspace');
  control = join(root, 'control');
  assets = join(root, 'assets');
  tempBase = join(root, 'temp');
  for (const path of [
    workspace,
    control,
    assets,
    tempBase,
    join(root, 'private'),
    join(root, 'home'),
  ])
    mkdirSync(path, { mode: 0o700 });
  writeFileSync(join(root, 'outside'), 'broad host read');
  writeFileSync(join(root, 'private', 'secret'), 'private');
  writeFileSync(join(workspace, 'tree.c'), source);
  tree = join(workspace, 'tree');
  const compiler = Bun.spawn(
    ['/usr/bin/clang', '-Wall', '-Wextra', '-Werror', join(workspace, 'tree.c'), '-o', tree],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const errors = await new Response(compiler.stderr).text();
  await new Response(compiler.stdout).text();
  expect(await compiler.exited, errors).toBe(0);
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, '../../../src/platform/process/shell-supervisor.ts')],
    outdir: assets,
    target: 'bun',
    naming: 'guardian.js',
  });
  expect(built.success).toBe(true);
  guardian = join(assets, 'guardian.js');
});
macTest(
  'exact launchd absence confirms cleanup even when the original label was already removed',
  async () => {
    const path = mkdtempSync(join(control, 'registration-'));
    const registration = {
      secret: randomUUID(),
      label: `com.kitecode.shell.${randomUUID()}`,
      domain: `user/${process.getuid!()}`,
      root: launchIdentity(path),
    };
    const target = `${registration.domain}/${registration.label}`;
    const plist = join(path, 'job.plist');
    writeFileSync(
      plist,
      `<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>${registration.label}</string><key>ProgramArguments</key><array><string>/usr/bin/true</string></array><key>ProcessType</key><string>Background</string><key>LimitLoadToSessionType</key><string>Background</string><key>RunAtLoad</key><true/></dict></plist>`,
      { mode: 0o600 },
    );
    const invoke = async (...args: string[]) => {
      const child = Bun.spawn(['/bin/launchctl', ...args], {
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'ignore',
      });
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
      try {
        return await child.exited;
      } finally {
        clearTimeout(timer);
      }
    };
    try {
      expect(await invoke('bootstrap', registration.domain, plist)).toBe(0);
      expect(await invoke('print', target)).toBe(0);
      expect(await invoke('bootout', target)).toBe(0);
      expect(await invoke('print', target)).toBe(113);
      await removeLaunchdRegistration(registration);
      expect(existsSync(path)).toBe(false);
    } finally {
      if (existsSync(path)) await removeLaunchdRegistration(registration);
    }
  },
  10_000,
);
afterAll(() => {
  if (
    root &&
    existsSync(control) &&
    readdirSync(control).length === 0 &&
    readdirSync(tempBase).length === 0
  )
    rmSync(root, { recursive: true, force: true });
});
function quote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
function options(full = false) {
  return {
    cwd: workspace,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: join(root, 'home') },
    supervisorPath: guardian,
    controlBase: control,
    protectedRoots: [join(root, 'private')],
    runtimeReadOnlyRoots: [
      dirname(process.execPath),
      ...[Bun.which('node')]
        .filter((path): path is string => path !== null)
        .map((path) => dirname(realpathSync.native(path))),
    ],
    temporaryRoot: tempBase,
    filesystemScope: full ? ('full_access' as const) : ('workspace_write' as const),
  };
}
function start(job: JobDefinition, command: string) {
  return job.start(
    { command },
    { sessionId: 'owned', executionId: crypto.randomUUID(), signal: new AbortController().signal },
  );
}
async function collect(job: JobDefinition, handle: JobHandle) {
  const events: JobEvent[] = [];
  for await (const event of job.observe(handle)) events.push(event);
  return events;
}
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function until(condition: () => boolean) {
  const deadline = Date.now() + 2500;
  while (!condition()) {
    if (Date.now() > deadline) throw Error('host_shell_deadline');
    await Bun.sleep(10);
  }
}
async function run(job: JobDefinition, command: string) {
  const handle = await start(job, command);
  try {
    return await collect(job, handle);
  } finally {
    await job.dispose(handle);
  }
}
function terminal(events: JobEvent[]) {
  const values = events.filter((event) => event.type === 'terminal');
  expect(values).toHaveLength(1);
  expect(values[0]).toMatchObject({
    supervision: 'ended',
    result: { details: { groupStopped: true, processTreeStopped: true } },
  });
  return values[0]!;
}

macTest(
  'host tools fork normally; broad readonly host/Home, workspace writes and private/Unix boundaries are actual OS rules',
  async () => {
    const job = createMacosHostShellJob(options());
    const events = await run(
      job,
      `printf '%s|' "$HOME"; /bin/cat ${quote(join(root, 'outside'))}; printf ok > workspace-effect; /bin/cat ${quote(join(root, 'private', 'secret'))}; printf bad > ${quote(join(root, 'outside'))}; ${quote(process.execPath)} -e 'const p=Bun.spawn(["/bin/echo","child-tool"],{stdout:"inherit",stderr:"inherit"});await p.exited;console.log("bun-tool")'`,
    );
    terminal(events);
    const output = events
      .filter((event) => event.type === 'output')
      .map((event) => event.content)
      .join('');
    expect(
      events
        .filter((event) => event.type === 'output')
        .filter((event) => event.stream === 'stdout')
        .map((event) => event.content)
        .join(''),
    ).toContain(`${join(root, 'home')}|broad host read`);
    expect(output).toContain('child-tool');
    expect(output).toContain('bun-tool');
    expect(output).toContain('Operation not permitted');
    expect(readFileSync(join(root, 'outside'), 'utf8')).toBe('broad host read');
    expect(readFileSync(join(workspace, 'workspace-effect'), 'utf8')).toBe('ok');
    expect(readdirSync(control)).toEqual([]);
    expect(readdirSync(tempBase)).toEqual([]);
  },
);

macTest(
  'approved ordinary host Shell reaches actual IP networking and cannot connect to a host Unix socket',
  async () => {
    let tcpAccepted = 0,
      unixAccepted = 0;
    const tcp = createServer((socket) => {
      tcpAccepted++;
      socket.end('ip-ok');
    });
    const unix = createServer((socket) => {
      unixAccepted++;
      socket.end('unix-must-not');
    });
    const socketPath = join(root, 'host.sock');
    await new Promise<void>((resolve) => tcp.listen(0, '127.0.0.1', resolve));
    await new Promise<void>((resolve) => unix.listen(socketPath, resolve));
    try {
      const address = tcp.address();
      if (!address || typeof address === 'string') throw Error('test_tcp_address');
      const positive = Bun.spawn(
        [
          process.execPath,
          '-e',
          `import{createConnection}from'node:net';await new Promise((r,j)=>{const c=createConnection(${JSON.stringify(socketPath)});c.on('data',b=>process.stdout.write(b));c.on('end',r);c.on('error',j)})`,
        ],
        { stdout: 'pipe', stderr: 'pipe' },
      );
      const [positiveExit, positiveOutput, positiveError] = await Promise.all([
        positive.exited,
        new Response(positive.stdout).text(),
        new Response(positive.stderr).text(),
      ]);
      expect(positiveExit, positiveError).toBe(0);
      expect(positiveOutput).toBe('unix-must-not');
      expect(unixAccepted).toBe(1);
      const script = `import{createConnection}from'node:net';await new Promise((r,j)=>{const c=createConnection({host:'127.0.0.1',port:${address.port}});c.on('data',b=>process.stdout.write(b));c.on('end',r);c.on('error',j)});await new Promise(r=>{const c=createConnection(${JSON.stringify(socketPath)});c.on('connect',()=>{console.log('UNIX_ACCEPTED');c.end();r()});c.on('error',e=>{console.log('unix-denied:'+e.code);r()})})`;
      const events = await run(
        createMacosHostShellJob(options()),
        `exec ${quote(process.execPath)} -e ${quote(script)}`,
      );
      terminal(events);
      const output = events
        .filter((event) => event.type === 'output')
        .map((event) => event.content)
        .join('');
      expect(output).toContain('ip-ok');
      expect(output).toMatch(/unix-denied:(EPERM|EACCES|ECONNREFUSED)/);
      expect(output).not.toContain('UNIX_ACCEPTED');
      expect(tcpAccepted).toBe(1);
      expect(unixAccepted).toBe(1);
    } finally {
      await Promise.all([
        new Promise<void>((resolve) => tcp.close(() => resolve())),
        new Promise<void>((resolve) => unix.close(() => resolve())),
      ]);
    }
  },
);

macTest(
  'Full cannot expose private data or modify an asset by renaming their ancestor',
  async () => {
    const parent = join(root, 'rename-parent');
    const secret = join(parent, 'private');
    const runtime = join(parent, 'runtime');
    const moved = join(workspace, 'renamed-parent');
    mkdirSync(secret, { recursive: true, mode: 0o700 });
    mkdirSync(runtime, { mode: 0o700 });
    writeFileSync(join(secret, 'secret'), 'ancestor-private-marker');
    writeFileSync(join(runtime, 'asset'), 'original asset');
    try {
      const events = await run(
        createMacosHostShellJob({
          ...options(true),
          protectedRoots: [secret],
          readonlyAssets: [runtime],
        }),
        `/bin/mv ${quote(parent)} ${quote(moved)}; /bin/cat ${quote(join(moved, 'private', 'secret'))}; printf bad > ${quote(join(moved, 'runtime', 'asset'))}`,
      );
      terminal(events);
      expect(existsSync(parent)).toBe(true);
      expect(existsSync(moved)).toBe(false);
      expect(readFileSync(join(runtime, 'asset'), 'utf8')).toBe('original asset');
      expect(
        events
          .filter((event) => event.type === 'output')
          .map((event) => event.content)
          .join(''),
      ).not.toContain('ancestor-private-marker');
    } finally {
      if (existsSync(moved)) renameSync(moved, parent);
      rmSync(parent, { recursive: true, force: true });
    }
  },
);

macTest(
  'a Full command cannot hardlink an asset or private secret into the writable Workspace',
  async () => {
    const before = readFileSync(guardian);
    const linked = join(workspace, 'guardian-link');
    try {
      const events = await run(
        createMacosHostShellJob(options(true)),
        `/bin/ln ${quote(guardian)} ${quote(linked)}; printf bad > ${quote(linked)}; /bin/ln ${quote(join(root, 'private', 'secret'))} private-link; /bin/cat private-link`,
      );
      terminal(events);
      expect(readFileSync(guardian)).toEqual(before);
      expect(existsSync(join(workspace, 'private-link'))).toBe(false);
      expect(
        events.some(
          (event) => event.type === 'output' && event.content.includes('Operation not permitted'),
        ),
      ).toBe(true);
    } finally {
      writeFileSync(guardian, before);
    }
  },
);

macTest(
  'Full scope permits actual outside write while the host private control and runtime assets remain protected',
  async () => {
    const job = createMacosHostShellJob(options(true));
    const outside = join(root, 'full-effect');
    const before = readFileSync(guardian);
    const events = await run(
      job,
      `printf full > ${quote(outside)}; printf bad > ${quote(guardian)}; /bin/cat ${quote(join(root, 'private', 'secret'))}`,
    );
    terminal(events);
    expect(readFileSync(outside, 'utf8')).toBe('full');
    expect(readFileSync(guardian)).toEqual(before);
    expect(
      events.some(
        (event) => event.type === 'output' && event.content.includes('Operation not permitted'),
      ),
    ).toBe(true);
  },
);

macTest(
  'natural root exit retains fork/setsid/orphan children until the original complete coalition has stopped',
  async () => {
    const job = createMacosHostShellJob(options());
    const pidFile = join(workspace, 'natural-pids');
    const events = await run(job, `exec ${quote(tree)} natural ${quote(pidFile)}`);
    const pids = readFileSync(pidFile, 'utf8').split(' ').map(Number);
    expect(pids[0]).toBe(pids[2]);
    expect(terminal(events)).toMatchObject({
      result: { outcome: 'succeeded', details: { forced: true } },
    });
    await until(() => !alive(pids[0]!) && !alive(pids[1]!));
    expect(readdirSync(control)).toEqual([]);
  },
);

macTest(
  'cancel joins one complete stop, forces TERM-ignoring detached descendants and leaves a foreign process alive',
  async () => {
    const job = createMacosHostShellJob(options());
    const pidFile = join(workspace, 'cancel-pids');
    const foreign = Bun.spawn(
      [process.execPath, '-e', 'setTimeout(()=>process.exit(0),10000);setInterval(()=>{},1000)'],
      { stdout: 'ignore', stderr: 'ignore' },
    );
    let handle: JobHandle | undefined;
    try {
      handle = await start(job, `exec ${quote(tree)} hold ${quote(pidFile)}`);
      const collected = collect(job, handle);
      await until(() => existsSync(pidFile));
      const stops = await Promise.all([job.cancel(handle), job.cancel(handle)]);
      expect(stops.map((value) => value.status)).toEqual(['stopped', 'stopped']);
      expect(terminal(await collected)).toMatchObject({
        result: { outcome: 'cancelled', details: { forced: true } },
      });
      const pids = readFileSync(pidFile, 'utf8').split(' ').map(Number);
      await until(() => !alive(pids[0]!) && !alive(pids[1]!));
      expect(foreign.exitCode).toBeNull();
      expect((await job.cancel(handle)).status).toBe('already_finished');
      expect(readdirSync(control)).toEqual([]);
    } finally {
      if (handle) await job.dispose(handle);
      foreign.kill('SIGKILL');
      await foreign.exited;
    }
  },
);

macTest(
  'private launchd IPC works beyond sockaddr_un path length and slow observation preserves actual byte gaps',
  async () => {
    const longControl = join(control, 'x'.repeat(80));
    mkdirSync(longControl, { mode: 0o700 });
    const job = createMacosHostShellJob({
      ...options(),
      controlBase: longControl,
      maxQueuedBytes: 1024,
    });
    try {
      const events = await run(
        job,
        `exec ${quote(process.execPath)} -e 'process.stdout.write("字".repeat(100000));process.stderr.write("err")'`,
      );
      terminal(events);
      expect(
        events.some(
          (event) =>
            event.type === 'output_dropped' &&
            event.stream === 'stdout' &&
            BigInt(event.bytes) > 0n,
        ),
      ).toBe(true);
      expect(readdirSync(longControl)).toEqual([]);
    } finally {
      rmSync(longControl, { recursive: true });
    }
  },
);

for (const mode of ['eof', 'kill'] as const)
  macTest(
    `actual parent ${mode} cleans detached descendants, private temp and only its launchd registration`,
    async () => {
      const pidFile = join(workspace, `parent-${mode}-pids`);
      const readyFile = join(workspace, `parent-${mode}-ready`);
      const fixture = join(assets, `parent-${mode}.js`);
      writeFileSync(
        fixture,
        `import {createMacosHostShellJob} from ${JSON.stringify(join(import.meta.dir, '../../../src/jobs/shell.ts'))};const job=createMacosHostShellJob(${JSON.stringify(options())});const h=await job.start({command:${JSON.stringify(`exec ${quote(tree)} hold ${quote(pidFile)}`)}},{sessionId:'owned',executionId:'parent',signal:new AbortController().signal});await Bun.write(${JSON.stringify(readyFile)},JSON.stringify(h.reference));process.stdin.resume();process.stdin.on('end',()=>process.exit(0));setTimeout(()=>process.exit(3),10000);for await(const event of job.observe(h)){};`,
      );
      const parent = Bun.spawn([process.execPath, fixture], {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      try {
        await until(() => existsSync(readyFile) && existsSync(pidFile));
        const reference = JSON.parse(readFileSync(readyFile, 'utf8'));
        expect(reference.coalitionId).toMatch(/^[1-9][0-9]*$/);
        const pids = readFileSync(pidFile, 'utf8').split(' ').map(Number);
        if (mode === 'eof') parent.stdin.end();
        else parent.kill('SIGKILL');
        await parent.exited;
        try {
          await until(
            () =>
              !alive(pids[0]!) &&
              !alive(pids[1]!) &&
              readdirSync(control).length === 0 &&
              readdirSync(tempBase).length === 0,
          );
        } catch (cause) {
          const state = {
            stage: 'host_shell_parent_cleanup_unconfirmed',
            mode,
            root,
            coalitionId: reference.coalitionId,
            pids: pids.slice(0, 2).map((pid) => ({ pid, alive: alive(pid) })),
            control: readdirSync(control),
            temporary: readdirSync(tempBase),
          };
          const snapshot = spawnSync(
            '/bin/ps',
            ['-p', pids.slice(0, 2).join(','), '-o', 'pid=,ppid=,stat=,comm='],
            { encoding: 'utf8', timeout: 500, maxBuffer: 8192 },
          );
          console.error(
            JSON.stringify({
              ...state,
              processSnapshot: snapshot.status === 0 ? snapshot.stdout : null,
              snapshotCode: snapshot.status,
            }),
          );
          throw cause;
        }
        expect(readdirSync(control)).toEqual([]);
      } finally {
        parent.kill('SIGKILL');
        await parent.exited;
      }
    },
  );
