import { mock } from 'bun:test';
import * as fs from 'node:fs';
import * as promises from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.once('SIGTERM', () => process.exit(143));
process.stdin.setEncoding('utf8');
let exitInput = '';
process.stdin.on('data', (chunk: string) => {
  exitInput += chunk;
  if (exitInput === 'exit\n') process.exit(0);
  else if (!'exit\n'.startsWith(exitInput)) process.exit(2);
});
process.stdin.once('end', () => process.exit(0));
const root = process.argv[2]!;
const mode = process.argv[3]!;
const moduleRoot = process.argv[4] ?? fileURLToPath(new URL('../../../..', import.meta.url));
const load = (path: string) => import(pathToFileURL(join(moduleRoot, path)).href);
// The saved source uses installed npm dependencies but its original public
// workspace exports. No new interface is invoked to establish the old failure.
const fixtureRoot = fileURLToPath(new URL('../../../..', import.meta.url));
if (moduleRoot !== fixtureRoot) {
  const packageManifest = (await Bun.file(
    join(moduleRoot, 'packages/agent/package.json'),
  ).json()) as { exports: Record<string, string> };
  for (const [entry, path] of Object.entries(packageManifest.exports)) {
    const original = { ...(await load(`packages/agent/${path}`)) };
    mock.module(
      entry === '.' ? '@kite-ai/agent' : `@kite-ai/agent${entry.slice(1)}`,
      () => original,
    );
  }
}
const { selectProfile } = (await load(
  'packages/agent/src/profile.ts',
)) as typeof import('@kite-ai/agent/profile');
const profile = selectProfile({ dataRoot: root, profile: 'test' });
const realFs = { ...fs };
const realPromises = { ...promises };
const workspaceRoot = join(root, 'workspace');
const skillRoot = join(workspaceRoot, 'original');
realFs.mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
realFs.mkdirSync(skillRoot, { recursive: true, mode: 0o700 });
const target = join(skillRoot, 'SKILL.md');
const manifest = {
  name: 'original',
  version: '1.0.0',
  description: 'Original knowledge',
  invocation: { allow_manual: true, allow_implicit: false },
  context: { mode: 'inline', agent: 'code' },
  input_schema: { type: 'object', additionalProperties: false },
  output_schema: { type: 'object', additionalProperties: false },
  capabilities: { require: [], deny: [] },
  effects: { filesystem: 'none', network: 'none', external_state: 'none' },
  approval: { minimum: 'user' },
  execution: { timeout_ms: 5000, max_attempts: 1 },
  verification: { mode: 'required' },
  recovery: { retry: 'never' },
};
const fileBody = `---\n${JSON.stringify(manifest)}\n---\n原完整知识 中🙂e\u0301\r\n原第二行`;
realFs.writeFileSync(target, fileBody, { mode: 0o600 });
let attempts = 0,
  opens = 0,
  modelCalls = 0,
  loadActive = 0,
  workflowCompileActive = 0;
