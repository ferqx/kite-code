import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { decodeMcpStdioProcessEvidence } from '@kite-ai/agent/mcp';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { type AgentClient, createClient, ExecutionOutputPages } from '@kite-ai/client';
import { startService } from '@kite-ai/service';
import { createDefaultProcessConfiguration } from '@kite-ai/service/configuration';
import type { CaseEvidence } from '../../../../scripts/runtime/unified-soak-cases';
import { check, until } from './common';

/** Trusted original artifact assets; there is deliberately no source/build fallback. */
export interface McpSoakStdioAssets {
  guardianPath: string;
  bunExecutable: string;
}
async function output(client: AgentClient, executionId: string) {
  const pages = new ExecutionOutputPages(executionId);
  const items = [];
  while (!pages.complete) {
    const page = pages.accept(
      await client.listExecutionOutput(executionId, {
        afterSeq: pages.afterSeq,
        upperSeq: pages.upperSeq,
        limit: 200,
      }),
    );
    items.push(...page.items);
  }
  return items;
}
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export async function runOwnedMcpStdio(root: string, e: CaseEvidence, assets: McpSoakStdioAssets) {
  if (![assets.guardianPath, assets.bunExecutable].every(isAbsolute))
    throw Error('mcp_stdio_owned_assets_invalid');
  const directory = join(root, 'stdio');
  mkdirSync(directory, { mode: 0o700 });
  const marker = join(directory, 'wire');
  const script = join(directory, 'server.js');
  writeFileSync(
    script,
    `import {writeFileSync} from 'node:fs';let buffer='';process.stdin.on('data',data=>{buffer+=data;for(;;){const at=buffer.indexOf('\\n');if(at<0)break;const line=buffer.slice(0,at);buffer=buffer.slice(at+1);const rpc=JSON.parse(line);if(rpc.id===undefined)continue;let result;if(rpc.method==='initialize')result={protocolVersion:'2024-11-05',serverInfo:{name:'owned',version:'1'},capabilities:{tools:{}}};else if(rpc.method==='tools/list')result={tools:[{name:'exit',description:'owned crash before reply',inputSchema:{type:'object'}}]};else{writeFileSync(${JSON.stringify(marker)},'one actual call',{mode:0o600});process.exit(7);}process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result})+'\\n');}});`,
    { mode: 0o600 },
  );
  const profile = selectProfile({ dataRoot: join(directory, 'data'), profile: 'soak' });
  mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(profile.profilePath, 'mcp.json'),
    JSON.stringify({
      mcpServers: {
        owned: {
          type: 'stdio',
          command: assets.bunExecutable,
          args: [script],
          cwd: directory,
          env: {},
          auth: { type: 'none' },
        },
      },
    }),
    { mode: 0o600 },
  );
  let providerCalls = 0;
  let releaseCall!: () => void;
  const callGate = new Promise<void>((resolve) => {
    releaseCall = resolve;
  });
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as Record<string, unknown>;
      const step = providerCalls++;
      let call: { name: string; input: unknown } | undefined;
      if (step === 0) call = { name: 'mcp.sources.list', input: {} };
      else if (step === 1) {
        const serverId = JSON.stringify(body.messages).match(/mcp-[a-f0-9]{64}/)?.[0];
        if (!serverId) throw Error('mcp_stdio_source_missing');
        call = { name: 'mcp.connect', input: { serverId, key: 'owned-stdio' } };
      } else if (step === 2) {
        await callGate;
        const tools = body.tools as { function: { name: string; description?: string } }[];
        const tool = tools.find(
          (row) => row.function.description === 'External MCP tool: owned crash before reply',
        );
        if (!tool) throw Error('mcp_stdio_remote_tool_missing');
        call = { name: tool.function.name, input: {} };
      }
      const frame = (delta: unknown, finishReason: string | null) =>
        `data: ${JSON.stringify({ id: `stdio-${step}`, object: 'chat.completion.chunk', model: 'fixed', choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
      return new Response(
        frame(
          call
            ? {
                tool_calls: [
                  {
                    index: 0,
                    id: `stdio-call-${step}`,
                    type: 'function',
                    function: { name: call.name, arguments: JSON.stringify(call.input) },
                  },
                ],
              }
            : { content: 'owned stdio complete' },
          null,
        ) +
          frame({}, call ? 'tool_calls' : 'stop') +
          'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const cleanup: (() => Promise<unknown>)[] = [];
  const closeOwned = async (items: (() => Promise<unknown>)[], message: string) => {
    const errors: unknown[] = [];
    for (const close of items.splice(0).reverse()) {
      try {
        await close();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, message);
  };
  const closeHot = () => closeOwned(cleanup, 'mcp_stdio_hot_cleanup_failed');
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
            baseURL: `${provider.url.href}v1`,
          },
        ],
      }),
      { mode: 0o600 },
    );
    const host = createDefaultProcessConfiguration({
      profile,
      mcpSources: { stdio: { ...assets, limits: { timeoutMs: 3000 } } },
      permissionPolicy: {
        readPolicy: (request) => ({
          mode: 'full',
          workspaceTrust: true,
          revision: 'owned-soak',
          allowed: [
            {
              kind: request.kind,
              definitionId: request.definitionId,
              definitionVersion: request.definitionVersion,
            },
          ],
        }),
      },
    });
    const store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
    cleanup.push(() => store.close());
    const storeId = (await store.getMetadata()).storeId;
    const runtime = createRuntime({
      store,
      permissions: host.permissions!,
      extensions: host.extensions,
      supportsExtensionInputs: host.supportsExtensionInputs,
      resolveRunConfiguration: host.resolveRunConfiguration,
      resolveRecoveryRunConfiguration: host.resolveRecoveryRunConfiguration,
    });
    cleanup.push(() => runtime.close());
    host.permissionManagement?.(runtime);
    const serviceProfile = {
      dataRoot: profile.dataRoot,
      name: profile.profile,
      accessKey: profile.profileAccessKey,
    };
    const service = await startService({
      runtime,
      profile: serviceProfile,
      subjectId: 'soak',
      buildId: 'unified-soak',
    });
    cleanup.push(() => service.close());
    const client = createClient({
      endpoint: service.endpoint,
      token: service.bootstrap.token,
      bootstrap: service.bootstrap,
      expected: {
        apiMajor: 1,
        profile: serviceProfile,
        requiredCapabilities: ['sessions', 'commands', 'history'],
      },
    });
    cleanup.push(async () => client.disposeNetwork());
    try {
      await client.connect();
      await client.createWorkspace({
        expectedStoreId: storeId,
        id: 'w',
        rootUri: pathToFileURL(`${directory}/`).href,
        name: 'owned',
      });
      const sessionId = 'stdio';
      await client.createSession({
        expectedStoreId: storeId,
        commandId: 'create-stdio',
        sessionId,
        workspaceId: 'w',
        title: 'owned stdio',
      });
      const commandId = randomUUID();
      await client.startRun(sessionId, {
        expectedStoreId: storeId,
        commandId,
        kind: 'run.start',
        content: 'actual stdio exit',
      });
      const command = await until(
        () => client.getCommand(commandId),
        (value) => value.status === 'applied',
      );
      const runId = String(object(command.receipt).runId);
      const view = await until(
        () => client.getView(sessionId),
        (value) =>
          providerCalls === 3 &&
          value.executions.some((row) => row.definitionId === 'mcp.source.connection'),
      );
      const jobId = view.executions.find((row) => row.definitionId === 'mcp.source.connection')!.id;
      const job = await client.getExecution(jobId);
      const storedJob = await store.getExecution(jobId);
      if (!storedJob) throw Error('mcp_stdio_original_job_missing');
      const ref = object(storedJob.reference);
      const binding = {
        originalStoreId: storeId,
        sessionId,
        executionId: jobId,
        serverId: String(ref.serverId),
        scopeId: String(ref.scopeId),
        configDigest: String(ref.configDigest),
      };
      const ready = await until(
        async () => {
          for (const item of await output(client, jobId)) {
            if (item.stream !== 'progress') continue;
            const frame = object(JSON.parse(item.content));
            if (frame.ready !== true) continue;
            const evidence = decodeMcpStdioProcessEvidence(
              frame.ownedProcesses,
              binding,
              process.pid,
            );
            if (evidence?.version === 2) return evidence;
          }
          return undefined;
        },
        (value) => value !== undefined,
      );
      releaseCall();
      await until(
        () => client.getRun(runId),
        (value) => !value.isActive,
      );
      const terminalJob = await until(
        () => client.getExecution(jobId),
        (value) => !['planned', 'dispatching', 'running'].includes(value.status),
      );
      const terminal = decodeMcpStdioProcessEvidence(
        object(object(terminalJob.result).details).ownedProcesses,
        binding,
        process.pid,
      );
      check(e.assertions, 'stdio_terminal_owned_receipt', terminal?.version ?? 0, 2);
      if (!ready || !terminal || terminal.version !== 2)
        throw Error('mcp_stdio_owned_receipt_missing');
      const complete = await client.getView(sessionId);
      const connect = complete.executions.find((row) => row.id === job.parentExecutionId);
      const remote = (await store.getView(sessionId)).executions.find(
        (row) => row.kind === 'tool' && row.callId === 'stdio-call-2',
      );
      if (!connect || !remote) throw Error('mcp_stdio_original_execution_missing');
      const storedConnect = await store.getExecution(connect.id);
      if (!storedConnect) throw Error('mcp_stdio_original_connect_missing');
      check(
        e.assertions,
        'stdio_job_original_binding',
        storedJob.originStoreId === storeId &&
          storedJob.sessionId === sessionId &&
          storedJob.originCommandId !== commandId &&
          storedJob.runId === null &&
          storedJob.parentExecutionId === connect.id &&
          storedJob.rootWorkCommandId === commandId &&
          storedConnect.originStoreId === storeId &&
          storedConnect.sessionId === sessionId &&
          storedConnect.runId === runId &&
          storedConnect.originCommandId === commandId &&
          storedConnect.rootWorkCommandId === commandId &&
          remote.originStoreId === storeId &&
          remote.sessionId === sessionId &&
          remote.runId === runId &&
          remote.originCommandId === commandId &&
          remote.rootWorkCommandId === commandId &&
          object(storedJob.input).serverId === binding.serverId &&
          object(storedJob.input).configDigest === binding.configDigest,
        true,
      );
      check(e.assertions, 'stdio_exit_unknown', remote.status, 'outcome_unknown');
      check(e.assertions, 'stdio_actual_wire', readFileSync(marker, 'utf8'), 'one actual call');
      const originalCommand = await client.getCommand(commandId);
      const originalConnectionCommand = await client.getCommand(storedJob.originCommandId);
      check(e.assertions, 'stdio_original_receipt', originalCommand.id, commandId);
      const originalRun = await client.getRun(runId);
      const originalConnect = await client.getExecution(connect.id);
      const originalTool = await client.getExecution(remote.id);
      const originalOutput = await output(client, jobId);
      const before = (await store.getMetadata()).lastChangeCursor;
      await client.getCommand(commandId);
      check(
        e.assertions,
        'stdio_readonly_zero_write',
        (await store.getMetadata()).lastChangeCursor,
        before,
      );
      e.identities ??= [];
      for (const execution of [storedConnect, remote, storedJob])
        e.identities.push({
          storeId: execution.originStoreId,
          sessionId: execution.sessionId,
          runId: execution.runId,
          executionId: execution.id,
          commandId: execution.originCommandId,
        });
      await closeHot();
      const callsBefore = providerCalls;
      const coldCleanup: (() => Promise<unknown>)[] = [];
      const coldErrors: unknown[] = [];
      try {
        const coldStore = await openSqliteStore({
          dataRoot: profile.dataRoot,
          profile: profile.profile,
        });
        coldCleanup.push(() => coldStore.close());
        const coldRuntime = createRuntime({
          store: coldStore,
          permissions: {
            async authorize() {
              return { allowed: false, revision: 'cold-read-only' };
            },
          },
        });
        coldCleanup.push(() => coldRuntime.close());
        const coldService = await startService({
          runtime: coldRuntime,
          profile: serviceProfile,
          subjectId: 'soak',
          buildId: 'unified-soak',
        });
        coldCleanup.push(() => coldService.close());
        const coldClient = createClient({
          endpoint: coldService.endpoint,
          token: coldService.bootstrap.token,
          bootstrap: coldService.bootstrap,
          expected: {
            apiMajor: 1,
            profile: serviceProfile,
            requiredCapabilities: ['commands', 'history'],
          },
        });
        coldCleanup.push(async () => coldClient.disposeNetwork());
        await coldClient.connect();
        const coldJob = await coldClient.getExecution(jobId),
          coldConnect = await coldClient.getExecution(connect.id),
          coldTool = await coldClient.getExecution(remote.id);
        const resultUnchanged =
          equal(coldJob, terminalJob) &&
          equal((await coldStore.getExecution(jobId))?.reference, storedJob.reference) &&
          equal(coldConnect, originalConnect) &&
          equal((await coldStore.getExecution(connect.id))?.reference, storedConnect.reference) &&
          equal(coldTool, originalTool) &&
          equal((await coldStore.getExecution(remote.id))?.reference, remote.reference);
        const outputUnchanged =
          equal(await output(coldClient, jobId), originalOutput) &&
          equal(await coldClient.getView(sessionId), complete);
        const commandUnchanged =
          equal(await coldClient.getCommand(commandId), originalCommand) &&
          equal(await coldClient.getCommand(storedJob.originCommandId), originalConnectionCommand);
        const runUnchanged = equal(await coldClient.getRun(runId), originalRun);
        const metadata = await coldStore.getMetadata();
        const unchanged =
          metadata.storeId === storeId &&
          metadata.lastChangeCursor === before &&
          providerCalls === callsBefore;
        check(e.assertions, 'stdio_cold_original_result', resultUnchanged, true);
        check(e.assertions, 'stdio_cold_original_output', outputUnchanged, true);
        check(e.assertions, 'stdio_cold_original_command', commandUnchanged, true);
        check(e.assertions, 'stdio_cold_original_run', runUnchanged, true);
        check(e.assertions, 'stdio_cold_zero_replay', unchanged, true);
        e.mcpStdioHandoff = {
          version: 1,
          coverage: 'original-mcp-stdio-job',
          binding,
          ownerPid: process.pid,
          connectionCommandId: storedJob.originCommandId,
          runCommandId: commandId,
          runId,
          connectExecutionId: connect.id,
          callExecutionId: remote.id,
          ready,
          terminal,
          cold: {
            storeId,
            cursor: before,
            unchanged: true,
            providerCallsBefore: callsBefore,
            providerCallsAfter: providerCalls,
            originalResultUnchanged: true,
            originalOutputUnchanged: true,
            originalCommandUnchanged: true,
            originalRunUnchanged: true,
          },
        };
      } catch (error) {
        coldErrors.push(error);
      } finally {
        try {
          await closeOwned(coldCleanup, 'mcp_stdio_cold_cleanup_failed');
        } catch (error) {
          coldErrors.push(error);
        }
      }
      if (coldErrors.length === 1) throw coldErrors[0];
      if (coldErrors.length) throw new AggregateError(coldErrors, 'mcp_stdio_cold_failed');
    } finally {
      releaseCall();
      await closeHot();
    }
  } finally {
    releaseCall();
    try {
      await closeHot();
    } finally {
      provider.stop(true);
    }
  }
}
