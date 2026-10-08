import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { verifyTerminalBundle } from '../../../apps/cli/host/terminal-artifact';
import { sourceServerArguments } from '../../../scripts/development/ensure-web';
import { sourceTerminalRoot } from '../../../scripts/release/source-terminal';
import { buildTerminalBundle } from '../../../scripts/release/terminal-bundle';

const repositoryRoot = resolve(import.meta.dir, '../../..');
async function execute(command: string[], cwd: string, home: string) {
  const child = Bun.spawn(command, {
    cwd,
    env: { PATH: '/usr/bin:/bin', HOME: home, LANG: 'C.UTF-8', TERM: 'xterm-256color' },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let forced: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(() => {
    child.kill('SIGTERM');
    forced = setTimeout(() => child.kill('SIGKILL'), 5000);
  }, 20000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (code) console.error({ command, code, stdout, stderr });
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
    if (forced) clearTimeout(forced);
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await child.exited;
    }
  }
}
function driver(root: string, kind: 'CLI' | 'TUI' | 'Server') {
  const path = join(root, `${kind}.ts`);
  const source =
    kind === 'Server' ? 'scripts/development/ensure-web.ts' : 'scripts/release/source-terminal.ts';
  const fn = kind === 'Server' ? 'runSourceServer' : `runSourceTerminal${kind}`;
  writeFileSync(
    path,
    `import {${fn}} from ${JSON.stringify(join(repositoryRoot, source))};\ntry{process.exitCode=await ${fn}(process.argv.slice(2),${JSON.stringify(root)});}catch(error){process.stderr.write(String(error?.code??'terminal_host_failed')+'\\n');process.exitCode=1;}\n`,
  );
  return path;
}

test('formal source wrappers pure argv and server finite projection never inspect missing candidates or profiles', async () => {
  const root = realpathSync(mkdtempSync('/private/tmp/kite-formal-pure-')),
    home = join(root, 'home');
  mkdirSync(home);
  try {
    expect(sourceTerminalRoot(root)).toBe(join(root, 'dist/unified-terminal'));
    const selected = sourceServerArguments([
      '--data-root',
      join(root, 'data'),
      '--server',
      join(root, 's.sock'),
      '--workspace',
      root,
      '--json',
    ]);
    expect(selected.start).toEqual([
      'server',
      'start',
      '--data-root',
      join(root, 'data'),
      '--server',
      join(root, 's.sock'),
      '--workspace',
      root,
    ]);
    expect(selected.web).toEqual([
      'web',
      '--data-root',
      join(root, 'data'),
      '--server',
      join(root, 's.sock'),
      '--json',
    ]);
    for (const argv of [
      ['--task', 'unavailable'],
      ['--workspace'],
      ['--json', '--json'],
      ['--unknown'],
    ])
      expect(() => sourceServerArguments(argv)).toThrow();
    for (const entry of ['cli', 'tui']) {
      for (const flag of ['--help', '--version']) {
        const result = await execute(
          [process.execPath, join(repositoryRoot, `scripts/release/entrypoints/${entry}.ts`), flag],
          root,
          home,
        );
        expect(result.code).toBe(0);
        expect(result.stdout.length).toBeGreaterThan(0);
      }
    }
    const cli = driver(root, 'CLI'),
      tui = driver(root, 'TUI'),
      server = driver(root, 'Server');
    const trace = join(root, 'trace.jsonl');
    writeFileSync(trace, '');
    expect((await execute([process.execPath, cli, 'trace', trace], root, home)).code).toBe(0);
    const nonTTY = await execute([process.execPath, tui], root, home);
    expect(nonTTY.code).toBe(1);
    expect(nonTTY.stderr).toBe('tui_terminal_unavailable\n');
    expect((await execute([process.execPath, server, '--help'], root, home)).code).toBe(0);
    const missing = await execute(
      [process.execPath, cli, 'run', '--task', 'must not start'],
      root,
      home,
    );
    expect(missing.code).toBe(1);
    expect(existsSync(join(home, '.kite-code'))).toBe(false);
    expect(existsSync(join(root, 'dist'))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);

test('fresh full candidate formal wrappers run, reuse daemon Web and shared 80x24 TUI with actual completed Run facts', async () => {
  const root = realpathSync(mkdtempSync('/private/tmp/kite-formal-terminal-')),
    home = join(root, 'home'),
    workspace = join(root, 'workspace'),
    candidate = sourceTerminalRoot(root);
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(workspace);
  const cli = driver(root, 'CLI'),
    tui = driver(root, 'TUI'),
    server = driver(root, 'Server'),
    socket = join(root, 'owned.sock');
  let calls = 0,
    started = false,
    stopped = false,
    databasePath = '';
  const directoryObservations: Record<string, unknown>[] = [];
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      if (request.method === 'GET' && new URL(request.url).pathname === '/directory-observation') {
        const db = new Database(databasePath, { readonly: true });
        try {
          directoryObservations.push({
            target: db
              .query(
                "SELECT id,delete_requested,control_revision FROM session WHERE id='resume-delete-target'",
              )
              .get(),
            active: db
              .query(
                "SELECT id,origin_command_id,cancel_requested FROM run WHERE session_id='formal-session' AND is_active=1",
              )
              .get(),
            deletions: db
              .query(
                "SELECT id,session_id,request_json,receipt_json FROM command WHERE kind='session.delete'",
              )
              .all(),
            calls,
          });
          return new Response('observed');
        } finally {
          db.close(true);
        }
      }
      const body = (await request.json()) as { messages: { role: string; content: string }[] };
      const user = body.messages.filter((m) => m.role === 'user').at(-1)!.content;
      expect(['formal source task', 'formal TUI task'].includes(user)).toBe(true);
      calls++;
      if (user === 'formal TUI task') {
        writeFileSync(join(root, 'tui-model-started'), 'original model waiting');
        while (!stopped && !existsSync(join(root, 'release-tui-model'))) await Bun.sleep(5);
      }
      const frame = (delta: unknown, finish_reason: string | null) =>
        `data: ${JSON.stringify({ id: 'formal', object: 'chat.completion.chunk', model: 'fixed', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      return new Response(
        frame(
          {
            content: user === 'formal source task' ? 'FORMAL CLI COMPLETE' : 'FORMAL TUI COMPLETE',
          },
          null,
        ) +
          frame({}, 'stop') +
          'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  let runtime = '';
  try {
    const built = await buildTerminalBundle({
      destination: candidate,
      repositoryRoot,
      bunExecutable: process.execPath,
    });
    expect(built.root).toBe(candidate);
    expect(built.buildId).toBe(`terminal-${built.digest}`);
    runtime = join(candidate, built.manifest.entries.runtime);
    const manifest = readFileSync(join(candidate, 'terminal-manifest.json'));
    const manifestPath = join(candidate, 'terminal-manifest.json');
    const wrongTarget = JSON.parse(manifest.toString('utf8'));
    wrongTarget.target.arch = process.arch === 'arm64' ? 'x64' : 'arm64';
    writeFileSync(manifestPath, JSON.stringify(wrongTarget));
    const wrongPlatform = await execute(
      [process.execPath, cli, 'server', 'start', '--server', socket],
      workspace,
      home,
    );
    expect(wrongPlatform.code).toBe(1);
    expect(wrongPlatform.stderr).toBe('terminal_target_mismatch\n');
    expect(existsSync(join(home, '.kite-code'))).toBe(false);
    writeFileSync(manifestPath, manifest);
    const protectedEntry = join(candidate, built.manifest.entries.service),
      entryBytes = readFileSync(protectedEntry);
    writeFileSync(
      protectedEntry,
      Buffer.concat([entryBytes, Buffer.from('\n//before-profile-tamper')]),
    );
    const earlyTamper = await execute(
      [process.execPath, cli, 'run', '--task', 'must not start'],
      workspace,
      home,
    );
    expect(earlyTamper.code).toBe(1);
    expect(earlyTamper.stderr).toContain('terminal_bundle_identity_mismatch');
    expect(existsSync(join(home, '.kite-code'))).toBe(false);
    writeFileSync(protectedEntry, entryBytes);

    const setup = join(root, 'setup.mjs'),
      dataRoot = join(home, '.kite-code', 'unified-agent');
    writeFileSync(
      setup,
      `import {selectProfile} from ${JSON.stringify(join(candidate, 'node_modules/@kite-ai/agent/profile.js'))};import {mkdirSync} from 'node:fs';const p=selectProfile({dataRoot:${JSON.stringify(dataRoot)},profile:'default'});mkdirSync(p.profilePath,{recursive:true,mode:0o700});console.log(JSON.stringify(p));`,
    );
    const prepared = await execute([runtime, setup], workspace, home);
    expect(prepared.code).toBe(0);
    const profile = JSON.parse(prepared.stdout) as { profilePath: string; databasePath: string };
    databasePath = profile.databasePath;
    mkdirSync(join(profile.profilePath, 'ui'), { recursive: true, mode: 0o700 });
    writeFileSync(join(profile.profilePath, 'ui/preferences.jsonc'), '{"language":"en-US"}', {
      mode: 0o600,
    });
    writeFileSync(
      join(profile.profilePath, 'config.jsonc'),
      JSON.stringify({
        modelId: 'fixed',
        tools: [],
        models: [
          {
            id: 'fixed',
            provider: 'compatible',
            model: 'fixed',
            baseURL: `${provider.url.href}v1`,
          },
        ],
      }),
      { mode: 0o600 },
    );
    const run = await execute(
      [
        process.execPath,
        cli,
        'run',
        '--thread',
        'formal-session',
        '--task',
        'formal source task',
        '--workspace',
        workspace,
        '--trust-workspace',
        '--full',
      ],
      workspace,
      home,
    );
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('FORMAL CLI COMPLETE');
    expect(calls).toBe(1);
    const read = join(root, 'read.mjs');
    writeFileSync(
      read,
      `import {openSqliteStore} from ${JSON.stringify(join(candidate, 'node_modules/@kite-ai/agent/sqlite.js'))};const s=await openSqliteStore({dataRoot:${JSON.stringify(dataRoot)},profile:'default',mode:'readonly'});try{const executions=await s.listExecutions('formal-session');const runs=await Promise.all([...new Set(executions.map(e=>e.runId))].map(id=>s.getRun(id)));console.log(JSON.stringify({session:await s.getSession('formal-session'),runs,executions,messages:await s.listMessages('formal-session')}));}finally{await s.close();}`,
    );
    const before = await execute([runtime, read], workspace, home);
    expect(before.code).toBe(0);
    const first = JSON.parse(before.stdout);
    expect(first.session.id).toBe('formal-session');
    expect(first.runs).toHaveLength(1);
    expect(first.runs[0].status).toBe('completed');
    expect(first.executions).toHaveLength(1);
    const launched = await execute(
      [process.execPath, server, '--server', socket, '--workspace', workspace, '--json'],
      workspace,
      home,
    );
    expect(launched.code).toBe(0);
    started = true;
    const lines = launched.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2);
    const identity = lines[0];
    expect(identity.state).toBe('accepting');
    expect(identity.runningBuildId).toBe(built.buildId);
    const web = lines[1];
    expect(web.instanceId).toBe(identity.instanceId);
    const webURL = new URL(web.url);
    expect(webURL.hostname).toBe('127.0.0.1');
    expect((await fetch(webURL)).status).toBe(200);
    const reused = await execute(
      [process.execPath, server, '--server', socket, '--workspace', workspace, '--json'],
      workspace,
      home,
    );
    expect(reused.code).toBe(0);
    const reusedLines = reused.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(reusedLines[0].reused).toBe(true);
    expect(reusedLines[0].instanceId).toBe(identity.instanceId);
    expect(reusedLines[1].url).toBe(web.url);
    const status = await execute(
      [process.execPath, cli, 'server', 'status', '--server', socket, '--json'],
      workspace,
      home,
    );
    expect(status.code).toBe(0);
    expect(JSON.parse(status.stdout).instanceId).toBe(identity.instanceId);
    const seedDirectory = join(root, 'seed-directory.mjs');
    writeFileSync(
      seedDirectory,
      `import {selectProfile} from ${JSON.stringify(join(candidate, 'node_modules/@kite-ai/agent/profile.js'))};import {requestDaemonBootstrap,selectDaemonEndpoint} from ${JSON.stringify(join(candidate, 'node_modules/@kite-ai/service/daemon.js'))};import {createClient} from ${JSON.stringify(join(candidate, 'node_modules/@kite-ai/client/index.js'))};const p=selectProfile({dataRoot:${JSON.stringify(dataRoot)},profile:'default'}),profile={dataRoot:p.dataRoot,name:p.profile,accessKey:p.profileAccessKey};const b=await requestDaemonBootstrap(selectDaemonEndpoint({profileAccessKey:p.profileAccessKey,explicitSocket:${JSON.stringify(socket)}}),profile);const c=createClient({endpoint:b.httpEndpoint,token:b.token,expected:{profile,apiMajor:1,instanceId:b.instanceId,buildId:b.buildId,requiredCapabilities:['sessions','commands']}});try{const info=await c.connect();await c.createSession({expectedStoreId:info.storeId,commandId:'create-resume-delete-target',sessionId:'resume-delete-target',workspaceId:${JSON.stringify(first.session.workspaceId)},title:'Directory delete target'});console.log('DIRECTORY_SEEDED');}finally{c.disposeNetwork();}`,
    );
    const seeded = await execute([runtime, seedDirectory], workspace, home);
    expect(seeded.code).toBe(0);
    expect(seeded.stdout).toContain('DIRECTORY_SEEDED');
    expect(calls).toBe(1);
    const program = `import os,pty,subprocess,select,time,signal,re,fcntl,termios,struct,urllib.request
signal.signal(signal.SIGTERM,lambda *_: (_ for _ in ()).throw(RuntimeError('owned PTY cancelled')))
master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',24,80,0,0));p=subprocess.Popen([${JSON.stringify(process.execPath)},${JSON.stringify(tui)},'--thread','formal-session','--workspace',${JSON.stringify(workspace)},'--server',${JSON.stringify(socket)}],env={'PATH':'/usr/bin:/bin','HOME':${JSON.stringify(home)},'LANG':'C.UTF-8','TERM':'xterm-256color'},stdin=slave,stdout=slave,stderr=slave,start_new_session=True);os.close(slave);buffer=b'';transcript=b''
def read_until(text, seconds):
 global buffer,transcript
 end=time.monotonic()+seconds
 while text not in re.sub(r'\\x1b\\[[0-?]*[ -/]*[@-~]','',buffer.decode(errors='replace')):
  if time.monotonic()>end:raise RuntimeError('formal PTY deadline '+buffer[-4000:].decode(errors='replace'))
  if select.select([master],[],[],.05)[0]:
   chunk=os.read(master,65536);buffer+=chunk;transcript+=chunk
def key(value,text):
 global buffer
 buffer=b'';os.write(master,value);read_until(text,10)
try:
 read_until('FORMAL CLI COMPLETE',10)
 read_until('New Run >',10)
 os.write(master,b'formal TUI task')
 read_until('formal TUI task',10)
 os.write(master,b'\\r')
 read_until('Working',10)
 end=time.monotonic()+10
 while not os.path.exists(${JSON.stringify(join(root, 'tui-model-started'))}):
  if time.monotonic()>end:raise RuntimeError('original model did not start')
  if select.select([master],[],[],.05)[0]:
   chunk=os.read(master,65536);buffer+=chunk;transcript+=chunk
 key(b'\\x12','Select Session (arrows/Enter, Esc)')
 read_until('Directory delete target [resume-delete-target]',10)
 key(b'\\x1b[B','> Directory delete target')
 key(b'd','Delete Session?');read_until('> Keep Session',10)
 key(b'\\r','Select Session (arrows/Enter, Esc)')
 urllib.request.urlopen(${JSON.stringify(`${provider.url.href}directory-observation`)}).read()
 key(b'd','Delete Session?');read_until('> Keep Session',10)
 key(b'\\x1b[B','> Delete Session')
 key(b'\\r','delete_requested');read_until('stop unconfirmed',10)
 urllib.request.urlopen(${JSON.stringify(`${provider.url.href}directory-observation`)}).read()
 key(b'\\x1b','Select Session (arrows/Enter, Esc)')
 key(b'\\x1b','Working')
 open(${JSON.stringify(join(root, 'release-tui-model'))},'w').write('explicit fixture release')
 read_until('FORMAL TUI COMPLETE',10)
 os.write(master,b'\\x11');end=time.monotonic()+5
 while p.poll() is None and time.monotonic()<end:
  if select.select([master],[],[],.05)[0]:
   try:buffer+=os.read(master,65536)
   except OSError:break
 p.wait(timeout=3);assert p.returncode==0;open(${JSON.stringify(join(root, 'pty-output'))},'wb').write(transcript);print('FORMAL_PTY_COMPLETE')
finally:
 open(${JSON.stringify(join(root, 'pty-output'))},'wb').write(transcript)
 if p.poll() is None:os.killpg(p.pid,signal.SIGKILL);p.wait()
 os.close(master)
`;
    const pty = await execute(['/usr/bin/python3', '-c', program], workspace, home);
    expect(pty.code).toBe(0);
    expect(pty.stdout).toContain('FORMAL_PTY_COMPLETE');
    expect(directoryObservations).toHaveLength(2);
    expect(directoryObservations[0]).toMatchObject({
      target: { id: 'resume-delete-target', delete_requested: 0, control_revision: 0 },
      active: { cancel_requested: 0 },
      deletions: [],
      calls: 2,
    });
    expect(directoryObservations[1]).toMatchObject({
      target: { id: 'resume-delete-target', delete_requested: 1, control_revision: 1 },
      active: directoryObservations[0]!.active,
      calls: 2,
    });
    const deletions = directoryObservations[1]!.deletions as {
      session_id: string;
      request_json: string;
      receipt_json: string;
    }[];
    expect(deletions).toHaveLength(1);
    expect(deletions[0]!.session_id).toBe('resume-delete-target');
    expect(JSON.parse(deletions[0]!.request_json)).toEqual({
      kind: 'session.delete',
      ifRevision: '0',
    });
    expect(JSON.parse(deletions[0]!.receipt_json)).toMatchObject({
      outcome: 'delete_requested',
      stopConfirmed: false,
      session: { id: 'resume-delete-target' },
    });
    const after = await execute([runtime, read], workspace, home);
    expect(after.code).toBe(0);
    const facts = JSON.parse(after.stdout);
    expect(facts.runs).toHaveLength(2);
    expect(facts.runs.every((r: { status: string }) => r.status === 'completed')).toBe(true);
    expect(facts.executions).toHaveLength(2);
    expect(calls).toBe(2);
    const publicRead = join(root, 'public-read.mjs');
    writeFileSync(
      publicRead,
      `import {selectProfile} from ${JSON.stringify(join(candidate, 'node_modules/@kite-ai/agent/profile.js'))};import {requestDaemonBootstrap,selectDaemonEndpoint} from ${JSON.stringify(join(candidate, 'node_modules/@kite-ai/service/daemon.js'))};import {createClient} from ${JSON.stringify(join(candidate, 'node_modules/@kite-ai/client/index.js'))};const p=selectProfile({dataRoot:${JSON.stringify(dataRoot)},profile:'default'}),profile={dataRoot:p.dataRoot,name:p.profile,accessKey:p.profileAccessKey};const b=await requestDaemonBootstrap(selectDaemonEndpoint({profileAccessKey:p.profileAccessKey,explicitSocket:${JSON.stringify(socket)}}),profile);const c=createClient({endpoint:b.httpEndpoint,token:b.token,expected:{profile,apiMajor:1,instanceId:b.instanceId,buildId:b.buildId,requiredCapabilities:['sessions','history']}});try{const info=await c.connect();console.log(JSON.stringify({storeId:info.storeId,view:await c.getView('formal-session'),runs:await Promise.all(${JSON.stringify(facts.runs.map((r: { id: string }) => r.id))}.map(id=>c.getRun(id)))}));}finally{c.disposeNetwork();}`,
    );
    const publicResult = await execute([runtime, publicRead], workspace, home);
    expect(publicResult.code).toBe(0);
    const actual = JSON.parse(publicResult.stdout);
    expect(actual.view).toMatchObject({
      storeId: actual.storeId,
      session: { id: 'formal-session', workspaceId: facts.session.workspaceId },
    });
    expect(actual.runs).toHaveLength(2);
    for (const run of actual.runs)
      expect(run).toMatchObject({
        originStoreId: actual.storeId,
        sessionId: 'formal-session',
        status: 'completed',
        isActive: false,
      });
    expect(calls).toBe(2);

    expect(readFileSync(join(candidate, 'terminal-manifest.json'))).toEqual(manifest);
    expect(verifyTerminalBundle(candidate).digest).toBe(built.digest);
    expect(
      (
        await execute(
          [process.execPath, cli, 'server', 'stop', '--server', socket],
          workspace,
          home,
        )
      ).code,
    ).toBe(0);
    started = false;
    const asset = join(candidate, built.manifest.entries.service),
      original = readFileSync(asset);
    writeFileSync(asset, Buffer.concat([original, Buffer.from('\n//tampered')]));
    const tampered = await execute(
      [process.execPath, cli, 'run', '--task', 'must never submit'],
      workspace,
      home,
    );
    expect(tampered.code).toBe(1);
    expect(tampered.stderr).toContain('terminal_bundle_identity_mismatch');
    writeFileSync(asset, original);
    console.log(
      JSON.stringify({
        qualification: 'formal-source-terminal',
        buildId: built.buildId,
        digest: built.digest,
        providerCalls: calls,
        sessionId: facts.session.id,
        runIds: facts.runs.map((r: { id: string }) => r.id),
        runStatuses: facts.runs.map((r: { status: string }) => r.status),
        daemonInstanceId: identity.instanceId,
        web,
      }),
    );
  } finally {
    stopped = true;
    if (started)
      await execute([process.execPath, cli, 'server', 'stop', '--server', socket], workspace, home);
    provider.stop(true);
    // Retain fresh physical candidate and PTY evidence for independent review; no profile authority escapes.
  }
}, 60000);
