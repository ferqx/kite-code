import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ClientError, createServiceLifecycleClient } from '@kite-ai/client';
import { retainProcessObservation, selectDaemonEndpoint } from '@kite-ai/service/daemon';
import { privateDirectory } from '../../../../tests/fixtures/test-filesystem';
import { runSelectedDaemon } from '../../host/daemon';
import { verifyTerminalBundle } from '../../host/terminal-artifact';
import { recoveryProfile } from '../fixtures/recovery-profile';

const repo = resolve(import.meta.dir, '../../../..');
// Unknown native closure retains the actual owner and its self-owned files for diagnosis.
const retainedCallerOwners = new Set<unknown>();
function processGone(pid: number) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}
async function awaitDead(observation: ReturnType<typeof retainProcessObservation>) {
  const end = Date.now() + 5000;
  while (observation.inspect() !== 'dead') {
    if (Date.now() > end) throw Error('caller_owned_service_exit_unknown');
    await Bun.sleep(5);
  }
}
async function stopCaller(child: Bun.Subprocess) {
  if (child.exitCode === null) {
    if (process.platform === 'win32') {
      const dispatch = Bun.spawnSync(['taskkill.exe', '/pid', String(child.pid), '/f'], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      if (dispatch.exitCode !== 0) throw Error('caller_cleanup_native_dispatch_failed');
    } else child.kill('SIGKILL');
  }
  await child.exited;
}

for (const connection of ['paired', 'shared'] as const)
  test(`actual ${connection} work argv durable POST loss + SIGKILL and cold caller argv first GET loss preserve complete Workflow request and zero POST`, async () => {
    const started = Date.now();
    const f = await recoveryProfile();
    const candidateParent = join(f.root, 'candidate-parent');
    privateDirectory(candidateParent);
    const candidateRoot = join(candidateParent, 'candidate');
    const base = `${f.root}-cli-caller`,
      runner = join(f.root, 'caller-runner.ts'),
      wire = `${base}.wire.jsonl`,
      journal = join(f.profile.profilePath, 'ui/caller-intents.json');
    const socket = selectDaemonEndpoint({
      profileAccessKey: f.profile.profileAccessKey,
      ...(process.platform === 'win32' ? {} : { explicitSocket: join(f.root, 'cli.sock') }),
    }).socket;
    let daemonArtifact: Parameters<typeof runSelectedDaemon>[0]['artifact'];
    let child: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
    let building: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
    let buildResult: Promise<[string, string, number]> | undefined;
    let seed:
      | Awaited<ReturnType<Awaited<ReturnType<typeof recoveryProfile>>['launch']>>
      | undefined;
    let currentPIDPath: string | undefined;
    let pendingOutput: Promise<[string, string, number]> | undefined;
    let failure: unknown;
    let serviceSpawnUnconfirmed = false;
    const cleanupErrors: unknown[] = [];
    const owned = new Map<
      number,
      {
        observation: ReturnType<typeof retainProcessObservation>;
        stopRequested?: boolean;
        bootstrap?: {
          endpoint: string;
          token: string;
          profile: { dataRoot: string; name: string; accessKey: string };
          instanceId: string;
        };
      }
    >();
    const closeOwned = async (pid: number) => {
      const original = owned.get(pid);
      if (!original) throw Error('caller_owned_service_missing');
      try {
        if (original.observation.inspect() === 'alive' && !original.stopRequested) {
          original.stopRequested = true;
          if (process.platform === 'win32') {
            const b = original.bootstrap;
            if (!b) {
              const dispatch = Bun.spawnSync(['taskkill.exe', '/pid', String(pid), '/f'], {
                stdout: 'pipe',
                stderr: 'pipe',
              });
              if (dispatch.exitCode !== 0)
                throw Error('caller_early_service_native_cleanup_failed');
            } else {
              const lifecycle = createServiceLifecycleClient({
                endpoint: b.endpoint,
                token: b.token,
                expected: { profile: b.profile, instanceId: b.instanceId },
              });
              try {
                try {
                  await lifecycle.shutdown('if_idle');
                } catch (error) {
                  if (!(error instanceof ClientError && error.code === 'network_outcome_unknown'))
                    throw error;
                }
              } finally {
                lifecycle.disposeNetwork();
              }
            }
          } else process.kill(pid, 'SIGKILL');
        }
        const end = Date.now() + 5000;
        while (original.observation.inspect() !== 'dead') {
          if (Date.now() > end) throw Error('caller_owned_service_exit_unknown');
          await Bun.sleep(5);
        }
        original.observation.close();
        owned.delete(pid);
        writeFileSync(
          `${base}.${pid}.service-exit.json`,
          JSON.stringify({ pid, dead: true, retainedBirth: true }),
        );
      } catch (error) {
        retainedCallerOwners.add({ root: f.root, original });
        throw error;
      }
    };
    const harvest = () => {
      if (connection !== 'paired' || !currentPIDPath) return;
      const recordPath = existsSync(currentPIDPath) ? currentPIDPath : `${currentPIDPath}.spawned`;
      if (!existsSync(recordPath)) return;
      const record = JSON.parse(readFileSync(recordPath, 'utf8'));
      if (!Number.isSafeInteger(record.pid) || typeof record.start !== 'string')
        throw Error('caller_owned_service_record_invalid');
      if (!owned.has(record.pid))
        owned.set(record.pid, {
          observation: retainProcessObservation(record.pid, record.start),
          bootstrap: record.bootstrap,
        });
    };
    try {
      building = Bun.spawn(
        [
          process.execPath,
          join(repo, 'scripts/release/terminal.ts'),
          'build',
          '--directory',
          candidateRoot,
        ],
        { stdout: 'pipe', stderr: 'pipe' },
      );
      buildResult = Promise.all([
        new Response(building.stdout).text(),
        new Response(building.stderr).text(),
        building.exited,
      ]);
      const [buildOut, buildErr, buildCode] = await buildResult;
      writeFileSync(
        `${base}.preparation.json`,
        JSON.stringify({
          elapsedMs: Date.now() - started,
          candidateRoot,
          sequentialBuild: true,
        }),
      );
      writeFileSync(`${base}.build.log`, buildOut + buildErr);
      if (buildCode !== 0) throw Error(`caller_candidate_build_failed:${buildErr}`);
      const selected = verifyTerminalBundle(candidateRoot);
      const artifact = selected.artifact;
      const reader = join(f.root, 'candidate-readonly.ts');
      writeFileSync(
        reader,
        `import{strict as assert}from'node:assert';import{Database}from'bun:sqlite';import{acquireArtifactAccess}from${JSON.stringify(pathToFileURL(join(selected.root, 'node_modules/@kite-ai/agent/artifact-access.js')).href)};import{initializeSqliteEngine}from${JSON.stringify(pathToFileURL(join(selected.root, 'node_modules/@kite-ai/agent/sqlite-engine.js')).href)};const pin=acquireArtifactAccess({root:${JSON.stringify(selected.root)},mode:'shared'});try{const engine=initializeSqliteEngine({root:${JSON.stringify(join(selected.root, 'node_modules/@kite-ai/agent/storage/engine'))},manifestSha256:${JSON.stringify(selected.manifest.sqlite.manifestSha256)}});assert.equal(engine.version,${JSON.stringify(selected.manifest.sqlite.version)});assert.equal(engine.sourceId,${JSON.stringify(selected.manifest.sqlite.sourceId)});const db=new Database(${JSON.stringify(f.profile.databasePath)},{readonly:true});try{console.log(JSON.stringify(db.query(process.argv[2]!).all()));}finally{db.close();}}finally{pin.release();}`,
      );
      // The fixture process already opened its development SQLite. Cold candidate WAL must
      // be read by a fresh process selecting the same verified engine before its first DB.
      f.rows = (sql: string) => {
        const result = Bun.spawnSync([artifact.executable, reader, sql], {
          stdout: 'pipe',
          stderr: 'pipe',
        });
        if (result.exitCode !== 0)
          throw Error(
            `caller_candidate_readonly_failed:${new TextDecoder().decode(result.stderr)}`,
          );
        return JSON.parse(new TextDecoder().decode(result.stdout));
      };
      writeFileSync(
        `${base}.candidate.json`,
        JSON.stringify({
          digest: selected.digest,
          buildId: selected.buildId,
          runtimeProtection: artifact.runtimeProtection,
        }),
      );
      symlinkSync(
        join(repo, 'apps/cli/node_modules'),
        join(f.root, 'node_modules'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      seed = await f.launch();
      const warm = seed;
      const contextSelectionId = (await warm.client.getView('s')).session.contextSelectionId;
      await warm.close();
      seed = undefined;
      if (connection === 'shared') {
        daemonArtifact = artifact;
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
        currentPIDPath = `${base}.${randomUUID()}.pid`;
        if (connection === 'shared') argv = [...argv, '--server', socket];
        writeFileSync(
          runner,
          `import{appendFileSync,writeFileSync}from'node:fs';import{createServer}from'node:http';import{runSelectedCLI}from${JSON.stringify(pathToFileURL(join(repo, 'apps/cli/host/index.ts')).href)};import{parseCLIArguments}from${JSON.stringify(pathToFileURL(join(repo, 'apps/cli/src/arguments.ts')).href)};import{readProcessStartIdentity}from${JSON.stringify(pathToFileURL(join(repo, 'apps/service/src/daemon/process-identity.ts')).href)};const actualSpawn=Bun.spawn.bind(Bun);Bun.spawn=((...args)=>{const original=actualSpawn(...args);const command=Array.isArray(args[0])?args[0]:args[0]?.cmd;if(command?.includes(${JSON.stringify(artifact.entrypoint)})){writeFileSync(${JSON.stringify(`${currentPIDPath}.spawned`)},JSON.stringify({pid:original.pid,start:readProcessStartIdentity(original.pid),entrypoint:${JSON.stringify(artifact.entrypoint)}}));}return original;});const actual=fetch;let drop=true,forwarding='';const relay=createServer(async(req,res)=>{let body='';for await(const b of req)body+=b;const headers=new Headers();for(const[k,v]of Object.entries(req.headers))if(v&&!['host','connection','content-length'].includes(k))headers.set(k,Array.isArray(v)?v.join(','):v);const response=await actual(forwarding,{method:req.method,headers,...(req.method==='POST'?{body}:{})});const json=await response.json();appendFileSync(${JSON.stringify(wire)},JSON.stringify({event:'physical_loss',mode:${JSON.stringify(mode)},method:req.method,json})+'\\n');res.socket!.destroy();${mode === 'post' ? "if(process.platform==='win32')await new Promise(()=>{});else process.kill(process.pid,'SIGKILL');" : ''}});await new Promise<void>(r=>relay.listen(0,'127.0.0.1',r));const address=relay.address()as{port:number};globalThis.fetch=Object.assign(async(...args:Parameters<typeof fetch>)=>{const method=args[1]?.method??'GET',url=new URL(String(args[0]));appendFileSync(${JSON.stringify(wire)},JSON.stringify({event:'request',mode:${JSON.stringify(mode)},method,path:url.pathname,body:args[1]?.body?JSON.parse(String(args[1].body)):null})+'\\n');${mode === 'prepared' ? `if(method==='POST'&&url.pathname==='/v1/sessions/s/commands'){writeFileSync(${JSON.stringify(`${base}.prepared-barrier`)},'prepared');if(process.platform==='win32')await new Promise(()=>{});else process.kill(process.pid,'SIGKILL');}` : ''}if(drop&&${mode === 'post' ? "method==='POST'&&url.pathname==='/v1/sessions/s/commands'" : mode === 'get' ? "method==='GET'&&url.pathname==='/v1/commands/cli-original'" : 'false'}){drop=false;forwarding=url.href;const pending=actual('http://127.0.0.1:'+address.port+url.pathname,args[1]);${mode === 'post' ? `if(process.platform==='win32'){void pending.catch(()=>{});await new Promise(()=>{});}` : ''}return pending;}return actual(...args);},{preconnect:actual.preconnect});const hostExit=new AbortController();try{process.exitCode=await runSelectedCLI({exitSignal:hostExit.signal,arguments:parseCLIArguments(${JSON.stringify(argv)}),artifact:${JSON.stringify(artifact)},dataRoot:${JSON.stringify(f.profile.dataRoot)},profile:'owned',cwd:${JSON.stringify(f.workspace)},onLaunched:c=>writeFileSync(${JSON.stringify(currentPIDPath)},JSON.stringify({pid:c.pid,start:readProcessStartIdentity(c.pid),bootstrap:c.bootstrap})),write:l=>{console.log(l);if(${mode === 'normal'}&&JSON.parse(l).kind==='work.event'&&(JSON.parse(l).line.startsWith('accepted ')||JSON.parse(l).line.includes('outcome_unknown')))hostExit.abort();},prompt:l=>process.stderr.write(l)});}finally{relay.close();}`,
        );
        child = Bun.spawn([process.execPath, runner], {
          stdout: 'pipe',
          stderr: 'pipe',
          stdin: 'ignore',
        });
        const capture = async (stream: ReadableStream<Uint8Array>, path: string) => {
          let text = '';
          const decoder = new TextDecoder();
          for await (const chunk of stream) {
            text += decoder.decode(chunk, { stream: true });
            writeFileSync(path, text);
          }
          text += decoder.decode();
          writeFileSync(path, text);
          return text;
        };
        const current = child;
        pendingOutput = Promise.all([
          capture(current.stdout, `${currentPIDPath}.stdout`),
          capture(current.stderr, `${currentPIDPath}.stderr`),
          current.exited,
        ]);
        const output = pendingOutput;
        if (process.platform === 'win32' && (mode === 'post' || mode === 'prepared')) {
          const end = Date.now() + 10000;
          while (
            !(mode === 'prepared'
              ? existsSync(`${base}.prepared-barrier`)
              : existsSync(wire) && readFileSync(wire, 'utf8').includes('physical_loss'))
          ) {
            if (child.exitCode !== null || Date.now() > end)
              throw Error('caller_original_kill_barrier_missing');
            await Bun.sleep(20);
          }
          process.kill(child.pid, 0);
          if (connection === 'paired') {
            const record = JSON.parse(readFileSync(currentPIDPath!, 'utf8'));
            owned.set(record.pid, {
              observation: retainProcessObservation(record.pid, record.start),
              bootstrap: record.bootstrap,
            });
          }
          const dispatch = Bun.spawnSync(['taskkill.exe', '/pid', String(child.pid), '/f'], {
            stdout: 'pipe',
            stderr: 'pipe',
          });
          if (dispatch.exitCode !== 0) throw Error('caller_native_termination_failed');
          writeFileSync(
            `${base}.${mode}.native-kill.json`,
            JSON.stringify({
              pid: child.pid,
              dispatchExitCode: dispatch.exitCode,
              descendants: false,
              barrier: mode,
            }),
          );
        }
        const [out, err, code] = await output;
        pendingOutput = undefined;
        writeFileSync(`${base}.${mode}.stdout`, out);
        writeFileSync(`${base}.${mode}.stderr`, err);
        writeFileSync(
          `${currentPIDPath}.caller-exit.json`,
          JSON.stringify({
            pid: current.pid,
            code,
            signalCode: current.signalCode,
            pidGone: processGone(current.pid),
            mode,
            elapsedMs: Date.now() - started,
            phase: existsSync(currentPIDPath!) ? 'launched' : 'before_onLaunched',
          }),
        );
        harvest();
        if (connection === 'paired' && !existsSync(currentPIDPath!)) {
          serviceSpawnUnconfirmed = !existsSync(`${currentPIDPath}.spawned`);
          throw Error(`caller_exit_before_onLaunched:${code}:${current.signalCode}:${err}`);
        }
        const original =
          connection === 'paired' ? JSON.parse(readFileSync(currentPIDPath!, 'utf8')) : null;
        const pid = original?.pid;
        if (mode === 'post' || mode === 'prepared') {
          if (process.platform !== 'win32') expect(child.signalCode).toBe('SIGKILL');
          else {
            expect(code).not.toBe(0);
            expect(processGone(child.pid)).toBe(true);
          }
        } else {
          if (code !== 0 && code !== 2 && code !== 1) console.error(err);
          expect([0, 1, 2]).toContain(code!);
        }
        // Cleanup only the exact Service launched by this fixture's host.
        if (pid) await closeOwned(pid);
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
    } catch (error) {
      failure = error;
    } finally {
      // Stop/wait the actual current caller, then collect only this launch's record.
      for (const action of [
        async () => {
          if (child) {
            await stopCaller(child);
            writeFileSync(
              `${base}.cleanup-caller-exit.json`,
              JSON.stringify({
                pid: child.pid,
                code: child.exitCode,
                signalCode: child.signalCode,
                pidGone: processGone(child.pid),
                waitConfirmed: true,
              }),
            );
          }
        },
        async () => {
          if (pendingOutput) {
            const [out, err, code] = await pendingOutput;
            writeFileSync(
              `${currentPIDPath}.interrupted-output.json`,
              JSON.stringify({
                out,
                err,
                code,
                signalCode: child?.signalCode,
                phase: 'interrupted',
              }),
            );
            pendingOutput = undefined;
          }
        },
        async () => {
          if (building) await stopCaller(building);
          if (buildResult) await buildResult;
        },
        async () => {
          harvest();
        },
        async () => {
          if (seed) await seed.close();
        },
      ])
        try {
          await action();
        } catch (error) {
          cleanupErrors.push(error);
        }
      for (const pid of owned.keys())
        try {
          await closeOwned(pid);
        } catch (error) {
          cleanupErrors.push(error);
        }
      if (daemonArtifact)
        try {
          await runSelectedDaemon({
            arguments: {
              kind: 'server',
              action: 'stop',
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
        } catch (error) {
          cleanupErrors.push(error);
        }
      if (serviceSpawnUnconfirmed) cleanupErrors.push(Error('caller_service_spawn_unconfirmed'));
      if (cleanupErrors.length === 0 && owned.size === 0) {
        f.close();
      } else
        retainedCallerOwners.add({
          root: f.root,
          candidateRoot,
          f,
          owned,
          child,
          building,
          seed,
        });
      writeFileSync(
        `${base}.cleanup.json`,
        JSON.stringify({
          originalFailure: failure ? String(failure) : null,
          candidateRoot,
          elapsedMs: Date.now() - started,
          cleanupErrors: cleanupErrors.map(String),
          retainedRoot: cleanupErrors.length || owned.size ? f.root : null,
        }),
      );
    }
    if (cleanupErrors.length)
      throw new AggregateError(
        failure ? [failure, ...cleanupErrors] : cleanupErrors,
        'cli_caller_cleanup_unknown',
        { cause: failure },
      );
    if (failure) throw failure;
  }, 300000);

test('actual paired main work JSON waits through original Tool approval and complete Run before owned Service closes', async () => {
  const f = await recoveryProfile(),
    base = `${f.root}-cli-complete`,
    runner = join(f.root, 'complete.ts');
  let child: Bun.Subprocess<'pipe', 'pipe', 'pipe'> | undefined;
  let seed: Awaited<ReturnType<Awaited<ReturnType<typeof recoveryProfile>>['launch']>> | undefined;
  let failure: unknown;
  let observation: ReturnType<typeof retainProcessObservation> | undefined;
  const cleanupErrors: unknown[] = [];
  const ownedPath = `${base}.service.json`;
  const closeObservedService = async () => {
    if (existsSync(ownedPath)) {
      const record = JSON.parse(readFileSync(ownedPath, 'utf8'));
      observation ??= retainProcessObservation(record.pid, record.start);
      if (observation.inspect() === 'alive') {
        if (!failure) throw Error('actual_main_service_not_closed');
        if (process.platform === 'win32') {
          const dispatch = Bun.spawnSync(['taskkill.exe', '/pid', String(record.pid), '/f'], {
            stdout: 'pipe',
            stderr: 'pipe',
          });
          if (dispatch.exitCode !== 0) throw Error('actual_main_service_native_cleanup_failed');
        } else process.kill(record.pid, 'SIGKILL');
      }
      await awaitDead(observation);
      observation.close();
      observation = undefined;
    }
  };
  try {
    seed = await f.launch();
    const warm = seed;
    await warm.client.recoverSession('s', {
      kind: 'session.recover',
      expectedStoreId: f.storeId,
      commandId: 'interrupt-original',
      decision: 'interrupt',
    });
    await warm.close();
    seed = undefined;
    symlinkSync(
      join(repo, 'apps/cli/node_modules'),
      join(f.root, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const request = {
      kind: 'run.start',
      expectedStoreId: f.storeId,
      commandId: 'cli-complete',
      content: '完整原JSON Work🙂e\u0301\r\n',
    };
    writeFileSync(
      runner,
      `import{writeFileSync}from'node:fs';import{readProcessStartIdentity}from${JSON.stringify(pathToFileURL(join(repo, 'apps/service/src/daemon/process-identity.ts')).href)};import{runCLIProcess}from${JSON.stringify(pathToFileURL(join(repo, 'apps/cli/host/main.ts')).href)};const actualSpawn=Bun.spawn.bind(Bun);Bun.spawn=((...args)=>{const original=actualSpawn(...args);const command=Array.isArray(args[0])?args[0]:args[0]?.cmd;if(command?.includes(${JSON.stringify(f.artifact.entrypoint)})){const record={pid:original.pid,start:readProcessStartIdentity(original.pid),entrypoint:${JSON.stringify(f.artifact.entrypoint)}};writeFileSync(${JSON.stringify(ownedPath)},JSON.stringify(record));void original.exited.then(code=>writeFileSync(${JSON.stringify(`${ownedPath}.exit`)},JSON.stringify({...record,code})));}return original;});process.exitCode=await runCLIProcess({argv:${JSON.stringify(['work', 's', '--input', JSON.stringify(request)])},artifact:${JSON.stringify(f.artifact)},dataRoot:${JSON.stringify(f.profile.dataRoot)},profile:'owned',cwd:${JSON.stringify(f.workspace)}});`,
    );
    child = Bun.spawn([process.execPath, runner], {
      env: { ...process.env, ...f.userConfiguration.homeEnvironment },
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
    const record = JSON.parse(readFileSync(ownedPath, 'utf8'));
    observation = retainProcessObservation(record.pid, record.start);
    await awaitDead(observation);
    const serviceExit = JSON.parse(readFileSync(`${ownedPath}.exit`, 'utf8'));
    if (
      serviceExit.code !== 0 ||
      serviceExit.pid !== record.pid ||
      serviceExit.start !== record.start
    )
      throw Error('actual_main_service_exit_not_normal');
    writeFileSync(
      `${base}.caller-exit.json`,
      JSON.stringify({
        pid: child.pid,
        code,
        pidGone: processGone(child.pid),
        service: { ...serviceExit, dead: true },
      }),
    );
    console.log('complete CLI artifacts', base);
  } catch (error) {
    failure = error;
  } finally {
    try {
      if (child) {
        await stopCaller(child);
        writeFileSync(
          `${base}.cleanup-caller-exit.json`,
          JSON.stringify({
            pid: child.pid,
            code: child.exitCode,
            signalCode: child.signalCode,
            pidGone: processGone(child.pid),
            waitConfirmed: true,
          }),
        );
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await closeObservedService();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      if (seed) await seed.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (!cleanupErrors.length) f.close();
    else retainedCallerOwners.add({ root: f.root, f, child, observation, seed });
    writeFileSync(
      `${base}.cleanup.json`,
      JSON.stringify({
        originalFailure: failure ? String(failure) : null,
        cleanupErrors: cleanupErrors.map(String),
        retainedRoot: cleanupErrors.length ? f.root : null,
      }),
    );
  }
  if (cleanupErrors.length)
    throw new AggregateError(
      failure ? [failure, ...cleanupErrors] : cleanupErrors,
      'cli_main_cleanup_unknown',
      { cause: failure },
    );
  if (failure) throw failure;
}, 300000);
