import { expect, test } from 'bun:test';
import { appendFileSync, linkSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { acquireProfileAccess, acquireProfileDataLock } from '@kite-ai/agent/profile-access';
import { openCallerJournal } from '../../host/caller-journal';
import { createCLICallerPort, createTuiCallerPort } from '../../host/caller-port';
import { observeCommand, runNonInteractive } from '../../src';
import { callerJobProfile } from '../fixtures/caller-job-profile';
import { recoveryProfile } from '../fixtures/recovery-profile';

const repo = resolve(import.meta.dir, '../../../..');
test('actual library run requires durable host port; original new Work request survives separately from UI drafts', async () => {
  const f = await recoveryProfile(),
    warm = await f.launch(),
    access = acquireProfileAccess(f.profile),
    j = openCallerJournal({
      access,
      acquireWriteLock: () => acquireProfileDataLock(access, 'tui_private'),
    });
  try {
    await warm.client.recoverSession('s', {
      kind: 'session.recover',
      expectedStoreId: f.storeId,
      commandId: 'interrupt-old',
      decision: 'interrupt',
    });
    const request = {
        kind: 'run.start' as const,
        expectedStoreId: f.storeId,
        commandId: 'library-work',
        content: '新Work完整🙂e\u0301\r\n',
      },
      options = {
        client: warm.client,
        caller: createCLICallerPort({ client: warm.client, storeId: f.storeId, journal: j }),
        write() {},
      };
    await expect(
      runNonInteractive(['run', 's', JSON.stringify(request)], { client: warm.client, write() {} }),
    ).rejects.toThrow('invalid_request');
    expect(await runNonInteractive(['run', 's', JSON.stringify(request)], options)).toBe(3);
    const original = j.list()[0]!.intent;
    expect(original.request).toEqual(request);
    expect(original.draft).toBeUndefined();
    const originalRun = (await warm.client.getCommand('library-work')).receipt as { runId: string };
    expect((await warm.client.getRun(originalRun.runId)).originCommandId).toBe('library-work');
    const calls = f.calls();
    expect(await runNonInteractive(['work', 's', JSON.stringify(request)], options)).toBe(3);
    expect(f.calls()).toBe(calls);
    expect(f.rows("SELECT count(*) AS n FROM command WHERE id='library-work'")).toEqual([{ n: 1 }]);
    const interrupt = new AbortController();
    const cancelled = await observeCommand(
      's',
      request as import('@kite-ai/client').StartCommandRequest,
      {
        ...options,
        signal: interrupt.signal,
        write: (line) => {
          if (line.startsWith('accepted ')) interrupt.abort();
        },
      },
    );
    expect(cancelled.cancellationAttempted).toBe(true);
    expect(cancelled.status).toBe('cancelled');
    const cancel = j.list().find((r) => r.intent.request.kind === 'command.cancel')!;
    expect(cancel.intent.target).toEqual({ kind: 'command', id: 'library-work' });
    expect(cancel.phase).toBe('applied');
    expect(cancel.intent.draft).toBeUndefined();
    expect(f.rows("SELECT count(*) AS n FROM command WHERE kind='command.cancel'")).toEqual([
      { n: 1 },
    ]);
  } finally {
    j.close();
    access.lock.release();
    await warm.close();
    f.close();
  }
}, 30000);

test('actual library exact Job Stop POST loss + producer SIGKILL; cold first GET loss and same body never cancel sibling or POST again', async () => {
  const f = await callerJobProfile(),
    base = `${f.root}-cli-job`,
    runner = join(f.root, 'cli-job.ts'),
    wire = `${base}.wire.jsonl`,
    journal = join(f.profile.profilePath, 'ui/caller-intents.json');
  let child: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
  try {
    const parent = (await f.client.getView('s')).runs.filter((r) => r.originCommandId === 'work');
    expect(parent).toHaveLength(1);
    expect(parent[0]!.status).toBe('completed');
    expect(f.calls()).toBe(2);
    const request = {
      kind: 'execution.cancel',
      expectedStoreId: f.storeId,
      commandId: 'cli-job-stop',
      executionId: f.jobs[0]!.id,
    };
    // Fixture already runs genuine independent confined Shell supervisors and completed parent Run.
    for (const cold of [false, true]) {
      writeFileSync(
        runner,
        `import{appendFileSync,writeFileSync}from'node:fs';import{createServer}from'node:http';import{createClient}from'@kite-ai/client';import{acquireProfileAccess,acquireProfileDataLock}from'@kite-ai/agent/profile-access';import{openCallerJournal}from${JSON.stringify(join(repo, 'apps/cli/host/caller-journal.ts'))};import{createCLICallerPort}from${JSON.stringify(join(repo, 'apps/cli/host/caller-port.ts'))};import{runNonInteractive}from${JSON.stringify(join(repo, 'apps/cli/src/index.ts'))};const actual=fetch;let drop=true,forwarding='';const relay=createServer(async(req,res)=>{let body='';for await(const b of req)body+=b;const headers=new Headers();for(const[k,v]of Object.entries(req.headers))if(v&&!['host','connection','content-length'].includes(k))headers.set(k,Array.isArray(v)?v.join(','):v);const response=await actual(forwarding,{method:req.method,headers,...(req.method==='POST'?{body}:{})});appendFileSync(${JSON.stringify(wire)},JSON.stringify({event:'physical_loss',cold:${cold},method:req.method,response:await response.json()})+'\\n');res.socket!.destroy();${cold ? '' : "process.kill(process.pid,'SIGKILL');"}});await new Promise<void>(r=>relay.listen(0,'127.0.0.1',r));const address=relay.address()as{port:number};globalThis.fetch=Object.assign(async(...args:Parameters<typeof fetch>)=>{const method=args[1]?.method??'GET',url=new URL(String(args[0]));appendFileSync(${JSON.stringify(wire)},JSON.stringify({event:'request',cold:${cold},method,path:url.pathname})+'\\n');if(drop&&${cold ? "method==='GET'&&url.pathname==='/v1/commands/cli-job-stop'" : "method==='POST'"}){drop=false;forwarding=url.href;return actual('http://127.0.0.1:'+address.port+url.pathname,args[1]);}return actual(...args);},{preconnect:actual.preconnect});const client=createClient({endpoint:process.env.OWNED_ENDPOINT!,token:process.env.OWNED_TOKEN!,expected:{profile:${JSON.stringify(f.serviceProfile)},apiMajor:1,requiredCapabilities:['commands','inputs']}});await client.connect();const access=acquireProfileAccess(${JSON.stringify({ dataRoot: f.profile.dataRoot, profile: 'owned' })}),j=openCallerJournal({access,acquireWriteLock:()=>acquireProfileDataLock(access,'tui_private')}),options={client,caller:createCLICallerPort({client,storeId:${JSON.stringify(f.storeId)},journal:j}),write:()=>{}};try{const args=['work','s',${JSON.stringify(JSON.stringify(request))}];${cold ? 'const first=await runNonInteractive(args,options),second=await runNonInteractive(args,options);console.log(JSON.stringify({first,second}));' : "await runNonInteractive(args,options);throw Error('kill expected');"}}finally{j.close();access.lock.release();client.disposeNetwork();relay.close();}`,
      );
      child = Bun.spawn([process.execPath, runner], {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, OWNED_ENDPOINT: f.endpoint, OWNED_TOKEN: f.token },
      });
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (cold) {
        if (code) console.error(err);
        expect(code).toBe(0);
        expect(JSON.parse(out.trim())).toEqual({ first: 2, second: 0 });
      } else {
        writeFileSync(`${base}.producer.stderr`, err);
        if (child.signalCode !== 'SIGKILL') console.error(err);
        expect(child.signalCode).toBe('SIGKILL');
        writeFileSync(`${base}.prepared.json`, readFileSync(journal));
      }
    }
    const a = await f.client.getExecution(f.jobs[0]!.id),
      b = await f.client.getExecution(f.jobs[1]!.id);
    expect(a.cancelRequestedAt).not.toBeNull();
    expect(b.cancelRequestedAt).toBeNull();
    expect(b.status).toBe('running');
    const events = readFileSync(wire, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(events.filter((e) => e.event === 'request' && e.method === 'POST')).toHaveLength(1);
    expect(
      events.filter((e) => e.event === 'request' && e.cold && e.method === 'POST'),
    ).toHaveLength(0);
    const command = await f.client.getCommand('cli-job-stop');
    expect(command.kind).toBe('execution.cancel');
    writeFileSync(
      `${base}.facts.json`,
      JSON.stringify({ a, b, command, parent, calls: f.calls() }),
    );
    writeFileSync(`${base}.final.json`, readFileSync(journal));
    appendFileSync(wire, `${JSON.stringify({ event: 'verified', a: a.id, b: b.id })}\n`);
    console.log('cli job artifacts', base);
  } finally {
    if (child?.exitCode === null) child.kill('SIGKILL');
    await f.close();
  }
}, 30000);

test('actual ordinary library full/corrupt/hardlinked private journal reports local not_submitted and never POSTs or replaces prior bytes', async () => {
  const f = await recoveryProfile(),
    warm = await f.launch(),
    access = acquireProfileAccess(f.profile),
    j = openCallerJournal({
      access,
      acquireWriteLock: () => acquireProfileDataLock(access, 'tui_private'),
    }),
    path = join(f.profile.profilePath, 'ui/caller-intents.json'),
    actual = globalThis.fetch;
  const wire: { method: string; path: string }[] = [];
  globalThis.fetch = Object.assign(
    async (...args: Parameters<typeof fetch>) => {
      wire.push({ method: args[1]?.method ?? 'GET', path: new URL(String(args[0])).pathname });
      return actual(...args);
    },
    { preconnect: actual.preconnect },
  );
  try {
    const port = createTuiCallerPort({ client: warm.client, storeId: f.storeId, journal: j });
    for (let n = 0; n < 128; n++)
      await port.prepare(
        { storeId: f.storeId, sessionId: 's', workspaceId: 'w' },
        {
          kind: 'run.start',
          expectedStoreId: f.storeId,
          commandId: `private-slot-${n}`,
          content: '完整合法内容🙂',
        },
      );
    const bytes = readFileSync(path),
      lines: string[] = [],
      request = {
        kind: 'run.start',
        expectedStoreId: f.storeId,
        commandId: 'blocked-private',
        content: '完整不能丢🙂',
      },
      options = {
        client: warm.client,
        caller: createCLICallerPort({ client: warm.client, storeId: f.storeId, journal: j }),
        write: (line: string) => lines.push(line),
      };
    expect(await runNonInteractive(['work', 's', JSON.stringify(request)], options)).toBe(1);
    expect(lines.at(-1)).toContain('caller_intent_limit');
    expect(readFileSync(path)).toEqual(bytes);
    expect(j.list()).toHaveLength(128);
    writeFileSync(path, '{bad-json');
    expect(await runNonInteractive(['work', 's', JSON.stringify(request)], options)).toBe(1);
    expect(lines.at(-1)).toContain('caller_journal_unavailable');
    expect(readFileSync(path, 'utf8')).toBe('{bad-json');
    writeFileSync(path, bytes);
    linkSync(path, `${path}.hardlink`);
    expect(await runNonInteractive(['work', 's', JSON.stringify(request)], options)).toBe(1);
    expect(lines.at(-1)).toContain('"phase":"not_submitted"');
    expect(readFileSync(path)).toEqual(bytes);
    expect(wire.filter((r) => r.method === 'POST')).toHaveLength(0);
    expect(f.rows("SELECT count(*) AS n FROM command WHERE id='blocked-private'")).toEqual([
      { n: 0 },
    ]);
    const base = `${f.root}-cli-capacity`;
    writeFileSync(`${base}.wire.json`, JSON.stringify(wire));
    writeFileSync(`${base}.journal.json`, bytes);
    writeFileSync(
      `${base}.facts.json`,
      JSON.stringify({ lines, commands: f.rows('SELECT id,kind,status FROM command') }),
    );
    console.log('cli capacity artifacts', base);
  } finally {
    globalThis.fetch = actual;
    j.close();
    access.lock.release();
    await warm.close();
    f.close();
  }
}, 30000);
