import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { persistentWorktreeDirectory } from '../../../../../../tests/fixtures/worktree-filesystem';
import { createRuntime } from '../../../../src';
import type {
  AuthorizationRequest,
  JobDefinition,
  Json,
  ToolContext,
} from '../../../../src/extensions';
import { createWindowsShellJob } from '../../../../src/jobs/windows-shell';
import { hostExecutionScope } from '../../../../src/permissions/shell';
import { openSqliteStore } from '../../../../src/sqlite';
import {
  digest,
  type GitWorktreeConfiguration,
  parseWorkerCommand,
  type WorktreeRequest,
} from '../../../../src/tools/git-worktree/protocol';
import { readWorktreeOutput } from '../../../../src/tools/git-worktree/read-output';
import { createShellExtension } from '../../../../src/tools/shell';
import { windowsShellFixture } from '../../../fixtures/windows-shell-runtime';

const windows = process.platform === 'win32' ? test : test.skip;
const scope = { filesystem: 'workspace_write', network: 'none' } as const;
const finish: Extract<ModelEvent, { type: 'finish' }> = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 0, outputTokens: 0 },
};
const object = (value: unknown) => value as Record<string, Json>;

function environment(home: string) {
  const result = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === 'string' &&
        [
          'SYSTEMROOT',
          'WINDIR',
          'USERPROFILE',
          'HOMEDRIVE',
          'HOMEPATH',
          'TEMP',
          'TMP',
          'PATH',
        ].includes(entry[0].toUpperCase()),
    ),
  );
  return { ...result, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL' };
}

/** Faults touch only the isolated worker's spawn boundary. ENOENT and nonzero Git
 * use the OS/Git directly; EPERM is injected without changing installation ACLs.
 * The real Runtime, original Tool records, native restricted Job and worker result stay in use.
 */
