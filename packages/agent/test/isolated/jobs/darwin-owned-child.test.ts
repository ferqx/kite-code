import { dlopen, ptr, toArrayBuffer } from 'bun:ffi';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import {
  type DarwinOwnedChild,
  startDarwinOwnedChild,
} from '../../../src/platform/process/darwin-owned-child';

const darwinTest = process.platform === 'darwin' ? test : test.skip;
let root: string;
let executable: string;
let cleanupConfirmed = true;
const fixture = `
#include <unistd.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
static int output(int fd, const char *data, size_t length) {
  while (length) { ssize_t n=write(fd,data,length); if(n<=0)return 1; data+=n;length-=n; } return 0;
}
int main(int argc,char **argv) {
  alarm(10);
  if(argc<2)return 90;
  if(!strcmp(argv[1],"args")) {
    if(argc!=3 || !getenv("OWNED_ENV"))return 99;
    printf("%s\\n%s\\n",argv[2],getenv("OWNED_ENV"));return 23;
  }
  if(!strcmp(argv[1],"output")) {
    char cwd[4096]; if(!getcwd(cwd,sizeof(cwd)))return 91;
    printf("cwd=%s env=%s\\n",cwd,getenv("OWNED_ENV"));fflush(stdout);
    char a[32768],b[32768];memset(a,'a',sizeof(a));memset(b,'b',sizeof(b));
    for(int i=0;i<16;i++) if(output(1,a,sizeof(a))||output(2,b,sizeof(b)))return 92;
    return 23;
  }
  if(!strcmp(argv[1],"tree")) {
    int channel[2];if(pipe(channel))return 93;
    pid_t child=fork();if(child<0)return 94;
    if(child==0) {
      close(channel[0]);signal(SIGTERM,SIG_IGN);alarm(8);
      pid_t grand=fork();if(grand<0)_exit(95);
      if(grand==0){close(channel[1]);alarm(7);for(;;)pause();}
      if(output(channel[1],(char*)&grand,sizeof(grand)))_exit(96);
      close(channel[1]);for(;;)pause();
    }
    close(channel[1]);pid_t grand=0;
    if(read(channel[0],&grand,sizeof(grand))!=sizeof(grand))return 97;
    close(channel[0]);
    printf("root=%d child=%d grand=%d pgid=%d sid=%d\\n",getpid(),child,grand,getpgrp(),getsid(0));
    fflush(stdout);fputs("tree-stderr\\n",stderr);fflush(stderr);return 23;
  }
  if(!strcmp(argv[1],"sleep")){for(;;)pause();}
  return 98;
}
`;
beforeAll(async () => {
  if (process.platform !== 'darwin') return;
  root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-owned-darwin-')));
  executable = join(root, 'fixture');
  const source = join(root, 'fixture.c');
  writeFileSync(source, fixture);
  const compiler = Bun.spawn(
    ['/usr/bin/xcrun', 'clang', '-Wall', '-Wextra', '-Werror', source, '-o', executable],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const diagnostics = await new Response(compiler.stderr).text();
  await new Response(compiler.stdout).text();
  expect(await compiler.exited, diagnostics).toBe(0);
});
afterAll(() => {
  if (root && cleanupConfirmed) rmSync(root, { recursive: true, force: true });
});
const start = (mode: string) =>
  startDarwinOwnedChild({ executable, argv: [mode], cwd: root, env: { OWNED_ENV: 'selected' } });
async function drain(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString();
}
async function cleanup(child: DarwinOwnedChild) {
  const stopped = await child.terminateGroup(0);
  cleanupConfirmed &&= stopped.confirmed;
  if (stopped.confirmed) child.reapAfterConfirmedStop();
  else {
    child.stdout.destroy();
    child.stderr.destroy();
  }
  expect(stopped.confirmed, `owned root ${child.pid}, retained diagnostics ${root}`).toBe(true);
}
function native() {
  return dlopen('/usr/lib/libSystem.B.dylib', {
    waitid: { args: ['i32', 'u32', 'ptr', 'i32'], returns: 'i32' },
    __error: { args: [], returns: 'ptr' },
  });
}
function waitable(pid: number) {
  const library = native();
  try {
    const info = Buffer.alloc(104);
    const result = library.symbols.waitid(1, pid, ptr(info), 0x25);
    return {
      result,
      errno: new DataView(toArrayBuffer(library.symbols.__error()!, 0, 4)).getInt32(0, true),
      pid: info.readInt32LE(12),
      code: info.readInt32LE(8),
      status: info.readInt32LE(20),
    };
  } finally {
    library.close();
  }
}
async function absent(pid: number) {
  const deadline = Date.now() + 2000;
  do {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
      throw error;
    }
    await Bun.sleep(20);
  } while (Date.now() < deadline);
  return false;
}

