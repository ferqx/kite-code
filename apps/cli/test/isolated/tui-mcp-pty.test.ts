import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { selectProfile } from '@kite-ai/agent/profile';
import { acquireProfileAccess, acquireProfileDataLock } from '@kite-ai/agent/profile-access';
import { createClient, requiresInteractionAttachment } from '@kite-ai/client';
import { launchPairedService } from '@kite-ai/service/paired';
import type { CLIServiceArtifact } from '../../host';
import { verifyTerminalBundle } from '../../host/terminal-artifact';
import { openTuiDraftFile } from '../../host/tui-drafts';

const repo = resolve(import.meta.dir, '../../../..');
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function until<T>(read: () => Promise<T | undefined>): Promise<T> {
  const deadline = performance.now() + 10_000;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (performance.now() > deadline) throw Error('owned_mcp_pty_deadline');
    await Bun.sleep(20);
  }
}

test('80x24 source-free MCP selection and clear preserve original pending work and complete history', async () => {
  const root = realpathSync(mkdtempSync('/private/tmp/kite-tui-mcp-pty-'));
  const evidenceRoot = `/private/tmp/kite-tui-mcp-pty-evidence-${randomUUID()}`;
  mkdirSync(evidenceRoot, { mode: 0o700 });
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { mode: 0o700 });
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'development' });
  let calls = 0,
    rpc = 0;
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      await request.json();
      calls++;
      const delta =
        calls === 1 || calls === 3
          ? { content: 'ORIGINAL_COMPLETE_HISTORY_TAIL' }
          : {
              tool_calls: [
                {
                  index: 0,
                  id: 'original-write',
                  type: 'function',
                  function: {
                    name: 'files.write',
                    arguments: JSON.stringify({
                      path: calls === 2 ? 'effect.txt' : 'effect-next.txt',
                      base: null,
                      content: 'owned authorized file effect',
                    }),
                  },
                },
              ],
            };
      return new Response(
        `data: ${JSON.stringify({ id: 'owned', object: 'chat.completion.chunk', model: 'fixed', choices: [{ index: 0, delta, finish_reason: calls === 1 || calls === 3 ? 'stop' : 'tool_calls' }] })}\n\ndata: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const remote = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch() {
      rpc++;
      return new Response('must not connect', { status: 500 });
    },
  });
  let observer: ReturnType<typeof createClient> | undefined;
  let python: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
  let stdout = '',
    stderr = '';
  let control: ReturnType<typeof Bun.serve> | undefined;
  const receipts: Record<string, unknown>[] = [];
  try {
    const build = Bun.spawn(
      [
        process.execPath,
        join(repo, 'scripts/release/terminal.ts'),
        'build',
        '--directory',
        join(root, 'candidate'),
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    const [buildOut, buildErr, buildExit] = await Promise.all([
      new Response(build.stdout).text(),
      new Response(build.stderr).text(),
      build.exited,
    ]);
    writeFileSync(join(evidenceRoot, 'candidate-build.log'), buildOut + buildErr);
    if (buildExit !== 0) throw Error('source_free_candidate_build_failed');
    const candidate = verifyTerminalBundle(join(root, 'candidate'));
    symlinkSync(join(candidate.root, 'node_modules'), join(root, 'node_modules'));
    const built = await Bun.build({
      entrypoints: [join(repo, 'apps/cli/test/fixtures/tui-mcp-pty.ts')],
      target: 'bun',
      packages: 'external',
      outdir: root,
    });
    expect(built.success).toBe(true);
    const entrypoint = join(root, 'tui-mcp-pty.js');
    const artifact: CLIServiceArtifact = {
      executable: candidate.artifact.executable,
      executableSha256: candidate.artifact.executableSha256,
      apiMajor: 1,
      entrypoint,
      entrypointSha256: sha(readFileSync(entrypoint)),
      buildId: `mcp-pty-${sha(readFileSync(entrypoint))}`,
    };
    writeFileSync(
      join(root, 'settings.json'),
      JSON.stringify({
        root,
        workspace,
        dataRoot: profile.dataRoot,
        mcpUrl: remote.url.href,
        artifact,
      }),
      { mode: 0o600 },
    );
    mkdirSync(join(profile.profilePath, 'ui'), { recursive: true, mode: 0o700 });
    writeFileSync(join(profile.profilePath, 'ui/preferences.jsonc'), '{"language":"en-US"}', {
      mode: 0o600,
    });
    const configPath = join(profile.profilePath, 'config.jsonc'),
      projectPath = join(workspace, 'kite-agent.jsonc');
    writeFileSync(
      configPath,
      `// USER COMMENT\n${JSON.stringify({ unknown: { keep: true }, modelId: 'fixed', tools: [{ id: 'files.write', definitionVersion: '2' }], models: [{ id: 'fixed', provider: 'compatible', model: 'fixed', baseURL: `${provider.url.href}v1` }], mcp: [{ id: 'owned-server', enabled: false }] })}\n`,
      { mode: 0o600 },
    );
    writeFileSync(projectPath, '// PROJECT COMMENT\n{"unknown":42}\n', { mode: 0o600 });
    const seed = await launchPairedService({
      profile,
      ...artifact,
      instanceId: randomUUID(),
      requiredCapabilities: ['sessions', 'commands', 'permission_controls'],
    });
    let storeId = '',
      historyIds: string[] = [];
    try {
      if (!seed.bootstrap.storeId) throw Error('seed_store_unavailable');
      storeId = seed.bootstrap.storeId;
      await seed.client.createWorkspace({
        expectedStoreId: storeId,
        id: 'w',
        rootUri: pathToFileURL(workspace).href,
        name: 'owned',
      });
      for (const id of ['a', 'b'])
        await seed.client.createSession({
          expectedStoreId: storeId,
          commandId: `create-${id}`,
          sessionId: id,
          workspaceId: 'w',
          title: id,
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
      const mode = await seed.client.getPermissionMode('a', { storeId });
      await seed.client.setPermissionMode('a', {
        expectedStoreId: storeId,
        commandId: 'ask',
        ifRevision: mode.revision,
        mode: 'ask',
        makeDefault: false,
        ifDefaultRevision: mode.defaultRevision,
      });
      await seed.client.startRun('a', {
        expectedStoreId: storeId,
        commandId: 'original-history',
        kind: 'run.start',
        content: 'complete original history',
      });
      await until(async () => {
        const view = await seed.client.getView('a');
        return view.runs.length === 1 && view.runs[0]!.status === 'completed' ? view : undefined;
      });
      historyIds = (await seed.client.getView('a')).messages.map((message) => message.id);
    } finally {
      await seed.close();
    }
    const access = acquireProfileAccess(profile);
    try {
      const draft = openTuiDraftFile({
        access,
        acquireWriteLock: () => acquireProfileDataLock(access, 'tui_private'),
      });
      try {
        draft.save({ storeId, workspaceId: 'w', sessionId: 'b' }, '0', 'PRESERVED_PRIVATE_DRAFT');
      } finally {
        draft.close();
      }
    } finally {
      access.lock.release();
    }
    const initialConfig = readFileSync(configPath, 'utf8');
    let originalCompleted = false;
    let expectedCalls = 2;
    let clearMessages = '';
    let originalRun = '',
      originalCard = '',
      originalRevision = '',
      originalCommand = '';
    async function connected() {
      if (observer) return observer;
      const privateRow = JSON.parse(readFileSync(join(root, 'observer-private.json'), 'utf8')) as {
        endpoint: string;
        token: string;
      };
      observer = createClient({
        ...privateRow,
        expected: {
          profile: {
            dataRoot: profile.dataRoot,
            name: profile.profile,
            accessKey: profile.profileAccessKey,
          },
          apiMajor: 1,
          requiredCapabilities: ['sessions', 'commands', 'interactions'],
        },
      });
      await observer.connect();
      return observer;
    }
    async function preserved() {
      const client = await connected(),
        view = await client.getView('a');
      const active = view.runs.find((run) => run.id === originalRun);
      if (
        !active ||
        (originalCompleted
          ? active.status !== 'completed'
          : !active.isActive || active.status !== 'waiting_interaction')
      )
        throw Error('original_run_changed');
      const cards = await client.listInteractions('a', {
        storeId,
        state: originalCompleted ? 'answered' : 'pending',
        limit: 20,
      });
      const card = cards.interactions.find((row) => row.id === originalCard);
      if (!card || card.revision !== originalRevision) throw Error('original_interaction_changed');
      if (!historyIds.every((id) => view.messages.some((message) => message.id === id)))
        throw Error('original_history_removed');
      if ((await client.getCommand(originalCommand)).cancelRequestedAt !== null)
        throw Error('original_command_cancelled');
      if (
        calls !== expectedCalls ||
        rpc !== 0 ||
        existsSync(join(root, 'credential-io')) ||
        existsSync(join(root, 'mcp-admit')) ||
        existsSync(join(workspace, 'effect-next.txt'))
      )
        throw Error('read_caused_effect');
      const drafts = JSON.parse(readFileSync(join(profile.profilePath, 'ui/tui.json'), 'utf8')) as {
        drafts: { sessionId: string; text: string }[];
      };
      if (
        !drafts.drafts.some(
          (row) => row.sessionId === 'b' && row.text === 'PRESERVED_PRIVATE_DRAFT',
        )
      )
        throw Error('private_draft_removed');
      return view;
    }
    control = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        try {
          const path = new URL(request.url).pathname,
            client = await connected();
          if (path === '/baseline') {
            const view = await client.getView('a'),
              run = view.runs.find((row) => row.isActive)!;
            originalRun = run.id;
            originalCommand = run.originCommandId;
            const cards = await client.listInteractions('a', {
              storeId,
              state: 'pending',
              limit: 20,
            });
            const card = cards.interactions.find((row) => row.runId === originalRun)!;
            originalCard = card.id;
            originalRevision = card.revision;
          } else if (path === '/before-confirm') {
            if (readFileSync(configPath, 'utf8') !== initialConfig)
              throw Error('confirmation_wrote_early');
          } else if (path === '/approve-job') {
            const ledger = readFileSync(join(root, 'http-ledger.jsonl'), 'utf8')
              .trim()
              .split('\n')
              .map((row) => JSON.parse(row)) as {
              method: string;
              body?: { commandId?: string; kind?: string };
            }[];
            const posts = ledger.filter(
              (row) => row.method === 'POST' && row.body?.kind === 'extension.invoke',
            );
            if (posts.length !== 1) throw Error('mcp_post_count');
            const queued = await client.getCommand(posts[0]!.body!.commandId!);
            receipts.push({ stage: 'queued_original_mcp_observed', command: queued });
            if (queued.status !== 'accepted' || readFileSync(configPath, 'utf8') !== initialConfig)
              throw Error('queued_mcp_misreported');
            await preserved();
            receipts.push({
              stage: 'accepted_before_original_completion',
              commandId: queued.id,
              status: queued.status,
              receipt: queued.receipt,
            });
            const original = (
              await client.listInteractions('a', { storeId, state: 'pending', limit: 20 })
            ).interactions.find((row) => row.id === originalCard)!;
            if (requiresInteractionAttachment(original))
              await client.readInteractionAttachment(original);
            await client.answerInteraction('a', original.id, {
              expectedStoreId: storeId,
              commandId: 'approve-owned-original-file',
              expectedRevision: original.revision,
              answer: { kind: 'approval', decision: 'approve', grant: 'approve_once' },
            });
            await until(async () => {
              const run = await client.getRun(originalRun);
              return run.status === 'completed' ? run : undefined;
            });
            const answeredOriginal = (
              await client.listInteractions('a', { storeId, state: 'answered', limit: 20 })
            ).interactions.find((row) => row.id === originalCard);
            if (!answeredOriginal) throw Error('original_answer_unconfirmed');
            originalRevision = answeredOriginal.revision;
            originalCompleted = true;
            expectedCalls = 3;
            const command = await until(async () => {
              const row = await client.getCommand(posts[0]!.body!.commandId!);
              return row.status === 'applied' ? row : undefined;
            });
            const executionId = (command.receipt as { executionId: string }).executionId;
            const card = await until(async () =>
              (
                await client.listInteractions('a', { storeId, state: 'pending', limit: 20 })
              ).interactions.find((row) => row.executionId === executionId),
            );
            if (requiresInteractionAttachment(card)) await client.readInteractionAttachment(card);
            await client.answerInteraction('a', card.id, {
              expectedStoreId: storeId,
              commandId: 'approve-original-mcp-job',
              expectedRevision: card.revision,
              answer: { kind: 'approval', decision: 'approve', grant: 'approve_once' },
            });
            const execution = await until(async () => {
              const row = await client.getExecution(executionId);
              return row.status === 'succeeded' ? row : undefined;
            });
            receipts.push({
              commandId: command.id,
              executionId: execution.id,
              result: execution.result,
            });
          } else if (path === '/new-pending') {
            const commandId = 'second-pending-work';
            await client.startRun('a', {
              expectedStoreId: storeId,
              commandId,
              kind: 'run.start',
              content: 'second owned pending task',
            });
            const view = await until(async () => {
              const row = await client.getView('a');
              return row.runs.some(
                (run) => run.originCommandId === commandId && run.status === 'waiting_interaction',
              )
                ? row
                : undefined;
            });
            const run = view.runs.find((run) => run.originCommandId === commandId)!;
            originalRun = run.id;
            originalCommand = commandId;
            originalCompleted = false;
            expectedCalls = 4;
            const card = (
              await client.listInteractions('a', { storeId, state: 'pending', limit: 20 })
            ).interactions.find((row) => row.runId === originalRun)!;
            originalCard = card.id;
            originalRevision = card.revision;
            clearMessages = JSON.stringify(view.messages);
          }
          const view = await preserved();
          if (
            (path === '/clear' || path === '/draft-clear') &&
            JSON.stringify(view.messages) !== clearMessages
          )
            throw Error('clear_changed_complete_history');
          receipts.push({
            stage: path,
            storeId,
            originalRun,
            originalCommand,
            originalCard,
            originalRevision,
            calls,
            rpc,
          });
          return Response.json({ passed: true });
        } catch (error) {
          writeFileSync(
            join(evidenceRoot, 'control-error.json'),
            JSON.stringify({
              path: new URL(request.url).pathname,
              code: error instanceof Error ? error.message : 'unknown',
            }),
          );
          return new Response(error instanceof Error ? error.message : 'control_failed', {
            status: 500,
          });
        }
      },
    });
    const program = `import os,pty,subprocess,select,time,fcntl,termios,struct,re,json,urllib.request
m,s=pty.openpty();fcntl.ioctl(s,termios.TIOCSWINSZ,struct.pack('HHHH',24,80,0,0));p=subprocess.Popen([${JSON.stringify(artifact.executable)},${JSON.stringify(entrypoint)}],stdin=s,stdout=s,stderr=s,start_new_session=True);os.close(s);b=b'';all_output=b''
def wait(text):
 global b,all_output
 end=time.monotonic()+10
 while text not in re.sub(r'\\s+',' ',re.sub(r'\\x1b\\[[0-?]*[ -/]*[@-~]','',b.decode(errors='replace'))):
  if p.poll() is not None:raise RuntimeError('early exit '+b[-3000:].decode(errors='replace'))
  if time.monotonic()>end:raise RuntimeError('expected '+text+' tail='+b[-5000:].decode(errors='replace'))
  if select.select([m],[],[],.05)[0]:
   data=os.read(m,65536);b+=data;all_output+=data
def receive(timeout=.05):
 global b,all_output
 if select.select([m],[],[],timeout)[0]:
  data=os.read(m,65536);b+=data;all_output+=data
def drain(deadline):
 reads=0
 while select.select([m],[],[],0)[0]:
  if reads>=16 or time.monotonic()>deadline:raise RuntimeError('owned_frame_drain_deadline')
  receive(0);reads+=1
def wait_draft(text):
 end=time.monotonic()+10
 while True:
  drain(end)
  frames=b.decode(errors='replace').split(chr(27)+'[?2026h')
  complete=next((frame.split(chr(27)+'[?2026l')[0] for frame in reversed(frames[1:]) if chr(27)+'[?2026l' in frame),'')
  frame=re.sub(re.escape(chr(27)+'[')+r'[0-?]*[ -/]*[@-~]','',complete)
  footer=frame.rsplit('Development TUI ·',1)[-1]
  if 'Session a ·' in footer and ' · Loading' not in footer and text in footer.splitlines():return
  if p.poll() is not None:raise RuntimeError('early exit before current draft')
  if time.monotonic()>end:raise RuntimeError('expected current draft '+text+' tail='+footer[-5000:])
  receive()
def key(value):
 global b
 drain(time.monotonic()+10)
 b=b'';os.write(m,value)
def check(path):
 try:
  with urllib.request.urlopen(${JSON.stringify(control.url.href)}+path,timeout=12) as response:assert json.load(response)['passed']
 except urllib.error.HTTPError as error:raise RuntimeError(path+' '+error.read().decode())
try:
 wait('New Run');key(b'owned pending task');wait('owned pending task');key(b'\\r');wait('approval [');check('baseline')
 key(b'/mcp');wait_draft('/mcp');key(b'\\r');wait('owned-server');wait('Reading this list does not connect');wait('Server list ready');key(b'\\x1b[B');wait('› owned-server ·');key(b'\\r');wait('Server: owned-server');wait('User settings');wait('Project settings');key(b'\\x1b[B');wait('› Enable · User settings');check('read-detail')
 key(b'\\r');wait('Confirm server change:');wait('Enter saves; Esc abandons');check('before-confirm');key(b'\\r');wait('Waiting for original result');check('approve-job')
 key(b'\\x1b[B'*2);wait('› Check original change');key(b'\\r');wait('Selection saved');key(b'\\x1b');wait('New Run');check('new-pending');wait('approval [');check('esc')
 key(b'/mcp');wait_draft('/mcp');key(b'\\r');wait('owned-server');wait('Server list ready');key(b'\\x1b[B');wait('› owned-server ·');key(b'\\r');wait('Server: owned-server');key(b'\\x1b[B'*3);wait('› Refresh servers');key(b'\\r');wait('owned-server');check('refresh');key(b'\\x03');wait('Up/Down explicit approval selection: none');check('ctrl-c')
 assert b'ORIGINAL_COMPLETE_HISTORY_TAIL' in all_output
 key(b'/clear');wait('/clear');key(b'\\r');wait('Up/Down explicit approval selection: none');check('clear');assert b'ORIGINAL_COMPLETE_HISTORY_TAIL' not in re.sub(rb'\\x1b\\[[0-?]*[ -/]*[@-~]',b'',b)
 key(b'PRIVATE_CARD_DRAFT');wait('PRIVATE_CARD_DRAFT');key(b'\\x0c');wait('PRIVATE_CARD_DRAFT');check('draft-clear');key(b'\\x11')
 end=time.monotonic()+6
 while p.poll() is None and time.monotonic()<end:
  if select.select([m],[],[],.05)[0]:
   try:all_output+=os.read(m,65536)
   except OSError:break
 p.wait(timeout=3);assert p.returncode==0;print(json.dumps({'pty':True,'columns':80,'rows':24,'pid':p.pid,'exit':p.returncode}))
finally:
 with open(${JSON.stringify(join(evidenceRoot, 'terminal.txt'))},'wb') as f:f.write(all_output)
 if p.poll() is None:os.killpg(p.pid,9);p.wait(timeout=5)
 os.close(m)
`;
    python = Bun.spawn(['python3', '-c', program], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      cwd: root,
      env: { PATH: process.env.PATH ?? '', HOME: join(root, 'home'), TMPDIR: root },
    });
    const outputs = await Promise.all([
      new Response(python.stdout).text(),
      new Response(python.stderr).text(),
      python.exited,
    ]);
    stdout = outputs[0];
    stderr = outputs[1];
    expect(outputs[2]).toBe(0);
    expect(stderr).toBe('');
    expect(JSON.parse(stdout)).toMatchObject({ pty: true, columns: 80, rows: 24, exit: 0 });
    expect(receipts.some((row) => row.stage === '/clear')).toBe(true);
    expect(receipts.some((row) => row.stage === '/draft-clear')).toBe(true);
    expect(calls).toBe(4);
    expect(rpc).toBe(0);
    expect(readFileSync(join(workspace, 'effect.txt'), 'utf8')).toBe(
      'owned authorized file effect',
    );
    expect(existsSync(join(workspace, 'effect-next.txt'))).toBe(false);
    expect(readFileSync(configPath, 'utf8')).toContain('// USER COMMENT');
    expect(readFileSync(configPath, 'utf8')).toContain('"keep":true');
    expect(readFileSync(configPath, 'utf8')).toContain('"enabled":true');
    expect(readFileSync(projectPath, 'utf8')).toBe('// PROJECT COMMENT\n{"unknown":42}\n');
    const pid = Number(readFileSync(join(root, 'owned-pid'), 'utf8'));
    expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
    expect(() => process.kill(pid, 0)).toThrow();
    const uiRequests = readFileSync(join(root, 'http-ledger.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((row) => JSON.parse(row)) as {
      method: string;
      path: string;
      body?: { kind?: string };
    }[];
    expect(
      uiRequests.filter((row) => row.method === 'POST' && row.body?.kind === 'extension.invoke'),
    ).toHaveLength(1);
    expect(
      uiRequests.filter(
        (row) =>
          row.method === 'POST' &&
          (row.path.endsWith('/cancel') ||
            ['run.cancel', 'command.cancel'].includes(row.body?.kind ?? '')),
      ),
    ).toHaveLength(0);
    const reopened = await launchPairedService({
      profile,
      ...artifact,
      instanceId: randomUUID(),
      requiredCapabilities: ['sessions', 'commands'],
    });
    try {
      expect(reopened.bootstrap.storeId).toBe(storeId);
      expect((await reopened.client.getView('a')).messages.map((row) => row.id)).toEqual(
        expect.arrayContaining(historyIds),
      );
      expect(calls).toBe(4);
    } finally {
      await reopened.close();
    }
    writeFileSync(join(evidenceRoot, 'helper.js'), readFileSync(entrypoint));
    writeFileSync(join(evidenceRoot, 'user-config.jsonc'), readFileSync(configPath));
    writeFileSync(join(evidenceRoot, 'project-config.jsonc'), readFileSync(projectPath));
    writeFileSync(
      join(evidenceRoot, 'receipts.json'),
      JSON.stringify(
        {
          candidateId: candidate.candidateId,
          helperSha256: artifact.entrypointSha256,
          storeId,
          historyIds,
          ownedServicePid: pid,
          tui: JSON.parse(stdout),
          uiMcpPostCount: uiRequests.filter(
            (row) => row.method === 'POST' && row.body?.kind === 'extension.invoke',
          ).length,
          receipts,
          calls,
          rpc,
          cleanupConfirmed: true,
        },
        null,
        2,
      ),
    );
    console.log(
      JSON.stringify({
        case: 'actual_mcp_pty_clear',
        evidenceRoot,
        storeId,
        originalRun,
        originalCommand,
        originalCard,
        calls,
        rpc,
        helperSha256: artifact.entrypointSha256,
      }),
    );
  } finally {
    writeFileSync(join(evidenceRoot, 'stage-receipts.json'), JSON.stringify(receipts, null, 2));
    writeFileSync(join(evidenceRoot, 'stdout.log'), stdout);
    writeFileSync(join(evidenceRoot, 'stderr.log'), stderr);
    if (existsSync(join(root, 'startup-ledger')))
      writeFileSync(
        join(evidenceRoot, 'startup-ledger'),
        readFileSync(join(root, 'startup-ledger')),
      );
    if (existsSync(join(root, 'http-ledger.jsonl')))
      writeFileSync(
        join(evidenceRoot, 'http-ledger.jsonl'),
        readFileSync(join(root, 'http-ledger.jsonl')),
      );
    if (python?.exitCode === null) {
      python.kill('SIGKILL');
      await python.exited;
    }
    observer?.disposeNetwork();
    await control?.stop(true);
    await provider.stop(true);
    await remote.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 180000);
