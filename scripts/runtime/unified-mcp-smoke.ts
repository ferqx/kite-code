import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fsyncSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { defineExtension, type Json } from '@kite-ai/agent/extensions';
import { createMcpAdapter } from '@kite-ai/agent/mcp';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { privateDirectory } from '@kite-ai/agent/windows-path-security';
import { createFixedModel } from '@kite-ai/ai';
import { createClient } from '@kite-ai/client';
import { startService } from '@kite-ai/service';
import { verifyLoopbackReads } from '../../tests/fixtures/mcp-leaf/loopback-reads';
import { openLoopbackMcpSmoke } from '../../tests/fixtures/mcp-leaf/loopback-smoke';

export function parseUnifiedMcpSmoke(args: readonly string[]) {
  if (
    args.length > 1 ||
    (args[0] !== undefined &&
      (!args[0].startsWith('--output=') || !isAbsolute(args[0].slice(9)) || args[0].length > 4105))
  )
    throw Error('unified_mcp_arguments_invalid');
  return args[0]?.slice(9) ?? null;
}

const scenarios = [
  { source: 'alpha', tool: 'echo', input: { text: 'one' }, outcome: 'succeeded' },
  { source: 'beta', tool: 'echo', input: { text: 'two' }, outcome: 'succeeded' },
  { source: 'alpha', tool: 'reject', input: {}, outcome: 'failed' },
  { source: 'alpha', tool: 'rpc_error', input: {}, outcome: 'outcome_unknown' },
] as const;

function object(value: Json | undefined): Record<string, Json> {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'mcp_result_object_missing');
  return value;
}