darwinTest('cold import never loads native libraries or starts a child', async () => {
  const script = join(root, 'cold.ts');
  writeFileSync(
    script,
    `import {mock} from 'bun:test';
mock.module('bun:ffi',()=>({dlopen(){throw Error('cold_dlopen')},ptr(){throw Error('cold_ptr')},toArrayBuffer(){throw Error('cold_memory')}}));
await import(${JSON.stringify(join(import.meta.dir, '../../../src/platform/process/darwin-owned-child.ts'))});
console.log('cold-ok');`,
  );
  const processChild = Bun.spawn([process.execPath, script], { stdout: 'pipe', stderr: 'pipe' });
  const outputs = await Promise.all([
    new Response(processChild.stdout).text(),
    new Response(processChild.stderr).text(),
  ]);
  expect(await processChild.exited, outputs[1]).toBe(0);
  expect(outputs[0]).toBe('cold-ok\n');
});

darwinTest(
  'root exit status, simultaneous pipe drain and held zombie survive until exact reap',
  async () => {
    const child = start('output');
    const outputs = Promise.all([drain(child.stdout), drain(child.stderr)]);
    try {
      expect(await child.exited).toBe(23);
      expect(waitable(child.pid)).toMatchObject({ result: 0, pid: child.pid, code: 1, status: 23 });
      expect(waitable(child.pid)).toMatchObject({ result: 0, pid: child.pid, code: 1, status: 23 });
      const [stdout, stderr] = await outputs;
      expect(stdout).toBe(`cwd=${root} env=selected\n${'a'.repeat(16 * 32768)}`);
      expect(stderr).toBe('b'.repeat(16 * 32768));
      const stopped = await child.terminateGroup(0);
      expect(stopped).toEqual({ confirmed: true, forced: false });
      expect(waitable(child.pid)).toMatchObject({ result: 0, pid: child.pid, status: 23 });
      child.reapAfterConfirmedStop();
      expect(waitable(child.pid)).toMatchObject({ result: -1, errno: 10 });
      const unrelated = Bun.spawn(['/bin/sleep', '2'], { stdout: 'ignore', stderr: 'ignore' });
      try {
        expect(await child.terminateGroup(0)).toEqual(stopped);
        child.reapAfterConfirmedStop();
        expect(unrelated.exitCode).toBeNull();
      } finally {
        unrelated.kill();
        await unrelated.exited;
      }
    } finally {
      await cleanup(child);
      await outputs;
    }
  },
  10000,
);

darwinTest(
  'natural root exit retains live descendants; TERM ignored forces KILL before root reap',
  async () => {
    const child = start('tree');
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    const outputEnd = new Promise<void>((resolve, reject) => {
      child.stdout.once('end', resolve);
      child.stdout.once('error', reject);
    });
    const stderr = drain(child.stderr);
    try {
      expect(await child.exited).toBe(23);
      const deadline = Date.now() + 2000;
      while (!stdout.includes('\n') && Date.now() < deadline) await Bun.sleep(10);
      const ids = /root=(\d+) child=(\d+) grand=(\d+) pgid=(\d+) sid=(\d+)/u.exec(stdout)!;
      expect(ids).not.toBeNull();
      const descendant = Number(ids[2]);
      const grandchild = Number(ids[3]);
      expect(Number(ids[1])).toBe(child.pid);
      expect(Number(ids[4])).toBe(child.pid);
      expect(Number(ids[5])).toBe(child.pid);
      process.kill(descendant, 0);
      process.kill(grandchild, 0);
      expect(waitable(child.pid)).toMatchObject({ result: 0, pid: child.pid, status: 23 });
      expect(() => child.reapAfterConfirmedStop()).toThrow('darwin_owned_child_stop_unconfirmed');
      const first = child.terminateGroup(80);
      expect(child.terminateGroup(0)).toBe(first);
      expect(await first).toEqual({ confirmed: true, forced: true });
      expect(waitable(child.pid)).toMatchObject({ result: 0, pid: child.pid, status: 23 });
      expect(await absent(descendant)).toBe(true);
      expect(await absent(grandchild)).toBe(true);
      child.reapAfterConfirmedStop();
      await outputEnd;
      expect(await stderr).toBe('tree-stderr\n');
    } finally {
      await cleanup(child);
      await Promise.all([outputEnd, stderr]);
    }
  },
  10000,
);

darwinTest('failed executable/cwd starts leave no child and close every pipe descriptor', () => {
  const descriptors = () => readdirSync('/dev/fd').sort();
  const before = descriptors();
  for (let attempt = 0; attempt < 20; attempt++) {
    expect(() =>
      startDarwinOwnedChild({ executable: `${root}/absent`, argv: [], cwd: root, env: {} }),
    ).toThrow('darwin_owned_child_spawn');
    expect(() =>
      startDarwinOwnedChild({ executable, argv: ['sleep'], cwd: `${root}/absent`, env: {} }),
    ).toThrow('darwin_owned_child_spawn');
  }
  expect(descriptors()).toEqual(before);
  const library = native();
  try {
    const info = Buffer.alloc(104);
    expect(library.symbols.waitid(0, 0, ptr(info), 0x25)).toBe(-1);
    expect(new DataView(toArrayBuffer(library.symbols.__error()!, 0, 4)).getInt32(0, true)).toBe(
      10,
    );
  } finally {
    library.close();
  }
});

