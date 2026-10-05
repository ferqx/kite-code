import { afterEach, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JobDefinition, JobEvent } from '@kite-ai/agent/extensions';
import { launchIdentity } from '../../../src/jobs/launch-identity';
import { confinedProfile } from '../../../src/jobs/seatbelt';
import { createMacosConfinedShellJob } from '../../../src/jobs/shell';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const macTest = process.platform === 'darwin' ? test : test.skip;

macTest(
  'actual allow-fork counterexample leaves setsid descendant alive after original group-ended proof',
  async () => {
    const f = await fixture();
    const source = join(f.readonly, 'escape.c'),
      binary = join(f.readonly, 'escape'),
      pidFile = join(f.workspace, 'escaped-pid');
    writeFileSync(
      source,
      `#include <unistd.h>\n#include <stdio.h>\n#include <stdlib.h>\nint main(){pid_t p=fork();if(p<0)return 3;if(p>0){usleep(200000);return 0;}if(setsid()<0)_exit(4);FILE *f=fopen(${JSON.stringify(pidFile)},"w");fprintf(f,"%d",getpid());fclose(f);close(0);close(1);close(2);sleep(15);_exit(0);}\n`,
    );
    const compiler = Bun.spawn(['/usr/bin/clang', source, '-o', binary], {
      stdout: 'ignore',
      stderr: 'pipe',
    });
    expect(await compiler.exited).toBe(0);
    const baselineTemp = join(f.root, 'baseline-temp');
    mkdirSync(baselineTemp);
    const profile = confinedProfile(f.workspace, baselineTemp, [f.readonly], [binary], []).replace(
      '(deny process-fork)',
      '(allow process-fork)',
    );
    const guardian = Bun.spawn([process.execPath, f.options.supervisorPath], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    let escaped: number | undefined;
    try {
      guardian.stdin.write(
        `${JSON.stringify({ type: 'start', nonce: 'escape-counterexample', executable: '/usr/bin/sandbox-exec', argv: ['-p', profile, binary], cwd: f.workspace, env: { PATH: '/usr/bin:/bin' }, graceMs: 200 })}\n`,
      );
      await guardian.exited;
      const frames = (await new Response(guardian.stdout).text())
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      const ready = frames.find((frame) => frame.type === 'ready'),
        terminal = frames.find((frame) => frame.type === 'terminal');
      escaped = Number(readFileSync(pidFile, 'utf8'));
      expect(alive(ready.processGroupId)).toBe(false);
      expect(terminal.groupStopped).toBe(true);
      expect(terminal.outcome).toBe('succeeded');
      expect(alive(escaped)).toBe(true);
    } finally {
      if (escaped && alive(escaped)) process.kill(escaped, 'SIGKILL');
      guardian.kill('SIGKILL');
      await guardian.exited;
    }
  },
);

macTest(
  'readonly assets remain readable; writable private temp cannot map a copied native executable',
  async () => {
    const f = await fixture();
    writeFileSync(join(f.readonly, 'data'), 'readonly');
    expect((await run(f.job, `exec /bin/cat ${quote(join(f.readonly, 'data'))}`)).output).toBe(
      'readonly',
    );
    const source = join(f.readonly, 'temp-exec.c'),
      binary = join(f.readonly, 'temp-exec');
    writeFileSync(
      source,
      `#include <unistd.h>\n#include <fcntl.h>\n#include <sys/stat.h>\n#include <stdio.h>\n#include <stdlib.h>\n#include <string.h>\nint main(int argc,char **argv){if(strstr(argv[0],"/copied")){FILE *f=fopen("copied-executed","w");fputs("bad",f);fclose(f);return 0;}char path[4096],b[4096];snprintf(path,sizeof(path),"%s/copied",getenv("TMPDIR"));int in=open(argv[0],O_RDONLY),out=open(path,O_WRONLY|O_CREAT,0700),n;while((n=read(in,b,sizeof(b)))>0)write(out,b,n);close(in);close(out);chmod(path,0700);char *args[]={path,NULL};execv(path,args);perror("temp-exec-denied");return 0;}\n`,
    );
    const compiler = Bun.spawn(['/usr/bin/clang', source, '-o', binary], {
      stdout: 'ignore',
      stderr: 'pipe',
    });
    expect(await compiler.exited).toBe(0);
    const job = createMacosConfinedShellJob({ ...f.options, shellExecutable: binary });
    const result = await run(job, 'fixed native input');
    expect(existsSync(join(f.workspace, 'copied-executed'))).toBe(false);
    expect(result.output).toContain('temp-exec-denied: Operation not permitted');
    expect(result.terminal).toMatchObject({
      supervision: 'ended',
      result: { outcome: 'succeeded' },
    });
  },
);

macTest(
  'private guardian rechecks root identity and sealed profile bytes before spawning any business process',
  async () => {
    for (const drift of ['root', 'profile'] as const) {
      const f = await fixture();
      const fact = launchIdentity(f.workspace);
      if (drift === 'root') {
        renameSync(f.workspace, `${f.workspace}-old`);
        mkdirSync(f.workspace);
      }
      const guardian = Bun.spawn([process.execPath, f.options.supervisorPath], {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      guardian.stdin.write(
        `${JSON.stringify({ type: 'start', nonce: 'private-test', executable: drift === 'profile' ? '/usr/bin/sandbox-exec' : '/bin/sh', argv: drift === 'profile' ? ['-p', 'invalid profile', '/bin/sh', '-c', 'printf x > result'] : ['-c', 'printf x > result'], identities: [fact], profileDigest: drift === 'profile' ? '0'.repeat(64) : undefined, cwd: f.workspace, env: { PATH: '/usr/bin:/bin' }, graceMs: 200 })}\n`,
      );
      expect(await guardian.exited).toBe(125);
      expect(await new Response(guardian.stdout).text()).toContain('"outcome":"failed"');
      expect(existsSync(join(f.workspace, 'result'))).toBe(false);
    }
  },
);
function quote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-confined-shell-')));
  roots.push(root);
  const workspace = join(root, 'workspace'),
    readonly = join(root, 'readonly'),
    protectedRoot = join(workspace, 'profile');
  for (const path of [workspace, readonly, protectedRoot]) mkdirSync(path);
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, '../../../src/platform/process/shell-supervisor.ts')],
    outdir: join(root, 'platform/process'),
    target: 'bun',
    naming: 'shell-supervisor.js',
  });
  expect(built.success).toBe(true);
  const options = {
    cwd: workspace,
    env: { PATH: '/usr/bin:/bin' },
    supervisorPath: built.outputs[0]!.path,
    protectedRoots: [protectedRoot],
    runtimeReadOnlyRoots: [readonly],
    temporaryRoot: root,
  };
  const job = createMacosConfinedShellJob(options);
  return { root, workspace, readonly, protectedRoot, options, job };
}
async function run(job: JobDefinition, command: string) {
  const handle = await job.start(
    { command },
    { sessionId: 's', executionId: crypto.randomUUID(), signal: new AbortController().signal },
  );
  const events: JobEvent[] = [];
  try {
    for await (const event of job.observe(handle)) events.push(event);
  } finally {
    await job.dispose(handle);
  }
  return {
    events,
    output: events
      .filter((event) => event.type === 'output')
      .map((event) => event.content)
      .join(''),
    terminal: events.at(-1),
  };
}
macTest(
  'real confined shell writes Workspace and private temp, denies external/readonly/protected and symlink escapes',
  async () => {
    const f = await fixture();
    const outside = join(f.root, 'outside');
    writeFileSync(outside, 'outside-secret');
    writeFileSync(join(f.readonly, 'asset'), 'readonly-asset');
    writeFileSync(join(f.protectedRoot, 'secret'), 'profile-secret');
    symlinkSync(outside, join(f.workspace, 'escape'));
    const success = await run(
      f.job,
      'printf workspace > result; printf temp > "$TMPDIR/result"; printf "%s" "$TMPDIR"',
    );
    expect(success.terminal).toMatchObject({
      type: 'terminal',
      supervision: 'ended',
      result: { outcome: 'succeeded' },
    });
    expect(readFileSync(join(f.workspace, 'result'), 'utf8')).toBe('workspace');
    expect(() => readFileSync(join(success.output, 'result'))).toThrow();
    for (const command of [
      `cat ${quote(outside)}`,
      'cat escape',
      `printf x > ${quote(outside)}`,
      `cat ${quote(join(f.protectedRoot, 'secret'))}`,
      `printf x > ${quote(join(f.readonly, 'asset'))}`,
    ]) {
      const denied = await run(f.job, command);
      expect(denied.terminal).toMatchObject({
        result: { outcome: 'failed' },
        supervision: 'ended',
      });
      expect(denied.output).not.toContain('outside-secret');
      expect(denied.output).not.toContain('profile-secret');
    }
    expect(readFileSync(outside, 'utf8')).toBe('outside-secret');
    expect(readFileSync(join(f.readonly, 'asset'), 'utf8')).toBe('readonly-asset');
  },
);
macTest(
  'real pinned Bun runs readonly script with threads but cannot spawn a subprocess',
  async () => {
    const f = await fixture();
    const script = join(f.readonly, 'script.js');
    writeFileSync(
      script,
      `await Bun.write('script-result','complete'); try { const p=Bun.spawn(['/bin/sleep','1']); await p.exited; console.log('spawn-created'); } catch { console.log('spawn-denied'); }`,
    );
    const result = await run(f.job, `exec ${quote(process.execPath)} ${quote(script)}`);
    expect(result.terminal).toMatchObject({
      result: { outcome: 'succeeded' },
      supervision: 'ended',
    });
    expect(readFileSync(join(f.workspace, 'script-result'), 'utf8')).toBe('complete');
    expect(result.output).toContain('spawn-denied');
    expect(result.output).not.toContain('spawn-created');
  },
);
macTest(
  'captured Workspace and guardian drift reject before a business process starts',
  async () => {
    const f = await fixture();
    writeFileSync(f.options.supervisorPath, 'changed');
    await expect(run(f.job, 'printf forbidden > result')).rejects.toThrow(
      'confined_launch_changed',
    );
    expect(() => readFileSync(join(f.workspace, 'result'))).toThrow();
  },
);

