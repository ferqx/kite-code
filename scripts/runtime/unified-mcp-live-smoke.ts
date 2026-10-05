import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { defineExtension } from '@kite-ai/agent/extensions';
import { createMcpAdapter } from '@kite-ai/agent/mcp';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createFixedModel } from '@kite-ai/ai';
import { createClient } from '@kite-ai/client';
import { startService } from '@kite-ai/service';

const endpoint = 'https://docs.langchain.com/mcp';
const expectedTool = 'search_docs_by_lang_chain';
export function parseUnifiedMcpSmoke(args: readonly string[], gate: string | undefined) {
  if (
    args.length > 1 ||
    (args[0] !== undefined &&
      (!args[0].startsWith('--output=') || !isAbsolute(args[0].slice(9)) || args[0].length > 4105))
  )
    throw Error('unified_mcp_live_arguments_invalid');
  const output: string | null = args[0]?.slice(9) ?? null;
  if (gate !== undefined && gate !== '' && gate !== '0' && gate !== '1')
    throw Error('unified_mcp_live_gate_invalid');
  return { output, enabled: gate === '1' };
}
export async function runUnifiedMcpLiveSmoke(enabled: boolean): Promise<Record<string, unknown>> {
  const base = {
    version: 1,
    endpoint,
    expectedTool,
    platform: process.platform,
    arch: process.arch,
    bunVersion: Bun.version,
    runtimeSha256: enabled
      ? createHash('sha256').update(readFileSync(process.execPath)).digest('hex')
      : null,
    cleanupScope: 'owned_local_resources',
    remoteStopConfirmed: null,
    scriptSha256: createHash('sha256')
      .update(readFileSync(import.meta.path))
      .digest('hex'),
    binding: {
      repository: process.env.GITHUB_REPOSITORY ?? null,
      commit: process.env.GITHUB_SHA ?? null,
      workflow: process.env.GITHUB_WORKFLOW ?? null,
      runId: process.env.GITHUB_RUN_ID ?? null,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    },
  };
  if (!enabled)
    return {
      ...base,
      status: 'disabled',
      qualified: false,
      networkAttempted: false,
      cleanup: 'not_started',
    };
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-unified-live-mcp-')));
  const home = join(root, 'home');
  mkdirSync(home, { mode: 0o700 });
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  const adapter = createMcpAdapter({
    id: 'langchain-docs-live',
    transport: { type: 'http', url: endpoint },
    limits: {
      timeoutMs: 20000,
      maxFrameBytes: 4 * 1024 * 1024,
      maxItems: 1024,
      maxPages: 32,
      maxInFlight: 1,
    },
  });
  const scope = adapter.scope('ci-original-live-read');
  let runtime: ReturnType<typeof createRuntime> | undefined;
  let service: Awaited<ReturnType<typeof startService>> | undefined;
  let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
  let result: Record<string, unknown>;
  let cleanup = 'confirmed';
  try {
    const tools = await scope.snapshotTools();
    const toolId = `mcp.langchain-docs-live.${createHash('sha256').update(JSON.stringify(expectedTool)).digest('hex').slice(0, 32)}`;
    const tool = tools.find((value) => value.id === toolId);
    if (!tool || tools.filter((value) => value.id === toolId).length !== 1)
      throw Error('unified_mcp_expected_live_tool_missing');
    store = await openSqliteStore({ dataRoot: join(home, 'data'), profile: 'live' });
    const storeId = (await store.getMetadata()).storeId;
    const model = createFixedModel([
      [
        {
          type: 'tool_call',
          id: 'original-docs-read',
          name: tool.id,
          arguments: JSON.stringify({ query: 'Model Context Protocol MCP server' }),
        },
        { type: 'finish', reason: 'tool_calls', usage: { inputTokens: 1, outputTokens: 1 } },
      ],
      [{ type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } }],
    ]);
    runtime = createRuntime({
      store,
      artifacts: createArtifactStore({
        profile: { dataRoot: join(home, 'data'), profile: 'live' },
        store,
      }),
      model,
      modelId: 'ci-fixed-no-provider',
      extensions: [
        defineExtension({ id: 'ci.langchain', version: '1', apiMajor: 1, tools: [tool] }),
      ],
      permissions: {
        authorize: async () => ({ allowed: true, revision: 'ci-explicit-live-read' }),
      },
    });
    service = await startService({
      runtime,
      profile: { dataRoot: join(home, 'data'), name: 'live', accessKey: 'owned-ci-live' },
      subjectId: 'ci-live',
      buildId: 'unified-live-mcp',
    });
    const client = createClient({
      endpoint: service.endpoint,
      token: service.bootstrap.token,
      expected: {
        apiMajor: 1,
        profile: service.bootstrap.profile,
        requiredCapabilities: ['commands', 'sessions'],
      },
    });
    await client.connect();
    await client.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      rootUri: `file://${root}`,
      name: 'Owned live docs read',
    });
    await client.createSession({
      expectedStoreId: storeId,
      sessionId: 's',
      workspaceId: 'w',
      commandId: 'create-live',
      title: 'Owned MCP smoke',
    });
    await client.startRun('s', {
      expectedStoreId: storeId,
      kind: 'run.start',
      commandId: 'original-live-read',
      content: 'Read official LangChain docs once.',
    });
    const deadline = Date.now() + 30000;
    for (;;) {
      const view = await client.getView('s');
      const execution = view.executions.find(
        (value) => value.kind === 'tool' && value.definitionId === tool.id,
      );
      const run = view.runs[0];
      if (
        execution &&
        run &&
        ['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status)
      ) {
        const actualResult = execution.result;
        if (
          !actualResult ||
          typeof actualResult !== 'object' ||
          Array.isArray(actualResult) ||
          typeof actualResult.content !== 'string' ||
          view.executions.filter((entry) => entry.kind === 'tool').length !== 1 ||
          run.status !== 'completed' ||
          execution.status !== 'succeeded' ||
          actualResult.outcome !== 'succeeded' ||
          !actualResult.content.toLowerCase().includes('langchain')
        )
          throw Error('unified_mcp_actual_read_failed');
        result = {
          ...base,
          status: 'passed',
          qualified: true,
          networkAttempted: true,
          storeId,
          sessionId: 's',
          runId: run.id,
          executionId: execution.id,
          tool: { id: tool.id, version: tool.version },
          catalogue: adapter.getCatalogue(),
          toolsList: 'completed',
          listedTools: tools.length,
          toolReadExecutions: 1,
          model: 'ci-fixed-no-provider',
          resultBytes: Buffer.byteLength(actualResult.content),
          resultSha256: createHash('sha256').update(actualResult.content).digest('hex'),
        };
        break;
      }
      if (Date.now() > deadline) throw Error('unified_mcp_actual_read_timeout');
      await Bun.sleep(10);
    }
  } catch (error) {
    result = {
      ...base,
      status: 'failed',
      qualified: false,
      networkAttempted: true,
      reason: error instanceof Error ? error.message.slice(0, 512) : 'unified_mcp_failed',
    };
  } finally {
    for (const close of [
      async () => service?.close(),
      async () => (runtime ? runtime.close() : store?.close()),
      async () => scope.release(),
      async () => adapter.close(),
    ]) {
      try {
        await close();
      } catch {
        cleanup = 'unconfirmed';
      }
    }
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (cleanup === 'confirmed') rmSync(root, { recursive: true, force: true });
  }
  return {
    ...result,
    cleanup,
    ...(cleanup === 'unconfirmed'
      ? { status: 'failed', qualified: false, reason: 'unified_mcp_cleanup_unconfirmed' }
      : {}),
  };
}
function writeMcpEvidence(path: string, evidence: unknown) {
  const serialized = `${JSON.stringify(evidence)}\n`;
  if (Buffer.byteLength(serialized) > 512 * 1024) throw Error('unified_smoke_evidence_limit');
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    writeFileSync(fd, serialized);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
if (import.meta.main) {
  const args = parseUnifiedMcpSmoke(process.argv.slice(2), process.env.KITE_RUN_LIVE_MCP_SMOKE);
  const deadline = args.enabled
    ? setTimeout(() => {
        const failed = {
          version: 1,
          status: 'failed',
          qualified: false,
          reason: 'unified_mcp_global_timeout',
          cleanup: 'unconfirmed',
        };
        if (args.output) {
          try {
            writeMcpEvidence(args.output, failed);
          } catch {
            /* Nonzero exit preserves failed or missing evidence. */
          }
        }
        console.error(JSON.stringify(failed));
        process.exit(1);
      }, 60000)
    : null;
  try {
    const evidence = await runUnifiedMcpLiveSmoke(args.enabled);
    if (args.output) writeMcpEvidence(args.output, evidence);
    console.log(JSON.stringify(evidence));
    if (args.enabled && !evidence.qualified) process.exitCode = 1;
  } finally {
    if (deadline) clearTimeout(deadline);
  }
}
