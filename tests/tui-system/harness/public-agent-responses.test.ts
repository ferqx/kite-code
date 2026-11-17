import { expect, test } from 'bun:test';
import { createTaskExtension } from '@kite-ai/agent/task';
import { createModelToolSurface } from '../../../packages/agent/src/model-tools';
import type { MockChatRequest, MockResponse } from './fixtures';
import { publicAgentResponses } from './public-agent-responses';
import { createTestWorkspace } from './test-workspace';

const runtime = {
  role: 'user',
  content: '<runtime-state source="runtime.kernel">\nrun: parent-run\n',
};
const request = (messages: MockChatRequest['messages']): MockChatRequest => ({
  body: {},
  messages,
});
const spawn: MockResponse = {
  message: {
    tool_calls: [
      { id: 'spawn-a', name: 'spawn_agent', args: { prompt: 'Read A', preset: 'explore' } },
      { id: 'spawn-b', name: 'spawn_agent', args: { prompt: 'Read B', preset: 'general' } },
    ],
  },
};
const receipts = ['a', 'b'].map((id) => ({
  role: 'tool',
  tool_call_id: `spawn-${id}`,
  content: JSON.stringify({
    accepted: true,
    agent_id: `child-${id}`,
    work_ref: `aw_soriginal_${id}`,
  }),
}));

test('public collaboration waits on exactly the original admitted work references through the current model schema', async () => {
  const workspace = createTestWorkspace();
  try {
    const responses = publicAgentResponses(workspace, [spawn]);
    await responses[0]!.response!(request([runtime]));
    const wait = await responses[1]!.response!(request([runtime, ...receipts]));
    const call = wait.message!.tool_calls![0]!;
    expect(call).toEqual({
      id: 'observe-spawn-a',
      name: 'wait_agent_events',
      args: { work_refs: ['aw_soriginal_a', 'aw_soriginal_b'], wait_ms: 30_000 },
    });
    expect(wait.toolContinuation).toBe('aborted');
    const tool = createTaskExtension({
      roles: [{ id: 'general', configurationId: 'fixture', description: 'Fixture metadata' }],
    }).tools!.find((candidate) => candidate.id === 'task.events')!;
    const surface = createModelToolSurface(
      {
        modelId: 'fixture',
        requestId: 'original',
        messages: [],
        tools: [{ id: tool.id, definitionVersion: tool.version, inputSchema: tool.inputSchema }],
      },
      new Map([[tool.id, tool]]),
    );
    const decoded = surface.decode({
      id: call.id,
      name: call.name,
      arguments: JSON.stringify(call.args),
    });
    expect(decoded.model?.error).toBeUndefined();
    expect(JSON.parse(decoded.arguments)).toEqual({
      workRefs: ['aw_soriginal_a', 'aw_soriginal_b'],
      waitMs: 30_000,
    });
    expect(
      surface.decode({
        id: call.id,
        name: call.name,
        arguments: JSON.stringify({ after_seq: '0', wait_ms: 30_000 }),
      }).model?.error,
    ).toBeDefined();
  } finally {
    workspace.cleanup();
  }
});

test('public collaboration rejects absent or duplicate original work references and invalid wait receipts', async () => {
  const workspace = createTestWorkspace();
  try {
    for (const invalid of [
      { accepted: true, agent_id: 'child-a' },
      { accepted: true, agent_id: 'child-a', work_ref: 'aw_soriginal_b' },
    ]) {
      const responses = publicAgentResponses(workspace, [spawn]);
      await responses[0]!.response!(request([runtime]));
      await expect(
        responses[1]!.response!(
          request([runtime, { ...receipts[0]!, content: JSON.stringify(invalid) }, receipts[1]!]),
        ),
      ).rejects.toThrow(/public_agent_fixture_(spawn_not_accepted|duplicate_work_reference)/);
    }
    for (const content of ['The arguments do not match the tool schema.', '{}']) {
      const responses = publicAgentResponses(workspace, [spawn]);
      await responses[0]!.response!(request([runtime]));
      await expect(
        responses[1]!.response!(
          request([
            runtime,
            ...receipts,
            { role: 'tool', tool_call_id: 'observe-spawn-a', content },
          ]),
        ),
      ).rejects.toThrow();
    }
  } finally {
    workspace.cleanup();
  }
});