macTest('actual OS denies TCP and Unix sockets before server acceptance', async () => {
  const f = await fixture();
  let accepted = 0;
  const tcp = createServer((socket) => {
    accepted++;
    socket.end();
  });
  const unix = createServer((socket) => {
    accepted++;
    socket.end();
  });
  const socketPath = join(f.workspace, 'socket');
  await new Promise<void>((resolve) => tcp.listen(0, '127.0.0.1', resolve));
  await new Promise<void>((resolve) => unix.listen(socketPath, resolve));
  try {
    const port = (tcp.address() as { port: number }).port;
    const script = join(f.readonly, 'network.js');
    writeFileSync(
      script,
      `for(const target of [{hostname:'127.0.0.1',port:${port}},{unix:${JSON.stringify(socketPath)}}]){try{await Bun.connect({...target,socket:{data(){},open(s){s.end()},error(){}}}); console.log('connected');}catch{console.log('denied')}}`,
    );
    const result = await run(f.job, `exec ${quote(process.execPath)} ${quote(script)}`);
    expect(result.output.match(/denied/g)).toHaveLength(2);
    expect(result.output).not.toContain('connected');
    expect(result.terminal).toMatchObject({
      supervision: 'ended',
      result: { outcome: 'succeeded' },
    });
    expect(accepted).toBe(0);
  } finally {
    await Promise.all(
      [tcp, unix].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  }
});

macTest(
  'fixed native interpreter cannot fork/daemonize, setsid or signal an unrelated process',
  async () => {
    const f = await fixture();
    const unrelated = Bun.spawn(['/bin/sleep', '30'], { stdout: 'ignore', stderr: 'ignore' });
    try {
      const source = join(f.readonly, 'probe.c'),
        binary = join(f.readonly, 'probe');
      writeFileSync(
        source,
        `#include <unistd.h>\n#include <signal.h>\n#include <stdio.h>\n#include <stdlib.h>\nint main(){int f=fork(); if(f==0)_exit(7); int d=daemon(1,1); printf("fork:%d daemon:%d setsid:%d signal:%d\\n",f,d,setsid(),kill(${unrelated.pid},SIGTERM));return 0;}\n`,
      );
      const compiler = Bun.spawn(['/usr/bin/clang', source, '-o', binary], {
        stdout: 'ignore',
        stderr: 'pipe',
      });
      expect(await compiler.exited).toBe(0);
      const job = createMacosConfinedShellJob({ ...f.options, shellExecutable: binary });
      const result = await run(job, 'closed actual input');
      expect(result.output).toContain('fork:-1 daemon:-1 setsid:-1 signal:-1');
      expect(result.terminal).toMatchObject({
        supervision: 'ended',
        result: { outcome: 'succeeded' },
      });
      expect(unrelated.exitCode).toBeNull();
    } finally {
      unrelated.kill('SIGKILL');
      await unrelated.exited;
    }
  },
);

macTest(
  'confined cancellation kills TERM-ignoring original group and removes its temp only after stop',
  async () => {
    const f = await fixture();
    const source = join(f.readonly, 'ignore-term.c'),
      binary = join(f.readonly, 'ignore-term');
    writeFileSync(
      source,
      '#include <unistd.h>\n#include <signal.h>\n#include <stdio.h>\n#include <stdlib.h>\nint main(){signal(SIGTERM,SIG_IGN);printf("%s",getenv("TMPDIR"));fflush(stdout);for(;;)pause();}\n',
    );
    const compiler = Bun.spawn(['/usr/bin/clang', source, '-o', binary], {
      stdout: 'ignore',
      stderr: 'pipe',
    });
    expect(await compiler.exited).toBe(0);
    const job = createMacosConfinedShellJob({ ...f.options, shellExecutable: binary });
    const handle = await job.start(
      { command: 'fixed native fixture' },
      { sessionId: 's', executionId: 'cancel', signal: new AbortController().signal },
    );
    const events: JobEvent[] = [];
    const observed = (async () => {
      for await (const event of job.observe(handle)) events.push(event);
    })();
    const end = Date.now() + 5000;
    while (!events.some((event) => event.type === 'output')) {
      if (Date.now() > end) throw Error('output_timeout');
      await Bun.sleep(10);
    }
    expect((await job.cancel(handle)).status).toBe('stopped');
    await observed;
    const temp = events
      .filter((event) => event.type === 'output')
      .map((event) => event.content)
      .join('');
    expect(() => readFileSync(join(temp, 'anything'))).toThrow();
    expect(events.at(-1)).toMatchObject({
      supervision: 'ended',
      result: { outcome: 'cancelled', details: { forced: true } },
    });
    await job.dispose(handle);
  },
);

macTest(
  'captured root aliases and readonly roots cannot be replaced during admission wait',
  async () => {
    for (const target of ['workspace', 'readonly'] as const) {
      const f = await fixture();
      renameSync(f[target], `${f[target]}-original`);
      mkdirSync(f[target]);
      await expect(run(f.job, 'printf forbidden > result')).rejects.toThrow(
        'confined_launch_changed',
      );
      expect(existsSync(join(f.workspace, 'result'))).toBe(false);
      expect(existsSync(join(`${f.workspace}-original`, 'result'))).toBe(false);
    }
  },
);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function until(check: () => boolean): Promise<void> {
  const end = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > end) throw Error('fixture_timeout');
    await Bun.sleep(10);
  }
}
for (const exit of ['eof', 'sigkill'] as const)
  macTest(`confined parent ${exit} stops actual process and cleans invocation temp`, async () => {
    const f = await fixture();
    const script = join(f.readonly, 'hold.js'),
      pidFile = join(f.workspace, 'process');
    writeFileSync(
      script,
      `await Bun.write(${JSON.stringify(pidFile)},JSON.stringify({pid:process.pid,temp:process.env.TMPDIR}));setInterval(()=>{},1000);`,
    );
    const leaf = await Bun.build({
      entrypoints: [join(import.meta.dir, '../../../src/jobs/shell.ts')],
      outdir: join(f.root, 'jobs'),
      target: 'bun',
      packages: 'external',
      naming: 'shell.js',
    });
    expect(leaf.success).toBe(true);
    const parentPath = join(f.root, 'parent.js');
    writeFileSync(
      parentPath,
      `import {createMacosConfinedShellJob} from ${JSON.stringify(leaf.outputs[0]!.path)};
const job=createMacosConfinedShellJob(${JSON.stringify({ ...f.options, supervisorPath: undefined })});
const h=await job.start({command:${JSON.stringify(`exec ${quote(process.execPath)} ${quote(script)}`)}},{sessionId:'s',executionId:'parent',signal:new AbortController().signal});console.log(JSON.stringify(h.reference));process.stdin.resume();process.stdin.on('end',()=>process.exit(0));`,
    );
    const parent = Bun.spawn([process.execPath, parentPath], {
      // Keep the outer runner's orphan guard, but exercise this parent's guardian EOF cleanup.
      // The inherited Bun flag otherwise SIGKILLs its guardian before temp cleanup can run.
      env: { ...process.env, BUN_FEATURE_FLAG_NO_ORPHANS: '0' },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const unrelated = Bun.spawn(['/bin/sleep', '30'], { stdout: 'ignore', stderr: 'ignore' });
    let reference: { processGroupId: number; supervisorPid: number } | undefined;
    try {
      const reader = parent.stdout.getReader();
      let output = '';
      while (!output.includes('\n')) {
        const chunk = await reader.read();
        if (chunk.done) throw Error('parent_failed');
        output += new TextDecoder().decode(chunk.value);
      }
      reference = JSON.parse(output.split('\n')[0]!);
      reader.releaseLock();
      await until(() => existsSync(pidFile));
      const fact = JSON.parse(readFileSync(pidFile, 'utf8')) as { pid: number; temp: string };
      expect(alive(fact.pid)).toBe(true);
      expect(existsSync(fact.temp)).toBe(true);
      if (exit === 'eof') parent.stdin.end();
      else parent.kill('SIGKILL');
      await parent.exited;
      await until(
        () => !alive(fact.pid) && !alive(reference!.supervisorPid) && !existsSync(fact.temp),
      );
      expect(alive(reference!.processGroupId)).toBe(false);
      expect(alive(unrelated.pid)).toBe(true);
    } finally {
      parent.kill('SIGKILL');
      await parent.exited;
      if (reference && alive(reference.processGroupId)) {
        try {
          process.kill(-reference.processGroupId, 'SIGKILL');
        } catch {}
      }
      if (reference && alive(reference.supervisorPid)) {
        try {
          process.kill(reference.supervisorPid, 'SIGTERM');
        } catch {}
      }
      unrelated.kill('SIGKILL');
      await unrelated.exited;
    }
  });

macTest(
  'full public manifest built outside source locates confined guardian and rejects missing packaged asset',
  async () => {
    const f = await fixture();
    const packageRoot = join(import.meta.dir, '../../..');
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
      exports: Record<string, string>;
    };
    const built = await Bun.build({
      entrypoints: Object.values(manifest.exports).map((path) => join(packageRoot, path)),
      root: join(packageRoot, 'src'),
      outdir: join(f.root, 'artifact'),
      target: 'bun',
      splitting: true,
      packages: 'external',
    });
    expect(built.success).toBe(true);
    const asset = await Bun.build({
      entrypoints: [join(packageRoot, 'src/platform/process/shell-supervisor.ts')],
      outdir: join(f.root, 'artifact/platform/process'),
      target: 'bun',
      naming: 'shell-supervisor.js',
    });
    expect(asset.success).toBe(true);
    const leaf = (await import(join(f.root, 'artifact/jobs/shell.js'))) as {
      createMacosConfinedShellJob: typeof createMacosConfinedShellJob;
    };
    const job = leaf.createMacosConfinedShellJob({ ...f.options, supervisorPath: undefined });
    expect((await run(job, 'printf complete-built')).output).toBe('complete-built');
    rmSync(join(f.root, 'artifact/platform/process/shell-supervisor.js'));
    expect(() =>
      leaf.createMacosConfinedShellJob({ ...f.options, supervisorPath: undefined }),
    ).toThrow('shell_supervisor_asset_unavailable');
  },
);
