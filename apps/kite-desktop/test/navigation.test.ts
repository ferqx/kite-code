import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AppMcpServer } from '@kite-ai/kite-app-contract';
import {
  createBunStdioChildRuntimeClientTransport,
  kiteAppServerVersion,
} from '@kite-ai/kite-local-runtime/client';
import type { RuntimeClientConnection } from '@kite-ai/runtime-client';
import { DesktopClient } from '../src/client';
import { createTestDesktopBridge, type DesktopTestCall } from './desktop-bridge';

test('desktop reads across projects, isolates execution, and ignores a superseded selection', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-desktop-navigation-')));
  for (const name of ['a', 'b', 'home', 'runtime', 'config']) mkdirSync(join(root, name));
  writeFileSync(
    join(root, 'config/kite-code.jsonc'),
    JSON.stringify({
      provider: {
        test: {
          type: 'openai-compatible',
          apiKey: 'fixture',
          baseURL: 'http://127.0.0.1:1/v1',
          model: 'test-model',
          models: ['test-model'],
        },
      },
      model: { default: { provider: 'test', name: 'test-model' } },
      sandbox: { enabled: false },
      mcpServers: {},
    }),
  );
  let workspace = join(root, 'a');
  let branch = 'main';
  let dirty = false;
  let branchSwitches = 0;
  let closes = 0;
  let failDirectory = false;
  let failModel = false;
  let failGit = false;
  let historyReads = 0;
  let projectReads = 0;
  let modelReads = 0;
  const injectedFailures = new Set<unknown>();
  let loseBranchResult = false;
  let activeDirectory = false;
  let directoryId: unknown;
  let loseCreationResult = false;
  let creationId: unknown;
  let creations = 0;
  let permissionWrites = 0;
  let losePermissionResult = false;
  let permissionResultId: unknown;
  let generation = 0;
  const carriers = new Map<
    number,
    { connection: RuntimeClientConnection; messages: AsyncIterator<unknown> }
  >();
  let holdNextQuery = false;
  let failMcpResponse = false;
  let mcpResponseId: unknown;
  let mcpActions = 0;
  let heldId: unknown;
  let release!: () => void;
  let observed!: () => void;
  let held = Promise.resolve();
  let received = Promise.resolve();
  const call: DesktopTestCall = async <T>(command: string, args?: Record<string, unknown>) => {
    if (command === 'runtime_status') return { workspace, connectionId: generation || null } as T;
    if (command === 'pick_workspace') return workspace as T;
    if (command === 'activate_workspace') return workspace as T;
    if (command === 'check_workspace' || command === 'runtime_detach') return undefined as T;
    if (command === 'list_projects') {
      projectReads++;
      return ['a', 'b'].map((name) => ({ path: join(root, name), lastOpenedAt: 1 })) as T;
    }
    if (command === 'switch_workspace_branch') {
      branchSwitches++;
      branch = args?.branch as string;
      if (loseBranchResult) throw new Error('fixture lost branch result');
    }
    if (command === 'query_workspace_branch' && failGit) throw new Error('Git is not installed');
    if (command === 'query_workspace_branch' || command === 'switch_workspace_branch')
      return {
        workspace,
        repository: true,
        root: workspace,
        current: branch,
        head: 'fixture-commit',
        branches: ['main', 'feature'],
        dirty,
        canSwitch: true,
      } as T;
    if (command === 'runtime_open') {
      const connection = await createBunStdioChildRuntimeClientTransport({
        argv: [
          process.execPath,
          resolve('scripts/release/entrypoints/service.ts'),
          'app-server',
          'run-stdio',
        ],
        cwd: '/',
        env: {
          KITE_CODE_HOME: join(root, 'runtime'),
          KITE_CODE_CONFIG_HOME: join(root, 'config'),
          KITE_APP_SERVER_WORKSPACE: workspace,
          KITE_APP_SERVER_BUILD_ID: 'desktop-navigation',
          HOME: join(root, 'home'),
          USERPROFILE: join(root, 'home'),
          PATH: process.env.PATH ?? '/usr/bin:/bin',
        },
      }).connect();
      carriers.set(++generation, {
        connection,
        messages: connection.messages()[Symbol.asyncIterator](),
      });
      return {
        connectionId: generation,
        workspace,
        expectedServerVersion: kiteAppServerVersion('desktop-navigation'),
      } as T;
    }
    const carrier = carriers.get(args?.connectionId as number)!;
    if (command === 'runtime_send') {
      const message = JSON.parse(args?.frame as string);
      if (message.method === 'runtime/query' && message.params?.query?.type === 'list_sessions')
        directoryId = message.id;
      if (
        message.method === 'runtime/command' &&
        message.params?.command?.type === 'create_session'
      ) {
        creations++;
        if (loseCreationResult) creationId = message.id;
      }
      if (
        message.method === 'runtime/command' &&
        message.params?.command?.type === 'set_interaction_mode'
      ) {
        permissionWrites++;
        if (losePermissionResult) permissionResultId = message.id;
      }
      if (message.method === 'history/list_sessions') {
        historyReads++;
        if (failDirectory) injectedFailures.add(message.id);
      }
      if (message.method === 'app/provider_model/snapshot' && failModel)
        injectedFailures.add(message.id);
      if (message.method === 'app/provider_model/snapshot') modelReads++;
      if (message.method === 'app/mcp/action') {
        mcpActions++;
        if (failMcpResponse) mcpResponseId = message.id;
      }
      if (holdNextQuery && message.method === 'runtime/query') {
        holdNextQuery = false;
        heldId = message.id;
      }
      await carrier.connection.send(message);
    } else if (command === 'runtime_receive') {
      const item = await carrier.messages.next();
      if (item.done) throw new Error('closed');
      const message = item.value as {
        id?: unknown;
        result?: { sessions?: Array<Record<string, unknown>> };
      };
      if (injectedFailures.delete(message.id))
        return JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          error: {
            code: -32603,
            message: 'fixture capability failure',
            data: { code: 'internal_error' },
          },
        }) as T;
      if (
        activeDirectory &&
        directoryId !== undefined &&
        message.id === directoryId &&
        message.result?.sessions?.length
      ) {
        message.result.sessions[0]!.currentRun = {
          runId: 'fixture-running',
          initialTurnId: 'fixture-turn',
          status: 'running',
          revision: 1,
        };
      }
      if (permissionResultId !== undefined && message.id === permissionResultId) {
        permissionResultId = undefined;
        return JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          error: {
            code: -32603,
            message: 'fixture lost permission receipt',
            data: { code: 'internal_error' },
          },
        }) as T;
      }
      if (creationId !== undefined && message.id === creationId) {
        creationId = undefined;
        return JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32000, message: 'fixture lost creation receipt' },
        }) as T;
      }
      if (heldId !== undefined && message.id === heldId) {
        heldId = undefined;
        observed();
        await held;
      }
      if (mcpResponseId !== undefined && message.id === mcpResponseId) {
        mcpResponseId = undefined;
        return JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32000, message: 'fixture lost action response' },
        }) as T;
      }
      return JSON.stringify(message) as T;
    } else if (command === 'runtime_close') {
      closes++;
      await carrier.connection.close();
    } else throw new Error(`Unexpected IPC ${command}`);
    return undefined as T;
  };
  let client = new DesktopClient(createTestDesktopBridge(call));
  try {
    await client.refreshProjects();
    await client.restoreWorkspace();
    expect(client.getSnapshot().connected).toBe(true);
    expect(client.getSnapshot().directory).toEqual([]);
    await waitFor(() => client.getSnapshot().trust?.status === 'trusted');
    expect(client.getSnapshot().trust?.status).toBe('trusted');
    expect(creations).toBe(0);
    await client.activateProject(workspace);
    expect(client.getSnapshot().trust?.status).toBe('trusted');
    expect(creations).toBe(0);
    await client.prepareNewConversation();
    expect(creations).toBe(0);
    branch = 'feature';
    await client.prepareNewConversation();
    expect(client.getSnapshot().branch?.current).toBe('feature');
    expect(creations).toBe(0);
    dirty = true;
    const beforeDirty = closes;
    await expect(client.switchBranch('main')).rejects.toThrow('改动');
    expect(closes).toBe(beforeDirty);
    expect(branchSwitches).toBe(0);
    // Selecting the actual current branch remains a no-op even with user edits.
    await client.switchBranch('feature');
    dirty = false;
    await client.switchBranch('main');
    expect(client.getSnapshot().branch?.current).toBe('main');
    expect(client.getSnapshot().connected).toBe(true);
    expect(branchSwitches).toBe(1);
    await client.refreshMcp();
    await client.refreshSkills();
    expect(client.getSnapshot().mcp?.workspace.canonicalPath).toBe(workspace);
    expect(client.getSnapshot().skills?.workspace.canonicalPath).toBe(workspace);
    expect(client.getSnapshot().mcp?.servers).toEqual([]);
    const missing: AppMcpServer = {
      key: { name: 'missing', source: 'user' },
      effective: true,
      sourcePath: '/fixture',
      transport: 'http',
      enabled: true,
      required: false,
      configStatus: 'ready',
      health: 'disconnected',
      authStatus: 'not_required',
      configuration: {},
      revision: 'stale',
      toolCount: 0,
      resourceCount: 0,
      promptCount: 0,
      tools: [],
      prompts: [],
    };
    await expect(client.runMcpAction(missing, 'reconnect')).rejects.toThrow('未确认生效');
    expect(mcpActions).toBe(1);
    failMcpResponse = true;
    await expect(client.runMcpAction(missing, 'reconnect')).rejects.toThrow('结果未知');
    expect(mcpActions).toBe(2);
    expect(client.getSnapshot().mcp?.servers).toEqual([]);
    failMcpResponse = false;
    await client.connect();
    const first = await client.newSession();
    await client.selectSession(first);
    await client.setInteractionMode(first, 'full');
    expect(client.getSnapshot().interactionMode).toBe('full');
    await client.setInteractionMode(first, 'auto');
    expect(client.getSnapshot().interactionMode).toBe('auto');
    const second = await client.newSession();
    const modesDuringSelection: Array<string | undefined> = [];
    const unsubscribeModes = client.subscribe(() => {
      modesDuringSelection.push(client.getSnapshot().interactionMode);
    });
    await client.selectSession(second);
    unsubscribeModes();
    expect(modesDuringSelection).not.toContain(undefined);
    const beforeReadFailureCloses = closes;
    const cachedDirectory = client.getSnapshot().directory;
    failDirectory = true;
    const beforeReads = historyReads;
    await expect(client.refreshDirectory()).rejects.toThrow();
    expect(historyReads).toBe(beforeReads + 6);
    expect(client.getSnapshot().directory).toEqual(cachedDirectory);
    expect(Object.keys(client.getSnapshot().directoryErrors ?? {})).toHaveLength(3);
    expect(client.getSnapshot().connected).toBe(true);
    expect(closes).toBe(beforeReadFailureCloses);
    failDirectory = false;
    await client.refreshDirectory();
    expect(client.getSnapshot().directoryErrors).toEqual({});
    failModel = true;
    await expect(client.refreshModels()).rejects.toThrow();
    expect(client.getSnapshot().connected).toBe(true);
    expect(client.getSnapshot().modelError).toBeDefined();
    await client.selectSession(first);
    expect(client.getSnapshot().ready).toBe(true);
    expect(closes).toBe(beforeReadFailureCloses);
    failModel = false;
    failGit = true;
    await client.prepareNewConversation();
    expect(client.getSnapshot().branch).toBeUndefined();
    expect(client.getSnapshot().connected).toBe(true);
    failGit = false;
    await client.refreshBranch();
    activeDirectory = true;
    const beforeActive = closes;
    await expect(client.switchBranch('feature')).rejects.toThrow('运行');
    expect(closes).toBe(beforeActive);
    activeDirectory = false;
    loseBranchResult = true;
    await expect(client.switchBranch('feature')).rejects.toThrow('lost branch');
    expect(client.getSnapshot().branch?.current).toBe('feature');
    expect(client.getSnapshot().ready).toBe(true);
    expect(branchSwitches).toBe(2);
    loseBranchResult = false;
    expect(
      client
        .getSnapshot()
        .sessions.map((session) => session.sessionId)
        .sort(),
    ).toEqual([first, second].sort());
    await client.selectSession(second);
    held = new Promise<void>((done) => {
      release = done;
    });
    received = new Promise<void>((done) => {
      observed = done;
    });
    holdNextQuery = true;
    const staleSelection = client.selectSession(first);
    await received;
    const currentSelection = client.selectSession(second);
    release();
    await Promise.all([staleSelection, currentSelection]);
    expect(client.getSnapshot().selected).toBe(second);
    expect(client.getSnapshot().projection?.sessionId).toBe(second);
    expect(client.getSnapshot().ready).toBe(true);
    const directoryBeforeSwitch = client.getSnapshot().directory;
    const projectsBeforeSwitch = client.getSnapshot().projects;
    const modelsBeforeSwitch = client.getSnapshot().models;
    const modelReadsBeforeSwitch = modelReads;
    const branchSnapshots: Array<string | undefined> = [];
    const unsubscribeBranchSnapshots = client.subscribe(() => {
      branchSnapshots.push(client.getSnapshot().branch?.current ?? undefined);
    });
    await client.disconnect();
    expect(client.getSnapshot().mcp).toBeUndefined();
    expect(client.getSnapshot().skills).toBeUndefined();
    workspace = join(root, 'b');
    const historyReadsBeforeSwitch = historyReads;
    const projectReadsBeforeSwitch = projectReads;
    await client.activateProject(workspace);
    await client.prepareNewConversation();
    unsubscribeBranchSnapshots();
    expect(branchSnapshots).not.toContain(undefined);
    expect(historyReads).toBe(historyReadsBeforeSwitch);
    expect(projectReads).toBe(projectReadsBeforeSwitch);
    expect(client.getSnapshot().directory).toBe(directoryBeforeSwitch);
    expect(client.getSnapshot().projects).toBe(projectsBeforeSwitch);
    expect(client.getSnapshot().models).toBe(modelsBeforeSwitch);
    expect(modelReadsBeforeSwitch).toBeGreaterThan(0);
    expect(modelReads).toBe(modelReadsBeforeSwitch);
    expect(client.getSnapshot().trust?.status).toBe('trusted');
    expect(client.getSnapshot().selected).toBeUndefined();
    expect(client.getSnapshot().messages).toEqual([]);
    expect(client.getSnapshot().sessions).toEqual([]);
    expect(
      client
        .getSnapshot()
        .directory?.some(
          (session) => session.sessionId === first && session.workspace === join(root, 'a'),
        ),
    ).toBe(true);
    await client.selectSession(first);
    expect(client.getSnapshot().ready).toBe(true);
    await expect(client.send('must not run in a different project')).rejects.toThrow('工作目录');
    const permissionConnection = generation;
    const permissionCloses = closes;
    losePermissionResult = true;
    const writesBeforePermission = permissionWrites;
    await client.setInteractionMode(first, 'full');
    losePermissionResult = false;
    expect(permissionWrites).toBe(writesBeforePermission + 1);
    expect(client.getSnapshot().interactionMode).toBe('full');
    expect(client.getSnapshot().commandError).toBeUndefined();
    expect(client.getSnapshot().workspace).toBe(workspace);
    expect(generation).toBe(permissionConnection);
    expect(closes).toBe(permissionCloses);
    await expect(client.send('permission must not admit cross-project execution')).rejects.toThrow(
      '工作目录',
    );
    const trustPath = join(root, 'config/workspace-trust.jsonc');
    const savedTrust = readFileSync(trustPath, 'utf8');
    const trustFile = JSON.parse(savedTrust);
    for (const [key, record] of Object.entries(trustFile.records)) {
      if ((record as { workspacePath: string }).workspacePath === join(root, 'a'))
        delete trustFile.records[key];
    }
    writeFileSync(trustPath, JSON.stringify(trustFile));
    await expect(client.setInteractionMode(first, 'auto')).rejects.toThrow('Unauthorized');
    expect(client.getSnapshot().interactionMode).toBe('full');
    writeFileSync(trustPath, '{invalid trust');
    await expect(client.setInteractionMode(first, 'auto')).rejects.toThrow(
      'Runtime admission unavailable',
    );
    expect(client.getSnapshot().interactionMode).toBe('full');
    writeFileSync(trustPath, savedTrust);
    await client.disconnect();
    workspace = '';
    await client.connect();
    await client.selectSession(first);
    expect(client.getSnapshot().ready).toBe(true);
    expect(client.getSnapshot().interactionMode).toBe('full');
    await client.setInteractionMode(first, 'auto');
    expect(client.getSnapshot().interactionMode).toBe('auto');
    expect(client.getSnapshot().workspace).toBe('');

    await client.disconnect();
    workspace = join(root, 'a');
    await client.openProject();
    expect(
      client
        .getSnapshot()
        .sessions.map((session) => session.sessionId)
        .sort(),
    ).toEqual([first, second].sort());
    await client.selectSession(first);
    expect(client.getSnapshot().ready).toBe(true);
    // A new renderer restores automatically without requesting native cleanup
    // or creating/replaying a session. Native tests verify same-process attach.
    const previousClient = client;
    const beforeRestoreMessages = client.getSnapshot().messages;
    client = new DesktopClient(createTestDesktopBridge(call));
    const beforeRestore = closes;
    const beforeRestoreCreations = creations;
    await client.restoreWorkspace();
    expect(client.getSnapshot().workspace).toBe(workspace);
    expect(client.getSnapshot().connected).toBe(true);
    expect(client.hasNativeConnection()).toBe(true);
    expect(closes).toBe(beforeRestore);
    expect(creations).toBe(beforeRestoreCreations);
    await client.selectSession(first);
    expect(client.getSnapshot().ready).toBe(true);
    expect(client.getSnapshot().messages).toEqual(beforeRestoreMessages);
    expect(client.getSnapshot().selected).toBe(first);
    expect(creations).toBe(beforeRestoreCreations);
    await previousClient.disconnect();
    loseCreationResult = true;
    const beforeCreation = creations;
    await expect(client.newSession()).rejects.toThrow('结果未知');
    const attempted = client.getSnapshot().selected!;
    expect(attempted).not.toBe(first);
    expect(client.getSnapshot().ready).toBe(false);
    loseCreationResult = false;
    await client.connect();
    expect(creations).toBe(beforeCreation + 1);
    expect(client.getSnapshot().selected).toBe(attempted);
    expect(
      client.getSnapshot().sessions.filter((session) => session.sessionId === attempted),
    ).toHaveLength(1);
    expect(client.getSnapshot().ready).toBe(true);
    // Persisted history survives loss of the last selected directory and invalid model config.
    await client.disconnect();
    rmSync(workspace, { recursive: true, force: true });
    writeFileSync(join(root, 'config/kite-code.jsonc'), '{invalid config');
    failGit = true;
    await client.connect();
    expect(client.getSnapshot().connected).toBe(true);
    expect(client.getSnapshot().directory?.some((entry) => entry.sessionId === first)).toBe(true);
    await client.selectSession(first);
    expect(client.getSnapshot().ready).toBe(true);
    expect(client.getSnapshot().projection?.sessionId).toBe(first);
    expect(creations).toBe(beforeCreation + 1);
  } finally {
    release?.();
    await client.disconnect();
    await Promise.all([...carriers.values()].map((carrier) => carrier.connection.close()));
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(5);
  expect(predicate()).toBe(true);
}
