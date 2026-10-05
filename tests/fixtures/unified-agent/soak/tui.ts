import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { selectProfile } from '@kite-ai/agent/profile';
import type { CLIServiceArtifact } from '@kite-ai/cli/host';
import { launchPairedService } from '@kite-ai/service/paired';
import type {
  CaseEvidence,
  ResourceObservation,
} from '../../../../scripts/runtime/unified-soak-cases';
import { check } from './common';
export async function runTuiCase(
  root: string,
  artifact: CLIServiceArtifact,
  samplerModule: string,
  cycles: 2 | 9 = 2,
): Promise<CaseEvidence> {
  const start = performance.now();
  const e: CaseEvidence = {
    caseId: 'tui_lifecycle_churn',
    status: 'passed',
    pid: process.pid,
    nonce: randomUUID(),
    durationMs: 0,
    workloadDurationMs: 0,
    cleanupConfirmed: false,
    assertions: [],
    unavailable: [],
  };
  if (process.platform === 'win32') {
    e.status = 'unavailable';
    e.unavailable.push('windows_owned_pty_backend_unavailable');
    return e;
  }
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { mode: 0o700 });
  let calls = 0;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      await request.json();
      calls++;
      const data = {
        id: 'owned',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'fixed',
        choices: [
          { index: 0, delta: { content: 'OWNED_SOAK_PTY_COMPLETE' }, finish_reason: 'stop' },
        ],
      };
      return new Response(`data: ${JSON.stringify(data)}\n\ndata: [DONE]\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'soak-tui' });
  mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
  mkdirSync(join(profile.profilePath, 'ui'), { mode: 0o700 });
  writeFileSync(join(profile.profilePath, 'ui/preferences.jsonc'), '{"language":"en-US"}', {
    mode: 0o600,
  });
  writeFileSync(
    join(profile.profilePath, 'config.jsonc'),
    JSON.stringify({
      modelId: 'fixed',
      tools: [],
      models: [
        { id: 'fixed', provider: 'compatible', model: 'fixed', baseURL: `${server.url.href}v1` },
      ],
    }),
    { mode: 0o600 },
  );
  let child: Bun.Subprocess | undefined;
  try {
    const seed = await launchPairedService({
      profile,
      ...artifact,
      instanceId: randomUUID(),
      requiredCapabilities: ['sessions', 'commands', 'permission_controls'],
    });
    try {
      if (seed.bootstrap.dataAvailability !== 'available') throw Error('tui_seed_unavailable');
      const storeId = seed.bootstrap.storeId;
      await seed.client.createWorkspace({
        expectedStoreId: storeId,
        id: 'w',
        rootUri: pathToFileURL(workspace).href,
        name: 'owned',
      });
      await seed.client.createSession({
        expectedStoreId: storeId,
        sessionId: 's',
        commandId: 'create',
        workspaceId: 'w',
        title: 'soak',
      });
      const trust = await seed.client.getWorkspaceTrust('w', { storeId });
      await seed.client.setWorkspaceTrust('w', {
        expectedStoreId: storeId,
        commandId: 'trust',
        trusted: true,
        ifRevision: trust.revision,
        canonicalIdentity: trust.canonicalIdentity,
        externalReadScopeDigest: trust.externalReadScopeDigest,
      });
      const mode = await seed.client.getPermissionMode('s', { storeId });
      await seed.client.setPermissionMode('s', {
        expectedStoreId: storeId,
        commandId: 'full',
        ifRevision: mode.revision,
        mode: 'full',
        makeDefault: false,
        ifDefaultRevision: mode.defaultRevision,
      });
    } finally {
      await seed.close();
    }
    const entry = join(root, 'observed-tui.ts'),
      main = join(root, 'observed-tui.js');
    const requestPath = join(root, 'sample-request.json'),
      responsePath = join(root, 'sample-response.json');
    const instrumentation = `import {readFileSync,writeFileSync} from 'node:fs';
import {runTUIProcess} from '@kite-ai/cli/tui-main';
import {sampleSoakResources} from ${JSON.stringify(samplerModule)};
let seen='';
const timer=setInterval(()=>{let request;try{request=JSON.parse(readFileSync(${JSON.stringify(requestPath)},'utf8'));}catch{return;}
if(typeof request.key!=='string'||request.key===seen)return;seen=request.key;Bun.gc(true);
writeFileSync(${JSON.stringify(responsePath)},JSON.stringify({key:seen,sample:sampleSoakResources()}),{mode:0o600});},5);
try { process.exitCode=await runTUIProcess(${JSON.stringify({ argv: ['--thread', 's'], artifact, dataRoot: profile.dataRoot, profile: profile.profile, cwd: workspace })}); }
finally { clearInterval(timer); }`;
    writeFileSync(entry, instrumentation, { mode: 0o600 });
    const built = await Bun.build({
      entrypoints: [entry],
      target: 'bun',
      packages: 'external',
      outdir: root,
    });
    if (!built.success) throw Error('tui_instrumentation_build_failed');
    const python = `import os,pty,subprocess,select,time,fcntl,termios,struct,json,re
m,s=pty.openpty();fcntl.ioctl(s,termios.TIOCSWINSZ,struct.pack('HHHH',24,100,0,0))
p=subprocess.Popen([${JSON.stringify(artifact.executable)},${JSON.stringify(main)}],stdin=s,stdout=s,stderr=s,start_new_session=True);os.close(s);b=b'';points=[]
def wait(text):
 global b
 deadline=time.monotonic()+60
 while text not in re.sub(rb'\\x1b\\[[0-?]*[ -/]*[@-~]',b'',b):
  if p.poll() is not None: raise RuntimeError('early exit '+b[-2000:].decode(errors='replace'))
  if time.monotonic()>deadline: raise RuntimeError('PTY deadline '+text.decode()+' '+b[-2000:].decode(errors='replace'))
  if select.select([m],[],[],.1)[0]: b+=os.read(m,65536)
def snapshot(key):
 with open(${JSON.stringify(requestPath)},'w') as f: json.dump({'key':key},f)
 deadline=time.monotonic()+10
 while time.monotonic()<deadline:
  try:
   with open(${JSON.stringify(responsePath)}) as f: value=json.load(f)
   if value['key']==key:return value['sample']
  except (FileNotFoundError,json.JSONDecodeError):pass
  if select.select([m],[],[],.01)[0]:
   global b
   b+=os.read(m,65536)
 raise RuntimeError('sample deadline')
try:
 wait(b'New Run');os.write(m,b'Owned soak terminal input');wait(b'Owned soak terminal input');os.write(m,b'\\r');wait(b'OWNED_SOAK_PTY_COMPLETE')
 for sequence in range(${cycles}):
  before=snapshot(str(sequence)+'-before');start=time.monotonic();b=b'';os.write(m,b'/rewind');wait(b'/rewind');b=b'';os.write(m,b'\\r');wait(b'Files recovery:');wait(b'Esc closes.');b=b'';os.write(m,b'\\x1b');wait(b'New Run');after=snapshot(str(sequence)+'-after')
  points.append({'sequence':sequence,'before':before,'after':after,'durationMs':(time.monotonic()-start)*1000,'focus':True})
 os.write(m,b'\\x11');deadline=time.monotonic()+6
 while p.poll() is None and time.monotonic()<deadline:
  if select.select([m],[],[],.1)[0]:
   try:b+=os.read(m,65536)
   except OSError:break
 p.wait(timeout=3);assert p.returncode==0;print(json.dumps({'pty':True,'input':True,'exit':p.returncode,'pid':p.pid,'points':points}))
finally:
 if p.poll() is None:p.kill();p.wait(timeout=5)
 os.close(m)
`;
    child = Bun.spawn(['python3', '-c', python], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { PATH: process.env.PATH ?? '', HOME: join(root, 'home'), TMPDIR: root },
    });
    const stdout = new Response(child.stdout as ReadableStream<Uint8Array>).text(),
      stderr = new Response(child.stderr as ReadableStream<Uint8Array>).text();
    const exit = await child.exited;
    const error = await stderr;
    if (exit !== 0) throw Error(`owned_pty_failed:${error.slice(-2000)}`);
    const facts = JSON.parse(await stdout) as {
      pty: boolean;
      input: boolean;
      exit: number;
      pid: number;
      points: {
        sequence: number;
        before: ResourceObservation;
        after: ResourceObservation;
        durationMs: number;
        focus: boolean;
      }[];
    };
    check(e.assertions, 'actual_pty', facts.pty, true);
    check(e.assertions, 'actual_input', facts.input && calls === 1, true);
    check(e.assertions, 'clean_exit', facts.exit, 0);
    check(
      e.assertions,
      'focus_open_close',
      facts.points.length === cycles && facts.points.every((point) => point.focus),
      true,
    );
    e.pid = facts.pid;
    e.points = facts.points.map((point) => ({
      sequence: point.sequence,
      before: point.before.metrics,
      after: point.after.metrics,
      observations: { before: point.before, after: point.after },
      durationMs: point.durationMs,
      assertions: [...e.assertions],
    }));
    e.cleanupConfirmed = true;
  } catch (error) {
    e.status = 'failed';
    e.unavailable.push(error instanceof Error ? error.message : 'tui_failed');
  } finally {
    if (child?.exitCode === null) {
      child.kill('SIGKILL');
      await child.exited;
    }
    server.stop(true);
    e.durationMs = performance.now() - start;
    e.workloadDurationMs = e.durationMs;
  }
  return e;
}