export async function runUnifiedMcpSmoke(): Promise<Record<string, unknown>> {
  const checks = {
    transport: 'streamable-http',
    model: 'fixed-local',
    platform: process.platform,
    arch: process.arch,
    bunVersion: Bun.version,
    scriptSha256: createHash('sha256')
      .update(readFileSync(import.meta.path))
      .digest('hex'),
    commit: process.env.GITHUB_SHA ?? null,
    runId: process.env.GITHUB_RUN_ID ?? null,
  };
  const root = join(realpathSync(tmpdir()), `kite-owned-mcp-${randomUUID()}`);
  privateDirectory(root);
  const close: (() => unknown)[] = [];
  let result: Record<string, unknown>;
  let cleanup = 'confirmed';
  try {
    const peer = openLoopbackMcpSmoke();
    close.push(() => peer.close());
    const connections = (['alpha', 'beta'] as const).map((id) => {
      const adapter = createMcpAdapter({ id, transport: { type: 'http', url: peer.urls[id] } });
      close.push(() => adapter.close());
      const scope = adapter.scope('ci-loopback');
      close.push(() => scope.release());
      return { id, adapter, scope };
    });
    const sources = await Promise.all(
      connections.map(async (connection) => {
        const tools = await connection.scope.snapshotTools();
        assert.deepEqual(
          peer.requests[connection.id].map(({ method }) => method),
          ['initialize', 'notifications/initialized', 'tools/list'],
        );
        const expected =
          connection.id === 'alpha' ? ['echo', 'reject', 'rpc_error'] : ['echo', 'reject'];
        const byName = new Map(
          expected.map((name) => {
            const hash = createHash('sha256')
              .update(JSON.stringify(name))
              .digest('hex')
              .slice(0, 32);
            const tool = tools.find((item) => item.id === `mcp.${connection.id}.${hash}`);
            assert(tool?.model?.name, 'mcp_catalogue_tool_missing');
            return [name, tool] as const;
          }),
        );
        assert.equal(tools.length, expected.length, 'unexpected_mcp_catalogue_size');
        return { ...connection, tools, byName };
      }),
    );
    const tools = sources.flatMap((source) => source.tools);
    assert.equal(
      new Set(tools.map((tool) => tool.model!.name)).size,
      tools.length,
      'mcp_tool_name_collision',
    );
    const calls = scenarios.map((scenario, index) => {
      const source = sources.find((entry) => entry.id === scenario.source)!;
      const tool = source.byName.get(scenario.tool)!;
      return { ...scenario, tool, callId: `owned-call-${index + 1}` };
    });
    const usage = { inputTokens: 1, outputTokens: 1 };
    const model = createFixedModel([
      ...calls.map((call) => [
        {
          type: 'tool_call' as const,
          id: call.callId,
          name: call.tool.model!.name,
          arguments: JSON.stringify(call.input),
        },
        { type: 'finish' as const, reason: 'tool_calls' as const, usage },
      ]),
      [{ type: 'finish', reason: 'stop', usage }],
    ]);
    const profile = { dataRoot: join(root, 'data'), profile: 'owned-mcp' };
    const store = await openSqliteStore(profile);
    close.push(() => store.close());
    const storeId = (await store.getMetadata()).storeId;
    const runtime = createRuntime({
      store,
      model,
      modelId: 'fixed-local',
      artifacts: createArtifactStore({ profile, store }),
      extensions: [defineExtension({ id: 'ci.mcp', version: '1', apiMajor: 1, tools })],
      permissions: { authorize: async () => ({ allowed: true, revision: 'ci-loopback' }) },
    });
    close.push(() => runtime.close());
    const service = await startService({
      runtime,
      profile: { dataRoot: profile.dataRoot, name: profile.profile, accessKey: 'owned-ci' },
      subjectId: 'ci',
      buildId: 'mcp-conformance',
    });
    close.push(() => service.close());
    const client = createClient({
      endpoint: service.endpoint,
      token: service.bootstrap.token,
      expected: {
        apiMajor: 1,
        profile: service.bootstrap.profile,
        requiredCapabilities: ['commands', 'sessions'],
      },
    });
    close.push(() => client.disposeNetwork());
    await client.connect();
    await client.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      rootUri: pathToFileURL(root).href,
      name: 'Owned MCP',
    });
    const sessionId = 's',
      commandId = 'loopback-call';
    await client.createSession({
      expectedStoreId: storeId,
      sessionId,
      workspaceId: 'w',
      commandId: 'create-s',
      title: 'Owned MCP',
    });
    await client.startRun(sessionId, {
      expectedStoreId: storeId,
      kind: 'run.start',
      commandId,
      content: 'Exercise only the two owned sources.',
    });
    let view = await client.getView(sessionId);
    const deadline = performance.now() + 30000;
    while (
      !view.runs.length ||
      !['completed', 'failed', 'cancelled', 'interrupted'].includes(view.runs[0]!.status)
    ) {
      if (performance.now() >= deadline) throw Error('mcp_run_timeout');
      await Bun.sleep(10);
      view = await client.getView(sessionId);
    }
    const run = view.runs[0]!;
    assert.equal(run.status, 'completed', 'mcp_run_incomplete');
    const executions = view.executions.filter((execution) => execution.kind === 'tool');
    assert.equal(executions.length, calls.length, 'mcp_execution_count');
    assert.equal(model.requests.length, calls.length + 1, 'mcp_model_count');
    const offeredNames = model.requests[0]!.tools.map((tool) => tool.id);
    for (const definition of tools) {
      assert.equal(
        offeredNames.filter((name) => name === definition.model!.name).length,
        1,
        'mcp_model_catalogue_missing',
      );
    }
    const receipts = await Promise.all(
      calls.map(async (call) => {
        const execution = executions.find((item) => item.definitionId === call.tool.id);
        assert(execution && execution.runId === run.id, 'mcp_execution_identity');
        const original = await store.getExecution(execution.id);
        assert.equal(original?.originCommandId, commandId);
        assert.equal(execution.definitionVersion, call.tool.version);
        assert.equal(execution.status, call.outcome, 'mcp_execution_outcome');
        const actual = object(execution.result);
        assert.equal(actual.outcome, call.outcome);
        const details = object(actual.details);
        assert(typeof actual.content === 'string');
        if (call.outcome === 'succeeded') {
          assert.deepEqual(details.content, [
            { type: 'text', text: `${call.source}:${call.input.text}` },
          ]);
          assert.deepEqual(details.structuredContent, {
            source: call.source,
            text: call.input.text,
          });
          assert(actual.content.includes(JSON.stringify(details.structuredContent)));
        } else if (call.outcome === 'failed') {
          assert.equal(details.isError, true);
          assert.deepEqual(details.content, [{ type: 'text', text: `${call.source}:rejected` }]);
          assert(actual.content.includes(`${call.source}:rejected`));
        } else {
          assert.deepEqual(details, {
            code: 'mcp_call_unconfirmed',
            remoteStopConfirmed: false,
            adapterAttempted: true,
          });
        }
        return {
          source: call.source,
          name: call.tool.model!.name,
          toolId: call.tool.id,
          version: call.tool.version,
          executionId: execution.id,
          outcome: actual.outcome,
          details,
        };
      }),
    );
    for (const source of sources) {
      const invoked = peer.requests[source.id].filter((request) => request.method === 'tools/call');
      assert.deepEqual(
        invoked.map(({ params }) => [params.name, params.arguments]),
        scenarios
          .filter((scenario) => scenario.source === source.id)
          .map((scenario) => [scenario.tool, scenario.input]),
      );
    }
    assert.deepEqual(
      peer.toolResponses,
      scenarios.map(({ source, tool, outcome }) => ({
        source,
        tool,
        httpStatus: 200,
        rpcErrorCode: outcome === 'outcome_unknown' ? -32603 : null,
        isToolError: outcome === 'failed',
      })),
      'mcp_wire_tool_responses',
    );
    const alpha = sources[0]!;
    const reads = await verifyLoopbackReads(alpha.adapter, alpha.scope, peer.requests.alpha);
    result = {
      status: 'passed',
      storeId,
      sessionId,
      originalRunId: run.id,
      commandId,
      modelRequests: model.requests.length,
      catalogues: sources.map(({ id, tools }) => ({
        source: id,
        names: tools.map((tool) => tool.model!.name),
      })),
      toolExecutions: receipts,
      wireToolResponses: peer.toolResponses,
      reads,
      wireMethods: Object.fromEntries(
        sources.map(({ id }) => [id, peer.requests[id].map(({ method }) => method)]),
      ),
    };
  } catch (error) {
    result = {
      status: 'failed',
      reason: error instanceof Error ? error.message.slice(0, 1024) : 'mcp_smoke_failed',
    };
  } finally {
    for (const dispose of close.reverse()) {
      try {
        await dispose();
      } catch {
        cleanup = 'unconfirmed';
      }
    }
    if (cleanup === 'confirmed') {
      try {
        rmSync(root, { recursive: true });
      } catch {
        cleanup = 'unconfirmed';
      }
    }
  }
  return {
    version: 1,
    ...checks,
    ...result,
    cleanup,
    ...(cleanup === 'confirmed' ? {} : { status: 'failed', reason: 'mcp_cleanup_unconfirmed' }),
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
  const output = parseUnifiedMcpSmoke(process.argv.slice(2));
  const timer = setTimeout(() => {
    const failed = {
      version: 1,
      status: 'failed',
      reason: 'mcp_global_timeout',
      cleanup: 'unconfirmed',
    };
    if (output) writeMcpEvidence(output, failed);
    console.error(JSON.stringify(failed));
    process.exit(1);
  }, 60000);
  try {
    const evidence = await runUnifiedMcpSmoke();
    if (output) writeMcpEvidence(output, evidence);
    console.log(JSON.stringify(evidence));
    if (evidence.status !== 'passed' || evidence.cleanup !== 'confirmed') process.exitCode = 1;
  } finally {
    clearTimeout(timer);
  }
}
