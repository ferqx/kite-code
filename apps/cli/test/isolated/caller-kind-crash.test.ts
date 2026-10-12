import { expect, test } from 'bun:test';
import { existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { TuiCallerRequest } from '@kite-ai/ui/tui';
import { recoveryProfile, untilRecovery } from '../fixtures/recovery-profile';

const repo = resolve(import.meta.dir, '../../../..');
function processGone(pid: number) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}
async function forceOwnedWindowsChild(
  child: { readonly pid: number; readonly exited: Promise<number> },
  receipt: string,
) {
  let exited = false;
  const completion = child.exited.then((code) => {
    exited = true;
    return code;
  });
  await Promise.resolve();
  if (exited) throw Error('owned_child_exited_before_native_dispatch');
  process.kill(child.pid, 0);
  const dispatch = Bun.spawnSync(['taskkill.exe', '/pid', String(child.pid), '/f'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (dispatch.exitCode !== 0) throw Error('owned_child_native_dispatch_failed');
  const code = await completion;
  expect(code).not.toBe(0);
  expect(processGone(child.pid)).toBe(true);
  writeFileSync(
    receipt,
    JSON.stringify({
      pid: child.pid,
      dispatchExitCode: dispatch.exitCode,
      exitCode: code,
      waitConfirmed: true,
      descendants: false,
    }),
  );
}
for (const kind of ['input.steer', 'input.follow_up', 'command.cancel'] as const)
  test(`actual ${kind} caller and paired Service native abrupt termination preserve original request; physical first GET loss cannot POST`, async () => {
    const f = await recoveryProfile();
    let warm = await f.launch(),
      child: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
    const base = `${f.root}-${kind.replaceAll('.', '-')}`,
      journal = join(f.profile.profilePath, 'ui/caller-intents.json'),
      runner = join(f.root, 'runner.ts'),
      wire = `${base}.wire.jsonl`;
    try {
      await warm.client.recoverSession('s', {
        kind: 'session.recover',
        expectedStoreId: f.storeId,
        commandId: 'prepare-original',
        decision: 'interrupt',
      });
      await warm.client.startRun('s', {
        kind: 'run.start',
        expectedStoreId: f.storeId,
        commandId: 'work-after-interrupt',
        content: 'held original Work',
      });
      await untilRecovery(
        async () =>
          (await warm.client.listInteractions('s', { storeId: f.storeId, state: 'pending' }))
            .interactions.length > 0,
      );
      const view = await warm.client.getView('s'),
        run = view.runs.find((r) => r.isActive)!;
      const request: TuiCallerRequest =
        kind === 'input.steer'
          ? {
              kind,
              expectedStoreId: f.storeId,
              commandId: 'original-caller',
              content: '原steer完整🙂e\u0301\r\n',
              targetRunId: run.id,
              contextSelectionId: view.session.contextSelectionId,
            }
          : kind === 'input.follow_up'
            ? {
                kind,
                expectedStoreId: f.storeId,
                commandId: 'original-caller',
                content: '原followup完整🙂e\u0301\r\n',
                afterRunId: run.id,
                contextSelectionId: view.session.contextSelectionId,
                extensionInputs: [
                  {
                    extensionId: 'builtin.planning',
                    definitionVersion: '1',
                    input: { mode: 'plan' },
                  },
                ],
              }
            : {
                kind,
                expectedStoreId: f.storeId,
                commandId: 'original-caller',
                targetCommandId: 'cancel-target',
              };
      if (kind === 'command.cancel')
        await warm.client.followUp('s', {
          kind: 'input.follow_up',
          expectedStoreId: f.storeId,
          commandId: 'cancel-target',
          content: 'only original queue',
          afterRunId: run.id,
          contextSelectionId: view.session.contextSelectionId,
        });
      symlinkSync(
        join(repo, 'apps/cli/node_modules'),
        join(f.root, 'node_modules'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      const source = (cold: boolean) =>
        `import{appendFileSync,readFileSync,writeFileSync}from'node:fs';import{createServer}from'node:http';import{createClient}from'@kite-ai/client';import{acquireProfileAccess,acquireProfileDataLock}from'@kite-ai/agent/profile-access';import{openCallerJournal}from${JSON.stringify(pathToFileURL(join(repo, 'apps/cli/host/caller-journal.ts')).href)};import{createTuiCallerPort}from${JSON.stringify(pathToFileURL(join(repo, 'apps/cli/host/caller-port.ts')).href)};import{createTuiDraftPort}from${JSON.stringify(pathToFileURL(join(repo, 'apps/cli/host/tui-draft-port.ts')).href)};import{openTuiDraftFile}from${JSON.stringify(pathToFileURL(join(repo, 'apps/cli/host/tui-drafts.ts')).href)};const actual=fetch;let forwarding='',drop=${true};const relay=createServer(async(req,res)=>{let body='';for await(const b of req)body+=b;const headers=new Headers();for(const[k,v]of Object.entries(req.headers))if(v&&!['host','connection','content-length'].includes(k))headers.set(k,Array.isArray(v)?v.join(','):v);const response=await actual(forwarding,{method:req.method,headers,...(req.method==='POST'?{body}:{})});const json=await response.json();appendFileSync(${JSON.stringify(wire)},JSON.stringify({event:'physical_loss',cold:${cold},method:req.method,response:json})+'\\n');res.socket!.destroy();if(req.method==='POST'){writeFileSync(${JSON.stringify(`${base}.prepared.json`)},readFileSync(${JSON.stringify(journal)}));if(process.platform==='win32')await new Promise(()=>{});else process.kill(process.pid,'SIGKILL');}});await new Promise<void>(r=>relay.listen(0,'127.0.0.1',r));const addr=relay.address()as{port:number};globalThis.fetch=Object.assign(async(...args:Parameters<typeof fetch>)=>{const method=args[1]?.method??'GET',url=new URL(String(args[0]));appendFileSync(${JSON.stringify(wire)},JSON.stringify({event:'request',cold:${cold},method,path:url.pathname,body:args[1]?.body?JSON.parse(String(args[1].body)):null})+'\\n');if(drop&&${cold ? "method==='GET'&&url.pathname==='/v1/commands/original-caller'" : "method==='POST'"}){drop=false;forwarding=url.href;const outgoing=actual('http://127.0.0.1:'+addr.port+url.pathname,args[1]);if(!${cold}&&process.platform==='win32'){void outgoing.catch(()=>{});await new Promise(()=>{});}return outgoing;}return actual(...args);},{preconnect:actual.preconnect});const client=createClient({endpoint:process.env.KITE_CALLER_TEST_ENDPOINT!,token:process.env.KITE_CALLER_TEST_TOKEN!,expected:{profile:${JSON.stringify(warm.bootstrap.profile)},apiMajor:1,requiredCapabilities:['commands','inputs']}});await client.connect();const access=acquireProfileAccess({dataRoot:${JSON.stringify(f.profile.dataRoot)},profile:'owned'}),lock=()=>acquireProfileDataLock(access,'tui_private'),j=openCallerJournal({access,acquireWriteLock:lock}),d=createTuiDraftPort({file:openTuiDraftFile({access,acquireWriteLock:lock}),notify:code=>{throw Error(code)},association:async()=> 'current'}),p=createTuiCallerPort({client,storeId:${JSON.stringify(f.storeId)},journal:j,drafts:d.port});try{${cold ? `const original=(await p.list())[0]!.intent,first=await p.lookup(original,new AbortController().signal),second=await p.submit(await p.prepare(original.scope,original.request));console.log(JSON.stringify({first,second}));` : `const original=await p.prepare({storeId:${JSON.stringify(f.storeId)},sessionId:'s',workspaceId:'w'},${JSON.stringify(request)});await p.submit(original);throw Error('expected actual SIGKILL');`}}finally{d.close();j.close();access.lock.release();client.disposeNetwork();relay.close();}`;
      const launch = async (cold: boolean) => {
        writeFileSync(runner, source(cold));
        child = Bun.spawn([process.execPath, runner], {
          env: {
            ...process.env,
            KITE_CALLER_TEST_ENDPOINT: warm.bootstrap.endpoint,
            KITE_CALLER_TEST_TOKEN: warm.bootstrap.token,
          },
          stdout: 'pipe',
          stderr: 'pipe',
        });
        if (!cold && process.platform === 'win32') {
          await untilRecovery(async () => {
            if (child!.exitCode !== null) throw Error('caller_exited_before_committed_loss');
            return existsSync(`${base}.prepared.json`);
          });
          await forceOwnedWindowsChild(child, `${base}.caller-native-kill.json`);
        }
        const [out, err, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        if (!cold) {
          if (process.platform !== 'win32') expect(child.signalCode).toBe('SIGKILL');
        } else {
          if (code) console.error(err);
          expect(code).toBe(0);
          const result = JSON.parse(out.trim());
          expect(result.first.phase).toBe('unknown');
          expect(['accepted', 'applied', 'rejected']).toContain(result.second.phase);
          expect(result.second.intent.request).toEqual(request);
        }
        writeFileSync(
          `${base}.${cold ? 'cold' : 'warm'}-caller-exit.json`,
          JSON.stringify({
            platform: process.platform,
            pid: child.pid,
            code,
            signalCode: child.signalCode,
            pidGone: processGone(child.pid),
            cold,
          }),
        );
        return { out, err, code };
      };
      await launch(false);
      const original = JSON.parse(readFileSync(journal, 'utf8')).records[0];
      expect(original.intent.request).toEqual(request);
      expect(original.intent.scope.storeId).toBe(f.storeId);
      expect(original.phase).toBe('submitting');
      if (process.platform === 'win32')
        await forceOwnedWindowsChild(warm, `${base}.service-native-kill.json`);
      else {
        process.kill(warm.pid, 'SIGKILL');
        const code = await warm.exited;
        writeFileSync(
          `${base}.service-kill-exit.json`,
          JSON.stringify({ platform: process.platform, pid: warm.pid, code, waitConfirmed: true }),
        );
      }
      warm.client.disposeNetwork();
      warm = await f.launch();
      await launch(true);
      const rows = readFileSync(wire, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
      expect(
        rows.filter((r) => !r.cold && r.event === 'physical_loss' && r.method === 'POST'),
      ).toHaveLength(1);
      expect(
        rows.filter((r) => r.cold && r.event === 'physical_loss' && r.method === 'GET'),
      ).toHaveLength(1);
      expect(rows.filter((r) => r.event === 'request' && r.method === 'POST')).toHaveLength(1);
      expect(rows.filter((r) => r.cold && r.event === 'request' && r.method === 'POST')).toEqual(
        [],
      );
      expect(
        rows.filter(
          (r) => r.cold && r.event === 'request' && r.path === '/v1/commands/original-caller',
        ),
      ).toHaveLength(2);
      expect(f.rows("SELECT count(*) AS n FROM command WHERE id='original-caller'")).toEqual([
        { n: 1 },
      ]);
      writeFileSync(`${base}.final.json`, readFileSync(journal));
      writeFileSync(
        `${base}.facts.json`,
        JSON.stringify({
          rows,
          commands: f.rows(
            'SELECT id,kind,status,subject_id,request_digest,receipt_json FROM command',
          ),
          runs: f.rows('SELECT id,origin_command_id,status FROM run'),
        }),
      );
      console.log('caller kind retained', base);
    } finally {
      if (child && child.exitCode === null) {
        if (process.platform === 'win32')
          await forceOwnedWindowsChild(child, `${base}.cleanup-native-kill.json`);
        else {
          child.kill('SIGKILL');
          await child.exited;
        }
      }
      await warm.close();
      f.close();
    }
  }, 30000);