let retainedHandle: promises.FileHandle | undefined;
let retainedDescriptor: number | undefined;
let closeEntered!: () => void;
const entered = new Promise<void>((resolve) => {
  closeEntered = resolve;
});
let releaseClose!: () => void;
const release = new Promise<void>((resolve) => {
  releaseClose = resolve;
});
let toolSignal: AbortSignal | undefined;
let signalAborted!: () => void;
const aborted = new Promise<void>((resolve) => {
  signalAborted = resolve;
});
const failure = Object.assign(Error('original knowledge close rejected before native close'), {
  code: 'fixture_original_knowledge_close_failed',
});
mock.module('node:fs/promises', () => ({
  ...realPromises,
  async open(...args: Parameters<typeof realPromises.open>) {
    const handle = await realPromises.open(...args);
    if (String(args[0]) === target) {
      opens++;
      if (
        !retainedHandle &&
        (mode === 'manual' ? workflowCompileActive > 0 : mode !== 'tool' || loadActive)
      ) {
        retainedHandle = handle;
        handle.close = async () => {
          attempts++;
          closeEntered();
          if (mode === 'tool' || mode === 'late') await release;
          throw failure;
        };
      }
    }
    return handle;
  },
}));
mock.module('node:fs', () => ({
  ...realFs,
  openSync(...args: Parameters<typeof realFs.openSync>) {
    const descriptor = realFs.openSync(...args);
    if (mode === 'manual' && String(args[0]) === target && retainedDescriptor === undefined) {
      opens++;
      retainedDescriptor = descriptor;
    }
    return descriptor;
  },
  closeSync(descriptor: number) {
    if (descriptor === retainedDescriptor) {
      attempts++;
      closeEntered();
      throw failure;
    }
    return realFs.closeSync(descriptor);
  },
}));
if (mode === 'manual') {
  const workflow = {
    ...((await load(
      'packages/agent/src/business/skill-workflow/index.ts',
    )) as typeof import('@kite-ai/agent/skill-workflow')),
  };
  mock.module('@kite-ai/agent/skill-workflow', () => ({
    ...workflow,
    async compileSkillWorkflowAsync(
      ...args: Parameters<typeof workflow.compileSkillWorkflowAsync>
    ) {
      // The normal catalogue metadata/load reads must finish before the fault.
      // Reject only the real Workflow compiler's acquired target FileHandle close.
      workflowCompileActive++;
      try {
        return await workflow.compileSkillWorkflowAsync(...args);
      } finally {
        workflowCompileActive--;
      }
    },
  }));
}
if (mode === 'tool') {
  const skills = {
    ...((await load(
      'packages/agent/src/skills/index.ts',
    )) as typeof import('@kite-ai/agent/skills')),
  };
  mock.module('@kite-ai/agent/skills', () => ({
    ...skills,
    createSkillSource(options: Parameters<typeof skills.createSkillSource>[0]) {
      const source = skills.createSkillSource(options);
      const original = source.load;
      source.load = async (...args: Parameters<typeof original>) => {
        loadActive++;
        try {
          return await original(...args);
        } finally {
          loadActive--;
        }
      };
      return source;
    },
  }));
  const extensions = {
    ...((await load(
      'packages/agent/src/extensions/index.ts',
    )) as typeof import('@kite-ai/agent/extensions')),
  };
  mock.module('@kite-ai/agent/extensions', () => ({
    ...extensions,
    defineExtension(input: Parameters<typeof extensions.defineExtension>[0]) {
      if (input.id === 'builtin.skills')
        input = {
          ...input,
          tools: input.tools?.map((tool) => ({
            ...tool,
            async execute(value, context) {
              toolSignal = context.signal;
              if (context.signal.aborted) signalAborted();
              else context.signal.addEventListener('abort', signalAborted, { once: true });
              return tool.execute(value, context);
            },
          })),
        };
      return extensions.defineExtension(input);
    },
  }));
}
const provider = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    await request.json();
    const first = modelCalls++ === 0;
    const delta = first
      ? {
          tool_calls: [
            {
              index: 0,
              id: 'original-load',
              type: 'function',
              function: { name: 'load_skill', arguments: JSON.stringify({ skill_id: 'original' }) },
            },
          ],
        }
      : { content: 'unexpected next Model' };
    const chunk = (value: unknown, finish: string | null) =>
      `data: ${JSON.stringify({ id: 'fixed', object: 'chat.completion.chunk', model: 'local', choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`;
    return new Response(
      `${chunk(delta, null)}${chunk({}, first ? 'tool_calls' : 'stop')}data: [DONE]\n\n`,
      { headers: { 'content-type': 'text/event-stream' } },
    );
  },
});
realFs.writeFileSync(
  join(profile.profilePath, 'config.jsonc'),
  JSON.stringify({
    modelId: 'local',
    models: [
      {
        id: 'local',
        provider: 'compatible',
        model: 'local',
        baseURL: `http://127.0.0.1:${provider.port}/v1`,
      },
    ],
    tools: [{ id: 'skills.load', definitionVersion: '1' }],
    skills: [{ id: 'original', path: 'original' }],
  }),
  { mode: 0o600 },
);
if (mode === 'manual' || mode === 'ordinary' || mode === 'late')
  realFs.writeFileSync(
    join(profile.profilePath, 'skill-workflow.jsonc'),
    JSON.stringify({
      version: 1,
      features: { skillActivation: true, skillWorkflow: true, verification: true },
    }),
    { mode: 0o600 },
  );