for (const mode of [
  'success',
  'native_pipe',
  'start_missing',
  'start_eperm',
  'filesystem_denied',
  'git_command',
  'authorization_denied',
] as const)
  windows(
    `Windows original Worktree Job distinguishes ${mode} without changing authorization or replaying Git`,
    async () => {
      const root = persistentWorktreeDirectory(`kite-windows-errors-${mode}-`);
      const readonlyCase = mode === 'success' || mode === 'native_pipe';
      const workspace = join(root, 'workspace'),
        control = join(root, 'control'),
        hooks = join(root, 'hooks');
      for (const directory of [workspace, control, hooks]) mkdirSync(directory);
      const forbiddenDirectory = join(root, 'outside-workspace-scope');
      const forbiddenFile = join(forbiddenDirectory, 'must-not-create.txt');
      mkdirSync(forbiddenDirectory);
      const shell = await windowsShellFixture();
      const git = join(dirname(shell.fullShell), '../../mingw64/bin/git.exe');
      const env = environment(root);
      const setupGit = (...args: string[]) =>
        execFileSync(git, args, {
          cwd: workspace,
          env,
          windowsHide: true,
          encoding: 'utf8',
        }).trim();
      setupGit('init', '-q', '-b', 'main');
      setupGit('config', 'user.name', 'Windows Worktree Error Fixture');
      setupGit('config', 'user.email', 'worktree@example.invalid');
      writeFileSync(join(workspace, 'tracked.txt'), 'committed baseline\n');
      setupGit('add', 'tracked.txt');
      setupGit('commit', '-qm', 'base');
      const head = setupGit('rev-parse', 'HEAD');
      const configPath = join(root, 'empty.toml');
      writeFileSync(configPath, '# isolated worker\n');
      const source = join(root, 'worker.ts');
      const workerModule = resolve(
        import.meta.dir,
        '../../../../src/tools/git-worktree/worker.ts',
      ).replaceAll('\\', '/');
      const protocolModule = resolve(
        import.meta.dir,
        '../../../../src/tools/git-worktree/protocol.ts',
      ).replaceAll('\\', '/');
      // Never modify the caller's Git installation or deny OS access globally.
      // Faults below remain inside this explicit test worker and its owned Job.
      writeFileSync(
        source,
        `
import {spyOn} from 'bun:test';
import * as processes from 'node:child_process';
import * as filesystem from 'node:fs';
import {writeSync} from 'node:fs';
const original=processes.spawn;
const mode=${JSON.stringify(mode)};
let pipeProbeUsed=false;
if(mode==='filesystem_denied'){
  const originalMkdtemp=filesystem.mkdtempSync;
  spyOn(filesystem,'mkdtempSync').mockImplementation((prefix,...rest)=>{
    if(String(prefix).includes('kite-worktree-git-')){
      try{filesystem.writeFileSync(${JSON.stringify(forbiddenFile)},'must not be written',{flag:'wx'});}
      catch(error){process.stderr.write('fixture_filesystem_denied '+JSON.stringify({code:error.code,syscall:error.syscall})+'\\n');throw error;}
      throw Error('owned_expected_filesystem_denial_not_observed');
    }
    return originalMkdtemp(prefix,...rest);
  });
}
spyOn(processes,'spawn').mockImplementation((executable,args,options)=>{
  let actual=executable, argv=[...args];
  if(mode==='start_missing')actual=${JSON.stringify(join(root, 'not-installed-git.exe'))};
  if(mode==='git_command'&&argv.includes('--git-dir'))argv=['--kite-invalid-command-for-error-fixture'];
  process.stderr.write('fixture_git_launch '+JSON.stringify({executable:actual,args:argv,cwd:options.cwd})+'\\n');
  if(mode==='start_eperm')throw Object.assign(new Error('isolated subprocess EPERM fault'),{code:'EPERM'});
  if(mode==='native_pipe'&&!pipeProbeUsed){
    pipeProbeUsed=true;
    process.stderr.write('fixture_pipe_stdio\\n');
    const child=original(actual,argv,{...options,stdio:['pipe','pipe','pipe']});
    child.stdout?.on('data',bytes=>writeSync(options.stdio[1],bytes));
    child.stderr?.on('data',bytes=>writeSync(options.stdio[2],bytes));
    child.stdin?.on('error',()=>{});child.stdin?.end('');
    return child;
  }
  return original(actual,argv,options);
});
const {executeWorktreeRequest}=await import(${JSON.stringify(workerModule)});
const {decodeWorkerRequest}=await import(${JSON.stringify(protocolModule)});
const request=decodeWorkerRequest(process.argv[2]);
const frame=await executeWorktreeRequest(request);
process.stdout.write(JSON.stringify(frame)+'\\n');
`,
      );
      const built = await Bun.build({
        entrypoints: [source],
        outdir: join(root, 'assets'),
        target: 'bun',
        naming: 'worker.js',
      });
      expect(built.success).toBe(true);
      const configuration: GitWorktreeConfiguration = {
        configurationId: `windows-errors-${mode}`,
        sourceCwd: workspace,
        bunPath: process.execPath,
        workerPath: built.outputs[0]!.path,
        configPath,
        git: { path: git, sha256: createHash('sha256').update(readFileSync(git)).digest('hex') },
        hooksPath: hooks,
      };
      const dispatched: { executionId: string; request: WorktreeRequest; scope: typeof scope }[] =
        [];
      const nativeJob = await createWindowsShellJob({
        cwd: workspace,
        env,
        controlBase: control,
        supervisorPath: shell.runner,
        shellExecutable: shell.shell,
        fullShellExecutable: shell.fullShell,
        coreutilsPath: shell.coreutils,
        stateRoot: shell.stateRoot,
        executionScope(context) {
          const accepted = hostExecutionScope(context);
          expect(accepted).toEqual(scope);
          return accepted;
        },
        trustedWorkerLaunch(command) {
          return parseWorkerCommand(command, configuration)
            ? {
                version: 1,
                env,
                bunFlags: ['--no-env-file', `--config=${configPath}`],
                digest: digest(configuration),
              }
            : undefined;
        },
      });
      const job: JobDefinition = {
        ...nativeJob,
        inputSchema: {
          type: 'object',
          properties: { command: { type: 'string' }, permissions: { type: 'object' } },
          required: ['command', 'permissions'],
          additionalProperties: false,
        },
        async start(value, context) {
          const input = object(value);
          expect(input.permissions).toEqual(scope);
          const request = parseWorkerCommand(String(input.command), configuration);
          expect(request).not.toBeNull();
          expect(request!.sourceCwd).toBe(workspace);
          expect(request!.phase).toBe(readonlyCase ? 'list' : 'prepare_create');
          dispatched.push({ executionId: context.executionId, request: request!, scope });
          return nativeJob.start({ command: String(input.command) }, context);
        },
      };
      const input: Json = readonlyCase
        ? { action: 'list' }
        : {
            action: 'create',
            key: 'original-error-intent',
            path: join(workspace, 'never-created'),
            permissions: scope,
          };
      const modelCall: ModelEvent[] = [
        {
          type: 'tool_call',
          id: 'original-call',
          name: 'git_worktree',
          arguments: JSON.stringify(input),
        },
        { ...finish, reason: 'tool_calls' },
      ];
      const replay = !readonlyCase && mode !== 'authorization_denied';
      const model = createFixedModel([
        modelCall,
        [finish],
        ...(replay ? [modelCall, [finish]] : []),
      ]);
      const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'test' });
      const authorizations: AuthorizationRequest[] = [];
      const extension = createShellExtension({ job, gitWorktree: { configuration } });
      const runtime = createRuntime({
        store,
        modelId: 'fixed',
        model,
        processConcurrency: 1,
        modelConcurrency: 1,
        extensions: [
          { ...extension, tools: extension.tools!.filter((tool) => tool.id === 'git.worktree') },
        ],
        permissions: {
          async authorize(request) {
            authorizations.push(request);
            return {
              allowed: !(mode === 'authorization_denied' && request.kind === 'tool'),
              revision: 'owned-windows-scope',
              reason: 'owned-fixture-decision',
              snapshot: {
                namespace: 'builtin.permissions',
                version: '1',
                data: {
                  mode: 'accept_edits',
                  workspaceTrust: true,
                  capability: {
                    kind: request.kind,
                    definitionId: request.definitionId,
                    definitionVersion: request.definitionVersion,
                    hardAllowed: true,
                    executionScope: scope,
                  },
                },
              },
            };
          },
        },
      });
      try {
        const expectedStoreId = (await store.getMetadata()).storeId;
        await runtime.createWorkspace({
          expectedStoreId,
          id: 'w',
          name: 'isolated Windows error fixture',
          rootUri: pathToFileURL(workspace).href,
        });
        await runtime.createSession({
          expectedStoreId,
          subjectId: 'owner',
          commandId: 'session',
          sessionId: 's',
          workspaceId: 'w',
          title: mode,
        });
        const run = async (commandId: string) => {
          await runtime.submitCommand({
            expectedStoreId,
            subjectId: 'owner',
            sessionId: 's',
            commandId,
            request: {
              kind: 'run.start',
              content: `Inspect the original ${mode} operation. No fallback or wider permissions.`,
            },
          });
          await runtime.waitForCommand(commandId, { timeoutMs: 30000 });
        };
        await run('first');
        const first = await store.listExecutions('s');
        const tool = first.find((execution) => execution.kind === 'tool')!;
        const jobs = first.filter((execution) => execution.kind === 'job');
        expect(tool).toBeDefined();
        if (mode === 'authorization_denied') {
          expect(tool.result).toMatchObject({
            outcome: 'failed',
            details: {
              code: 'permission_denied',
              adapterAttempted: false,
              dispatchCommitted: false,
            },
          });
          expect(String(object(tool.result).content)).toContain('not executed');
          expect(tool.authorization?.dispatched).not.toBe(true);
          expect(jobs).toHaveLength(0);
          expect(dispatched).toEqual([]);
          expect(authorizations.some((request) => request.kind === 'job')).toBe(false);
          expect(
            await store.listExtensionRecords({ extensionId: 'builtin.shell', sessionId: 's' }),
          ).toEqual([]);
        } else {
          expect(jobs).toHaveLength(1);
          expect(dispatched).toHaveLength(1);
          const execution = jobs[0]!;
          expect(execution.status).toBe('succeeded');
          expect(execution.parentExecutionId).toBe(tool.id);
          expect(execution.cancelWithParent).toBe(true);
          expect(execution.input).toMatchObject({ permissions: scope });
          expect(execution.result).toMatchObject({
            outcome: 'succeeded',
            details: { cleanupConfirmed: true, processTreeStopped: true },
          });
          const records = await store.listExtensionRecords({
            extensionId: 'builtin.shell',
            sessionId: 's',
          });
          expect(records).toHaveLength(1);
          const record = object(records[0]!.value),
            step = object(object(record.steps)[readonlyCase ? 'query' : 'prepare']);
          const ref = step.ref as unknown as Parameters<typeof readWorktreeOutput>[0];
          expect(ref).toMatchObject({
            executionId: execution.id,
            originStoreId: expectedStoreId,
            sessionId: 's',
            extensionId: 'builtin.shell',
            commandId: execution.originCommandId,
          });
          expect(step.inputDigest).toBe(digest(execution.input));
          const observed = await readWorktreeOutput(
            ref,
            {
              sessionId: 's',
              operations: {
                get: () => store.getExecution(execution.id),
                readOutput: (
                  _ref: Parameters<ToolContext['operations']['readOutput']>[0],
                  options: Parameters<ToolContext['operations']['readOutput']>[1],
                ) => store.listExecutionOutput({ executionId: execution.id, ...options }),
              } as unknown as ToolContext['operations'],
            },
            dispatched[0]!.request,
          );
          expect(observed.frame?.phase).toBe(dispatched[0]!.request.phase);
          expect(observed.frame?.operationToken).toBe(dispatched[0]!.request.operationToken);
          const page = await store.listExecutionOutput({ executionId: execution.id, limit: 200 });
          expect(page.items.length).toBeLessThan(200);
          const diagnostics = page.items
            .filter((item) => item.stream === 'stderr')
            .map((item) => item.content)
            .join('');
          if (mode === 'filesystem_denied') {
            expect(diagnostics).toContain('fixture_filesystem_denied');
            expect(diagnostics).toContain('"syscall":"open"');
            expect(diagnostics).not.toContain('fixture_git_launch');
          } else {
            expect(diagnostics).toContain('fixture_git_launch');
            expect(diagnostics).toContain(JSON.stringify(workspace));
          }
          if (mode === 'success') expect(observed.frame?.businessOutcome).toBe('succeeded');
          if (mode === 'native_pipe') expect(diagnostics).toContain('fixture_pipe_stdio');
          if (readonlyCase && observed.frame?.businessOutcome === 'succeeded') {
            expect(observed.frame?.businessOutcome).toBe('succeeded');
            expect(tool.result).toMatchObject({
              outcome: 'succeeded',
              details: {
                action: 'list',
                sourceWorktree: workspace,
                cwdChanged: false,
                mutation: 'not_started',
              },
            });
          } else {
            const category =
              mode === 'git_command'
                ? 'git_command'
                : mode === 'filesystem_denied'
                  ? 'permission_denied'
                  : 'process_start';
            const code =
              mode === 'git_command'
                ? 'git_operation_failed'
                : mode === 'filesystem_denied'
                  ? 'git_permission_denied'
                  : 'git_process_start_failed';
            expect(observed.frame).toMatchObject({
              businessOutcome: 'failed',
              details: { code, failure: { category }, mutation: 'not_started', cwdChanged: false },
            });
            expect(tool.result).toMatchObject({
              outcome: 'failed',
              details: { code, failure: { category }, mutation: 'not_started' },
            });
            expect(object(object(tool.result).details).code).not.toBe('permission_denied');
            if (mode === 'start_missing')
              expect(object(object(tool.result).details).failure).toMatchObject({
                errno: 'ENOENT',
              });
            if (mode === 'start_eperm')
              expect(object(object(tool.result).details).failure).toMatchObject({ errno: 'EPERM' });
            if (mode === 'native_pipe')
              expect(['EPERM', 'EACCES']).toContain(
                String(object(object(object(tool.result).details).failure).errno),
              );
            if (mode === 'filesystem_denied')
              expect(['EPERM', 'EACCES']).toContain(
                String(object(object(object(tool.result).details).failure).errno),
              );
            if (mode === 'git_command')
              expect(object(object(tool.result).details).failure).toMatchObject({
                exitCode: expect.any(Number),
              });
            if (replay) {
              const original = structuredClone(record);
              await run('replay');
              expect(dispatched).toHaveLength(1);
              const after = await store.listExecutions('s');
              expect(
                after.filter((entry) => entry.kind === 'job').map((entry) => entry.id),
              ).toEqual([execution.id]);
              const replayed = after
                .filter((entry) => entry.kind === 'tool')
                .find((entry) => entry.id !== tool.id)!;
              expect(replayed.result).toMatchObject({
                outcome: 'failed',
                details: {
                  code,
                  failure: { category },
                  replayed: true,
                  observedAt: object(object(tool.result).details).observedAt,
                },
              });
              expect(
                (
                  await store.listExtensionRecords({ extensionId: 'builtin.shell', sessionId: 's' })
                )[0]!.value,
              ).toEqual(original);
            }
          }
        }
        expect(existsSync(join(workspace, 'never-created'))).toBe(false);
        expect(existsSync(forbiddenFile)).toBe(false);
        expect(setupGit('rev-parse', 'HEAD')).toBe(head);
        expect(setupGit('status', '--porcelain')).toBe('');
        expect(readdirSync(control)).toEqual([]);
        const output = resolve(
          import.meta.dir,
          '../../../../../../.cache/worktree-error-classification-20261106',
        );
        mkdirSync(output, { recursive: true });
        writeFileSync(
          join(output, `windows-${mode}-${randomUUID()}.json`),
          JSON.stringify(
            { mode, root, scope, dispatched, executions: await store.listExecutions('s') },
            null,
            2,
          ),
        );
      } finally {
        await runtime.close();
        // Persistent owned Git fixtures remain; no worktree or user directory is deleted.
      }
    },
    60000,
  );
