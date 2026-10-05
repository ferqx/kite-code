import { expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { createStdioPermissionReader, promptPermissionMode } from '../../src/permissions';
import { recoveryProfile } from '../fixtures/recovery-profile';

const repo = resolve(import.meta.dir, '../../../..');
test('80x24 actual composer edits graphemes and bracketed paste without premature POST or placeholder content', async () => {
  const f = await recoveryProfile();
  let python: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
  let relay: ReturnType<typeof Bun.serve> | undefined;
  let closing = false;
  const transcript = `${f.root}-composer.pty.log`;
  try {
    const preparation = await f.launch();
    try {
      await preparation.client.recoverSession('s', {
        kind: 'session.recover',
        expectedStoreId: f.storeId,
        commandId: 'composer-preparation',
        decision: 'interrupt',
      });
      await preparation.client.createSession({
        expectedStoreId: f.storeId,
        commandId: 'composer-session',
        sessionId: 'composer',
        workspaceId: 'w',
        title: 'Composer',
      });
      const reader = createStdioPermissionReader(Readable.from(['ask\n']));
      try {
        await promptPermissionMode('composer', f.storeId, reader, {
          client: preparation.client,
          write() {},
        });
      } finally {
        reader.dispose();
      }
    } finally {
      await preparation.close();
    }
    const configPath = join(f.profile.profilePath, 'config.jsonc'),
      config = JSON.parse(readFileSync(configPath, 'utf8')),
      originalURL = config.models[0].baseURL;
    let relayed = 0;
    relay = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const bytes = await request.arrayBuffer();
        relayed++;
        if (relayed === 1) {
          writeFileSync(join(f.root, 'composer-model-entered'), 'owned real SDK request');
          while (!existsSync(join(f.root, 'composer-model-release')) && !closing)
            await Bun.sleep(5);
        }
        if (closing) throw Error('owned fixture closed');
        const headers = new Headers(request.headers);
        for (const name of ['host', 'connection', 'content-length', 'transfer-encoding'])
          headers.delete(name);
        return fetch(originalURL + '/chat/completions', {
          method: 'POST',
          headers,
          body: bytes,
        });
      },
    });
    config.models[0].baseURL = relay.url.href + 'v1';
    writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
    const network = join(f.root, 'composer-network'),
      runner = join(f.root, 'composer-runner.ts');
    const paste = '真实第一行🙂e\u0301\r\n' + '完整中文尾部'.repeat(70) + '\nEND_ORIGINAL_PASTE';
    const expected = '首前中🙂改后' + paste;
    writeFileSync(
      runner,
      `import{appendFileSync}from'node:fs';import{runTUIHost}from${JSON.stringify(join(repo, 'apps/cli/host/tui.tsx'))};const actual=globalThis.fetch;globalThis.fetch=Object.assign(async(...args:Parameters<typeof fetch>)=>{appendFileSync(${JSON.stringify(network)},JSON.stringify({method:args[1]?.method??'GET',path:new URL(String(args[0])).pathname,body:args[1]?.body?JSON.parse(String(args[1].body)):null})+'\\n');return actual(...args);},{preconnect:actual.preconnect});await runTUIHost({dataRoot:${JSON.stringify(f.profile.dataRoot)},profile:'owned',thread:'composer',cwd:${JSON.stringify(f.workspace)},artifact:${JSON.stringify(f.artifact)}});`,
    );
    const program = `import os,pty,subprocess,select,time,signal,re,fcntl,termios,struct,json
master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',24,80,0,0));p=subprocess.Popen([${JSON.stringify(process.execPath)},${JSON.stringify(runner)}],stdin=slave,stdout=slave,stderr=slave,start_new_session=True);os.close(slave);buffer=b'';full=b''
def pump():
 global buffer,full
 end=time.monotonic()+.1
 while time.monotonic()<end:
  if select.select([master],[],[],.02)[0]:
   data=os.read(master,65536);buffer+=data;full+=data
def key(value):
 global buffer
 buffer=b'';os.write(master,value);pump()
def wait(text):
 deadline=time.monotonic()+10
 while text not in re.sub(r'\\s+',' ',re.sub(r'\\x1b\\[[0-?]*[ -/]*[@-~]','',buffer.decode(errors='replace'))):
  if time.monotonic()>deadline:raise RuntimeError('expected '+text+' tail='+buffer[-6000:].decode(errors='replace'))
  pump()
def wait_file(path):
 deadline=time.monotonic()+10
 while not os.path.exists(path):
  if time.monotonic()>deadline:raise RuntimeError('owned model request did not enter')
  pump()
def writes():return [row for row in [json.loads(line) for line in open(${JSON.stringify(network)})] if row['method']=='POST']
try:
 wait('New Run');key(b'/rec');wait('/recovery');key(b'\\x1b');key(b'o');wait('/recovery');key(b'\\t');wait('/recovery');assert writes()==[]
 for _ in range(9):key(b'\\x7f')
 key('前中🙂e\\u0301后'.encode());key(b'\\x1b[H');key('首'.encode());key(b'\\x1b[F');key(b'\\x1b[D');key(b'\\x7f');key('改'.encode());key(b'\\x1b[F')
 key(b'\\x1b[200~'+('REMOVE_BLOCK\\n'+'discard '*30).encode()+b'\\x1b[201~');wait('Pasted');assert writes()==[];key(b'\\x7f');assert writes()==[]
 key(b'\\x1b[200~'+${JSON.stringify(paste)}.encode()+b'\\x1b[201~');wait('Pasted');assert writes()==[];key(b'\\r');wait('Steer original active Run');wait_file(${JSON.stringify(join(f.root, 'composer-model-entered'))});assert len(writes())==1;assert writes()[0]['body']['content']==${JSON.stringify(expected)}
 key(${JSON.stringify('A中🙂e\u0301Z')}.encode());key(b'\\x1b[H');key(b'\\x1b[C');key(b'\\x1b[3~');key(b'\\x1b[F');key(b'\\x1b[D');key(b'\\x7f');key(b'\\x1b\\r');key(b'\\x1b[A');key('行'.encode());key(b'\\x1b[B');key(b'\\x1b[H');key('次'.encode());assert len(writes())==1
 deadline=time.monotonic()+5
 while True:
  drafts=json.load(open(${JSON.stringify(join(f.profile.profilePath, 'ui/tui.json'))}))
  if any(row['sessionId']=='composer' and row['text']==${JSON.stringify('行A🙂\n次Z')} for row in drafts['drafts']):break
  if time.monotonic()>deadline:raise RuntimeError('exact held draft not durable: '+json.dumps(drafts,ensure_ascii=False))
  pump()
 key(b'\\x1b[F')
 for _ in range(6):key(b'\\x7f')
 open(${JSON.stringify(join(f.root, 'composer-model-release'))},'w').write('explicit owned model release');wait('approval [')
 key(b'\\x1b[B');wait('only this call');key(b'\\r');wait('RECOVERED_ORIGINAL_DONE');assert len(writes())==2
 key(b'\\x1b[A');wait('Pasted');assert len(writes())==2;key(b'\\x1b[B');assert len(writes())==2
 key(b'\\x12');wait('Select Session');key(b'\\x1b[A');key(b'\\x1b[A');key(b'\\r');wait('Session s');key(b'ORIGINAL_SCOPE_TEXT');wait('ORIGINAL_SCOPE_TEXT');key(b'\\x12');wait('Select Session');key(b'\\x1b[A');key(b'\\x1b[A');key(b'\\x1b[B');key(b'\\r');wait('Session composer');key(b'COMPOSER_SCOPE_TEXT');wait('COMPOSER_SCOPE_TEXT');key(b'\\x12');wait('Select Session');key(b'\\x1b[A');key(b'\\x1b[A');key(b'\\r');wait('Session s');wait('ORIGINAL_SCOPE_TEXT');assert len(writes())==2
 key(b'\\x11');deadline=time.monotonic()+6
 while p.poll() is None and time.monotonic()<deadline:pump()
 p.wait(timeout=3);assert p.returncode==0;print('COMPOSER_REAL_UTF8_ONCE')
finally:
 open(${JSON.stringify(transcript)},'wb').write(full)
 if p.poll() is None:os.killpg(p.pid,signal.SIGKILL);p.wait()
 os.close(master)
`;
    writeFileSync(`${f.root}-composer-driver.py`, program);
    python = Bun.spawn(['python3', '-c', program], { stdout: 'pipe', stderr: 'pipe' });
    const [out, err, code] = await Promise.all([
      new Response(python.stdout).text(),
      new Response(python.stderr).text(),
      python.exited,
    ]);
    if (code !== 0) {
      console.error(err);
      console.error(
        'actual composer failure facts',
        JSON.stringify({
          commands: f.rows('SELECT id,kind,status,receipt_json FROM command'),
          runs: f.rows('SELECT id,origin_command_id,status,is_active,reason FROM run'),
          executions: f.rows('SELECT id,kind,state,run_id,result_json FROM execution'),
          calls: f.calls(),
        }),
      );
    }
    console.log('PTY transcript', transcript);
    expect(code).toBe(0);
    expect(out).toContain('COMPOSER_REAL_UTF8_ONCE');
    const rows = readFileSync(network, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const writes = rows.filter((row) => row.method === 'POST' && row.body?.kind === 'run.start');
    expect(
      rows.filter((row) => row.method === 'POST' && row.path.includes('/interactions/')),
    ).toHaveLength(1);
    expect(writes).toHaveLength(1);
    expect(writes[0].body).toMatchObject({
      kind: 'run.start',
      expectedStoreId: f.storeId,
      content: expected,
    });
    expect(f.rows('SELECT origin_command_id,status FROM run ORDER BY started_at')).toEqual([
      { origin_command_id: 'work', status: 'interrupted' },
      { origin_command_id: writes[0].body.commandId, status: 'completed' },
    ]);
    expect(
      f.rows(
        "SELECT json_extract(p.json,'$.content') AS content FROM message m JOIN message_part p ON p.message_id=m.id WHERE m.session_id='composer' AND m.role='user' AND p.kind='text' AND p.ordinal=0",
      ),
    ).toEqual([{ content: expected }]);
    const drafts = JSON.parse(readFileSync(join(f.profile.profilePath, 'ui/tui.json'), 'utf8'));
    expect(
      drafts.drafts
        .filter((row: { text: string }) => row.text)
        .map((row: { storeId: string; workspaceId: string; sessionId: string; text: string }) => ({
          storeId: row.storeId,
          workspaceId: row.workspaceId,
          sessionId: row.sessionId,
          text: row.text,
        }))
        .sort((a: { sessionId: string }, b: { sessionId: string }) =>
          a.sessionId.localeCompare(b.sessionId),
        ),
    ).toEqual([
      { storeId: f.storeId, workspaceId: 'w', sessionId: 'composer', text: 'COMPOSER_SCOPE_TEXT' },
      { storeId: f.storeId, workspaceId: 'w', sessionId: 's', text: 'ORIGINAL_SCOPE_TEXT' },
    ]);
    expect(f.calls()).toBe(3);
  } finally {
    if (python && python.exitCode === null) {
      python.kill('SIGKILL');
      await python.exited;
    }
    closing = true;
    relay?.stop(true);
    f.close();
  }
}, 30000);
