import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AnswerInteractionRequest } from '@kite-ai/client';
import { launchPairedService } from '@kite-ai/service/paired';
import { workflowQuestionProfile } from '../fixtures/workflow-question-profile';

const repo = resolve(import.meta.dir, '../../../..');
for (const scenario of ['replan', 'waive', 'cancel'] as const)
  test(`80x24 actual TUI ${scenario} preserves the original Workflow question scope`, async () => {
    const decision = scenario === 'cancel' ? 'waive' : scenario;
    const f = await workflowQuestionProfile(decision);
    const evidence = `/private/tmp/kite-workflow-question-pty-evidence-${crypto.randomUUID()}`;
    mkdirSync(evidence, { mode: 0o700 });
    let python: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
    try {
      const seed = await launchPairedService({
        ...f.artifact,
        profile: f.profile,
        instanceId: crypto.randomUUID(),
        requiredCapabilities: ['sessions', 'interactions'],
      });
      try {
        const storeId = seed.bootstrap.storeId!;
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
          title: 'Decision',
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
      const runner = join(f.root, 'runner.ts'),
        ledger = join(f.root, 'network'),
        pidPath = join(f.root, 'owned-pid');
      writeFileSync(
        runner,
        `import {appendFileSync,writeFileSync} from 'node:fs';
import {runTUIHost} from ${JSON.stringify(join(repo, 'apps/cli/host/tui.tsx'))};
const actual=globalThis.fetch;let savedAnswer, lostGet=false;
globalThis.fetch=Object.assign(async(...args:Parameters<typeof fetch>)=>{
 const options=args[1],path=new URL(String(args[0])).pathname;
 const body=options?.body?JSON.parse(String(options.body)):null;
 appendFileSync(${JSON.stringify(ledger)},JSON.stringify({method:options?.method??'GET',path,body})+'\\n');
 const result=await actual(...args);
 if(options?.method==='POST'&&path.endsWith('/answer')&&body?.answer?.kind==='question'){
  savedAnswer=body.commandId;await result.arrayBuffer();throw Error('lost original question answer response');
 }
 if(!lostGet&&savedAnswer&&path==='/v1/commands/'+savedAnswer){
  lostGet=true;await result.arrayBuffer();writeFileSync(${JSON.stringify(join(f.root, 'first-get-lost'))},'lost');
  throw Error('lost first original question answer GET');
 }
 return result;
},{preconnect:actual.preconnect});
await runTUIHost({dataRoot:${JSON.stringify(f.profile.dataRoot)},profile:'owned',thread:'s',cwd:${JSON.stringify(f.workspace)},artifact:${JSON.stringify(f.artifact)},onLaunched:({pid})=>writeFileSync(${JSON.stringify(pidPath)},String(pid))});`,
      );
      const detail = 'original explicit user instruction';
      const program = `import os,pty,subprocess,select,time,signal,re,fcntl,termios,struct,sqlite3,json
master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',24,80,0,0));p=subprocess.Popen([${JSON.stringify(process.execPath)},${JSON.stringify(runner)}],stdin=slave,stdout=slave,stderr=slave,start_new_session=True);os.close(slave);buffer=b''
def wait(text):
 global buffer
 deadline=time.monotonic()+10
 while text not in re.sub(r'\\s+',' ',re.sub(r'\\x1b\\[[0-?]*[ -/]*[@-~]','',buffer.decode(errors='replace'))):
  if time.monotonic()>deadline:raise RuntimeError('expected '+text+' tail='+buffer[-5000:].decode(errors='replace'))
  if select.select([master],[],[],.05)[0]:buffer+=os.read(master,65536)
def key(value):
 global buffer
 buffer=b'';os.write(master,value)
seen=set()
def card(kind,definition=None):
 global buffer
 deadline=time.monotonic()+10
 while True:
  db=sqlite3.connect(${JSON.stringify(f.profile.databasePath)});rows=db.execute("SELECT id,request_json FROM interaction WHERE kind=? AND state='pending'",(kind,)).fetchall();db.close()
  for id,request in rows:
   if id not in seen and (definition is None or json.loads(request).get('definitionId')==definition):
    seen.add(id);wait(id[:24]);return id
  if time.monotonic()>deadline:raise RuntimeError('missing pending '+kind+' '+str(definition))
  if select.select([master],[],[],.05)[0]:buffer+=os.read(master,65536)
def approve(definition):
 card('approval',definition);key(b'\\x1b[B');wait('only this call');key(b'\\r')
def snapshot(stage):
 db=sqlite3.connect(${JSON.stringify(f.profile.databasePath)});db.row_factory=sqlite3.Row
 value={'stage':stage,'tuiPid':p.pid,'tuiExit':p.poll(),'facts':{table:[dict(row) for row in db.execute('SELECT * FROM '+table)] for table in ['run','command','execution','interaction','extension_record']}};db.close()
 with open(${JSON.stringify(join(evidence, 'stages.jsonl'))},'a') as stream:stream.write(json.dumps(value)+'\\n')
def completed():
 global buffer
 # Final streamed prose precedes the original Run's durable terminal transition.
 snapshot('final-body-visible');deadline=time.monotonic()+10
 db=sqlite3.connect(${JSON.stringify(f.profile.databasePath)});original=db.execute("SELECT run_id FROM interaction WHERE kind='question'").fetchone()[0];db.close()
 while True:
  db=sqlite3.connect(${JSON.stringify(f.profile.databasePath)});state=db.execute('SELECT status FROM run WHERE id=?',(original,)).fetchone()[0];db.close()
  if state=='completed':snapshot('original-completed-before-quit');return
  if state in ['cancelled','failed','interrupted']:raise RuntimeError('original Run terminal '+state)
  if time.monotonic()>deadline:raise RuntimeError('original Run completion not confirmed '+original+' '+state)
  if select.select([master],[],[],.05)[0]:buffer+=os.read(master,65536)
try:
 wait('New Run >');key(b'/alpha-skill original verification task');wait('/alpha-skill original verification task');key(b'\\r')
 approve('complete_skill');approve('skill.workflow.verify');approve('decide_skill_verification')
 ${
   scenario === 'cancel'
     ? `card('question');key(b'\\x03');wait('command.cancel: applied');key(b'\\x03')
 deadline=time.monotonic()+10
 while True:
  db=sqlite3.connect(${JSON.stringify(f.profile.databasePath)});state=db.execute("SELECT status FROM run").fetchone()[0];db.close()
  if state=='cancelled':break
  if time.monotonic()>deadline:raise RuntimeError('original Run cancellation not confirmed')
  if select.select([master],[],[],.05)[0]:buffer+=os.read(master,65536)
 key(b'\\x11')`
     : `card('question');wait('Question 1/2 · Selection: No selection (Enter has no answer)');key(b'\\x1b[B' * ${decision === 'replan' ? 1 : 2});wait('Question 1/2 · Selection: ${decision === 'replan' ? 1 : 2}');key(b'\\r')
 wait('Question 2/2');key(${JSON.stringify(detail)}.encode());wait(${JSON.stringify(detail)});key(b'\\r');wait('interaction.answer: unknown')
 key(b'\\x0c');deadline=time.monotonic()+10
 while not os.path.exists(${JSON.stringify(join(f.root, 'first-get-lost'))}):
  if time.monotonic()>deadline:raise RuntimeError('original question answer GET loss not confirmed')
  if select.select([master],[],[],.05)[0]:buffer+=os.read(master,65536)
 wait('interaction.answer: unknown');assert os.path.exists(${JSON.stringify(join(f.root, 'first-get-lost'))})
 key(b'\\x0c');wait('interaction.answer: applied')
 ${decision === 'replan' ? "approve('complete_skill');approve('skill.workflow.verify')" : ''}
 wait('WORKFLOW_DECISION_DONE');completed();key(b'\\x11')`
}

 deadline=time.monotonic()+6
 while p.poll() is None and time.monotonic()<deadline:
  if select.select([master],[],[],.1)[0]:
   try:os.read(master,65536)
   except OSError:break
 p.wait(timeout=3);assert p.returncode==0;print(${JSON.stringify(scenario === 'cancel' ? 'WORKFLOW_QUESTION_ORIGINAL_CANCELLED' : 'WORKFLOW_QUESTION_ORIGINAL_COMPLETE')})
finally:
 try:
  snapshot('tui-finally')
  with open(${JSON.stringify(join(evidence, 'frame.txt'))},'wb') as stream:stream.write(buffer)
 finally:
  if p.poll() is None:os.killpg(p.pid,signal.SIGKILL);p.wait()
  os.close(master)
`;
      python = Bun.spawn(['python3', '-c', program], { stdout: 'pipe', stderr: 'pipe' });
      const [out, err, exit] = await Promise.all([
        new Response(python.stdout).text(),
        new Response(python.stderr).text(),
        python.exited,
      ]);
      if (exit !== 0) console.error(err);
      expect(exit).toBe(0);
      expect(out).toContain(
        scenario === 'cancel'
          ? 'WORKFLOW_QUESTION_ORIGINAL_CANCELLED'
          : 'WORKFLOW_QUESTION_ORIGINAL_COMPLETE',
      );
      const network = readFileSync(ledger, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)) as {
        method: string;
        path: string;
        body: {
          commandId: string;
          expectedStoreId: string;
          expectedRevision?: string;
          targetCommandId?: string;
          kind?: string;
          answer?: AnswerInteractionRequest['answer'];
        } | null;
      }[];
      const answers = network.filter(
        (row) =>
          row.method === 'POST' &&
          row.path.endsWith('/answer') &&
          row.body?.answer?.kind === 'question',
      );
      if (scenario === 'cancel') {
        expect(answers).toHaveLength(0);
        const starts = network.filter(
          (row) => row.method === 'POST' && row.body?.kind === 'run.start',
        );
        const cancellations = network.filter(
          (row) => row.method === 'POST' && row.body?.kind === 'command.cancel',
        );
        expect(starts).toHaveLength(1);
        expect(cancellations).toHaveLength(1);
        expect(cancellations[0]!.body).toMatchObject({
          expectedStoreId: starts[0]!.body!.expectedStoreId,
          targetCommandId: starts[0]!.body!.commandId,
        });
        const db = new Database(f.profile.databasePath, { readonly: true });
        try {
          expect(db.query('SELECT status,origin_command_id FROM run').get()).toEqual({
            status: 'cancelled',
            origin_command_id: starts[0]!.body!.commandId,
          });
          expect(
            db
              .query(
                "SELECT state,accepted_decision_revision,answer_json FROM interaction WHERE kind='question'",
              )
              .get(),
          ).toEqual({
            state: 'cancelled',
            accepted_decision_revision: null,
            answer_json: null,
          });
          const records = db
            .query(
              "SELECT key,json FROM extension_record WHERE extension_id='builtin.skill-workflow'",
            )
            .all() as { key: string; json: string }[];
          expect(
            JSON.parse(records.find((row) => row.key.endsWith('/attempts/1/verification'))!.json)
              .outcome,
          ).toBe('failed');
          expect(records.filter((row) => row.key.includes('/decision/'))).toHaveLength(0);
          expect(records.some((row) => row.key.includes('/attempts/2/'))).toBe(false);
          expect(JSON.parse(records.find((row) => row.key.endsWith('/head'))!.json)).toEqual({
            kind: 'head',
            attempt: 1,
          });
          expect(
            db
              .query(
                "SELECT COUNT(*) AS count FROM command WHERE kind='interaction.answer' AND json_extract(request_json,'$.answer.kind')='question'",
              )
              .get(),
          ).toEqual({ count: 0 });
        } finally {
          db.close();
        }
        expect(f.requests).toHaveLength(2);
        expect(readFileSync(f.ledger, 'utf8').trim().split('\n')).toHaveLength(1);
        expect(() => process.kill(Number(readFileSync(pidPath, 'utf8')), 0)).toThrow();
        return;
      }
      expect(answers).toHaveLength(1);
      const original = answers[0]!.body!;
      expect(original.answer).toEqual({
        kind: 'question',
        answers: { decision, detail: 'original explicit user instruction' },
      });
      expect(
        network.filter(
          (row) => row.method === 'GET' && row.path === `/v1/commands/${original.commandId}`,
        ),
      ).toHaveLength(2);
      expect(readFileSync(join(f.root, 'first-get-lost'), 'utf8')).toBe('lost');
      expect(
        network.filter((row) => row.method === 'POST' && row.body?.kind === 'run.start'),
      ).toHaveLength(1);
      const db = new Database(f.profile.databasePath, { readonly: true });
      try {
        const answerRows = db
          .query(
            "SELECT id,session_id,subject_id FROM command WHERE kind='interaction.answer' AND json_extract(request_json,'$.answer.kind')='question'",
          )
          .all() as { id: string; session_id: string; subject_id: string }[];
        expect(answerRows).toHaveLength(1);
        expect(answerRows[0]).toMatchObject({ id: original.commandId, session_id: 's' });
        const question = db
          .query(
            "SELECT id,subject_id,presentation_session_id,origin_store_id,run_id,execution_id,request_json,answer_json,state,accepted_decision_revision FROM interaction WHERE kind='question'",
          )
          .get() as {
          id: string;
          subject_id: string;
          presentation_session_id: string;
          origin_store_id: string;
          run_id: string;
          execution_id: string;
          request_json: string;
          answer_json: string;
          state: string;
          accepted_decision_revision: number;
        };
        expect(question).toMatchObject({
          subject_id: answerRows[0]!.subject_id,
          presentation_session_id: 's',
          state: 'answered',
          accepted_decision_revision: 2,
        });
        expect(JSON.parse(question.answer_json)).toEqual(original.answer);
        expect(original.expectedStoreId).toBe(question.origin_store_id);
        expect(BigInt(original.expectedRevision!) + 1n).toBe(
          BigInt(question.accepted_decision_revision),
        );
        expect(db.query('SELECT id,status,origin_command_id FROM run').get()).toEqual({
          id: question.run_id,
          status: 'completed',
          origin_command_id: network.find(
            (row) => row.method === 'POST' && row.body?.kind === 'run.start',
          )!.body!.commandId,
        });
        const records = db
          .query(
            "SELECT key,json FROM extension_record WHERE extension_id='builtin.skill-workflow'",
          )
          .all() as { key: string; json: string }[];
        const first = records.find((row) => row.key.endsWith('/attempts/1/verification'));
        expect(JSON.parse(first!.json).outcome).toBe('failed');
        const failedProof = JSON.parse(first!.json);
        const closed = JSON.parse(
          records.find((row) => row.key.endsWith('/attempts/1/closed'))!.json,
        );
        expect(closed.output).toEqual({ answer: 'original failed output' });
        expect(failedProof.outputDigest).toBe(closed.outputDigest);
        expect(
          db
            .query(
              'SELECT state,kind,session_id,adapter_id,result_revision FROM execution WHERE id=?',
            )
            .get(failedProof.executionId),
        ).toEqual({
          state: 'failed',
          kind: 'job',
          session_id: 's',
          adapter_id: 'skill.workflow.verify',
          result_revision: Number(failedProof.resultRevision),
        });
        const decisionRecord = records.find((row) => row.key.includes('/attempts/1/decision/'))!;
        const adopted = JSON.parse(decisionRecord.json);
        expect(adopted.request).toEqual(JSON.parse(question.request_json));
        expect(adopted.proof).toMatchObject({
          interactionId: question.id,
          originStoreId: question.origin_store_id,
          sessionId: 's',
          runId: question.run_id,
          executionId: question.execution_id,
          decisionRevision: '2',
          request: adopted.request,
          answer: original.answer,
        });
        expect(adopted.request).toMatchObject({
          attempt: 1,
          headRevision: closed.headRevision,
          outputDigest: closed.outputDigest,
          verifier: failedProof,
        });
        expect(JSON.parse(records.find((row) => row.key.endsWith('/head'))!.json)).toEqual(
          decision === 'waive'
            ? { kind: 'head', attempt: 1, waiverKey: decisionRecord.key }
            : { kind: 'head', attempt: 2 },
        );
        const approvals = db
          .query(
            "SELECT request_json,state,accepted_decision_revision FROM interaction WHERE kind='approval' ORDER BY rowid",
          )
          .all() as { request_json: string; state: string; accepted_decision_revision: number }[];
        expect(approvals.map((row) => JSON.parse(row.request_json).definitionId)).toEqual(
          decision === 'waive'
            ? ['complete_skill', 'skill.workflow.verify', 'decide_skill_verification']
            : [
                'complete_skill',
                'skill.workflow.verify',
                'decide_skill_verification',
                'complete_skill',
                'skill.workflow.verify',
              ],
        );
        expect(
          approvals.every(
            (row) => row.state === 'answered' && row.accepted_decision_revision === 2,
          ),
        ).toBe(true);

        if (decision === 'waive')
          expect(
            records.some(
              (row) =>
                JSON.parse(row.json).status === 'waived' ||
                JSON.parse(row.json).outcome === 'waived',
            ),
          ).toBe(true);
        else
          expect(
            JSON.parse(records.find((row) => row.key.endsWith('/attempts/2/verification'))!.json)
              .outcome,
          ).toBe('passed');
      } finally {
        db.close();
      }
      expect(readFileSync(f.ledger, 'utf8').trim().split('\n')).toHaveLength(
        decision === 'waive' ? 1 : 2,
      );
      expect(() => process.kill(Number(readFileSync(pidPath, 'utf8')), 0)).toThrow();
    } finally {
      try {
        if (python && python.exitCode === null) {
          // Interrupt the held Python so its finally owns cleanup of its current Popen.
          python.kill('SIGINT');
          await python.exited;
        }
      } finally {
        try {
          for (const name of ['network', 'first-get-lost', 'owned-pid'])
            if (existsSync(join(f.root, name)))
              writeFileSync(join(evidence, name), readFileSync(join(f.root, name)));
          writeFileSync(join(evidence, 'requests.json'), JSON.stringify(f.requests));
          if (existsSync(f.profile.databasePath)) {
            const db = new Database(f.profile.databasePath, { readonly: true });
            try {
              writeFileSync(
                join(evidence, 'final-facts.json'),
                JSON.stringify(
                  Object.fromEntries(
                    ['run', 'command', 'execution', 'interaction', 'extension_record'].map(
                      (table) => [table, db.query(`SELECT * FROM ${table}`).all()],
                    ),
                  ),
                ),
              );
            } finally {
              db.close();
            }
          }
          console.error(JSON.stringify({ scenario, evidence, pythonExit: python?.exitCode }));
        } finally {
          f.close();
        }
      }
    }
  }, 40000);
