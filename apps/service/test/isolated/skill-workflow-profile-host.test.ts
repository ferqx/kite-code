import { expect, test } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import {
  createFixedModel,
  type ModelAdapter,
  type ModelEvent,
  type ModelRequest,
} from '@kite-ai/ai';
import { createPermissionPolicy } from '../../src/permissions';
import { createWorkflowConfiguration } from '../../src/skill-workflow-configuration';

const native = process.platform === 'darwin' || process.platform === 'linux' ? test : test.skip;
const finish: Extract<ModelEvent, { type: 'finish' }> = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};

native.each(['profile', 'workspace', 'profile-drift'] as const)(
  'configured %s Workflow completes through the actual host Job and cold original proof',
  async (scenario) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-workflow-profile-host-')));
    const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'original' });
    const workspace = join(root, 'workspace'),
      control = join(root, 'control');
    const skill =
      scenario === 'workspace'
        ? join(workspace, 'skill')
        : join(profile.profilePath, 'skills', 'fixture');
    let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
    let runtime: ReturnType<typeof createRuntime> | undefined;
    let cold: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
    let failure: unknown;
    try {
      for (const path of [workspace, control, profile.profilePath, skill, join(skill, 'dist')])
        mkdirSync(path, { recursive: true, mode: 0o700 });
      const ledger = join(workspace, 'verification-ledger');
      const privateSibling = join(profile.profilePath, 'private-sibling');
      const coordinationSecret = join(control, 'private-coordination');
      writeFileSync(privateSibling, 'must remain private');
      writeFileSync(coordinationSecret, 'must remain private');
      const manifest = {
        name: 'fixture',
        version: '1.0.0',
        description: 'Original source Workflow',
        invocation: { allow_manual: true, allow_implicit: false },
        context: { mode: 'inline', agent: 'code' },
        input_schema: { type: 'object', additionalProperties: false },
        output_schema: {
          type: 'object',
          properties: { ok: { const: true } },
          required: ['ok'],
          additionalProperties: false,
        },
        capabilities: { require: [], deny: [] },
        effects: { filesystem: 'write', network: 'none', external_state: 'none' },
        approval: { minimum: 'user' },
        execution: { timeout_ms: 5000, max_attempts: 1 },
        verification: {
          mode: 'required',
          strategy: 'script',
          entrypoint: 'check.ts',
          timeout_ms: 5000,
        },
        recovery: { retry: 'never' },
      };
      const source = `---\n${JSON.stringify(manifest)}\n---\nOriginal governed instructions\n`;
      writeFileSync(join(skill, 'SKILL.md'), source);
      writeFileSync(join(skill, 'helper.ts'), "export const original = 'original helper';\n");
      writeFileSync(join(skill, 'dist', 'resource.txt'), 'original ignored-directory resource');
      const script = `import {readFileSync,writeFileSync} from 'node:fs';
import {original} from './helper.ts';
if(process.cwd()!==${JSON.stringify(skill)})throw Error('original cwd lost');
if(original!=='original helper'||readFileSync('dist/resource.txt','utf8')!=='original ignored-directory resource')throw Error('source projection incomplete');
for(const path of ${JSON.stringify([privateSibling, coordinationSecret])}) { let denied=false;try{readFileSync(path)}catch{denied=true}if(!denied)throw Error('private sibling readable'); }
${scenario !== 'workspace' ? "let sourceDenied=false;try{writeFileSync('source-write','forbidden')}catch{sourceDenied=true}if(!sourceDenied)throw Error('source writable');" : ''}
writeFileSync(${JSON.stringify(ledger)},JSON.stringify({cwd:process.cwd(),helper:original,resource:readFileSync('dist/resource.txt','utf8')}));
console.log('original verifier full output');\n`;
      writeFileSync(join(skill, 'check.ts'), script);
      let supervisorPath: string;
      let linux: { bubblewrapPath: string } | undefined;
      if (process.platform === 'linux') {
        if (!['x64', 'arm64'].includes(process.arch)) throw Error('linux_shell_arch_unsupported');
        const compiler = Bun.which('cc'),
          bubblewrapPath = Bun.which('bwrap');
        if (!compiler || !bubblewrapPath)
          throw Error('linux_workflow_qualification_dependencies_unavailable');
        mkdirSync(join(root, 'assets'), { mode: 0o700 });
        supervisorPath = join(root, 'assets', 'linux-shell-init');
        const compiled = Bun.spawnSync(
          [
            compiler,
            '-std=c11',
            '-O2',
            '-Wall',
            '-Wextra',
            '-Werror',
            '-fstack-protector-strong',
            '-D_FORTIFY_SOURCE=2',
            '-fPIE',
            '-pie',
            '-Wl,-z,relro,-z,now',
            join(import.meta.dir, '../../../../packages/agent/native/linux-shell-init.c'),
            '-o',
            supervisorPath,
          ],
          { stdout: 'pipe', stderr: 'pipe' },
        );
        if (compiled.exitCode !== 0)
          throw Error(`linux_shell_init_build_failed:${compiled.stderr.toString()}`);
        const bytes = readFileSync(supervisorPath);
        if (
          bytes.length < 64 ||
          !bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
          bytes[4] !== 2 ||
          bytes[5] !== 1 ||
          ![2, 3].includes(bytes.readUInt16LE(16)) ||
          bytes.readUInt16LE(18) !== (process.arch === 'x64' ? 62 : 183)
        )
          throw Error('linux_shell_init_invalid_elf');
        chmodSync(supervisorPath, 0o755);
        linux = { bubblewrapPath: realpathSync(bubblewrapPath) };
      } else {
        const built = await Bun.build({
          entrypoints: [
            join(
              import.meta.dir,
              '../../../../packages/agent/src/platform/process/shell-supervisor.ts',
            ),
          ],
          outdir: join(root, 'assets'),
          target: 'bun',
          naming: 'shell-supervisor.js',
        });
        expect(built.success).toBe(true);
        supervisorPath = built.outputs[0]!.path;
      }
      const shell = {
        platform: process.platform as 'darwin' | 'linux',
        configurationId: 'original-workflow-host',
        env: { PATH: '/usr/bin:/bin' },
        supervisorPath,
        ...(linux ? { linux } : {}),
        bunExecutable: process.execPath,
        shellExecutable: '/bin/sh',
        graceMs: 20,
        host: {
          controlBase: control,
          protectedRoots: [profile.dataRoot, control],
          readonlyAssets: [join(root, 'assets')],
          runtimeReadOnlyRoots: [dirname(realpathSync(process.execPath))],
        },
      };
      const originalInput = {
        extensionId: 'builtin.skill-workflow',
        definitionVersion: '1',
        input: { activations: [{ key: 'original', skillId: 'skill:fixture', input: {} }] },
      };
      const fixed = createFixedModel([
        [
          {
            type: 'tool_call',
            id: 'complete-original',
            name: 'complete_skill',
            arguments: JSON.stringify({ activation_id: 'original', output: { ok: true } }),
          },
          { ...finish, reason: 'tool_calls' },
        ],
        [{ type: 'text_delta', text: 'Original complete Model result' }, finish],
      ]);
      const requests: ModelRequest[] = [];
      const model: ModelAdapter = {
        async *stream(request, options) {
          requests.push(structuredClone(request));
          yield* fixed.stream(request, options);
        },
      };
      const identities = [
        { kind: 'model' as const, definitionId: 'fixed', definitionVersion: '1' },
        { kind: 'tool' as const, definitionId: 'complete_skill', definitionVersion: '1' },
        { kind: 'job' as const, definitionId: 'skill.workflow.verify', definitionVersion: '1' },
      ];
      const permissions = createPermissionPolicy({
        readPolicy: () => ({
          mode: 'ask',
          workspaceTrust: true,
          revision: 'original-policy',
          allowed: identities,
        }),
        describeCapability: (request) =>
          identities.some(
            (identity) =>
              identity.kind === request.kind &&
              identity.definitionId === request.definitionId &&
              identity.definitionVersion === request.definitionVersion,
          )
            ? {
                kind: request.kind,
                definitionId: request.definitionId,
                definitionVersion: request.definitionVersion,
                revision: 'original-registration',
                effects: request.kind === 'job' ? ['process', 'workspace_write'] : ['record_write'],
                hardAllowed: true,
                safeRead: false,
              }
            : null,
      });
      store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
      const originalStore = store;
      runtime = createRuntime({
        store,
        model,
        modelId: 'fixed',
        permissions,
        supportsExtensionInputs: true,
        async resolveRunConfiguration({ command }) {
          const configured = await createWorkflowConfiguration({
            profile,
            workspaceRoot: workspace,
            skills: [{ id: 'configured-original', path: skill, enabled: true }],
            toolIds: [],
            allowedCapabilities: [],
            flags: { skillActivation: true, skillWorkflow: true, verification: true },
            shell,
            request: command.request,
            capabilities: [],
            forkConfigurations: [],
          });
          expect(configured.entries[0]?.source).toBe(scenario === 'workspace' ? 'project' : 'user');
          expect(
            configured.entries[0]?.contract?.files.some((file) => file.startsWith('dist/')),
          ).toBe(false);
          return {
            model,
            modelId: 'fixed',
            extensions: [configured.extension, configured.verifierExtension!],
            initializeRequirements: configured.initializeRequirements,
            snapshot: JSON.parse(JSON.stringify({ skillWorkflow: configured.snapshot })),
          };
        },
      });
      const expectedStoreId = (await store.getMetadata()).storeId;
      const base = { expectedStoreId, sessionId: 's', subjectId: 'owner' };
      await runtime.createWorkspace({
        expectedStoreId,
        id: 'w',
        name: 'Original Workspace',
        rootUri: `file://${workspace}`,
      });
      await runtime.createSession({
        ...base,
        commandId: 'create',
        workspaceId: 'w',
        title: 'Original Workflow',
      });
      await runtime.submitCommand({
        ...base,
        commandId: 'original',
        request: {
          kind: 'run.start',
          content: 'Explicit original Workflow',
          extensionInputs: [originalInput],
        },
      });
      const deadline = Date.now() + 15000;
      let approvals = 0,
        verifyApproved = false;
      for (;;) {
        const pending = await store.listInteractions({ ...base, state: 'pending' });
        for (const card of pending.interactions.filter((card) => card.kind === 'approval')) {
          if (card.definitionId === 'skill.workflow.verify') {
            verifyApproved = true;
            if (scenario === 'profile-drift')
              writeFileSync(join(skill, 'check.ts'), `${script}\n// changed after admission\n`);
          }
          await runtime.answerInteraction({
            ...base,
            commandId: `approve-${approvals++}`,
            presentationSessionId: 's',
            interactionId: card.id,
            expectedRevision: card.revision,
            answer: { kind: 'approval', decision: 'approve' },
          });
        }
        const view = await store.getView('s');
        const run = view.runs.find((run) => run.originCommandId === 'original');
        if (run && !run.isActive) break;
        if (Date.now() > deadline)
          throw Error(
            `workflow_profile_host_deadline:${JSON.stringify(view.executions.map((e) => ({ definitionId: e.definitionId, status: e.status, result: e.result })))}`,
          );
        await Bun.sleep(5);
      }
      if (!verifyApproved) {
        const actual = await store.getView('s');
        console.error(
          'workflow_profile_host_before_verify',
          JSON.stringify({
            scenario,
            approvals,
            modelCalls: requests.length,
            runs: actual.runs.map(({ id, status, reason }) => ({ id, status, reason })),
            executions: actual.executions.map(({ definitionId, status, result }) => ({
              definitionId,
              status,
              result,
            })),
          }),
        );
      }
      expect(verifyApproved).toBe(true);
      const view = await store.getView('s'),
        executions = await store.listExecutions('s');
      const run = view.runs.find((run) => run.originCommandId === 'original')!;
      if (scenario !== 'profile-drift' && run.status !== 'completed')
        console.error(
          'workflow_profile_host_terminal',
          JSON.stringify({
            root,
            scenario,
            run,
            executions: executions.map(({ definitionId, status, result, reference }) => ({
              definitionId,
              status,
              result,
              reference,
            })),
          }),
        );
      expect(run.status).toBe(scenario === 'profile-drift' ? 'failed' : 'completed');
      expect(run.requirements.some((ref) => ref.extensionId === 'builtin.skill-workflow')).toBe(
        true,
      );
      expect((await store.getCommand('original'))?.request).toMatchObject({
        extensionInputs: [originalInput],
      });
      expect(JSON.stringify(requests[0])).toContain('Original governed instructions');
      const job = executions.find((e) => e.definitionId === 'skill.workflow.verify')!;
      expect(job.kind).toBe('job');
      expect(job.status).toBe(scenario === 'profile-drift' ? 'failed' : 'succeeded');
      const records = await store.listExtensionRecords({
        sessionId: 's',
        extensionId: 'builtin.skill-workflow',
      });
      const proof = records.find((record) => record.key.endsWith('/verification'))?.value;
      if (scenario === 'profile-drift') {
        // Source freshness rejects dispatch; no verification of the changed source is published.
        expect(proof).toBeUndefined();
        expect(job.reference).toBeNull();
        expect(readFileSync(join(skill, 'check.ts'), 'utf8')).toContain('changed after admission');
        expect(() => readFileSync(ledger)).toThrow();
      } else {
        expect(proof).toMatchObject({
          outcome: 'passed',
          originStoreId: expectedStoreId,
          sessionId: 's',
          runId: run.id,
          executionId: job.id,
          resultRevision: job.resultRevision,
        });
        expect(JSON.parse(readFileSync(ledger, 'utf8'))).toEqual({
          cwd: skill,
          helper: 'original helper',
          resource: 'original ignored-directory resource',
        });
        expect(job.result).toMatchObject({
          outcome: 'succeeded',
          details: {
            ownedProcesses: {
              ...(process.platform === 'linux'
                ? {
                    version: 2,
                    coverage: 'shell-owned-pid-namespace',
                    owner: {
                      phase: 'terminal',
                      fdClosed: true,
                      closeUnknown: false,
                      namespace: {
                        treeStopped: true,
                        init: { dead: true },
                        root: {
                          dead: true,
                          waitReceipt: { code: 0, signal: null, waitConfirmed: true, reaped: true },
                        },
                      },
                      wrapper: {
                        exit: { code: 0, signal: null, reaped: true },
                        closed: true,
                        stdoutEof: true,
                        stderrEof: true,
                      },
                    },
                  }
                : {
                    version: 1,
                    coverage: 'shell-owned-coalition',
                    coalition: { processTreeStopped: true, registrationRemoved: true },
                  }),
              binding: { sessionId: 's', executionId: job.id },
            },
          },
        });
        expect(requests).toHaveLength(2);
        expect(
          view.messages.some(
            (message) =>
              message.role === 'assistant' && message.content === 'Original complete Model result',
          ),
        ).toBe(true);
      }
      const saved = { run: await store.getRun(run.id), executions, records, view };
      const calls = requests.length;
      const shutdown = runtime.tryBeginShutdown('cancel', {
        async beforeResourceClose() {
          // Capture the original settled View after actual owner/task drain.
          // A pre-drain generation cannot predict a later owner acquisition.
          saved.view = await originalStore.getView('s');
          expect(await originalStore.getRun(run.id)).toEqual(saved.run);
          expect(await originalStore.listExecutions('s')).toEqual(saved.executions);
          expect(
            await originalStore.listExtensionRecords({
              sessionId: 's',
              extensionId: 'builtin.skill-workflow',
            }),
          ).toEqual(saved.records);
        },
      });
      expect(shutdown.accepted).toBe(true);
      if (!shutdown.accepted) throw Error('workflow_host_shutdown_refused');
      await shutdown.completion;
      runtime = undefined;
      await originalStore.close();
      store = undefined;
      cold = await openSqliteStore({
        dataRoot: profile.dataRoot,
        profile: profile.profile,
        mode: 'readonly',
      });
      expect((await cold.getMetadata()).storeId).toBe(expectedStoreId);
      expect(await cold.getRun(run.id)).toEqual(saved.run);
      expect(await cold.listExecutions('s')).toEqual(saved.executions);
      expect(
        await cold.listExtensionRecords({ sessionId: 's', extensionId: 'builtin.skill-workflow' }),
      ).toEqual(saved.records);
      expect(await cold.getView('s')).toEqual(saved.view);
      expect(requests).toHaveLength(calls);
    } catch (error) {
      failure = error;
    } finally {
      const errors: unknown[] = [];
      for (const owner of [cold, runtime, store])
        if (owner)
          try {
            await owner.close();
          } catch (error) {
            errors.push(error);
          }
      if (!failure && errors.length === 0) rmSync(root, { recursive: true, force: true });
      if (errors.length)
        failure = new AggregateError(
          failure ? [failure, ...errors] : errors,
          `workflow_profile_host_cleanup:${root}`,
        );
    }
    if (failure) throw failure;
  },
  30000,
);
