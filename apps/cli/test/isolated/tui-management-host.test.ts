import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { selectProfile } from '@kite-ai/agent/profile';
import { launchPairedService } from '@kite-ai/service/paired';
import type { CLIServiceArtifact } from '../../host';

const repo = resolve(import.meta.dir, '../../../..');
test('actual development PTY slash routes manage Session/Fork/current Context and manual compression without replay', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-tui-management-'))),
    profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'development' });
  const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex'),
    entrypoint = join(repo, 'apps/service/dist/main.js'),
    entrypointSha256 = sha(readFileSync(entrypoint));
  const artifact: CLIServiceArtifact = {
    entrypoint,
    entrypointSha256,
    executable: realpathSync(process.execPath),
    executableSha256: sha(readFileSync(process.execPath)),
    buildId: `development-${entrypointSha256}`,
    apiMajor: 1,
  };
  let stopped = false;
  let calls = 0,
    summaryFullInput = false,
    summaryFocus = false,
    followupFullInput = false;
  const rewindObservations: unknown[] = [];
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      if (request.method === 'GET' && new URL(request.url).pathname === '/rewind-observation') {
        const db = new Database(profile.databasePath, { readonly: true });
        try {
          rewindObservations.push({
            commands: db.query('SELECT count(*) AS n FROM command').get(),
            executions: db.query('SELECT count(*) AS n FROM execution').get(),
            session: db
              .query(
                "SELECT workspace_id,context_selection_id,control_revision,next_seq FROM session WHERE id='a'",
              )
              .get(),
            calls,
          });
          return new Response('observed');
        } finally {
          db.close();
        }
      }
      const body = JSON.stringify(await request.json());
      calls++;
      if (calls === 2 && body.includes('ORIGINAL_FULL_TAIL')) summaryFullInput = true;
      if (calls === 2 && body.includes('preserve original facts')) summaryFocus = true;
      if (
        calls === 3 &&
        body.includes('Queued after maintenance') &&
        body.includes('Summary of owned task')
      )
        followupFullInput = true;
      if (calls === 2)
        while (!stopped && !existsSync(join(root, 'release-summary'))) await Bun.sleep(5);
      const content =
        calls === 1
          ? `${'Original factual text. '.repeat(2000)}\n\nORIGINAL_FULL_TAIL`
          : calls === 2
            ? 'Summary of owned task and original answer.'
            : 'FOLLOWUP_COMPLETED';
      const frame = (delta: unknown, finish_reason: string | null) =>
        `data: ${JSON.stringify({ id: 'local', object: 'chat.completion.chunk', model: 'fixed', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      return new Response(`${frame({ content }, null)}${frame({}, 'stop')}data: [DONE]\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });
  try {
    mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
    // This fixture asserts English labels independently of the host device locale.
    mkdirSync(join(profile.profilePath, 'ui'), { recursive: true, mode: 0o700 });
    writeFileSync(join(profile.profilePath, 'ui/preferences.jsonc'), '{"language":"en-US"}', {
      mode: 0o600,
    });
    writeFileSync(
      join(profile.profilePath, 'config.jsonc'),
      JSON.stringify({
        modelId: 'fixed',
        tools: [],
        compression: { automatic: false, validateExpanded: true },
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
    const seed = await launchPairedService({
      profile,
      ...artifact,
      instanceId: crypto.randomUUID(),
      requiredCapabilities: ['sessions', 'context', 'commands'],
    });
    try {
      if (seed.bootstrap.dataAvailability !== 'available') throw Error('unavailable');
      const expectedStoreId = seed.bootstrap.storeId;
      await seed.client.createWorkspace({
        expectedStoreId,
        id: 'w',
        rootUri: `file://${root}`,
        name: 'owned',
      });
      // Dynamic slash resolution reads only the trusted original workspace catalogue.
      const trust = await seed.client.getWorkspaceTrust('w', { storeId: expectedStoreId });
      await seed.client.setWorkspaceTrust('w', {
        expectedStoreId,
        commandId: 'trust-owned-workspace',
        ifRevision: trust.revision,
        trusted: true,
        canonicalIdentity: trust.canonicalIdentity,
        externalReadScopeDigest: trust.externalReadScopeDigest,
      });
      await seed.client.createSession({
        expectedStoreId,
        commandId: 'create',
        sessionId: 'a',
        workspaceId: 'w',
        title: 'old',
      });
    } finally {
      await seed.close();
    }
    const program = `import os,pty,subprocess,select,time,signal,re,fcntl,termios,struct,urllib.request
master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',24,80,0,0))
p=subprocess.Popen([${JSON.stringify(process.execPath)},${JSON.stringify(join(repo, 'scripts/development/unified-tui.ts'))},'--thread','a','--data-root',${JSON.stringify(profile.dataRoot)}],stdin=slave,stdout=slave,stderr=slave,start_new_session=True)
os.close(slave);buffer=b''
def wait(text):
 global buffer
 deadline=time.monotonic()+10
 while text not in re.sub(r'\\s+',' ',re.sub(r'\\x1b\\[[0-?]*[ -/]*[@-~]','',buffer.decode(errors='replace'))):
  if time.monotonic()>deadline: raise RuntimeError('expected '+text+' tail='+buffer[-3000:].decode(errors='replace'))
  if select.select([master],[],[],.1)[0]: buffer+=os.read(master,65536)
def send(text):
 global buffer
 buffer=b'';os.write(master,text.encode());wait(text);buffer=b'';os.write(master,b'\\r')
def pump():
 global buffer
 end=time.monotonic()+.5
 while time.monotonic()<end:
  if select.select([master],[],[],.05)[0]: buffer+=os.read(master,65536)
try:
 wait('New Run');send('Owned ordinary task');wait('ORIGINAL_FULL_TAIL');pump()
 send('/session rename Managed title');wait('session.rename: applied');pump()
 send('/context');wait('Current selected Context projection');wait('frozen upper');os.write(master,b'\\x1b');pump()
 send('/compact preserve original facts');wait('context.compress: accepted');pump();send('Queued after maintenance');wait('input.follow_up');open(${JSON.stringify(join(root, 'release-summary'))},'w').write('explicit fixture release');pump();os.write(master,b'\\x0b');wait('FOLLOWUP_COMPLETED');pump();os.write(master,b'\\x0b');wait('context.compress: applied');pump()
 send('/compact reset');pump();os.write(master,b'\\x0b');wait('context.compression.reset: failed');os.write(master,b'\\x1b');pump()
 urllib.request.urlopen(${JSON.stringify(`${provider.url.href}rewind-observation`)}).read()
 send('/rewind');wait('Files recovery:');wait('R reloads readonly directory. Esc closes.');os.write(master,b'\\x1b');pump()
 urllib.request.urlopen(${JSON.stringify(`${provider.url.href}rewind-observation`)}).read()
 send('/unknown');wait('tui_command_unavailable');pump()
 for remaining in range(len('/unknown')-1,-1,-1):
  buffer=b'';os.write(master,b'\\x7f');wait('New Run >'+(' '+('/unknown'[:remaining]) if remaining else ''))
 send('/session fork Forked scope');wait('session.fork: applied');pump()
 send('/session delete confirm');wait('delete_requested');wait('stop unconfirmed');pump()
 os.write(master,b'\\x11');
 deadline=time.monotonic()+6
 while p.poll() is None and time.monotonic()<deadline:
  if select.select([master],[],[],.1)[0]:
   try: buffer+=os.read(master,65536)
   except OSError: break
 p.wait(timeout=3);assert p.returncode==0
 os.close(master)
 master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',24,80,0,0))
 p=subprocess.Popen([${JSON.stringify(process.execPath)},${JSON.stringify(join(repo, 'scripts/development/unified-tui.ts'))},'--thread','a','--data-root',${JSON.stringify(profile.dataRoot)}],stdin=slave,stdout=slave,stderr=slave,start_new_session=True)
 os.close(slave);buffer=b''
 wait('New Run');send('/exit')
 deadline=time.monotonic()+6
 while p.poll() is None and time.monotonic()<deadline:
  if select.select([master],[],[],.1)[0]:
   try: buffer+=os.read(master,65536)
   except OSError: break
 p.wait(timeout=3);assert p.returncode==0
 print('SLASH_COMPLETE_ZERO_REPLAY')
finally:
 if p.poll() is None: os.killpg(p.pid,signal.SIGKILL);p.wait()
 os.close(master)
`;
    const child = Bun.spawn(['python3', '-c', program], { stdout: 'pipe', stderr: 'pipe' });
    const [out, err, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exit !== 0) {
      console.error(err);
      const db = new Database(profile.databasePath, { readonly: true });
      try {
        console.error(
          JSON.stringify({
            commands: db.query('SELECT id,kind,status,receipt_json FROM command').all(),
            runs: db.query('SELECT id,status,reason,origin_command_id FROM run').all(),
            sessions: db.query('SELECT id,next_seq,context_selection_id FROM session').all(),
            messages: db.query('SELECT id,seq,status,source_json FROM message ORDER BY seq').all(),
            models: db
              .query(
                "SELECT id,run_id,state,decision_source_json FROM execution WHERE kind='model'",
              )
              .all(),
            compressions: db
              .query("SELECT id,seq,request_json FROM context_snapshot WHERE kind='compression'")
              .all(),
            calls,
          }),
        );
      } finally {
        db.close();
      }
    }
    expect(exit).toBe(0);
    expect(err).toBe('');
    expect(out).toContain('SLASH_COMPLETE_ZERO_REPLAY');
    expect(calls).toBe(3);
    expect(followupFullInput).toBe(true);
    expect(summaryFullInput).toBe(true);
    expect(summaryFocus).toBe(true);
    expect(rewindObservations).toHaveLength(2);
    expect(rewindObservations[1]).toEqual(rewindObservations[0]);
    const db = new Database(profile.databasePath, { readonly: true });
    try {
      expect(db.query("SELECT title FROM session WHERE id='a'").get()).toEqual({
        title: 'Managed title',
      });
      expect(
        db
          .query(
            "SELECT count(*) AS n FROM session WHERE title='Forked scope' AND deleted_at IS NOT NULL",
          )
          .get(),
      ).toEqual({ n: 1 });
      const fork = db
        .query(
          "SELECT c.receipt_json FROM command c JOIN session s ON s.id=json_extract(c.receipt_json,'$.sessionId') WHERE c.kind='session.create' AND s.title='Forked scope'",
        )
        .get() as { receipt_json: string };
      const receipt = JSON.parse(fork.receipt_json);
      expect(receipt.sourceSessionId).toBe('a');
      expect(receipt.sourceSelectionId).toBe(
        (
          db.query("SELECT context_selection_id FROM session WHERE id='a'").get() as {
            context_selection_id: string;
          }
        ).context_selection_id,
      );
      expect(receipt.omittedExtensionState).toBe(false);
      expect(receipt.namespaceReport).toEqual([]);
      expect(
        db
          .query(
            "SELECT count(*) AS n FROM command WHERE json_extract(request_json,'$.content')='/unknown'",
          )
          .get(),
      ).toEqual({ n: 0 });
      expect(db.query("SELECT count(*) AS n FROM execution WHERE kind!='model'").get()).toEqual({
        n: 0,
      });
      expect(
        db
          .query(
            "SELECT count(*) AS n FROM run r JOIN command c ON c.id=r.origin_command_id WHERE r.session_id='a' AND r.status='completed' AND json_extract(c.request_json,'$.content') IN ('Owned ordinary task','Queued after maintenance')",
          )
          .get(),
      ).toEqual({ n: 2 });
      expect(
        db
          .query(
            "SELECT count(*) AS n FROM context_snapshot WHERE kind='compression' AND session_id='a'",
          )
          .get(),
      ).toEqual({ n: 1 });
    } finally {
      db.close();
    }
  } finally {
    stopped = true;
    provider.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 40000);
