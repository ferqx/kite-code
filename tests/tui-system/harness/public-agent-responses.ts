import { Database } from 'bun:sqlite';
import type { MockChatRequest, MockResponse } from './fixtures';
import type { TestWorkspace } from './test-workspace';

/** Route real parent coordination independently of concurrent child Model requests. */
export function publicAgentResponses(
  workspace: TestWorkspace,
  script: MockResponse[],
  outcome: 'succeeded' | 'cancelled' = 'succeeded',
): MockResponse[] {
  const spawns = script.flatMap((response) =>
    (response.message?.tool_calls ?? []).filter((call) => call.name === 'spawn_agent'),
  );
  if (!spawns.length) throw Error('public_agent_fixture_has_no_spawn');
  const spawnIds = new Set(spawns.map((call) => call.id));
  const final = script.find((response) =>
    response.expectedRequest?.toolResults?.some((result) => spawnIds.has(result.toolCallId)),
  );
  const work = script.filter((response) => response !== final);
  let cursor = 0;
  let parentRun: string | undefined;
  const waitId = `observe-${spawns[0]!.id}`;
  const listId = `directory-${spawns[0]!.id}`;
  const requiredResults = (request: MockChatRequest) =>
    request.messages
      .filter((message) => message.role === 'tool' && message.tool_call_id)
      .map((message) => ({ toolCallId: message.tool_call_id! }));
  const tool = (request: MockChatRequest, id: string) =>
    request.messages.find((message) => message.role === 'tool' && message.tool_call_id === id);
  const parsed = (content: unknown): Record<string, unknown> => {
    const value: unknown = JSON.parse(String(content));
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw Error('public_agent_fixture_invalid_receipt');
    return value as Record<string, unknown>;
  };
  const resolve = async (request: MockChatRequest): Promise<MockResponse> => {
    const runtime = request.messages
      .filter((message) => message.role === 'user')
      .map((message) => String(message.content))
      .filter((content) => content.startsWith('<runtime-state source="runtime.kernel">'))
      .at(-1);
    const run = runtime && /^run: ([^\n]+)$/m.exec(runtime)?.[1];
    const receipts = spawns.map((spawn) => tool(request, spawn.id));
    if (!run && receipts.some(Boolean)) throw Error('public_agent_fixture_runtime_scope_missing');
    if (run && run === parentRun && receipts.some(Boolean)) {
      if (!receipts.every(Boolean)) throw Error('public_agent_fixture_partial_spawn_receipts');
      const agentIds = receipts.map((receipt) => {
        const value = parsed(receipt!.content);
        if (value.accepted !== true || typeof value.agent_id !== 'string')
          throw Error('public_agent_fixture_spawn_not_accepted');
        return value.agent_id;
      });
      if (new Set(agentIds).size !== spawns.length)
        throw Error('public_agent_fixture_duplicate_child_identity');
      if (tool(request, listId)) {
        if (!final) throw Error('cancelled_public_agent_fixture_continued');
        const directory = parsed(tool(request, listId)!.content);
        const items = directory.items as Array<Record<string, unknown>> | undefined;
        if (
          !items ||
          items.length !== agentIds.length ||
          items.some(
            (item) =>
              !agentIds.includes(String(item.agent_id)) ||
              item.state !== 'idle' ||
              item.last_outcome !== outcome ||
              !item.last_result_source,
          )
        )
          throw Error('public_agent_fixture_directory_not_complete');
        const expected = final.expectedRequest!.toolResults!.flatMap(
          (result) => result.contentIncludes ?? [],
        );
        return {
          ...final,
          expectedRequest: {
            toolResults: [
              ...requiredResults(request).filter((result) => result.toolCallId !== listId),
              {
                toolCallId: listId,
                contentIncludes: [...new Set(['last_result_source', ...agentIds, ...expected])],
              },
            ],
          },
        };
      }
      if (tool(request, waitId)) {
        // One event can precede a sibling's completion. Gate this synthetic Model
        // response on the real original carriers, then read every complete public
        // result; no child output or completion is manufactured by this fixture.
        const deadline = Date.now() + 30_000;
        while (true) {
          using database = new Database(workspace.databasePath, { readonly: true });
          const carriers = agentIds.map((id) =>
            database
              .query<{ state: string; call_id: string }, [string]>(
                `SELECT c.state,p.call_id FROM execution c
                 JOIN execution p ON p.id=c.parent_execution_id
                 WHERE c.child_session_id=? AND c.kind='job'`,
              )
              .get(id),
          );
          if (carriers.every((carrier) => carrier?.state === outcome)) {
            if (carriers.some((carrier) => !spawnIds.has(carrier!.call_id)))
              throw Error('public_agent_fixture_carrier_identity_mismatch');
            break;
          }
          if (Date.now() >= deadline) throw Error('public_agent_fixture_child_completion_deadline');
          await Bun.sleep(5);
        }
        return {
          expectedRequest: { toolResults: requiredResults(request) },
          message: {
            tool_calls: [{ id: listId, name: 'list_agents', args: { agent_ids: agentIds } }],
          },
        };
      }
      return {
        expectedRequest: {
          toolResults: receipts.map((receipt) => ({
            toolCallId: receipt!.tool_call_id!,
            contentIncludes: ['"accepted":true', 'agent_id'],
          })),
        },
        ...(!final ? { toolContinuation: 'aborted' as const } : {}),
        message: {
          tool_calls: [
            {
              id: waitId,
              name: 'wait_agent_events',
              args: { after_seq: '0', wait_ms: 30_000 },
            },
          ],
        },
      };
    }
    const next = work[cursor++];
    if (!next) throw Error('public_agent_fixture_child_script_exhausted');
    const response = next.response ? await next.response(request) : next;
    if (response.message?.tool_calls?.some((call) => call.name === 'spawn_agent')) {
      if (!run) throw Error('public_agent_fixture_runtime_scope_missing');
      parentRun = run;
      return { ...response, toolContinuation: 'required' };
    }
    return response;
  };
  return Array.from({ length: script.length + (final ? 2 : 1) }, () => ({ response: resolve }));
}