const { createDefaultProcessConfiguration } = (await load(
  'apps/service/src/configuration.ts',
)) as typeof import('../../src/configuration');
const { assembleProcessService } = (await load(
  'apps/service/src/process-service.ts',
)) as typeof import('../../src/process-service');
const { createClient } = (await load(
  'packages/client/src/index.ts',
)) as typeof import('@kite-ai/client');
let runtime: import('@kite-ai/agent').AgentRuntime | undefined;
let managementPort: import('../../src/permission-management').PermissionManagementPort | undefined;
let subjectId = '';
let service: Awaited<ReturnType<typeof assembleProcessService>> | undefined;
let client: ReturnType<typeof createClient> | undefined;
let retained = false;
const describe = (error: unknown) =>
  error instanceof Error
    ? { code: 'code' in error ? error.code : null, message: error.message }
    : null;
const settle = async <T>(task: Promise<T>) =>
  task.then(
    (value) => ({ success: true, value }),
    (error: unknown) => ({ success: false, error: describe(error) }),
  );
const until = async (condition: () => Promise<boolean>, phase: string) => {
  const deadline = Date.now() + 3000;
  while (!(await condition())) {
    if (Date.now() >= deadline) throw Error(`knowledge fixture deadline: ${phase}`);
    await Bun.sleep(5);
  }
};
try {
  service = await assembleProcessService(
    {
      profile: {
        dataRoot: profile.dataRoot,
        profile: profile.profile,
        profileAccessKey: profile.profileAccessKey,
      },
      instanceId: `knowledge-${mode}`,
      buildId: 'fixed',
      token: 'd'.repeat(64),
    },
    {
      configure(_startup, context) {
        subjectId = context.subjectId;
        const host = createDefaultProcessConfiguration({
          userConfigurationPath: profile.profilePath + '/config.jsonc',
          profile,
          permissionPolicy:
            mode === 'prep' || mode === 'tool'
              ? {
                  readPolicy: () => ({
                    mode: 'full',
                    workspaceTrust: true,
                    revision: 'trusted-knowledge',
                    allowed: [
                      { kind: 'model', definitionId: 'local', definitionVersion: '1' },
                      { kind: 'tool', definitionId: 'skills.load', definitionVersion: '1' },
                    ],
                  }),
                }
              : undefined,
        });
        const management = host.permissionManagement!;
        return {
          ...host,
          permissionManagement(owner) {
            runtime = owner;
            managementPort = management(owner);
            return managementPort;
          },
        };
      },
    },
  );
  client = createClient({
    endpoint: service.endpoint,
    token: service.bootstrap.token,
    bootstrap: service.bootstrap,
    expected: {
      apiMajor: 1,
      profile: service.bootstrap.profile,
      requiredCapabilities: ['sessions', 'commands', 'history', 'skill_catalogue'],
    },
  });
  await client.connect();
  const expectedStoreId = service.bootstrap.storeId!;
  await client.createWorkspace({
    expectedStoreId,
    id: 'w',
    rootUri: pathToFileURL(workspaceRoot).href,
    name: 'original',
  });
  await client.createSession({
    expectedStoreId,
    commandId: 'create',
    sessionId: 's',
    workspaceId: 'w',
    title: 'original',
  });
  if (!runtime || !managementPort) throw Error('original runtime missing');
  if (mode === 'ordinary' || mode === 'manual' || mode === 'late') {
    const identity = { expectedStoreId, subjectId, workspaceId: 'w' };
    const trust = await managementPort.readTrust(identity);
    await managementPort.setTrust({
      ...identity,
      commandId: 'trust',
      trusted: true,
      canonicalIdentity: trust.canonicalIdentity,
      externalReadScopeDigest: trust.externalReadScopeDigest,
      ifRevision: trust.revision,
    });
  }
  const initial = {
    storedView: await runtime.getView('s'),
    metadata: await runtime.getMetadata(),
    command: await runtime.getCommand('create'),
    messages: await runtime.listMessages('s', { limit: 200 }),
  };
  const input = '原用户正文 中🙂e\u0301\r\n原第二行';
  let firstRead: unknown,
    secondRead: unknown,
    closePending = false;
  let closing: Promise<void> | undefined;
  if (mode === 'prep' || mode === 'tool') {
    await client.startRun('s', {
      expectedStoreId,
      commandId: 'work',
      kind: 'run.start',
      content: input,
      ...(mode === 'prep' ? { selectedSkills: ['original'] } : {}),
    });
    if (mode === 'tool') {
      await entered;
      const view = await client.getView('s');
      const run = view.runs.find((row) => row.isActive);
      if (!run || !toolSignal) throw Error('original active Tool/Run missing');
      await client.cancelRun('s', {
        expectedStoreId,
        commandId: 'cancel',
        kind: 'run.cancel',
        runId: run.id,
      });
      await aborted;
      releaseClose();
      await until(
        async () => (await client!.getView('s')).runs.every((row) => !row.isActive),
        'original cancelled Tool',
      );
    } else
      await until(
        async () => (await client!.getCommand('work'))?.status === 'rejected',
        'preparation rejection',
      );
  } else {
    const request = client.listSkills('w', {
      storeId: expectedStoreId,
      ...(mode === 'manual' ? { workflow: 'manual' as const } : {}),
    });
    void request.catch(() => {});
    if (mode === 'late') {
      await entered;
      let finished = false;
      closing = service.close();
      void closing.then(
        () => {
          finished = true;
        },
        () => {
          finished = true;
        },
      );
      // An actual live owner observes the pending request at the shutdown boundary.
      await runtime!.getMetadata();
      closePending = !finished;
      releaseClose();
    }
    firstRead = await settle(request);
    if (mode !== 'late')
      secondRead = await settle(
        client.listSkills('w', {
          storeId: expectedStoreId,
          ...(mode === 'ordinary' ? { workflow: 'manual' as const } : {}),
        }),
      );
  }
  if (!runtime) throw Error('original runtime missing');
  const storedView = mode === 'late' ? initial.storedView : await runtime.getView('s');
  const metadata = mode === 'late' ? initial.metadata : await runtime.getMetadata();
  const command =
    mode === 'late'
      ? initial.command
      : await runtime.getCommand(mode === 'prep' || mode === 'tool' ? 'work' : 'create');
  const messages =
    mode === 'late' ? initial.messages : await runtime.listMessages('s', { limit: 200 });
  closing ??= service.close();
  const sameClose = closing === service.close();
  const error = await closing.then(
    () => null,
    (cause: unknown) => cause,
  );
  const runtimeError = await runtime.close().then(
    () => null,
    (cause: unknown) => cause,
  );
  let fileContent: string;
  const bytes = Buffer.alloc(Buffer.byteLength(fileBody));
  if (retainedHandle) {
    await retainedHandle.read(bytes, 0, bytes.length, 0);
    fileContent = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } else if (retainedDescriptor !== undefined) {
    realFs.readSync(retainedDescriptor, bytes, 0, bytes.length, 0);
    fileContent = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } else throw Error('original acquired knowledge resource missing');
  // Original reads use positioned read; readFile starts at the unchanged descriptor offset.
  retained = true;
  console.log(
    JSON.stringify({
      pid: process.pid,
      mode,
      input,
      fileBody,
      fileContent,
      attempts,
      opens,
      modelCalls,
      aborted: toolSignal?.aborted ?? false,
      firstRead,
      secondRead,
      closePending,
      storedView,
      metadata,
      command,
      messages,
      executions: storedView.executions,
      sameClose,
      lifecycle: runtime.getLifecycleState(),
      error: describe(error),
      runtimeError: describe(runtimeError),
    }),
  );
} catch (error) {
  console.error(error);
  process.exit(1);
} finally {
  releaseClose();
  client?.disposeNetwork();
  provider.stop(true);
  if (service && !retained)
    await service.close().catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
}
