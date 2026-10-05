import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runSelectedDaemon } from '../../host/daemon';
import { recoveryProfile } from '../fixtures/recovery-profile';

const repo = resolve(import.meta.dir, '../../../..');
for (const connection of ['paired', 'shared'] as const)
  test(`actual ${connection} work argv durable POST loss + SIGKILL and cold caller argv first GET loss preserve complete Workflow request and zero POST`, async () => {
    const f = await recoveryProfile();
    const base = `${f.root}-cli-caller`,
      runner = join(f.root, 'caller-runner.ts'),
      wire = `${base}.wire.jsonl`,
      journal = join(f.profile.profilePath, 'ui/caller-intents.json');
    const socket = join(f.root, 'cli.sock');
    let daemonArtifact: Parameters<typeof runSelectedDaemon>[0]['artifact'];
    let child: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
    const owned = new Set<number>();
    try {
      symlinkSync(join(repo, 'apps/cli/node_modules'), join(f.root, 'node_modules'), 'dir');
      const warm = await f.launch();
      const contextSelectionId = (await warm.client.getView('s')).session.contextSelectionId;
      await warm.close();
      if (connection === 'shared') {
        const web = join(f.root, 'web');
        mkdirSync(web);
        const manifest = [
          ['/index.html', 'text/html; charset=utf-8', '<title>Owned</title>'],
          ['/app.js', 'text/javascript; charset=utf-8', 'globalThis.owned=true;'],
          ['/app.css', 'text/css; charset=utf-8', 'body{}'],
        ].map(([path, mediaType, content]) => {
          writeFileSync(join(web, path!.slice(1)), content!);
          return {
            path,
            mediaType,
            size: Buffer.byteLength(content!),
            sha256: createHash('sha256').update(content!).digest('hex'),
          };
        });
        const raw = JSON.stringify(manifest);
        writeFileSync(join(web, 'manifest.json'), raw);
        const entrypoint = join(f.root, 'artifact/node_modules/@kite-ai/service/daemon-main.js');
        daemonArtifact = {
          ...f.artifact,
          daemon: {
            entrypoint,
            entrypointSha256: createHash('sha256').update(readFileSync(entrypoint)).digest('hex'),
            web: { directory: web, manifestSha256: createHash('sha256').update(raw).digest('hex') },
          },
        };
        await runSelectedDaemon({
          arguments: {
            kind: 'server',
            action: 'start',
            server: socket,
            json: false,
            cancel: false,
          },
          artifact: daemonArtifact,
          dataRoot: f.profile.dataRoot,
          profile: 'owned',
          cwd: f.workspace,
          write() {},
        });
      }
      const request = {
        kind: 'input.follow_up',
        expectedStoreId: f.storeId,
        commandId: 'cli-original',
        content: '完整普通CLI🙂e\u0301\r\n第二行',
        afterRunId: f.run.id,
        contextSelectionId,
        extensionInputs: [
          {
            extensionId: 'builtin.skill-workflow',
            definitionVersion: '1',
            input: {
              activations: [
                { skillId: 'skill:unconfigured', input: { full: '保留完整正文🙂\r\n' } },
              ],
            },
          },
        ],
      };
      const launch = async (argv: string[], mode: 'post' | 'get' | 'normal' | 'prepared') => {
        if (connection === 'shared') argv = [...argv, '--server', socket];
        writeFileSync(
          runner,
          `import{appendFileSync,writeFileSync}from'node:fs';import{createServer}from'node:http';import{runSelectedCLI}from${JSON.stringify(join(repo, 'apps/cli/host/index.ts'))};import{parseCLIArguments}from${JSON.stringify(join(repo, 'apps/cli/src/arguments.ts'))};const actual=fetch;let drop=true,forwarding='';const relay=createServer(async(req,res)=>{let body='';for await(const b of req)body+=b;const headers=new Headers();for(const[k,v]of Object.entries(req.headers))if(v&&!['host','connection','content-length'].includes(k))headers.set(k,Array.isArray(v)?v.join(','):v);const response=await actual(forwarding,{method:req.method,headers,...(req.method==='POST'?{body}:{})});const json=await response.json();appendFileSync(${JSON.stringify(wire)},JSON.stringify({event:'physical_loss',mode:${JSON.stringify(mode)},method:req.method,json})+'\\n');res.socket!.destroy();${mode === 'post' ? "process.kill(process.pid,'SIGKILL');" : ''}});await new Promise<void>(r=>relay.listen(0,'127.0.0.1',r));const address=relay.address()as{port:number};globalThis.fetch=Object.assign(async(...args:Parameters<typeof fetch>)=>{const method=args[1]?.method??'GET',url=new URL(String(args[0]));appendFileSync(${JSON.stringify(wire)},JSON.stringify({event:'request',mode:${JSON.stringify(mode)},method,path:url.pathname,body:args[1]?.body?JSON.parse(String(args[1].body)):null})+'\\n');${mode === 'prepared' ? "if(method==='POST'&&url.pathname==='/v1/sessions/s/commands'){process.kill(process.pid,'SIGKILL');}" : ''}if(drop&&${mode === 'post' ? "method==='POST'&&url.pathname==='/v1/sessions/s/commands'" : mode === 'get' ? "method==='GET'&&url.pathname==='/v1/commands/cli-original'" : 'false'}){drop=false;forwarding=url.href;return actual('http://127.0.0.1:'+address.port+url.pathname,args[1]);}return actual(...args);},{preconnect:actual.preconnect});const hostExit=new AbortController();try{process.exitCode=await runSelectedCLI({exitSignal:hostExit.signal,arguments:parseCLIArguments(${JSON.stringify(argv)}),artifact:${JSON.stringify(f.artifact)},dataRoot:${JSON.stringify(f.profile.dataRoot)},profile:'owned',cwd:${JSON.stringify(f.workspace)},onLaunched:c=>writeFileSync(${JSON.stringify(`${base}.pid`)},String(c.pid)),write:l=>{console.log(l);if(${mode === 'normal'}&&JSON.parse(l).kind==='work.event'&&(JSON.parse(l).line.startsWith('accepted ')||JSON.parse(l).line.includes('outcome_unknown')))hostExit.abort();},prompt:l=>process.stderr.write(l)});}finally{relay.close();}`,
        );
        child = Bun.spawn([process.execPath, runner], {
          stdout: 'pipe',
          stderr: 'pipe',
          stdin: 'ignore',
        });
        const [out, err, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        const pid = connection === 'paired' ? Number(readFileSync(`${base}.pid`, 'utf8')) : null;
        if (pid) owned.add(pid);
        writeFileSync(`${base}.${mode}.stdout`, out);
        writeFileSync(`${base}.${mode}.stderr`, err);
        if (mode === 'post' || mode === 'prepared') expect(child.signalCode).toBe('SIGKILL');
        else {
          if (code !== 0 && code !== 2 && code !== 1) console.error(err);
          expect([0, 1, 2]).toContain(code!);
        }
        // Cleanup only the exact Service launched by this fixture's host.
        if (pid)
          try {
            process.kill(pid, 'SIGKILL');
          } catch {}
        return { out, code };
      };
      await launch(['work', 's', '--input', JSON.stringify(request)], 'post');
      const doc = JSON.parse(readFileSync(journal, 'utf8')),
        intent = doc.records[0].intent;
      expect(intent.request).toEqual(request);
      expect(intent.draft).toBeUndefined();
      writeFileSync(`${base}.prepared.json`, readFileSync(journal));
      const first = await launch(
        ['caller', 'lookup', 's', '--input', JSON.stringify(intent)],
        'get',
      );
      expect(first.code).toBe(2);
      expect(first.out).toContain('"phase":"unknown"');
      const second = await launch(
        ['caller', 'lookup', 's', '--input', JSON.stringify(intent)],
        'normal',
      );
      expect(second.out).toContain('"phase":"accepted"');
      expect(second.code).toBe(2);
      const same = await launch(['work', 's', '--input', JSON.stringify(request)], 'normal');
      expect(same.code).toBe(2);
      const drift = await launch(
        ['work', 's', '--input', JSON.stringify({ ...request, content: 'drift' })],
        'normal',
      );
      expect(drift.code).toBe(2);
      const absent = await launch(
        ['caller', 'lookup', 's', '--input', JSON.stringify({ ...intent, subjectId: 'other' })],
        'normal',
      );
      expect(absent.code).toBe(2);
      const wrongWorkspace = await launch(
        [
          'caller',
          'lookup',
          's',
          '--input',
          JSON.stringify({ ...intent, scope: { ...intent.scope, workspaceId: 'other' } }),
        ],
        'normal',
      );
      expect(wrongWorkspace.code).toBe(2);
      const wrongStore = await launch(
        ['work', 's', '--input', JSON.stringify({ ...request, expectedStoreId: 'other' })],
        'normal',
      );
      expect(wrongStore.code).toBe(2);
      const directory = await launch(
        [
          'caller',
          'list',
          's',
          '--input',
          JSON.stringify({ expectedStoreId: f.storeId, workspaceId: 'w' }),
        ],
        'normal',
      );
      expect(directory.code).toBe(0);
      expect(JSON.parse(directory.out.trim()).records[0].intent).toEqual(intent);

      const preparedRequest = { ...request, commandId: 'cli-prepared' };
      await launch(['work', 's', '--input', JSON.stringify(preparedRequest)], 'prepared');
      const prepared = JSON.parse(readFileSync(journal, 'utf8')).records.find(
        (r: { intent: { request: { commandId: string } } }) =>
          r.intent.request.commandId === 'cli-prepared',
      );
      expect(prepared.phase).toBe('submitting');
      expect(prepared.intent.request).toEqual(preparedRequest);
      const preparedLookup = await launch(
        ['caller', 'lookup', 's', '--input', JSON.stringify(prepared.intent)],
        'normal',
      );
      expect(preparedLookup.code).toBe(2);
      expect(preparedLookup.out).toContain('"phase":"unknown"');
      const preparedAgain = await launch(
        ['work', 's', '--input', JSON.stringify(preparedRequest)],
        'normal',
      );
      expect(preparedAgain.code).toBe(2);
      expect(f.rows("SELECT count(*) AS n FROM command WHERE id='cli-prepared'")).toEqual([
        { n: 0 },
      ]);
      writeFileSync(`${base}.cold-prepared.json`, readFileSync(journal));
      const events = readFileSync(wire, 'utf8')
        .trim()
        .split('\n')
        .map((x) => JSON.parse(x));
      expect(
        events.filter(
          (e) =>
            e.event === 'request' &&
            e.mode !== 'prepared' &&
            e.method === 'POST' &&
            e.path === '/v1/sessions/s/commands',
        ),
      ).toHaveLength(1);
      expect(
        events.filter(
          (e) =>
            e.event === 'request' && !['post', 'prepared'].includes(e.mode) && e.method === 'POST',
        ),
      ).toHaveLength(0);
      const facts = f.rows(
        "SELECT id,kind,status,request_digest FROM command WHERE id='cli-original'",
      );
      expect(facts).toHaveLength(1);
      writeFileSync(`${base}.facts.json`, JSON.stringify(facts));
      writeFileSync(`${base}.final.json`, readFileSync(journal));
      console.log('cli caller artifacts', base);
    } finally {
      if (child?.exitCode === null) child.kill();
      for (const pid of owned)
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
      if (daemonArtifact)
        await runSelectedDaemon({
          arguments: { kind: 'server', action: 'stop', server: socket, json: false, cancel: false },
          artifact: daemonArtifact,
          dataRoot: f.profile.dataRoot,
          profile: 'owned',
          cwd: f.workspace,
          write() {},
        });
      f.close();
    }
  }, 30000);

test('actual paired main work JSON waits through original Tool approval and complete Run before owned Service closes', async () => {
  const f = await recoveryProfile(),
    base = `${f.root}-cli-complete`,
    runner = join(f.root, 'complete.ts');
  let child: Bun.Subprocess<'pipe', 'pipe', 'pipe'> | undefined;
  try {
    const warm = await f.launch();
    await warm.client.recoverSession('s', {
      kind: 'session.recover',
      expectedStoreId: f.storeId,
      commandId: 'interrupt-original',
      decision: 'interrupt',
    });
    await warm.close();
    symlinkSync(join(repo, 'apps/cli/node_modules'), join(f.root, 'node_modules'), 'dir');
    const request = {
      kind: 'run.start',
      expectedStoreId: f.storeId,
      commandId: 'cli-complete',
      content: '完整原JSON Work🙂e\u0301\r\n',
    };
    writeFileSync(
      runner,
      `import{runCLIProcess}from${JSON.stringify(join(repo, 'apps/cli/host/main.ts'))};process.exitCode=await runCLIProcess({argv:${JSON.stringify(['work', 's', '--input', JSON.stringify(request)])},artifact:${JSON.stringify(f.artifact)},dataRoot:${JSON.stringify(f.profile.dataRoot)},profile:'owned',cwd:${JSON.stringify(f.workspace)}});`,
    );
    child = Bun.spawn([process.execPath, runner], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    let answered = false;
    const capture = async (stream: ReadableStream<Uint8Array>, path: string, approve = false) => {
      let value = '';
      const decoder = new TextDecoder();
      for await (const chunk of stream) {
        value += decoder.decode(chunk, { stream: true });
        writeFileSync(path, value);
        if (approve && !answered && value.includes('Answer approve (once)')) {
          answered = true;
          child!.stdin.write('approve\n');
          child!.stdin.end();
        }
      }
      return value;
    };
    const [out, err, code] = await Promise.all([
      capture(child.stdout, `${base}.stdout`),
      capture(child.stderr, `${base}.stderr`, true),
      child.exited,
    ]);
    writeFileSync(`${base}.stdout`, out);
    writeFileSync(`${base}.stderr`, err);
    if (code) console.error(err);
    expect(code).toBe(0);
    const lines = out
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines[0].kind).toBe('caller.intent');
    expect(lines[0].intent.request).toEqual(request);
    expect(lines.some((l) => l.kind === 'caller.receipt' && l.command.id === 'cli-complete')).toBe(
      true,
    );
    const result = lines.find((l) => l.kind === 'work.outcome');
    expect(result.status).toBe('succeeded');
    expect(result.run.status).toBe('completed');
    expect(result.run.originCommandId).toBe('cli-complete');
    expect(result.run.originStoreId).toBe(f.storeId);
    expect(result.run.sessionId).toBe('s');
    expect(out).toContain('RECOVERED_ORIGINAL_DONE');
    expect(err).toContain('Answer approve (once)');
    expect(readFileSync(join(f.workspace, 'effect'), 'utf8')).toBe('ORIGINAL_EFFECT_ONCE');
    expect(f.calls()).toBe(3);
    expect(f.rows("SELECT count(*) AS n FROM command WHERE id='cli-complete'")).toEqual([{ n: 1 }]);
    const facts = {
      commands: f.rows('SELECT id,kind,status,subject_id,request_digest,receipt_json FROM command'),
      runs: f.rows('SELECT id,origin_command_id,status FROM run'),
      executions: f.rows('SELECT id,kind,state,adapter_id FROM execution'),
      calls: f.calls(),
    };
    expect(
      facts.executions.filter(
        (e) =>
          typeof e === 'object' &&
          e !== null &&
          'kind' in e &&
          e.kind === 'tool' &&
          'state' in e &&
          e.state === 'succeeded',
      ),
    ).toHaveLength(1);
    writeFileSync(`${base}.facts.json`, JSON.stringify(facts));
    writeFileSync(
      `${base}.journal.json`,
      readFileSync(join(f.profile.profilePath, 'ui/caller-intents.json')),
    );
    console.log('complete CLI artifacts', base);
  } finally {
    if (child?.exitCode === null) child.kill('SIGKILL');
    f.close();
  }
}, 30000);
