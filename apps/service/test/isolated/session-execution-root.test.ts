import { expect, test } from 'bun:test';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type AgentRuntime, createRuntime, prepareOutputDirectory } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { createTemporaryCredentialBackend } from '@kite-ai/agent/config';
import { verifyDocumentHelper } from '@kite-ai/agent/documents';
import type { ToolContext } from '@kite-ai/agent/extensions';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { windowsShellFixture } from '../../../../packages/agent/test/fixtures/windows-shell-runtime';
import { chinesePagedPdf, simplePdf } from '../../../../tests/fixtures/pdf';
import { privateDirectory } from '../../../../tests/fixtures/test-filesystem';
import { parseShellModelFeedback } from '../../../../tests/fixtures/unified-agent/shell-model-feedback';
import { persistentWorktreeDirectory } from '../../../../tests/fixtures/worktree-filesystem';
import { createDefaultProcessConfiguration } from '../../src/configuration';
import { planningSnapshotDigest } from '../../src/planning-configuration';
import { createWorktreeHost } from '../../src/worktree-host';
import { initializeLivePermissionFixture } from '../fixtures/live-permission-fixture';

const native = process.platform === 'darwin' ? test : test.skip;
const onWindows = process.platform === 'win32' && process.arch === 'x64';
function git(cwd: string, ...args: string[]) {
  const executable = onWindows ? Bun.which('git') : '/usr/bin/git';
  if (!executable) throw new Error('fixture Git executable unavailable');
  const value = Bun.spawnSync([executable, ...args], {
    cwd,
    env: {
      PATH: onWindows ? process.env.PATH! : '/usr/bin:/bin',
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: onWindows ? 'NUL' : '/dev/null',
      ...(onWindows ? { SystemRoot: process.env.SystemRoot!, USERPROFILE: cwd } : {}),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (value.exitCode) throw new Error(value.stderr.toString());
  return value.stdout.toString().trim();
}

async function exerciseRootSwitch(
  protectProfile = false,
  mode: 'full' | 'auto' = 'full',
  background = false,
) {
  const root = persistentWorktreeDirectory('session-root-');
  const source = join(root, 'source'),
    target = join(root, 'target');
  const unregistered = join(root, 'unregistered');
  mkdirSync(source);
  git(source, 'init', '-b', 'main');
  git(source, 'config', 'user.name', 'Root fixture');
  git(source, 'config', 'user.email', 'root@example.invalid');
  expect(realpathSync(resolve(source, git(source, 'rev-parse', '--show-toplevel')))).toBe(source);
  expect(realpathSync(join(source, git(source, 'rev-parse', '--git-common-dir')))).toBe(
    join(source, '.git'),
  );
  expect(git(source, 'remote')).toBe('');
  writeFileSync(join(source, 'AGENTS.md'), 'SOURCE_ROOT_ONLY_MARKER\n');
  if (onWindows) {
    writeFileSync(
      join(source, '.gitattributes'),
      'ledger.ts text eol=lf\nledger.csv text eol=lf\n*.pdf binary\n',
    );
    writeFileSync(join(source, 'ledger.ts'), 'export const root = "linked,42";\n');
    writeFileSync(join(source, 'ledger.csv'), 'root,amount\nlinked,42\n');
    writeFileSync(join(source, 'brief.pdf'), simplePdf());
    writeFileSync(join(source, 'scan.pdf'), chinesePagedPdf());
  } else {
    writeFileSync(join(source, 'where.txt'), 'source-root-content\n');
  }
  git(source, 'add', '.');
  git(source, 'commit', '-m', 'initial');
  if (onWindows) {
    mkdirSync(unregistered);
    writeFileSync(join(source, 'ledger.ts'), 'export const root = "source,17";\n');
  } else {
    git(source, 'worktree', 'add', '--detach', target, 'HEAD');
    writeFileSync(join(target, 'AGENTS.md'), 'TARGET_ROOT_ONLY_MARKER\n');
    writeFileSync(join(target, 'where.txt'), 'target-root-content\n');
  }
  // launchd control sockets require a short path; code worktrees remain durable.
  const hostRoot = realpathSync(mkdtempSync(join(tmpdir(), 'kite-root-host-')));
  const profile = selectProfile({ dataRoot: join(hostRoot, 'data'), profile: 'roots' });
  privateDirectory(profile.profilePath);
  privateDirectory(join(hostRoot, 'control'));
  const calls: [string, Record<string, unknown>][] = background
    ? [
        ['git_worktree', { action: 'use', path: target }],
        [
          'shell_execute',
          {
            background: true,
            command:
              'while [ ! -f release-old-shell ]; do sleep 0.05; done; pwd; pwd > "$KITE_OUTPUT_DIR/late.txt"',
          },
        ],
        ['git_worktree', { action: 'exit' }],
        ['shell_wait', {}],
      ]
    : onWindows
      ? [
          ['git_worktree', { action: 'create', path: target, filesystem: 'full_access' }],
          ['git_worktree', { action: 'list' }],
          ['git_worktree', { action: 'use', path: unregistered }],
          ['git_worktree', { action: 'use' }],
          ['read_file', { path: 'ledger.ts' }],
          ['read_file', { path: 'brief.pdf' }],
          ['read_file', { path: 'ledger.csv' }],
          [
            'exec_command',
            {
              cmd: 'set -e; head -n 2 ledger.csv; "$KITE_DOCUMENTS_BUN" --no-install "$KITE_DOCUMENTS_HELPER" pdf-text --input brief.pdf --pages 1; printf root-inspected > inspection.txt',
              yield_time_ms: 10000,
            },
          ],
          [
            'exec_command',
            {
              cmd: '"$KITE_DOCUMENTS_BUN" --no-install "$KITE_DOCUMENTS_HELPER" pdf-render --input scan.pdf --pages 2 --out .',
              yield_time_ms: 10000,
            },
          ],
          ['view_images', {}],
          ['git_worktree', { action: 'exit' }],
          ['read_file', { path: 'ledger.ts' }],
        ]
      : [
          ['git_worktree', { action: 'use', path: target }],
          ['read_file', { path: 'where.txt' }],
          [
            'shell_execute',
            { command: mode === 'auto' ? 'pwd; printf root-inspected > inspection.txt' : 'pwd' },
          ],
          ['git_worktree', { action: 'list' }],
          [
            'git_worktree',
            {
              action: 'create',
              path: join(root, 'created-from-target'),
              filesystem: 'full_access',
            },
          ],
          ['git_worktree', { action: 'exit' }],
          ['read_file', { path: 'where.txt' }],
          [
            'shell_execute',
            { command: mode === 'auto' ? 'pwd; printf root-inspected > inspection.txt' : 'pwd' },
          ],
        ];
  let index = 0;
  const reviews: Record<string, unknown>[] = [];
  const requests: { messages: { role: string; content: unknown }[] }[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { messages: { role: string; content: unknown }[] };
      let review: Record<string, unknown> | undefined;
      try {
        const value = JSON.parse(
          String(body.messages.filter((row) => row.role === 'user').at(-1)?.content ?? ''),
        );
        if (value.purpose === 'shell_risk' || value.purpose === 'authorization_check')
          review = value;
      } catch {}
      if (review) reviews.push(review);
      else requests.push(body);
      const call = review ? undefined : calls[index++];
      if (onWindows && call?.[1].action === 'use' && call[1].path === undefined) {
        const create = (await store!.listExecutions('s')).find(
          (row) => row.kind === 'tool' && row.definitionId === 'git.worktree',
        );
        const receipt = create?.result as { details?: { path?: string } } | undefined;
        expect(receipt?.details?.path, JSON.stringify(create?.result)).toBe(target);
        call[1].path = receipt!.details!.path!;
      }
      if (onWindows && call?.[0] === 'view_images') {
        const rendered = readdirSync(target).filter((name) => name.startsWith('kite-pdf-pages-'));
        expect(rendered).toHaveLength(1);
        call[1] = { paths: [join(target, rendered[0]!, 'page-2.png')] };
      }
      if (background && call?.[0] === 'git_worktree' && call[1].action === 'exit') {
        const deadline = Date.now() + 10000;
        let originalJob = (await store!.listExecutions('s')).find(
          (row) => row.definitionId === 'shell.command',
        );
        while (originalJob?.status !== 'running' && Date.now() < deadline) {
          await Bun.sleep(20);
          originalJob = (await store!.listExecutions('s')).find(
            (row) => row.definitionId === 'shell.command',
          );
        }
        expect(originalJob?.status, JSON.stringify(originalJob?.result)).toBe('running');
        expect(originalJob?.authorization?.dispatched).toBe(true);
      }
      if (background && call?.[0] === 'shell_wait') {
        const originalJob = (await store!.listExecutions('s')).find(
          (row) => row.definitionId === 'shell.command',
        );
        expect(originalJob).toMatchObject({
          status: 'running',
          authorization: { dispatched: true },
          decisionSource: {
            executionRoot: { epoch: '1', effectiveRootUri: pathToFileURL(target).href },
          },
        });
        expect((await runtime!.getSessionExecutionRoot({ sessionId: 's' })).epoch).toBe('2');
        const previous = body.messages.filter((row) => row.role === 'tool');
        const launched = previous.find((row) => String(row.content).includes('shell_id'));
        const shellId = parseShellModelFeedback(String(launched?.content ?? '')).shellId;
        expect(shellId).toBeTruthy();
        call[1] = { shell_id: shellId, wait_ms: 10000 };
        writeFileSync(join(target, 'release-old-shell'), 'release after exit');
      }
      const delta = call
        ? {
            tool_calls: [
              {
                index: 0,
                id: `call-${index}`,
                type: 'function',
                function: { name: call[0], arguments: JSON.stringify(call[1]) },
              },
            ],
          }
        : {
            content: review
              ? JSON.stringify(
                  review.purpose === 'shell_risk'
                    ? {
                        risk: 'ordinary',
                        reason: 'Prints the current directory and writes a fixed fixture marker.',
                      }
                    : {
                        decision: 'approve_once',
                        reason: 'Fixture approves this exact operation.',
                      },
                )
              : 'Done.',
          };
      const chunk = (value: object, reason: string | null) =>
        `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixed', choices: [{ index: 0, delta: value, finish_reason: reason }] })}\n\n`;
      return new Response(
        chunk(delta, null) + chunk({}, call ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
  let runtime: AgentRuntime | undefined;
  try {
    writeFileSync(
      join(profile.profilePath, 'config.jsonc'),
      JSON.stringify({
        modelId: 'fixed',
        models: [
          {
            id: 'fixed',
            provider: 'compatible',
            model: 'fixed',
            baseURL: `http://127.0.0.1:${server.port}/v1`,
          },
        ],
        tools: [
          { id: 'git.worktree' },
          { id: 'files.read' },
          { id: 'shell.execute' },
          ...(onWindows ? [{ id: 'files.view_images' }] : []),
          ...(background ? [{ id: 'shell.wait' }] : []),
        ],
      }),
    );
    const supervisor = await Bun.build({
      entrypoints: [
        join(
          import.meta.dir,
          '../../../../packages/agent/src/platform/process/shell-supervisor.ts',
        ),
      ],
      outdir: join(hostRoot, 'assets'),
      naming: 'shell-supervisor.js',
      target: 'bun',
    });
    expect(supervisor.success).toBe(true);
    const windows = onWindows ? await windowsShellFixture() : undefined;
    const documentHelper = onWindows ? await verifyDocumentHelper() : undefined;
    const host = createDefaultProcessConfiguration({
      profile,
      localCodex: false,
      userConfigurationPath: join(profile.profilePath, 'config.jsonc'),
      credentialBackend: createTemporaryCredentialBackend(),
      shell: {
        platform: onWindows ? 'win32' : 'darwin',
        configurationId: 'session-root-fixture',
        env: onWindows
          ? {
              PATH: process.env.PATH!,
              SystemRoot: process.env.SystemRoot!,
              HOME: hostRoot,
              USERPROFILE: hostRoot,
              GIT_CONFIG_NOSYSTEM: '1',
              GIT_CONFIG_GLOBAL: 'NUL',
              KITE_DOCUMENTS_BUN: process.execPath,
              KITE_DOCUMENTS_HELPER: documentHelper!,
            }
          : { PATH: '/usr/bin:/bin', HOME: source },
        supervisorPath: windows?.runner ?? supervisor.outputs[0]!.path,
        bunExecutable: process.execPath,
        shellExecutable: windows?.shell ?? '/bin/sh',
        ...(windows
          ? {
              windows: {
                kind: 'bash' as const,
                fullShellExecutable: windows.fullShell,
                stateRoot: join(hostRoot, 'sandbox'),
              },
            }
          : {}),
        host: {
          controlBase: join(hostRoot, 'control'),
          // Match the production host: its own staging path is not a protected parent.
          protectedRoots: [
            join(hostRoot, 'control'),
            ...(protectProfile ? [profile.dataRoot] : []),
          ],
          readonlyAssets: [join(hostRoot, 'assets')],
          runtimeReadOnlyRoots: [dirname(process.execPath)],
        },
      },
    });
    store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
    runtime = createRuntime({
      ...host,
      permissions: host.permissions!,
      store,
      artifacts: createArtifactStore({ profile, store }),
      outputCollections: {
        prepare: (context, identity) => prepareOutputDirectory(runtime!, context, identity),
      },
      processConcurrency: 2,
      modelConcurrency: 1,
    });
    host.permissionManagement!(runtime);
    const expectedStoreId = (await store.getMetadata()).storeId;
    const base = { expectedStoreId, subjectId: 'owner', sessionId: 's' };
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'w',
      rootUri: pathToFileURL(source).href,
      name: 'source',
    });
    await runtime.createSession({
      ...base,
      workspaceId: 'w',
      commandId: 'create-s',
      title: 'root-switch',
    });
    await runtime.createSession({
      ...base,
      sessionId: 'other',
      workspaceId: 'w',
      commandId: 'create-other',
      title: 'untouched',
    });
    await initializeLivePermissionFixture({
      runtime,
      profile,
      ...base,
      workspaceId: 'w',
      mode,
      trusted: true,
      nativeShellRead: !onWindows,
    });
    await runtime.submitCommand({
      ...base,
      commandId: 'switch-run',
      request: {
        kind: 'run.start',
        content:
          'Use the target worktree, read and inspect it, then exit and inspect the original workspace.',
      },
    });
    const receipt = await runtime.waitForCommand('switch-run', {
      timeoutMs: onWindows ? 70000 : 30000,
    });
    const rows = await store.listExecutions('s');
    const tools = rows.filter((row) => row.kind === 'tool');
    expect(
      receipt,
      JSON.stringify({
        receipt,
        tools: tools.map((x) => ({ tool: x.definitionId, result: x.result })),
      }),
    ).toMatchObject({ status: 'applied' });
    expect(
      tools.map((row) => row.status),
      JSON.stringify(tools.filter((row) => row.status !== 'succeeded').map((row) => row.result)),
    ).toEqual(
      calls.map(([, input], index) =>
        (protectProfile && index === 4) ||
        input.path === unregistered ||
        (onWindows && (input.path === 'brief.pdf' || input.path === 'ledger.csv'))
          ? 'failed'
          : 'succeeded',
      ),
    );
    if (protectProfile)
      expect(tools[4]!.result).toMatchObject({
        outcome: 'failed',
        details: { code: 'git_permission_denied', mutation: 'not_started' },
      });
    expect(new Set(rows.filter((row) => row.runId).map((row) => row.runId)).size).toBe(1);
    expect((await runtime.getSessionExecutionRoot({ sessionId: 's' })).epoch).toBe('2');
    expect((await runtime.getSessionExecutionRoot({ sessionId: 's' })).effectiveRootUri).toBe(
      pathToFileURL(source).href,
    );
    expect((await runtime.getSessionExecutionRoot({ sessionId: 'other' })).epoch).toBe('0');
    expect((await runtime.getWorkspace('w'))!.rootUri).toBe(pathToFileURL(source).href);
    if (onWindows) {
      const epochs = tools.map(({ decisionSource }) => {
        const source = decisionSource as { executionRoot?: { epoch?: string } } | undefined;
        return source?.executionRoot?.epoch;
      });
      expect(epochs).toEqual(['0', '0', '0', '0', '1', '1', '1', '1', '1', '1', '1', '2']);
      expect(tools[0]!.result).toMatchObject({ details: { path: target, cwdChanged: false } });
      const list = tools[1]!.result as {
        details: { cwdChanged: boolean; worktrees: { path: string }[] };
      };
      expect(list.details.cwdChanged).toBe(false);
      expect(list.details.worktrees.map(({ path }) => resolve(path))).toEqual([source, target]);
      expect(tools[2]!.result).toMatchObject({
        details: { code: 'not_linked_worktree', adapterAttempted: false, dispatchCommitted: false },
      });
      expect(tools[3]!.result).toMatchObject({ details: { action: 'use', cwdChanged: true } });
      expect(tools[4]!.result).toMatchObject({ content: expect.stringContaining('linked,42') });
      for (const index of [5, 6]) {
        expect(tools[index]!.result).toMatchObject({ details: { code: 'unsupported_file_type' } });
        expect((tools[index]!.result as { modelImages?: unknown[] }).modelImages).toBeUndefined();
      }
      const textReply = JSON.stringify(requests[8]);
      expect(textReply).toContain('Hello PDF');
      expect(textReply).toContain('linked,42');
      expect(JSON.stringify(requests.slice(0, 10))).not.toContain('data:image/png;base64,');
      expect(JSON.stringify(requests[10])).toContain('data:image/png;base64,');
      expect(tools[9]!.result).toMatchObject({ modelImages: [{ mediaType: 'image/png' }] });
      expect(tools[10]!.result).toMatchObject({ details: { action: 'exit', cwdChanged: true } });
      expect(tools[11]!.result).toMatchObject({ content: expect.stringContaining('source,17') });
      const shell = tools.slice(7, 9);
      expect(shell.every((tool) => tool.authorization?.dispatched)).toBe(true);
      const jobs = rows.filter(
        (row) => row.kind === 'job' && shell.some(({ id }) => row.parentExecutionId === id),
      );
      expect(jobs).toHaveLength(2);
      for (const job of jobs) {
        expect(job.definitionId).toBe('shell.command');
        expect(job.status).toBe('succeeded');
        expect(job.result).toMatchObject({ details: { exitCode: 0, processTreeStopped: true } });
      }
      expect(readFileSync(join(target, 'inspection.txt'), 'utf8')).toBe('root-inspected');
      expect(existsSync(join(source, 'inspection.txt'))).toBe(false);
      expect(existsSync(target)).toBe(true);
      return;
    }
    if (background) {
      const jobs = rows.filter((row) => row.definitionId === 'shell.command');
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({
        status: 'succeeded',
        authorization: { dispatched: true },
        decisionSource: {
          executionRoot: { epoch: '1', effectiveRootUri: pathToFileURL(target).href },
        },
        result: { details: { processTreeStopped: true } },
      });
      const deadline = Date.now() + 10000;
      let page = await runtime.queryOutputFiles(base);
      while (!page.items.some((item) => item.name === 'late.txt') && Date.now() < deadline) {
        await Bun.sleep(20);
        page = await runtime.queryOutputFiles(base);
      }
      expect(
        page.collections.map((item) => item.state),
        JSON.stringify(page),
      ).toEqual(['ready']);
      expect(page.items.map((item) => item.name)).toEqual(['late.txt']);
      const record = await runtime.resolveOutputFile({ ...base, target: page.items[0]! });
      expect(record.sourceExecutionId).toBe(jobs[0]!.id);
      const read = await runtime.readArtifact({
        ...base,
        refId: record.reference.id,
        scope: record.reference.scope,
      });
      expect(new TextDecoder().decode(read.content)).toBe(`${target}\n`);
      expect(existsSync(join(source, 'release-old-shell'))).toBe(false);
      return;
    }
    expect(JSON.stringify(tools[1]!.result)).toContain('target-root-content');
    expect(JSON.stringify(tools[2]!.result)).toContain(target);
    expect(JSON.stringify(tools[6]!.result)).toContain('source-root-content');
    expect(JSON.stringify(tools[7]!.result)).toContain(source);
    const prefix = (n: number) =>
      JSON.stringify(requests[n]?.messages.filter((m) => m.role !== 'tool'));
    expect(prefix(1)).toContain('TARGET_ROOT_ONLY_MARKER');
    expect(prefix(1)).not.toContain('SOURCE_ROOT_ONLY_MARKER');
    expect(prefix(6)).toContain('SOURCE_ROOT_ONLY_MARKER');
    expect(prefix(6)).not.toContain('TARGET_ROOT_ONLY_MARKER');
    const systemContext = (index: number) =>
      requests[index]?.messages.find(({ role }) => role === 'system')?.content;
    expect(systemContext(1)).toContain(`Workspace root: ${realpathSync(target)}`);
    expect(systemContext(6)).toContain(`Workspace root: ${realpathSync(source)}`);
    expect(systemContext(1)).toContain('Shell: /bin/sh (POSIX)');
    if (mode === 'auto') {
      expect(reviews.length).toBe(2);
      expect(reviews.every((review) => review.purpose === 'shell_risk')).toBe(true);
      expect(readFileSync(join(target, 'inspection.txt'), 'utf8')).toBe('root-inspected');
      expect(readFileSync(join(source, 'inspection.txt'), 'utf8')).toBe('root-inspected');
    }
    expect(existsSync(target)).toBe(true);
    expect(existsSync(join(root, 'created-from-target', '.git'))).toBe(!protectProfile);
    expect(JSON.stringify(tools[3]!.result)).toContain(target);
    expect(readFileSync(join(target, 'where.txt'), 'utf8')).toBe('target-root-content\n');
  } catch (error) {
    console.error(error);
    throw error;
  } finally {
    await runtime?.close();
    await store?.close();
    server.stop(true);
  }
}

native(
  'same Run explicitly uses and exits a worktree with Files, Shell and project sources at one epoch',
  () => exerciseRootSwitch(),
  60000,
);

test.skipIf(!onWindows)(
  'Windows switches to an isolated worktree and routes code, PDF and CSV before exit',
  () => exerciseRootSwitch(false, 'auto'),
  90000,
);
native(
  'Auto keeps exact Shell risk review after a root change without losing the original Run ceiling',
  () => exerciseRootSwitch(false, 'auto'),
  60000,
);

native(
  'a dispatched background Shell retains its root and collects output after the same Run exits',
  () => exerciseRootSwitch(false, 'full', true),
  60000,
);

native(
  'an explicit protected root still denies Git filesystem inspection after switching even in Full mode',
  () => exerciseRootSwitch(true),
  60000,
);

test.skipIf(!onWindows && process.platform !== 'darwin')(
  'worktree activation rejects a mismatched dispatch proof or a target replaced after permission inspection',
  async () => {
    const root = persistentWorktreeDirectory('root-approval-');
    const source = join(root, 'source'),
      target = join(root, 'target');
    mkdirSync(source);
    git(source, 'init', '-b', 'main');
    git(
      source,
      '-c',
      'user.name=Root fixture',
      '-c',
      'user.email=root@example.invalid',
      'commit',
      '--allow-empty',
      '-m',
      'initial',
    );
    git(source, 'worktree', 'add', '--detach', target, 'HEAD');
    let prepared = 0;
    const runtime = {
      getSessionExecutionRoot: async () => ({
        sessionId: 's',
        workspaceId: 'w',
        effectiveRootUri: pathToFileURL(source).href,
        epoch: '0',
        identity: null,
      }),
      getSession: async () => ({
        id: 's',
        workspaceId: 'w',
        rootSessionId: 's',
        ownerInstanceId: 'owner',
        ownerGeneration: '1',
      }),
      getExecution: async () => ({
        id: 'e',
        sessionId: 's',
        kind: 'tool',
        definitionId: 'git.worktree',
        definitionVersion: '1',
        originStoreId: 'store',
        decisionSource: {},
      }),
      getWorkspace: async () => ({ rootUri: pathToFileURL(source).href }),
      getMetadata: async () => ({ storeId: 'store' }),
      prepareSessionExecutionRoot: async () => {
        prepared++;
        throw new Error('must_not_prepare');
      },
    } as unknown as AgentRuntime;
    const host = createWorktreeHost(() => runtime);
    const request = { action: 'use' as const, path: target };
    const context = {
      sessionId: 's',
      executionId: 'e',
      signal: new AbortController().signal,
    } as ToolContext;
    const selection = await host.describeExecutionRoot(request, context, source);
    const approvedDigest = planningSnapshotDigest({ sourceCwd: source, request, selection });
    const withProof = (commandDigest: string): ToolContext => ({
      ...context,
      dispatchAuthorization: {
        revision: 'fixture-authorization',
        snapshot: {
          namespace: 'builtin.permissions',
          version: '1',
          data: {
            capability: {
              kind: 'tool',
              definitionId: 'git.worktree',
              definitionVersion: '1',
              hardAllowed: true,
              commandDigest,
            },
          },
        },
      },
    });
    await expect(host.prepareExecutionRoot(request, context, source)).rejects.toMatchObject({
      code: 'execution_root_authorization_unavailable',
    });
    await expect(
      host.prepareExecutionRoot(request, withProof('different-selection'), source),
    ).rejects.toMatchObject({ code: 'execution_root_changed' });
    expect(prepared).toBe(0);
    renameSync(target, `${target}-old`);
    mkdirSync(target);
    copyFileSync(join(`${target}-old`, '.git'), join(target, '.git'));
    await expect(
      host.prepareExecutionRoot(request, withProof(approvedDigest), source),
    ).rejects.toMatchObject({ code: 'execution_root_changed' });
    expect(prepared).toBe(0);
    expect(existsSync(`${target}-old`)).toBe(true);
  },
);
