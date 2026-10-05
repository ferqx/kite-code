import { expect, test } from 'bun:test';
import { join } from 'node:path';

for (const order of ['root-first', 'job-first'] as const) {
  test(`real 80x24 ${order} four pending cards preserve independent approval and unknown original answer`, async () => {
    const program = `import os,pty,subprocess,select,time,signal,json,re,tempfile,fcntl,termios,struct
master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',24,80,0,0));temporary=tempfile.TemporaryDirectory(prefix='kite-cards-');facts=os.path.join(temporary.name,'facts.json');cardsfile=os.path.join(temporary.name,'cards.json');wire=os.path.join(temporary.name,'wire.jsonl');reviews=os.path.join(temporary.name,'reviews.json');env=dict(os.environ);env.update(KITE_TUI_FACTS=facts,KITE_TUI_CARDS=cardsfile,KITE_TUI_WIRE=wire,KITE_TUI_REVIEWS=reviews,KITE_LOSE_CARD='1',KITE_TUI_ROOT=os.path.join(temporary.name,'runtime'));os.mkdir(env['KITE_TUI_ROOT'],0o700)
p=subprocess.Popen([${JSON.stringify(process.execPath)},${JSON.stringify(join(import.meta.dir, 'pending-cards.fixture.tsx'))}],stdin=slave,stdout=slave,stderr=slave,env=env,start_new_session=True);os.close(slave);buffer=b'';full=b''
def pump():
 global buffer,full
 if select.select([master],[],[],.08)[0]:
  try: data=os.read(master,65536);buffer+=data;full+=data
  except OSError: pass
def wait(text):
 deadline=time.monotonic()+8
 while text not in re.sub(r'\\s+',' ',re.sub(r'\\x1b\\[[0-?]*[ -/]*[@-~]','',buffer.decode(errors='replace'))):
  if time.monotonic()>deadline:raise RuntimeError('expected '+text+' tail='+buffer[-5000:].decode(errors='replace'))
  pump()
def key(data):
 global buffer
 buffer=b'';os.write(master,data);end=time.monotonic()+.1
 while time.monotonic()<end:pump()
def cards():
 try:return json.load(open(cardsfile))
 except:return []
def waitcards(n):
 deadline=time.monotonic()+8
 while len(cards())!=n:
  if time.monotonic()>deadline:raise RuntimeError('pending directory '+str(cards())+' tail='+buffer[-3000:].decode(errors='replace'))
  pump()
def waitreview(card):
 deadline=time.monotonic()+8
 while True:
  try: current=json.load(open(reviews))
  except:current=[]
  if any(json.loads(item['key'])[3]==card['id'] and item['bytes']>70000 for item in current):return
  if time.monotonic()>deadline:raise RuntimeError('missing original full attachment '+str(current)+' tail='+buffer[-3000:].decode(errors='replace'))
  pump()
def choose(card):
 current=cards();index=next(i for i,c in enumerate(current) if c['id']==card['id']);key(b'\\x02');wait('Pending cards');key(b'\\x1b[A'*5);key(b'\\x1b[B'*index);key(b'\\r');wait(card['id'])
try:
 wait('New Run');key(b'work');key(b'\\r');waitcards(4);initial=cards();assert len({c['id'] for c in initial})==4;assert len({c['originStoreId'] for c in initial})==1
 root=next(c for c in initial if c['kind']=='question');job=next(c for c in initial if c['definitionId']=='required-verifier');children=[c for c in initial if c['definitionId']=='ask'];assert len(children)==2;assert len({c['sessionId'] for c in children})==2;assert root['sessionId']=='a';assert job['sessionId']=='a';assert all(c['presentationSessionId']=='a' for c in initial)
 for original in children+[job]:
  choose(original);key(b'\\x01');waitreview(original)
 order=[root,children[1],job,children[0]] if ${JSON.stringify(order)}=='root-first' else [job,children[0],root,children[1]]
 for i,card in enumerate(order):
  choose(card)
  if card['kind']=='question':key(b'{"choiceId":"root-choice"}')
  else:
   waitreview(card);key(b'\\x1b[B')
  key(b'\\r')
  if i==0:
   wait('unknown');before=open(wire).read().count('"method":"POST"');key(b'\\x02');key(b'\\x1b[B');key(b'\\r');key(b'\\r');assert open(wire).read().count('"method":"POST"')==before
   key(b'\\x0c');wait('unknown');key(b'\\x0c')
  waitcards(3-i)
 wait('MULTI_CARD_DONE');os.kill(p.pid,signal.SIGTERM)
 deadline=time.monotonic()+5
 while p.poll() is None and time.monotonic()<deadline:pump()
 p.wait(timeout=3);print('SAFE_FACTS '+open(facts).read());print('WIRE_FACTS '+json.dumps([json.loads(line) for line in open(wire)]));print('PTY_COMPLETE_BYTES '+str(len(full)))
finally:
 if p.poll() is None:os.killpg(p.pid,signal.SIGKILL);p.wait()
 os.close(master);temporary.cleanup()
`;
    const child = Bun.spawn(['python3', '-c', program], { stdout: 'pipe', stderr: 'pipe' });
    const [out, err, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exit) console.error(err, out);
    expect(exit).toBe(0);
    expect(err).toBe('');
    const facts = JSON.parse(out.split('SAFE_FACTS ')[1]!.split('\n')[0]!);
    const wire = JSON.parse(out.split('WIRE_FACTS ')[1]!.split('\n')[0]!) as {
      method: string;
      path: string;
      body?: {
        commandId: string;
        expectedStoreId: string;
        expectedRevision: string;
        answer?: unknown;
      };
    }[];
    expect(facts.effects).toBe(2);
    expect(facts.verifierStarts).toBe(1);
    expect(facts.modelCalls).toBe(2);
    expect(facts.childCalls).toBe(4);
    expect(facts.cancellations).toBe(0);
    expect(facts.runs).toEqual(['completed']);
    expect(facts.attachmentFacts).toHaveLength(3);
    for (const review of facts.attachmentFacts) {
      expect(review.bytes).toBeGreaterThan(70000);
      expect(review.policyBytes).toBeGreaterThan(70000);
      expect(review.tail).toContain('END_FULL_');
    }
    const delegate = facts.executionFacts.find(
      (item: { definitionId: string }) => item.definitionId === 'delegate',
    );
    const job = facts.executionFacts.find(
      (item: { definitionId: string }) => item.definitionId === 'required-verifier',
    );
    expect(job).toMatchObject({
      kind: 'job',
      sessionId: 'a',
      runId: null,
      parentExecutionId: delegate.id,
      status: 'succeeded',
    });
    const children = facts.executionFacts.filter((item: { definitionId: string }) =>
      item.definitionId.startsWith('agent/'),
    );
    expect(children).toHaveLength(2);
    for (const child of children)
      expect(child).toMatchObject({
        sessionId: 'a',
        parentExecutionId: delegate.id,
        status: 'succeeded',
      });
    expect(facts.postCount).toBe(4);
    expect(facts.getCount).toBe(2);
    expect(facts.interactions).toHaveLength(4);
    for (const card of facts.interactions) {
      expect(card.state).toBe('answered');
      expect(card.acceptedDecisionRevision).toBe(card.revision);
    }
    const posts = wire.filter((row) => row.method === 'POST' && row.path.endsWith('/answer'));
    expect(posts).toHaveLength(4);
    for (const posted of posts) {
      const cardId = decodeURIComponent(posted.path.split('/').at(-2)!);
      const card = facts.interactions.find((item: { id: string }) => item.id === cardId);
      expect(card).toBeDefined();
      expect(card.originStoreId).toBe(posted.body!.expectedStoreId);
      expect(card.acceptedDecisionRevision).toBe(
        String(BigInt(posted.body!.expectedRevision) + 1n),
      );
      if (card.kind === 'approval')
        expect(card.answer).toMatchObject({ decision: 'approve', grant: 'approve_once' });
    }
    const lostPost = posts.find((row) => row.body!.commandId === facts.lostCommand)!;
    const lostCardId = decodeURIComponent(lostPost.path.split('/').at(-2)!);
    expect(facts.originalGetResponses).toHaveLength(2);
    for (const received of facts.originalGetResponses)
      expect(received).toMatchObject({
        id: facts.lostCommand,
        kind: 'interaction.answer',
        originStoreId: lostPost.body!.expectedStoreId,
        sessionId: 'a',
        status: 'applied',
        receipt: {
          outcome: 'answer_saved',
          interactionId: lostCardId,
          decisionRevision: String(BigInt(lostPost.body!.expectedRevision) + 1n),
        },
      });
    expect(new Set(posts.map((row) => row.body!.commandId)).size).toBe(4);
    const gets = wire.filter(
      (row) => row.method === 'GET' && row.path.endsWith('/commands/' + facts.lostCommand),
    );
    expect(gets).toHaveLength(2);
    expect(new Set(gets.map((row) => row.path)).size).toBe(1);
    expect(posts.find((row) => row.body!.commandId === facts.lostCommand)!.path).toContain(
      '/sessions/a/',
    );
    expect(new Set(posts.map((row) => row.body!.expectedStoreId)).size).toBe(1);
  }, 30000);
}
