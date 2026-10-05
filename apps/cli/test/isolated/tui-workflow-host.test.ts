import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { selectProfile } from '@kite-ai/agent/profile';
import { createClient } from '@kite-ai/client';
import { bootstrapSchema } from '@kite-ai/service/daemon';
import { launchPairedService } from '@kite-ai/service/paired';
import type { CLIServiceArtifact } from '../../host';
import { buildOwnedDaemon } from '../fixtures/daemon-host-build';
import { workflowManifest } from '../fixtures/workflow-manifest';

const repo = resolve(import.meta.dir, '../../../..');
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
for (const mode of ['paired', 'shared'] as const)
  for (const contextMode of ['inline', 'fork'] as const)
    test(`80x24 actual ${mode} TUI ${contextMode} slash receives its original completion`, async () => {
      const root = realpathSync(mkdtempSync('/private/tmp/kite-tui-workflow-'));
      const workspace = join(root, 'workspace');
      mkdirSync(workspace, { mode: 0o700 });
      mkdirSync(join(workspace, 'skill'));
      const body = `WORKFLOW_INSTRUCTIONS_ORIGINAL_${'complete exact workflow '.repeat(100)}_FULL_TAIL`;
      writeFileSync(
        join(workspace, 'skill/SKILL.md'),
        `---\n${JSON.stringify({ ...workflowManifest('alpha-skill'), context: { mode: contextMode, agent: 'code' }, ...(contextMode === 'fork' ? { output_schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false } } : {}) })}\n---\n${body}\n`,
      );
      const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'development' });
      mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
      mkdirSync(join(profile.profilePath, 'ui'), { mode: 0o700 });
      writeFileSync(join(profile.profilePath, 'ui/preferences.jsonc'), '{"language":"en-US"}', {
        mode: 0o600,
      });
      writeFileSync(
        join(profile.profilePath, 'skill-workflow.jsonc'),
        JSON.stringify({
          version: 1,
          features: { skillActivation: true, skillWorkflow: true, verification: false },
        }),
        { mode: 0o600 },
      );
      const observed: { messages: { role: string; content: unknown }[] }[] = [];
      const forkOutput = {
        answer: `ORIGINAL_FORK_RESULT_${'exact child output '.repeat(150)}_TAIL`,
      };
      let parentCalls = 0;
      const provider = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        async fetch(request) {
          const input = (await request.json()) as (typeof observed)[number];
          observed.push(input);
          const db = new Database(profile.databasePath, { readonly: true });
          let activationId: string;
          try {
            const row = db
              .query(
                "SELECT request_json FROM command WHERE kind='run.start' ORDER BY seq DESC LIMIT 1",
              )
              .get() as { request_json: string };
            activationId = JSON.parse(row.request_json).extensionInputs[0].input.activations[0].key;
          } finally {
            db.close();
          }
          const child =
            contextMode === 'fork' &&
            JSON.stringify(input.messages).includes('Execute the explicitly activated Skill');
          if (!child) parentCalls++;
          const done =
            child ||
            (contextMode === 'fork' ? parentCalls === 3 : input.messages.at(-1)?.role === 'tool');
          const delta = child
            ? { content: JSON.stringify(forkOutput) }
            : done
              ? { content: 'WORKFLOW_DONE_ORIGINAL' }
              : {
                  tool_calls: [
                    {
                      index: 0,
                      id: `original-${parentCalls}`,
                      type: 'function',
                      function:
                        contextMode === 'fork' && parentCalls === 1
                          ? {
                              name: 'activate_skill',
                              arguments: JSON.stringify({
                                key: activationId,
                                skill_id: 'skill:alpha-skill',
                                input: {},
                              }),
                            }
                          : {
                              name: 'complete_skill',
                              arguments: JSON.stringify({
                                activation_id: activationId,
                                output: contextMode === 'fork' ? forkOutput : {},
                              }),
                            },
                    },
                  ],
                };
          const encoder = new TextEncoder();
          const chunk = (value: unknown, finish: string | null) =>
            `data: ${JSON.stringify({ id: 'owned', object: 'chat.completion.chunk', model: 'fixed', choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`;
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  encoder.encode(
                    `${chunk(delta, null)}${chunk({}, done ? 'stop' : 'tool_calls')}data: [DONE]\n\n`,
                  ),
                );
                controller.close();
              },
            }),
            { headers: { 'content-type': 'text/event-stream' } },
          );
        },
      });
      writeFileSync(
        join(profile.profilePath, 'config.jsonc'),
        JSON.stringify({
          modelId: 'fixed',
          skills: [{ id: 'alpha', path: 'skill' }],
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
      let pairedEntry = join(repo, 'apps/service/dist/main.js'),
        daemonEntry = join(repo, 'apps/service/dist/daemon-main.js');
      if (contextMode === 'fork') {
        const base = join(root, 'artifact');
        await buildOwnedDaemon(base);
        for (const entry of ['paired', 'daemon'] as const) {
          const source = join(base, `${entry}-workflow.ts`);
          writeFileSync(
            source,
            `import {selectProfile} from '@kite-ai/agent/profile';import {createDefaultProcessConfiguration} from '@kite-ai/service/configuration';import {${entry === 'paired' ? 'runServiceProcess' : 'runDaemonProcess'}} from '@kite-ai/service/${entry === 'paired' ? 'main' : 'daemon-main'}';await ${entry === 'paired' ? 'runServiceProcess' : 'runDaemonProcess'}({configure(startup){return createDefaultProcessConfiguration({profile:selectProfile(startup.profile),hostConfiguration:startup.hostConfiguration,child:[{id:'code',version:'1',toolIds:[]}]});}});`,
          );
          const result = await Bun.build({
            entrypoints: [source],
            target: 'bun',
            packages: 'external',
            outdir: base,
          });
          expect(result.success).toBe(true);
        }
        pairedEntry = join(base, 'paired-workflow.js');
        daemonEntry = join(base, 'daemon-workflow.js');
      }
      const artifact: CLIServiceArtifact = {
        entrypoint: pairedEntry,
        entrypointSha256: hash(readFileSync(pairedEntry)),
        executable: realpathSync(process.execPath),
        executableSha256: hash(readFileSync(process.execPath)),
        buildId: 'owned-workflow',
        apiMajor: 1,
      };
      let daemon: Bun.Subprocess<'pipe', 'pipe', 'pipe'> | undefined;
      let python: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
      let client: ReturnType<typeof createClient> | undefined;
      let storeId: string;
      const socket = join(root, 'd.sock');
      async function seed(value: ReturnType<typeof createClient>, id: string) {
        await value.createWorkspace({
          expectedStoreId: id,
          id: 'w',
          rootUri: `file://${workspace}`,
          name: 'owned',
        });
        const trust = await value.getWorkspaceTrust('w', { storeId: id });
        await value.setWorkspaceTrust('w', {
          expectedStoreId: id,
          commandId: randomUUID(),
          ifRevision: trust.revision,
          trusted: true,
          canonicalIdentity: trust.canonicalIdentity,
          externalReadScopeDigest: trust.externalReadScopeDigest,
        });
        await value.createSession({
          expectedStoreId: id,
          commandId: 'create',
          sessionId: 'a',
          workspaceId: 'w',
          title: 'Workflow',
        });
        const permission = await value.getPermissionMode('a', { storeId: id });
        await value.setPermissionMode('a', {
          expectedStoreId: id,
          commandId: randomUUID(),
          ifRevision: permission.revision,
          ifDefaultRevision: permission.defaultRevision,
          makeDefault: false,
          mode: 'full',
        });
      }
      try {
        if (mode === 'paired') {
          const service = await launchPairedService({
            profile,
            ...artifact,
            instanceId: randomUUID(),
            requiredCapabilities: ['sessions'],
          });
          try {
            storeId = service.bootstrap.storeId!;
            await seed(service.client, storeId);
          } finally {
            await service.close();
          }
        } else {
          const web = join(root, 'web');
          mkdirSync(web);
          const assets = [
            ['/index.html', 'text/html; charset=utf-8', '<title>owned</title>'],
            ['/app.js', 'text/javascript; charset=utf-8', 'globalThis.owned=true;'],
            ['/app.css', 'text/css; charset=utf-8', 'body{}'],
          ].map(([path, mediaType, content]) => {
            writeFileSync(join(web, path!.slice(1)), content!);
            return { path, mediaType, size: Buffer.byteLength(content!), sha256: hash(content!) };
          });
          const manifest = JSON.stringify(assets);
          writeFileSync(join(web, 'manifest.json'), manifest);
          const instanceId = randomUUID();
          daemon = Bun.spawn([process.execPath, daemonEntry], {
            stdin: 'pipe',
            stdout: 'pipe',
            stderr: 'pipe',
          });
          daemon.stdin.write(
            `${JSON.stringify({ operation: 'start', startup: { profile: { dataRoot: profile.dataRoot, profile: profile.profile, profileAccessKey: profile.profileAccessKey }, instanceId, buildId: 'owned-workflow', token: 's'.repeat(64) }, workspace, socket, web: { directory: web, manifestSha256: hash(manifest) } })}\n`,
          );
          daemon.stdin.end();
          const reader = daemon.stdout.getReader();
          let frame = '';
          try {
            while (!frame.includes('\n')) {
              const chunk = await reader.read();
              if (chunk.done) throw Error('workflow_daemon_start_failed');
              frame += new TextDecoder().decode(chunk.value);
            }
          } finally {
            await reader.cancel();
            reader.releaseLock();
          }
          const boot = bootstrapSchema.parse(JSON.parse(frame));
          client = createClient({
            endpoint: boot.httpEndpoint,
            token: boot.token,
            expected: {
              profile: boot.profile,
              instanceId,
              buildId: boot.buildId,
              apiMajor: 1,
              requiredCapabilities: [
                'sessions',
                'skill_workflow_catalogue',
                'run_extension_inputs',
              ],
            },
          });
          storeId = (await client.connect()).storeId!;
          await seed(client, storeId);
        }
        const runner = join(root, 'runner.ts');
        const posts = join(root, 'posts'),
          pidPath = join(root, 'owned-pid');
        writeFileSync(
          runner,
          `import {appendFileSync,writeFileSync} from 'node:fs';import {runTUIHost} from ${JSON.stringify(join(repo, 'apps/cli/host/tui.tsx'))};const actual=globalThis.fetch;globalThis.fetch=Object.assign(async(...args:Parameters<typeof fetch>)=>{const options=args[1];if(options?.method==='POST'&&new URL(String(args[0])).pathname.endsWith('/commands'))appendFileSync(${JSON.stringify(posts)},String(options.body)+'\\n');return actual(...args);},{preconnect:actual.preconnect});await runTUIHost({dataRoot:${JSON.stringify(profile.dataRoot)},profile:'development',thread:'a',cwd:${JSON.stringify(workspace)},${mode === 'paired' ? `artifact:${JSON.stringify(artifact)},onLaunched:({pid})=>writeFileSync(${JSON.stringify(pidPath)},String(pid)),` : `server:${JSON.stringify(socket)},`}});`,
        );
        const program = `import os,pty,subprocess,select,time,re,fcntl,termios,struct,sqlite3,json,signal
master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',24,80,0,0));p=subprocess.Popen([${JSON.stringify(process.execPath)},${JSON.stringify(runner)}],stdin=slave,stdout=slave,stderr=slave,start_new_session=True);os.close(slave);buffer=b''
def wait(text):
 global buffer
 end=time.monotonic()+12
 while text not in re.sub(r'\\s+',' ',re.sub(r'\\x1b\\[[0-?]*[ -/]*[@-~]','',buffer.decode(errors='replace'))):
  if time.monotonic()>end:raise RuntimeError('expected '+text+' tail='+buffer[-6000:].decode(errors='replace'))
  if select.select([master],[],[],.05)[0]:buffer+=os.read(master,65536)
def key(value):
 global buffer
 buffer=b'';os.write(master,value)
def facts():
 db=sqlite3.connect('file:'+${JSON.stringify(profile.databasePath)}+'?mode=ro',uri=True);rows=db.execute("select request_json from command where kind='run.start'").fetchall();active=db.execute('select count(*) from run where is_active=1').fetchone()[0];db.close();return rows,active
try:
 wait('New Run >');key(b'/alpha-skill original task');wait('/alpha-skill original task');key(b'\\r');wait('WORKFLOW_DONE_ORIGINAL')
 end=time.monotonic()+5
 while facts()[1]:
  if time.monotonic()>end:raise RuntimeError('Run still active')
  if select.select([master],[],[],.05)[0]:buffer+=os.read(master,65536)
 rows,active=facts();assert len(rows)==1;request=json.loads(rows[0][0]);assert request['content']=='original task';assert request['extensionInputs'][0]['input']['activations'][0]['skillId']=='skill:alpha-skill';assert request['extensionInputs'][0]['input']['activations'][0]['input']=={}
 key(b'\\x11');end=time.monotonic()+6
 while p.poll() is None and time.monotonic()<end:
  if select.select([master],[],[],.05)[0]:
   try:os.read(master,65536)
   except OSError:break
 p.wait(timeout=3);assert p.returncode==0;print('WORKFLOW_PTY_ORIGINAL_COMPLETE')
finally:
 if p.poll() is None:os.killpg(p.pid,signal.SIGKILL);p.wait()
 os.close(master)
`;
        python = Bun.spawn(['python3', '-c', program], { stdout: 'pipe', stderr: 'pipe' });
        const [out, err, code] = await Promise.all([
          new Response(python.stdout).text(),
          new Response(python.stderr).text(),
          python.exited,
        ]);
        if (code !== 0) console.error(err);
        expect(code).toBe(0);
        expect(out).toContain('WORKFLOW_PTY_ORIGINAL_COMPLETE');
        expect(observed.length).toBe(contextMode === 'fork' ? 4 : 2);
        expect(
          observed[0]!.messages
            .map((message) =>
              typeof message.content === 'string'
                ? message.content
                : JSON.stringify(message.content),
            )
            .join('\n'),
        ).toContain(body);
        if (contextMode === 'fork') {
          const child = observed.filter((input) =>
            JSON.stringify(input.messages).includes('Execute the explicitly activated Skill'),
          );
          expect(child).toHaveLength(1);
          expect(JSON.stringify(child[0]!.messages)).toContain(body);
          expect(JSON.stringify(child[0]!.messages)).toContain('Input: {}');
          expect(JSON.stringify(observed[2]!.messages)).toContain(forkOutput.answer);
        }
        const posted = readFileSync(posts, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        expect(posted).toHaveLength(1);
        expect(posted[0]).toMatchObject({
          kind: 'run.start',
          content: 'original task',
          extensionInputs: [
            {
              extensionId: 'builtin.skill-workflow',
              definitionVersion: '1',
              input: { activations: [{ skillId: 'skill:alpha-skill', input: {} }] },
            },
          ],
        });
        const db = new Database(profile.databasePath, { readonly: true });
        try {
          if (contextMode === 'fork') {
            const sessions = db
              .query(
                'SELECT id,parent_id,root_id,workspace_id FROM session WHERE parent_id IS NOT NULL',
              )
              .all() as { id: string; parent_id: string; root_id: string; workspace_id: string }[];
            expect(sessions).toHaveLength(1);
            const child = sessions[0]!;
            expect(child).toMatchObject({ parent_id: 'a', root_id: 'a', workspace_id: 'w' });
            const jobs = db
              .query(
                "SELECT id,session_id,origin_store_id,origin_command_id,root_work_command_id,parent_execution_id,adapter_id,definition_version,child_session_id,child_configuration_json,result_json,result_revision,state FROM execution WHERE kind='job'",
              )
              .all() as {
              id: string;
              session_id: string;
              origin_store_id: string;
              origin_command_id: string;
              root_work_command_id: string;
              parent_execution_id: string;
              adapter_id: string;
              definition_version: string;
              child_session_id: string;
              child_configuration_json: string;
              result_json: string;
              result_revision: number;
              state: string;
            }[];
            expect(jobs).toHaveLength(1);
            const job = jobs[0]!;
            expect(job).toMatchObject({
              session_id: 'a',
              origin_store_id: storeId!,
              root_work_command_id: posted[0].commandId,
              adapter_id: 'agent/code',
              definition_version: '1',
              child_session_id: child.id,
              state: 'succeeded',
            });
            expect(JSON.parse(job.child_configuration_json)).toMatchObject({
              id: 'code',
              version: '1',
            });
            const parentTool = db
              .query('SELECT adapter_id,run_id,origin_command_id,state FROM execution WHERE id=?')
              .get(job.parent_execution_id) as {
              adapter_id: string;
              run_id: string;
              origin_command_id: string;
              state: string;
            };
            expect(parentTool).toMatchObject({
              adapter_id: 'activate_skill',
              origin_command_id: posted[0].commandId,
              state: 'succeeded',
            });
            const parentRun = db
              .query('SELECT session_id,origin_command_id,is_active,status FROM run WHERE id=?')
              .get(parentTool.run_id);
            expect(parentRun).toMatchObject({
              session_id: 'a',
              origin_command_id: posted[0].commandId,
              is_active: 0,
              status: 'completed',
            });
            const childRuns = db
              .query('SELECT id,origin_command_id,is_active,status FROM run WHERE session_id=?')
              .all(child.id) as {
              id: string;
              origin_command_id: string;
              is_active: number;
              status: string;
            }[];
            expect(childRuns).toHaveLength(1);
            expect(childRuns[0]).toMatchObject({
              origin_command_id: `child-start-${job.id}`,
              is_active: 0,
              status: 'completed',
            });
            const childStart = db
              .query(
                'SELECT request_json,root_work_command_id,origin_store_id FROM command WHERE id=?',
              )
              .get(childRuns[0]!.origin_command_id) as {
              request_json: string;
              root_work_command_id: string;
              origin_store_id: string;
            };
            expect(childStart).toMatchObject({
              root_work_command_id: posted[0].commandId,
              origin_store_id: storeId!,
            });
            const childIntent = JSON.parse(childStart.request_json);
            expect(childIntent).toMatchObject({
              kind: 'child.start',
              parentExecutionId: job.id,
              configurationId: 'code',
              configurationVersion: '1',
            });
            expect(childIntent.input.content).toContain(body);
            expect(childIntent.input.content).toContain('Input: {}');
            const result = JSON.parse(job.result_json);
            expect(result).toMatchObject({
              outcome: 'succeeded',
              details: { childSessionId: child.id, runId: childRuns[0]!.id, status: 'completed' },
            });
            expect(result.content).toBe(JSON.stringify(forkOutput));
            const anchorRows = db
              .query(
                "SELECT key,revision,json,origin_store_id,scope_id FROM extension_record WHERE extension_id='builtin.skill-workflow' AND content_type='application/vnd.kite.skill-activation+json'",
              )
              .all() as {
              key: string;
              revision: number;
              json: string;
              origin_store_id: string;
              scope_id: string;
            }[];
            expect(anchorRows).toHaveLength(1);
            const anchor = anchorRows[0]!;
            expect(anchor).toMatchObject({
              revision: 1,
              origin_store_id: storeId!,
              scope_id: 'a',
            });
            const activation = JSON.parse(anchor.json);
            expect(activation).toMatchObject({
              activationId: posted[0].extensionInputs[0].input.activations[0].key,
              runId: parentTool.run_id,
              sessionId: 'a',
              skillId: 'skill:alpha-skill',
            });
            const attemptKey = `${anchor.key}/attempts/1`;
            const head = db
              .query(
                "SELECT revision,json FROM extension_record WHERE extension_id='builtin.skill-workflow' AND key=?",
              )
              .get(`${anchor.key}/head`) as { revision: number; json: string };
            expect(head.revision).toBe(1);
            expect(JSON.parse(head.json)).toEqual({ kind: 'head', attempt: 1 });
            const closedRows = db
              .query(
                "SELECT key,json FROM extension_record WHERE extension_id='builtin.skill-workflow' AND key LIKE '%/closed'",
              )
              .all() as { key: string; json: string }[];
            expect(closedRows).toHaveLength(1);
            expect(closedRows[0]!.key).toBe(`${attemptKey}/closed`);
            expect(JSON.parse(closedRows[0]!.json)).toEqual({
              activationId: posted[0].extensionInputs[0].input.activations[0].key,
              status: 'closed',
              attempt: 1,
              anchorRevision: String(anchor.revision),
              headRevision: String(head.revision),
              outputDigest: hash(JSON.stringify(forkOutput)),
              output: forkOutput,
              executionId: job.parent_execution_id,
              forkProof: {
                executionId: job.id,
                resultRevision: String(job.result_revision),
                outputDigest: hash(JSON.stringify(forkOutput)),
              },
            });
            const forkRecords = db
              .query(
                "SELECT key,json FROM extension_record WHERE extension_id='builtin.skill-workflow' AND key LIKE '%/fork-operation'",
              )
              .all() as { key: string; json: string }[];
            expect(forkRecords).toHaveLength(1);
            expect(forkRecords[0]!.key).toBe(`${attemptKey}/fork-operation`);
            expect(JSON.parse(forkRecords[0]!.json)).toMatchObject({
              attempt: 1,
              parentExecutionId: job.parent_execution_id,
              ref: { executionId: job.id, commandId: job.origin_command_id },
            });
            expect(
              db.query("SELECT key FROM extension_record WHERE key LIKE '%/invalidated'").all(),
            ).toHaveLength(0);
            const forkOpening = db
              .query(
                "SELECT json FROM extension_record WHERE extension_id='builtin.skill-workflow' AND key=?",
              )
              .get(`${attemptKey}/fork-opening`) as { json: string };
            expect(JSON.parse(forkOpening.json)).toEqual({
              kind: 'fork_opening',
              attempt: 1,
              activationId: activation.activationId,
              anchorRevision: String(anchor.revision),
              skillId: activation.skillId,
              skillRevision: activation.skillRevision,
              runId: parentTool.run_id,
              sessionId: 'a',
              originStoreId: storeId!,
              headRevision: String(head.revision),
              carrierExecutionId: job.parent_execution_id,
              carrierDefinitionId: 'activate_skill',
              carrierDefinitionVersion: '1',
              carrierInputDigest: hash(
                JSON.stringify({
                  input: {},
                  key: activation.activationId,
                  skill_id: activation.skillId,
                }),
              ),
              configurationId: 'code',
              configurationVersion: '1',
            });
            expect(
              db
                .query(
                  "SELECT key FROM extension_record WHERE extension_id='builtin.skill-workflow' AND key LIKE ? ORDER BY key",
                )
                .all(`${anchor.key}/attempts/%`),
            ).toEqual([
              { key: `${attemptKey}/closed` },
              { key: `${attemptKey}/fork-opening` },
              { key: `${attemptKey}/fork-operation` },
              { key: `${attemptKey}/opening` },
            ]);
          }
          expect(
            (
              db
                .query(
                  "SELECT count(*) AS n FROM execution WHERE adapter_id='complete_skill' AND state='succeeded'",
                )
                .get() as { n: number }
            ).n,
          ).toBe(1);
          expect(
            (
              db
                .query(
                  "SELECT count(*) AS n FROM extension_record WHERE extension_id='builtin.skill-workflow' AND key LIKE '%/closed'",
                )
                .get() as { n: number }
            ).n,
          ).toBe(1);
        } finally {
          db.close();
        }
        if (mode === 'paired')
          expect(() => process.kill(Number(readFileSync(pidPath, 'utf8')), 0)).toThrow();
        else {
          expect(daemon!.exitCode).toBeNull();
          expect((await client!.verifyConnection()).storeId).toBe(storeId!);
        }
      } finally {
        if (python && python.exitCode === null) {
          python.kill('SIGTERM');
          await python.exited;
        }
        client?.disposeNetwork();
        if (daemon && daemon.exitCode === null) {
          daemon.kill('SIGTERM');
          await daemon.exited;
        }
        provider.stop(true);
        rmSync(root, { recursive: true, force: true });
      }
    }, 40000);