darwinTest(
  'real native signals and waitpid occur only once, with no signal after reap',
  async () => {
    const script = join(root, 'count-cleanup.ts');
    writeFileSync(
      script,
      `import {dlopen as nativeDlopen,ptr,toArrayBuffer} from 'bun:ffi';
import {mock} from 'bun:test';
const actualDlopen=nativeDlopen;
let signals=0,reaps=0,reaped=false,lateSignals=0;
mock.module('bun:ffi',()=>({ptr,toArrayBuffer,dlopen(path,options){
 const library=actualDlopen(path,options);
 const symbols={...library.symbols};
 if(symbols.kill){const kill=symbols.kill;symbols.kill=(...args)=>{signals++;if(reaped)lateSignals++;return kill(...args)};}
 if(symbols.waitpid){const waitpid=symbols.waitpid;symbols.waitpid=(...args)=>{reaps++;const result=waitpid(...args);if(result===args[0])reaped=true;return result};}
 return {...library,symbols,close:()=>library.close()};
}}));
const {startDarwinOwnedChild}=await import(${JSON.stringify(join(import.meta.dir, '../../../src/platform/process/darwin-owned-child.ts'))});
const child=startDarwinOwnedChild({executable:${JSON.stringify(executable)},argv:['tree'],cwd:${JSON.stringify(root)},env:{}});
const drain=Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text()]);
if(await child.exited!==23)throw Error('wrong-root-status');
const first=child.terminateGroup(80);
if(child.terminateGroup(0)!==first)throw Error('duplicate-termination');
const result=await first;
if(!result.confirmed||!result.forced)throw Error('stop-unconfirmed');
child.reapAfterConfirmedStop();
child.reapAfterConfirmedStop();
await child.terminateGroup(0);
await drain;
console.log(JSON.stringify({signals,reaps,lateSignals}));`,
    );
    const processChild = Bun.spawn([process.execPath, script], { stdout: 'pipe', stderr: 'pipe' });
    const outputs = await Promise.all([
      new Response(processChild.stdout).text(),
      new Response(processChild.stderr).text(),
    ]);
    expect(await processChild.exited, outputs[1]).toBe(0);
    expect(JSON.parse(outputs[0])).toEqual({ signals: 2, reaps: 1, lateSignals: 0 });
  },
);

darwinTest(
  'native spawn receives unpooled argv and env buffers intact across forced GC',
  async () => {
    const argument = `argument-${'a'.repeat(16384)}`;
    const environment = `environment-${'b'.repeat(16384)}`;
    const script = join(root, 'gc-launch.ts');
    writeFileSync(
      script,
      `import {dlopen as nativeDlopen,ptr,toArrayBuffer} from 'bun:ffi';
import {mock} from 'bun:test';
const actualDlopen=nativeDlopen;
let collections=0;
mock.module('bun:ffi',()=>({ptr,toArrayBuffer,dlopen(path,options){
 const library=actualDlopen(path,options);
 const symbols={...library.symbols};
 if(symbols.posix_spawn){const spawn=symbols.posix_spawn;symbols.posix_spawn=(...args)=>{Bun.gc(true);collections++;return spawn(...args)};}
 return {...library,symbols,close:()=>library.close()};
}}));
const {startDarwinOwnedChild}=await import(${JSON.stringify(join(import.meta.dir, '../../../src/platform/process/darwin-owned-child.ts'))});
const child=startDarwinOwnedChild({executable:${JSON.stringify(executable)},argv:['args',${JSON.stringify(argument)}],cwd:${JSON.stringify(root)},env:{OWNED_ENV:${JSON.stringify(environment)}}});
const drain=Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text()]);
if(await child.exited!==23)throw Error('wrong-root-status');
const result=await child.terminateGroup(0);
if(!result.confirmed)throw Error('stop-unconfirmed');
child.reapAfterConfirmedStop();
const outputs=await drain;
console.log(JSON.stringify({collections,stdout:outputs[0],stderr:outputs[1]}));`,
    );
    const processChild = Bun.spawn([process.execPath, script], { stdout: 'pipe', stderr: 'pipe' });
    const outputs = await Promise.all([
      new Response(processChild.stdout).text(),
      new Response(processChild.stderr).text(),
    ]);
    expect(await processChild.exited, outputs[1]).toBe(0);
    expect(JSON.parse(outputs[0])).toEqual({
      collections: 1,
      stdout: `${argument}\n${environment}\n`,
      stderr: '',
    });
  },
);
