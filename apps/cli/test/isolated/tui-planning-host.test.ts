import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { launchPairedService } from '@kite-ai/service/paired';
import { workflowQuestionProfile } from '../fixtures/workflow-question-profile';

const repo = resolve(import.meta.dir, '../../../..');
for (const entrance of ['slash-task', 'draft-mode', 'active-queued', 'scope-draft'] as const)
  test(`80x24 actual ${entrance} single Planning intent reviews full original Artifact and never inherits Full authority`, async () => {
    const f = await workflowQuestionProfile('waive');
    let python: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
    const body = `ORIGINAL_PLAN_UTF8 ${'原完整🙂e\u0301方案'.repeat(6500)} ORIGINAL_PLAN_FULL_TAIL`;
    let calls = 0,
      closing = false;
    const models: Record<string, unknown>[] = [];
    const provider = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const model = (await request.json()) as Record<string, unknown>;
        models.push(model);
        const ordinal = calls++;
        const step = entrance === 'active-queued' ? ordinal - 1 : ordinal;
        if (entrance === 'active-queued' && ordinal === 0) {
          writeFileSync(
            join(f.root, 'original-model-entered'),
            'actual original Model SDK request',
          );
          while (!existsSync(join(f.root, 'original-model-release')) && !closing)
            await Bun.sleep(5);
          if (closing) throw Error('owned Planning fixture closed');
          const frame = (delta: unknown, reason: string | null) =>
            `data: ${JSON.stringify({ id: 'original-parent', object: 'chat.completion.chunk', model: 'fixed', choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`;
          return new Response(
            frame({ content: 'ORIGINAL_PARENT_ACTUALLY_ENDED' }, null) +
              frame({}, 'stop') +
              'data: [DONE]\n\n',
            { headers: { 'content-type': 'text/event-stream' } },
          );
        }
        const db = new Database(f.profile.databasePath, { readonly: true });
        let current: Record<string, unknown> | undefined,
          runId: string | undefined,
          writeId: string | undefined;
        try {
          const row = db
            .query(
              "SELECT json FROM extension_record WHERE extension_id='builtin.planning' AND scope_kind='session' AND scope_id='s' AND key='plan.current'",
            )
            .get() as { json: string } | null;
          current = row ? JSON.parse(row.json) : undefined;
          runId = (
            db
              .query("SELECT id FROM run WHERE session_id='s' ORDER BY rowid DESC LIMIT 1")
              .get() as {
              id: string;
            } | null
          )?.id;
          writeId = (
            db
              .query(
                "SELECT id FROM execution WHERE adapter_id='files.write' AND state='succeeded' ORDER BY rowid DESC LIMIT 1",
              )
              .get() as { id: string } | null
          )?.id;
        } finally {
          db.close();
        }
        const call =
          step === 0
            ? {
                name: 'files.write',
                input: { path: 'before.txt', content: 'must stay denied', base: null },
              }
            : step === 1
              ? {
                  name: 'planning.write',
                  input: {
                    planId: 'original-plan',
                    expectedVersion: null,
                    title: 'Original human plan',
                    body,
                    steps: [{ id: 'write-once', title: 'Write exactly once' }],
                  },
                }
              : step === 2
                ? {
                    name: 'planning.review',
                    input: {
                      planId: current?.planId,
                      version: current?.version,
                      digest: current?.digest,
                    },
                  }
                : step === 3
                  ? {
                      name: 'files.write',
                      input: {
                        path: 'after.txt',
                        content: 'ORIGINAL_PLAN_ACTUAL_EFFECT',
                        base: null,
                      },
                    }
                  : step === 4
                    ? {
                        name: 'planning.update',
                        input: {
                          runId,
                          planId: current?.planId,
                          version: current?.version,
                          digest: current?.digest,
                          expectedProgressRevision: null,
                          stepId: 'write-once',
                          status: 'completed',
                          executionId: writeId,
                          completePlan: true,
                        },
                      }
                    : null;
        const delta = call
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: `original-plan-call-${step}`,
                  type: 'function',
                  function: { name: call.name, arguments: JSON.stringify(call.input) },
                },
              ],
            }
          : { content: 'ORIGINAL_PLAN_ACTUALLY_COMPLETED' };
        const frame = (value: unknown, reason: string | null) =>
          `data: ${JSON.stringify({ id: 'owned-plan', object: 'chat.completion.chunk', model: 'fixed', choices: [{ index: 0, delta: value, finish_reason: reason }] })}\n\n`;
        return new Response(
          frame(delta, null) + frame({}, call ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
    });
    try {
      const configPath = join(f.profile.profilePath, 'config.jsonc');
      writeFileSync(
        configPath,
        JSON.stringify({
          modelId: 'fixed',
          models: [
            {
              id: 'fixed',
              provider: 'compatible',
              model: 'fixed',
              baseURL: `${provider.url.href}v1`,
            },
          ],
          tools: [
            { id: 'files.read', definitionVersion: '3' },
            { id: 'files.write', definitionVersion: '2' },
          ],
        }),
        { mode: 0o600 },
      );
      const seed = await launchPairedService({
        ...f.artifact,
        profile: f.profile,
        instanceId: crypto.randomUUID(),
        requiredCapabilities: ['sessions', 'interactions'],
      });
      let storeId: string;
      try {
        storeId = seed.bootstrap.storeId!;
        await seed.client.createWorkspace({
          expectedStoreId: storeId,
          id: 'w',
          rootUri: `file://${f.workspace}`,
          name: 'owned',
        });
        const trust = await seed.client.getWorkspaceTrust('w', { storeId });
        await seed.client.setWorkspaceTrust('w', {
          expectedStoreId: storeId,
          commandId: 'trust',
          ifRevision: trust.revision,
          trusted: true,
          canonicalIdentity: trust.canonicalIdentity,
          externalReadScopeDigest: trust.externalReadScopeDigest,
        });
        await seed.client.createSession({
          expectedStoreId: storeId,
          commandId: 'create',
          sessionId: 's',
          workspaceId: 'w',
          title: 'Original Plan',
        });
        if (entrance === 'scope-draft')
          await seed.client.createSession({
            expectedStoreId: storeId,
            commandId: 'create-other',
            sessionId: 'b',
            workspaceId: 'w',
            title: 'Other original Plan scope',
          });
        const mode = await seed.client.getPermissionMode('s', { storeId });
        await seed.client.setPermissionMode('s', {
          expectedStoreId: storeId,
          commandId: 'full',
          ifRevision: mode.revision,
          ifDefaultRevision: mode.defaultRevision,
          makeDefault: false,
          mode: 'full',
        });
      } finally {
        await seed.close();
      }
      const runner = join(f.root, 'plan-runner.ts'),
        wire = join(f.root, 'plan-wire.jsonl'),
        firstLost = join(f.root, 'first-plan-get-lost'),
        transcript = `${f.root}-plan.pty.log`;
      writeFileSync(
        runner,
        `import{appendFileSync,writeFileSync}from'node:fs';import{runTUIHost}from${JSON.stringify(join(repo, 'apps/cli/host/tui.tsx'))};const actual=globalThis.fetch;let originalAnswer,lostGet=false;globalThis.fetch=Object.assign(async(...args:Parameters<typeof fetch>)=>{const path=new URL(String(args[0])).pathname,method=args[1]?.method??'GET',body=args[1]?.body?JSON.parse(String(args[1].body)):null;appendFileSync(${JSON.stringify(wire)},JSON.stringify({path,method,body})+'\\n');const response=await actual(...args);if(method==='GET'&&path.includes('/artifacts/')){writeFileSync(${JSON.stringify(join(f.root, 'plan-attachment.bin'))},new Uint8Array(await response.clone().arrayBuffer()));}if(method==='POST'&&path.endsWith('/answer')&&body?.answer?.kind==='plan_review'){originalAnswer=body.commandId;await response.arrayBuffer();throw Error('actual original plan answer POST response lost');}if(method==='GET'&&originalAnswer&&path==='/v1/commands/'+originalAnswer&&!lostGet){lostGet=true;await response.arrayBuffer();writeFileSync(${JSON.stringify(firstLost)},'actual original GET lost');throw Error('actual original plan GET response lost');}return response;},{preconnect:actual.preconnect});await runTUIHost({dataRoot:${JSON.stringify(f.profile.dataRoot)},profile:'owned',thread:'s',cwd:${JSON.stringify(f.workspace)},artifact:${JSON.stringify(f.artifact)},onLaunched:({pid})=>writeFileSync(${JSON.stringify(join(f.root, 'plan-owned-pid'))},String(pid))});`,
      );
      const enter =
        entrance === 'scope-draft'
          ? String.raw`choose('b','Other original Plan scope');wait('New Run >');key(b'\x1b[Z');wait('Planning next Run >');key(b'UNSENT_ORIGINAL_OTHER_PLAN');wait('UNSENT_ORIGINAL_OTHER_PLAN');choose('s','Original Plan');wait('New Run >');key(${JSON.stringify('/plan original single plan 中文🙂')}.encode());wait('/plan original single plan');key(b'\r')`
          : entrance === 'active-queued'
            ? String.raw`key(b'original parent task');wait('original parent task');key(b'\r');wait('Steer original active Run >');key(${JSON.stringify('/plan original single plan 中文🙂')}.encode());wait('/plan original single plan');key(b'\r');wait('input.follow_up: accepted');db=sqlite3.connect(${JSON.stringify(f.profile.databasePath)});assert db.execute("SELECT COUNT(*) FROM run WHERE session_id='s'").fetchone()[0]==1;assert db.execute("SELECT status FROM run WHERE session_id='s'").fetchone()[0]=='running';db.close();open(${JSON.stringify(join(f.root, 'original-model-release'))},'w').write('explicit owned original Model release')`
            : entrance === 'slash-task'
              ? String.raw`key(b'\x1b[Z');wait('Planning next Run >');key(b'\x1b[Z');wait('New Run >');key(${JSON.stringify('/plan original single plan 中文🙂')}.encode());wait('/plan original single plan');key(b'\r')`
              : String.raw`key(b'/plan');wait('/plan');key(b'\r');wait('Planning next Run >');key(b'\x1b[Z');wait('New Run >');key(b'\x1b[Z');wait('Planning next Run >');key(${JSON.stringify('original single plan 中文🙂')}.encode());wait('original single plan');key(b'\r')`;
      const program = `import os,pty,subprocess,select,time,signal,re,fcntl,termios,struct,sqlite3,json
master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',24,80,0,0));p=subprocess.Popen([${JSON.stringify(process.execPath)},${JSON.stringify(runner)}],stdin=slave,stdout=slave,stderr=slave,start_new_session=True);os.close(slave);buffer=b'';full=b''
def pump():
 global buffer,full
 if select.select([master],[],[],.05)[0]:
  try:data=os.read(master,65536);buffer+=data;full+=data
  except OSError:pass
def wait(text):
 deadline=time.monotonic()+8
 while text not in re.sub(r'\\s+',' ',re.sub(r'\\x1b\\[[0-?]*[ -/]*[@-~]','',buffer.decode(errors='replace'))):
  if time.monotonic()>deadline:raise RuntimeError('expected '+text+' tail='+buffer[-5000:].decode(errors='replace'))
  pump()
def key(value):
 global buffer
 buffer=b'';os.write(master,value);until=time.monotonic()+.1
 while time.monotonic()<until:pump()
def choose(id,title):
 key(b'\\x12');wait(title)
 for direction in [None,b'\\x1b[B',b'\\x1b[A']:
  if direction:key(direction)
  rendered=re.sub(r'\\s+',' ',re.sub(r'\\x1b\\[[0-?]*[ -/]*[@-~]','',buffer.decode(errors='replace')))
  if '> '+title+' ['+id+']' in rendered:key(b'\\r');wait('Session '+id+' ·');return
 raise RuntimeError('original Session target not selected '+id)
try:
 wait('New Run >');${enter};wait('plan_review');assert not os.path.exists(${JSON.stringify(join(f.workspace, 'before.txt'))}),'original Full wrote before plan';assert not os.path.exists(${JSON.stringify(join(f.workspace, 'after.txt'))}),'effect existed before user approval'
 key(b'\\x01');wait('ORIGINAL_PLAN_FULL_TAIL');key(b'approve accept_edits');wait('approve accept_edits');key(b'\\r');wait('interaction.answer: unknown');key(b'\\x0c');wait('interaction.answer: unknown');assert os.path.exists(${JSON.stringify(firstLost)});key(b'\\x0c');wait('interaction.answer: applied');wait('ORIGINAL_PLAN_ACTUALLY_COMPLETED')
 deadline=time.monotonic()+8
 while True:
  db=sqlite3.connect(${JSON.stringify(f.profile.databasePath)});actual=db.execute("SELECT status,reason FROM run WHERE session_id='s' ORDER BY rowid DESC LIMIT 1").fetchone();db.close()
  if actual[0]=='completed':break
  if time.monotonic()>deadline:raise RuntimeError('actual original Run not completed '+repr(actual))
  pump()
 ${entrance === 'scope-draft' ? String.raw`choose('b','Other original Plan scope');wait('Planning next Run >');wait('UNSENT_ORIGINAL_OTHER_PLAN')` : ''}
 key(b'\\x11')
 deadline=time.monotonic()+6
 while p.poll() is None and time.monotonic()<deadline:pump()
 p.wait(timeout=3);assert p.returncode==0;open(${JSON.stringify(transcript)},'wb').write(full);print('ORIGINAL_PLAN_PT Y_COMPLETE')
finally:
 open(${JSON.stringify(transcript)},'wb').write(full)
 if p.poll() is None:os.killpg(p.pid,signal.SIGKILL);p.wait()
 os.close(master)
`;
      python = Bun.spawn(['python3', '-c', program], { stdout: 'pipe', stderr: 'pipe' });
      const [out, err, exit] = await Promise.all([
        new Response(python.stdout).text(),
        new Response(python.stderr).text(),
        python.exited,
      ]);
      if (exit) console.error(err, out);
      expect(exit).toBe(0);
      expect(err).toBe('');
      const network = readFileSync(wire, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      const starts = network.filter(
        (row) => row.method === 'POST' && row.body?.kind === 'run.start',
      );
      const work = network.filter(
        (row) =>
          row.method === 'POST' &&
          row.body?.kind === (entrance === 'active-queued' ? 'input.follow_up' : 'run.start'),
      );
      expect(starts).toHaveLength(1);
      if (entrance === 'active-queued') {
        expect(starts[0].body.extensionInputs).toBeUndefined();
        expect(starts[0].body.content).toBe('original parent task');
      }
      expect(work).toHaveLength(1);
      expect(work[0].body.extensionInputs).toEqual([
        { extensionId: 'builtin.planning', definitionVersion: '1', input: { mode: 'plan' } },
      ]);
      expect(work[0].body.content).toBe('original single plan 中文🙂');
      expect(
        network.filter(
          (row) =>
            row.method === 'POST' &&
            ['permission.mode', 'command.cancel', 'execution.cancel'].includes(row.body?.kind),
        ),
      ).toHaveLength(0);
      expect(network.filter((row) => row.method === 'POST')).toHaveLength(
        entrance === 'active-queued' ? 3 : 2,
      );
      const answers = network.filter(
        (row) => row.method === 'POST' && row.body?.answer?.kind === 'plan_review',
      );
      expect(answers).toHaveLength(1);
      expect(answers[0].body.answer).toEqual({
        kind: 'plan_review',
        decision: 'approve',
        mode: 'accept_edits',
      });
      expect(answers[0].body.expectedStoreId).toBe(storeId!);
      expect(answers[0].path).toContain('/sessions/s/interactions/');
      expect(
        network.filter(
          (row) => row.method === 'GET' && row.path === '/v1/commands/' + answers[0].body.commandId,
        ),
      ).toHaveLength(2);
      expect(readFileSync(join(f.workspace, 'after.txt'), 'utf8')).toBe(
        'ORIGINAL_PLAN_ACTUAL_EFFECT',
      );
      expect(existsSync(join(f.workspace, 'before.txt'))).toBe(false);
      expect(calls).toBe(entrance === 'active-queued' ? 7 : 6);
      expect(readFileSync(join(f.root, 'plan-attachment.bin'), 'utf8')).toContain(body);
      expect(
        network.filter((row) => row.method === 'GET' && row.path.includes('/artifacts/')),
      ).toHaveLength(1);
      writeFileSync(`${f.root}-plan-wire.jsonl`, readFileSync(wire));
      writeFileSync(
        `${f.root}-plan-attachment.bin`,
        readFileSync(join(f.root, 'plan-attachment.bin')),
      );
      expect(f.requests).toHaveLength(0);
      const db = new Database(f.profile.databasePath, { readonly: true });
      try {
        const original = db
          .query(
            "SELECT state,accepted_decision_revision,answer_json,request_json FROM interaction WHERE kind='plan_review'",
          )
          .get() as {
          status?: string;
          accepted_decision_revision: number;
          answer_json: string;
          request_json: string;
        };
        expect(original.accepted_decision_revision).toBe(2);
        expect(JSON.parse(original.answer_json).mode).toBe('accept_edits');
        expect(JSON.parse(original.request_json).policy.review).toBeDefined();
        expect(
          db
            .query(
              "SELECT COUNT(*) AS n FROM execution WHERE adapter_id='files.write' AND state='succeeded'",
            )
            .get(),
        ).toEqual({ n: 1 });
        expect(
          db
            .query(
              "SELECT COUNT(*) AS n FROM execution WHERE adapter_id='files.write' AND state='failed'",
            )
            .get(),
        ).toEqual({ n: 1 });
        const current = JSON.parse(
          (
            db
              .query(
                "SELECT json FROM extension_record WHERE extension_id='builtin.planning' AND scope_id='s' AND key='plan.current'",
              )
              .get() as { json: string }
          ).json,
        );
        expect(current.planId).toBe('original-plan');
        const progress = JSON.parse(
          (
            db
              .query(
                "SELECT json FROM extension_record WHERE extension_id='builtin.planning' AND scope_id='s' AND key=?",
              )
              .get(`progress/original-plan/${current.version}`) as { json: string }
          ).json,
        );
        expect(progress.completePlan).toBe(true);
        expect(progress.steps['write-once'].status).toBe('completed');
        const actualRun = db
          .query(
            "SELECT id,origin_command_id,status,config_json,requirements_json FROM run WHERE session_id='s' ORDER BY rowid DESC LIMIT 1",
          )
          .get() as {
          id: string;
          origin_command_id: string;
          status: string;
          config_json: string;
          requirements_json: string;
        };
        expect(actualRun.origin_command_id).toBe(work[0].body.commandId);
        if (entrance === 'active-queued') {
          const parent = db
            .query('SELECT id,status,config_json FROM run WHERE origin_command_id=?')
            .get(starts[0].body.commandId) as { id: string; status: string; config_json: string };
          expect(parent.id).toBe(work[0].body.afterRunId);
          expect(parent.status).toBe('completed');
          expect(JSON.parse(parent.config_json).snapshot.planning.intent).toBeNull();
          expect(db.query("SELECT COUNT(*) AS n FROM run WHERE session_id='s'").get()).toEqual({
            n: 2,
          });
        }
        expect(actualRun.status).toBe('completed');
        if (entrance === 'scope-draft') {
          expect(db.query("SELECT COUNT(*) AS n FROM run WHERE session_id='b'").get()).toEqual({
            n: 0,
          });
        }
        expect(JSON.parse(actualRun.config_json).snapshot.planning.intent).toEqual({
          mode: 'plan',
        });
        expect(progress.runId).toBe(actualRun.id);
        const command = db
          .query('SELECT receipt_json FROM command WHERE id=?')
          .get(answers[0].body.commandId) as { receipt_json: string };
        expect(JSON.parse(command.receipt_json)).toMatchObject({
          interactionId: answers[0].path.split('/').at(-2),
          decisionRevision: '2',
          outcome: 'answer_saved',
        });
        writeFileSync(
          `${f.root}-plan-facts.json`,
          JSON.stringify({
            original,
            current,
            progress,
            actualRun,
            answerReceipt: JSON.parse(command.receipt_json),
            calls,
            work: work[0],
            answer: answers[0],
          }),
        );
        expect(
          db
            .query(
              "SELECT COUNT(*) AS n FROM execution WHERE adapter_id='planning.update' AND state='succeeded'",
            )
            .get(),
        ).toEqual({ n: 1 });
        expect(() =>
          process.kill(Number(readFileSync(join(f.root, 'plan-owned-pid'), 'utf8')), 0),
        ).toThrow();
        console.log(transcript);
      } finally {
        db.close();
      }
    } finally {
      closing = true;
      if (python && python.exitCode === null) {
        python.kill();
        await python.exited;
      }
      provider.stop(true);
      f.close();
    }
  }, 30000);
