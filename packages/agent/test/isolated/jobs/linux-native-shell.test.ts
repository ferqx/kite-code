import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
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
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { JobDefinition, JobEvent, JobHandle } from '@kite-ai/agent/extensions';
import {
  createLinuxConfinedShellJob,
  createLinuxHostShellJob,
  decodeLinuxShellProcessEvidence,
} from '@kite-ai/agent/jobs/shell';
import { privateDirectory } from '../../../../../tests/fixtures/test-filesystem';

const linuxTest = process.platform === 'linux' ? test : test.skip;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const treeSource = `#include <unistd.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
int main(int argc,char **argv) {
  if(argc!=3) { return 90; }
  alarm(15);
  pid_t child=fork();
  if(child<0) { return 91; }
  if(child==0) {
    if(setsid()<0) { _exit(92); }
    signal(SIGTERM,SIG_IGN);
    pid_t grand=fork();
    if(grand<0) { _exit(93); }
    if(grand==0) { close(0);close(1);close(2);for(;;) { pause(); } }
    FILE*f=fopen(argv[2],"w");
    if(!f) { _exit(94); }
    fprintf(f,"%d %d",getpid(),grand);
    if(fclose(f)) { _exit(95); }
    close(0);close(1);close(2);
    for(;;) { pause(); }
  }
  for(int i=0;i<200&&access(argv[2],F_OK);i++) { usleep(10000); }
  if(access(argv[2],F_OK)) { return 96; }
  puts("FULL_ROOT_OUTPUT");fflush(stdout);
  if(argv[1][0]=='n') { return 0; }
  signal(SIGTERM,SIG_IGN);
  for(;;) { pause(); }
}
`;
async function fixture(run: (f: ReturnType<typeof setup>) => Promise<void>) {
  const f = setup();
  let completed = false;
  try {
    await run(f);
    completed = true;
  } finally {
    if (completed) rmSync(f.root, { recursive: true, force: true });
    else console.error('LINUX_SHELL_FAILURE_ROOT', f.root);
  }
}
function setup() {
  const cc = Bun.which('cc'),
    bwrap = Bun.which('bwrap');
  if (!cc || !bwrap) throw Error('linux_native_shell_required_tools_missing');
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'kite-linux-native-shell-')));
  const workspace = join(root, 'workspace'),
    assets = join(root, 'assets'),
    profile = join(root, 'profile'),
    control = join(profile, '.coordination', 'instance'),
    temporaryRoot = join(root, 'temp');
  for (const path of [workspace, assets, control, temporaryRoot]) privateDirectory(path);
  const init = join(assets, 'init'),
    tree = join(workspace, 'tree');
  const compile = (source: string, output: string) => {
    const result = spawnSync(
      cc,
      ['-std=c11', '-D_DEFAULT_SOURCE', '-O2', '-Wall', '-Wextra', '-Werror', source, '-o', output],
      { encoding: 'utf8', timeout: 10000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  };
  compile(join(import.meta.dir, '../../../native/linux-shell-init.c'), init);
  const source = join(workspace, 'tree.c');
  writeFileSync(source, treeSource);
  compile(source, tree);
  writeFileSync(join(profile, 'secret'), 'PROFILE_SECRET');
  writeFileSync(join(control, 'secret'), 'COORD_SECRET');
  const outside = join(root, 'outside');
  writeFileSync(outside, 'OUTSIDE_SECRET');
  return {
    root,
    workspace,
    assets,
    profile,
    control,
    temporaryRoot,
    tree,
    outside,
    options: {
      cwd: workspace,
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
      bubblewrapPath: realpathSync.native(bwrap),
      linux: { bubblewrapPath: realpathSync.native(bwrap), initExecutable: init },
      shellExecutable: '/bin/sh',
      bunExecutable: realpathSync.native(process.execPath),
      protectedRoots: [profile, control],
      readonlyAssets: [assets],
      runtimeReadOnlyRoots: [dirname(realpathSync.native(process.execPath))],
      temporaryRoot,
      graceMs: 100,
    },
  };
}
async function start(job: JobDefinition, command: string) {
  return job.start(
    { command },
    {
      sessionId: 'linux-native',
      executionId: crypto.randomUUID(),
      signal: new AbortController().signal,
    },
  );
}
function content(events: JobEvent[]) {
  return events
    .filter((e) => e.type === 'output')
    .map((e) => e.content)
    .join('');
}
function ended(events: JobEvent[], handle: JobHandle, outcome: 'succeeded' | 'cancelled') {
  const terminals = events.filter((e) => e.type === 'terminal');
  expect(terminals).toHaveLength(1);
  const terminal = terminals[0]!;
  if (terminal.type !== 'terminal') throw Error('linux_shell_terminal_missing');
  expect(terminal.supervision).toBe('ended');
  expect(terminal.result.outcome).toBe(outcome);
  const ref = handle.reference as unknown as { nonce: string; executionId: string };
  const evidence = decodeLinuxShellProcessEvidence(
    (terminal.result.details as Record<string, unknown>).ownedProcesses,
    { sessionId: 'linux-native', executionId: ref.executionId, nonce: ref.nonce },
    process.pid,
  );
  expect(evidence).toBeDefined();
  expect(evidence?.owner).toMatchObject({
    phase: 'terminal',
    fdClosed: true,
    closeUnknown: false,
    wrapper: { closed: true, stdoutEof: true, stderrEof: true, exit: { code: 0, signal: null } },
    namespace: {
      treeStopped: true,
      init: { dead: true },
      root: { dead: true, waitReceipt: { reaped: true } },
    },
  });
}
async function run(job: JobDefinition, command: string) {
  const handle = await start(job, command),
    events: JobEvent[] = [];
  try {
    for await (const event of job.observe(handle)) events.push(event);
    return { handle, events };
  } finally {
    await job.dispose(handle);
  }
}
linuxTest(
  'ordinary Full writes Profile, control and runtime data without implicit path masks while exact executables stay verified',
  () =>
    fixture(async (f) => {
      const controlFile = join(f.control, 'approved-full-effect');
      const runtimeFile = join(f.assets, 'approved-full-effect');
      const profileFile = join(f.profile, 'approved-full-effect');
      const result = await run(
        createLinuxHostShellJob({
          ...f.options,
          controlBase: f.control,
          protectedRoots: [],
          readonlyAssets: [],
          runtimeReadOnlyRoots: [],
          filesystemScope: 'full_access',
        }),
        `printf control > ${quote(controlFile)}; printf runtime > ${quote(runtimeFile)}; printf profile > ${quote(profileFile)}; cat ${quote(join(f.profile, 'secret'))}`,
      );
      ended(result.events, result.handle, 'succeeded');
      expect(readFileSync(controlFile, 'utf8')).toBe('control');
      expect(readFileSync(runtimeFile, 'utf8')).toBe('runtime');
      expect(readFileSync(profileFile, 'utf8')).toBe('profile');
      expect(content(result.events)).toContain('PROFILE_SECRET');
      expect(readdirSync(f.temporaryRoot)).toEqual([]);
    }),
  45000,
);
linuxTest(
  'private Codex directories preserve real Workspace and Full effects while auth rotates outside the running namespace',
  () =>
    fixture(async (f) => {
      for (const [index, home] of [
        join(f.root, 'missing-parent', 'codex-home'),
        join(f.workspace, '.codex'),
      ].entries()) {
        const auth = join(home, 'auth.json');
        for (const scope of ['workspace_write', 'full_access'] as const) {
          const existed = existsSync(home);
          if (existed) chmodSync(home, 0o750);
          const job = createLinuxHostShellJob({
            ...f.options,
            protectedFiles: [auth],
            filesystemScope: scope,
          });
          // Factory/Run preparation is readonly, including absent parents.
          expect(existsSync(home)).toBe(existed);
          const marker = `${index}-${scope}`;
          const ready = join(f.workspace, `${marker}-ready`);
          const release = join(f.workspace, `${marker}-release`);
          const written = join(f.workspace, `${marker}-written`);
          const external = join(f.root, `${marker}-external`);
          const handle = await start(
            job,
            `printf ready > ${quote(ready)}; while [ ! -f ${quote(release)} ]; do if cat ${quote(auth)} 2>/dev/null; then exit 31; fi; sleep 0.01; done; if printf overwrite > ${quote(auth)}; then exit 32; fi; if mv ${quote(home)} ${quote(`${home}-moved`)}; then exit 33; fi; printf WORKSPACE_OK > ${quote(written)}; if printf FULL_OK > ${quote(external)}; then printf EXTERNAL_ALLOWED; else printf EXTERNAL_DENIED; fi; printf PRIVATE_DIRECTORY_OK`,
          );
          const events: JobEvent[] = [];
          let finished = false;
          try {
            expect(lstatSync(home).mode & 0o777).toBe(existed ? 0o750 : 0o700);
            expect(existsSync(auth)).toBe(existed);
            const deadline = Date.now() + 5000;
            while (!existsSync(ready) && Date.now() < deadline) await Bun.sleep(10);
            expect(existsSync(ready)).toBe(true);
            for (let rotation = 0; rotation < 4; rotation++) {
              const next = join(home, 'next-auth');
              writeFileSync(next, `SYNTHETIC_AUTH_ROTATION_${rotation}`, { mode: 0o600 });
              renameSync(next, auth);
              await Bun.sleep(25);
            }
            writeFileSync(release, 'continue');
            for await (const event of job.observe(handle)) events.push(event);
            finished = true;
            ended(events, handle, 'succeeded');
            expect(content(events)).toContain('PRIVATE_DIRECTORY_OK');
            expect(content(events)).not.toContain('SYNTHETIC_AUTH');
            expect(content(events)).toContain(
              scope === 'full_access' ? 'EXTERNAL_ALLOWED' : 'EXTERNAL_DENIED',
            );
            expect(readFileSync(written, 'utf8')).toBe('WORKSPACE_OK');
            expect(existsSync(external)).toBe(scope === 'full_access');
            if (scope === 'full_access') expect(readFileSync(external, 'utf8')).toBe('FULL_OK');
            expect(readFileSync(auth, 'utf8')).toBe('SYNTHETIC_AUTH_ROTATION_3');
            expect(lstatSync(home).mode & 0o777).toBe(existed ? 0o750 : 0o700);
            expect(readdirSync(f.temporaryRoot)).toEqual([]);
          } finally {
            if (!finished) await job.cancel(handle);
            await job.dispose(handle);
          }
        }
      }
    }),
  45000,
);
linuxTest(
  'a verified readonly Skill projection inside the private directory exposes its original source while credentials stay masked',
  () =>
    fixture(async (f) => {
      const home = join(f.profile, 'codex-home');
      const source = join(home, 'skills', 'original');
      mkdirSync(source, { recursive: true, mode: 0o700 });
      const auth = join(home, 'auth.json');
      const original = join(source, 'source.txt');
      writeFileSync(auth, 'SYNTHETIC_PROJECTED_AUTH');
      writeFileSync(original, 'VERIFIED_SOURCE');
      const result = await run(
        createLinuxHostShellJob({
          ...f.options,
          cwd: source,
          workspaceRoot: f.workspace,
          controlBase: f.control,
          readOnlySourceRoot: source,
          protectedFiles: [auth],
          filesystemScope: 'full_access',
        }),
        `cat ${quote(original)}; if cat ${quote(auth)} ${quote(join(f.profile, 'secret'))}; then exit 31; fi; if printf changed > ${quote(original)}; then exit 32; fi; printf WORKSPACE_OK > ${quote(join(f.workspace, 'projection-written'))}; printf VERIFIED_PROJECTION_OK`,
      );
      ended(result.events, result.handle, 'succeeded');
      expect(content(result.events)).toContain('VERIFIED_SOURCE');
      expect(content(result.events)).toContain('VERIFIED_PROJECTION_OK');
      expect(content(result.events)).not.toContain('SYNTHETIC_PROJECTED_AUTH');
      expect(content(result.events)).not.toContain('PROFILE_SECRET');
      expect(readFileSync(original, 'utf8')).toBe('VERIFIED_SOURCE');
      expect(readFileSync(join(f.workspace, 'projection-written'), 'utf8')).toBe('WORKSPACE_OK');
      expect(readdirSync(f.temporaryRoot)).toEqual([]);
    }),
  45000,
);
linuxTest(
  'installed-style host scopes protect Profile and nested coordination while preserving Full/Workspace and natural escaped-child cleanup',
  () =>
    fixture(async (f) => {
      const target = join(f.root, 'outside-write');
      for (const scope of ['workspace_write', 'full_access'] as const) {
        const job = createLinuxHostShellJob({ ...f.options, filesystemScope: scope });
        const result = await run(
          job,
          `printf allowed > ${quote(join(f.workspace, 'written'))}; if printf outside > ${quote(target)}; then printf OUTSIDE_WRITE; else printf OUTSIDE_DENIED; fi; if cat ${quote(join(f.profile, 'secret'))} ${quote(join(f.control, 'secret'))}; then exit 31; fi; if mv ${quote(f.profile)} ${quote(`${f.profile}-moved`)}; then exit 32; fi; if mv ${quote(f.root)} ${quote(`${f.root}-moved`)}; then exit 33; fi; printf PRIVATE_GUARD_DONE`,
        );
        ended(result.events, result.handle, 'succeeded');
        expect(content(result.events)).toContain(
          scope === 'full_access' ? 'OUTSIDE_WRITE' : 'OUTSIDE_DENIED',
        );
        expect(content(result.events)).not.toContain('PROFILE_SECRET');
        expect(content(result.events)).not.toContain('COORD_SECRET');
        expect(content(result.events)).toContain('PRIVATE_GUARD_DONE');
      }
      expect(readFileSync(target, 'utf8')).toBe('outside');
      const result = await run(
        createLinuxHostShellJob({ ...f.options, filesystemScope: 'workspace_write' }),
        `exec ${quote(f.tree)} natural ${quote(join(f.workspace, 'natural-pids'))}`,
      );
      ended(result.events, result.handle, 'succeeded');
      expect(content(result.events)).toContain('FULL_ROOT_OUTPUT');
      expect(readdirSync(f.temporaryRoot)).toEqual([]);
    }),
  45000,
);
linuxTest(
  'cancel preserves original complete output and actual namespace ended receipt before disposing temp',
  () =>
    fixture(async (f) => {
      const job = createLinuxHostShellJob({ ...f.options, filesystemScope: 'workspace_write' });
      const handle = await start(
        job,
        `printf BEFORE_CANCEL; exec ${quote(f.tree)} hold ${quote(join(f.workspace, 'cancel-pids'))}`,
      );
      const events: JobEvent[] = [];
      let cancelled = false;
      try {
        for await (const event of job.observe(handle)) {
          events.push(event);
          if (!cancelled && content(events).includes('FULL_ROOT_OUTPUT')) {
            cancelled = true;
            expect(await job.cancel(handle)).toEqual({ status: 'stopped' });
          }
        }
        expect(cancelled).toBe(true);
        expect(content(events)).toBe('BEFORE_CANCELFULL_ROOT_OUTPUT\n');
        expect(content(events)).toContain('FULL_ROOT_OUTPUT');
        ended(events, handle, 'cancelled');
        expect(readdirSync(f.temporaryRoot)).toEqual([]);
      } finally {
        await job.dispose(handle);
      }
    }),
  45000,
);
linuxTest(
  'fixed compensation writes Workspace and reads sealed data while denying foreign reads/network/fork and temp native execution',
  () =>
    fixture(async (f) => {
      let accepts = 0;
      const server = createServer((socket) => {
        accepts++;
        socket.destroy();
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw Error('linux_probe_listener');
      try {
        const script = join(f.assets, 'probe.js');
        writeFileSync(
          script,
          `import {readFileSync,writeFileSync,chmodSync} from 'node:fs';import {connect} from 'node:net';import {dlopen,FFIType,ptr,toArrayBuffer} from 'bun:ffi';
const libc=dlopen('libc.so.6',{fork:{args:[],returns:FFIType.i32},_exit:{args:[FFIType.i32],returns:FFIType.void},execve:{args:[FFIType.ptr,FFIType.ptr,FFIType.ptr],returns:FFIType.i32},__errno_location:{args:[],returns:FFIType.ptr}});
if(readFileSync(${JSON.stringify(join(f.assets, 'sealed'))},'utf8')!=='SEALED')throw Error('sealed_read');writeFileSync(${JSON.stringify(join(f.workspace, 'compensated'))},'WORKSPACE_WRITE');
let denied=false;try{readFileSync(${JSON.stringify(f.outside)});}catch{denied=true;}if(!denied)throw Error('foreign_read');
const child=libc.symbols.fork();if(child===0)libc.symbols._exit(81);if(child!==-1)throw Error('fork_allowed');
const bytes=readFileSync(${JSON.stringify(f.tree)});const target=process.env.TMPDIR+'/native';writeFileSync(target,bytes);chmodSync(target,0o700);const name=Buffer.from(target+'\\0');const args=new BigUint64Array([BigInt(ptr(name)),0n]);const env=new BigUint64Array([0n]);if(libc.symbols.execve(ptr(name),ptr(args),ptr(env))!==-1||new DataView(toArrayBuffer(libc.symbols.__errno_location(),0,4)).getInt32(0,true)!==13)throw Error('temp_exec_not_denied');
await new Promise((resolve,reject)=>{const s=connect({host:'127.0.0.1',port:${address.port}});s.setTimeout(200,()=>{s.destroy();resolve();});s.once('error',()=>resolve());s.once('connect',()=>{s.destroy();reject(Error('network_allowed'));});});console.log('STRICT_COMPLETE');libc.close();`,
        );
        writeFileSync(join(f.assets, 'sealed'), 'SEALED');
        const result = await run(
          createLinuxConfinedShellJob({
            ...f.options,
            runtimeReadOnlyRoots: [f.assets, dirname(realpathSync.native(process.execPath))],
          }),
          `exec ${quote(realpathSync.native(process.execPath))} ${quote(script)}`,
        );
        ended(result.events, result.handle, 'succeeded');
        expect(content(result.events)).toContain('STRICT_COMPLETE');
        expect(readFileSync(join(f.workspace, 'compensated'), 'utf8')).toBe('WORKSPACE_WRITE');
        expect(existsSync(join(f.profile, 'secret'))).toBe(true);
        expect(accepts).toBe(0);
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    }),
  45000,
);

linuxTest(
  'explicit per-launch filesystem and network grants independently constrain actual Linux effects',
  () =>
    fixture(async (f) => {
      let tcpAccepted = 0,
        unixAccepted = 0;
      const tcp = createServer((socket) => {
        tcpAccepted++;
        socket.end();
      });
      const unix = createServer((socket) => {
        unixAccepted++;
        socket.end();
      });
      const socketPath = join(f.root, 'explicit-scope.sock');
      await new Promise<void>((resolve) => tcp.listen(0, '127.0.0.1', resolve));
      await new Promise<void>((resolve) => unix.listen(socketPath, resolve));
      try {
        const address = tcp.address();
        if (!address || typeof address === 'string') throw Error('test_tcp_address');
        const script = `import{createConnection}from'node:net';const connect=target=>new Promise(r=>{const c=createConnection(target);c.setTimeout(1000);c.on('connect',()=>{console.log('CONNECTED');c.end()});c.on('end',r);c.on('error',e=>{console.log('DENIED:'+e.code);r()});c.on('timeout',()=>{console.log('TIMEOUT');c.destroy();r()})});await connect({host:'127.0.0.1',port:${address.port}});await connect(${JSON.stringify(socketPath)})`;
        for (const filesystem of ['workspace_write', 'full_access'] as const) {
          for (const network of ['none', 'internet'] as const) {
            const marker = `${filesystem}-${network}`;
            const external = join(f.root, `explicit-${marker}`);
            const result = await run(
              createLinuxHostShellJob({
                ...f.options,
                filesystemScope: 'workspace_write',
                executionScope: { filesystem, network },
              }),
              `printf workspace > ${quote(`explicit-${marker}`)}; if printf external > ${quote(external)}; then printf EXTERNAL_ALLOWED; else printf EXTERNAL_DENIED; fi; ${quote(realpathSync.native(process.execPath))} -e ${quote(script)}`,
            );
            ended(result.events, result.handle, 'succeeded');
            const output = content(result.events);
            expect(readFileSync(join(f.workspace, `explicit-${marker}`), 'utf8')).toBe('workspace');
            expect(existsSync(external)).toBe(filesystem === 'full_access');
            expect(output).toContain(
              filesystem === 'full_access' ? 'EXTERNAL_ALLOWED' : 'EXTERNAL_DENIED',
            );
            if (filesystem === 'full_access')
              expect(readFileSync(external, 'utf8')).toBe('external');
            expect(output).not.toContain('TIMEOUT');
            if (network === 'none') expect(output.match(/DENIED:/g)).toHaveLength(2);
            expect(tcpAccepted).toBe(
              network === 'internet'
                ? filesystem === 'full_access'
                  ? 2
                  : 1
                : filesystem === 'full_access'
                  ? 1
                  : 0,
            );
            expect(unixAccepted).toBe(
              filesystem === 'full_access' && network === 'internet' ? 1 : 0,
            );
            expect(readdirSync(f.temporaryRoot)).toEqual([]);
          }
        }
      } finally {
        await Promise.all([
          new Promise<void>((resolve) => tcp.close(() => resolve())),
          new Promise<void>((resolve) => unix.close(() => resolve())),
        ]);
      }
    }),
  45000,
);

linuxTest(
  'registered output temp survives native producer terminal and disposal',
  () =>
    fixture(async (f) => {
      const staging = join(f.workspace, 'managed-shell-staging');
      mkdirSync(staging);
      let allocated = '';
      const job = createLinuxHostShellJob({
        ...f.options,
        temporaryRoot: staging,
        filesystemScope: 'workspace_write',
        outputCollection: {
          async prepare(_context, identity) {
            await Promise.resolve();
            allocated = identity.canonical;
            mkdirSync(join(allocated, 'out'));
            return { env: { KITE_OUTPUT_DIR: join(allocated, 'out') }, cleanupTransferred: true };
          },
        },
      });
      const result = await run(job, 'printf report > "$KITE_OUTPUT_DIR/report.txt"');
      ended(result.events, result.handle, 'succeeded');
      expect(readFileSync(join(allocated, 'out/report.txt'), 'utf8')).toBe('report');
      expect(readdirSync(staging)).toHaveLength(1);
    }),
  45000,
);

linuxTest(
  'current-user mount ownership preserves devpts, sealed flags and capability-free namespace restrictions',
  () =>
    fixture(async (f) => {
      const source = join(f.assets, 'mount-probe.c');
      const binary = join(f.assets, 'mount-probe');
      writeFileSync(
        source,
        `#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/capability.h>
#include <linux/nsfs.h>
#include <poll.h>
#include <pty.h>
#include <sched.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <sys/syscall.h>
#include <termios.h>
#include <unistd.h>
static int transfer(int from, int to, const char *text) {
  char bytes[16]; size_t size = strlen(text);
  if (write(from, text, size) != (ssize_t)size) return -1;
  struct pollfd wait = { .fd = to, .events = POLLIN };
  if (poll(&wait, 1, 1000) != 1 || read(to, bytes, size) != (ssize_t)size || memcmp(bytes, text, size)) return -1;
  return 0;
}
int main(void) {
  alarm(10);
  int mnt = open("/proc/self/ns/mnt", O_RDONLY | O_CLOEXEC);
  int user = open("/proc/self/ns/user", O_RDONLY | O_CLOEXEC);
  int owner = ioctl(mnt, NS_GET_USERNS);
  struct stat own, current;
  if (mnt < 0 || user < 0 || owner < 0 || fstat(owner, &own) || fstat(user, &current) ||
      own.st_dev != current.st_dev || own.st_ino != current.st_ino) return 70;
  if (close(owner) || close(user)) return 71;
  struct __user_cap_header_struct header = { .version = _LINUX_CAPABILITY_VERSION_3, .pid = 0 };
  struct __user_cap_data_struct caps[2];
  if (syscall(SYS_capget, &header, caps)) return 72;
  for (int i = 0; i < 2; i++) if (caps[i].effective || caps[i].permitted || caps[i].inheritable) return 73;
  struct statvfs flags;
  const char *temp = getenv("TMPDIR");
  if (!temp || statvfs(temp, &flags) ||
      (flags.f_flag & (ST_NOEXEC | ST_NOSUID | ST_NODEV)) != (ST_NOEXEC | ST_NOSUID | ST_NODEV)) return 74;
  errno = 0;
  if (unshare(CLONE_NEWNS) != -1 || errno != EPERM) return 75;
  errno = 0;
  if (setns(mnt, CLONE_NEWNS) != -1 || errno != EPERM) return 76;
  errno = 0;
  if (mount(NULL, temp, NULL, MS_BIND | MS_REMOUNT, NULL) != -1 || errno != EPERM) return 77;
  if (close(mnt)) return 78;
  FILE *info = fopen("/proc/self/mountinfo", "r");
  if (!info) return 79;
  char *line = NULL; size_t capacity = 0;
  while (getline(&line, &capacity, info) > 0) {
    char *separator = strstr(line, " - ");
    if (!separator) return 80;
    *separator = 0;
    if (strstr(line, " shared:")) return 81;
  }
  free(line);
  if (ferror(info) || fclose(info)) return 82;
  int master, slave; char name[128]; struct termios terminal;
  if (openpty(&master, &slave, name, NULL, NULL) || strncmp(name, "/dev/pts/", 9)) return 83;
  if (tcgetattr(slave, &terminal)) return 84;
  cfmakeraw(&terminal);
  if (tcsetattr(slave, TCSANOW, &terminal) || transfer(master, slave, "TO_SLAVE") ||
      transfer(slave, master, "TO_MASTER")) return 85;
  if (close(slave) || close(master)) return 86;
  if (!access(name, F_OK) || errno != ENOENT) return 87;
  puts("OWNED_MOUNT_CAPS_SEAL_PTY_OK");
  return 0;
}
`,
      );
      const compiled = spawnSync(
        'cc',
        ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', source, '-lutil', '-o', binary],
        { encoding: 'utf8', timeout: 10000 },
      );
      expect(compiled.error).toBeUndefined();
      expect(compiled.status, compiled.stderr).toBe(0);
      for (const mode of ['workspace_write', 'full_access', 'confined'] as const) {
        const options = { ...f.options, shellExecutable: binary };
        const job =
          mode === 'confined'
            ? createLinuxConfinedShellJob(options)
            : createLinuxHostShellJob({ ...options, filesystemScope: mode });
        const result = await run(job, 'native_mount_probe');
        ended(result.events, result.handle, 'succeeded');
        expect(content(result.events)).toBe('OWNED_MOUNT_CAPS_SEAL_PTY_OK\n');
        expect(readdirSync(f.temporaryRoot)).toEqual([]);
      }
    }),
  45000,
);
