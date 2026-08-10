import { expect, test } from 'bun:test';
import { eventsForInvalidModelToolCalls } from '@/core/controllers/model-controller';

test('classifies invalid model tool arguments before tool execution', () => {
  const events = eventsForInvalidModelToolCalls(
    [{ id: 'bad-call', name: 'read_file', args: { _parse_error: 'invalid JSON' } }],
    'message-1',
    0,
  );
  expect(events).toContainEqual(
    expect.objectContaining({
      type: 'tool.failed',
      toolCallId: 'bad-call',
      failure: expect.objectContaining({ kind: 'model_invalid_tool_args' }),
    }),
  );
});

test('legacy recovery rejects a malformed undeclared tool before argument classification', () => {
  const events = eventsForInvalidModelToolCalls(
    [{ id: 'bad-shell', name: 'shell_execute', args: { _parse_error: 'invalid JSON' } }],
    'message-1',
    0,
    'legacy_plan_recovery',
  );
  expect(events).toContainEqual(
    expect.objectContaining({
      type: 'tool.rejected',
      toolCallId: 'bad-shell',
      reason: 'legacy_plan_replan_required',
      failure: expect.objectContaining({ kind: 'mandatory_policy_unavailable' }),
    }),
  );
  expect(events.some((event) => event.type === 'tool.failed')).toBe(false);
});

test('legacy recovery preserves invalid-argument classification for allowed plan tools', () => {
  const events = eventsForInvalidModelToolCalls(
    [{ id: 'bad-write-plan', name: 'write_plan', args: { _parse_error: 'invalid JSON' } }],
    'message-1',
    0,
    'legacy_plan_recovery',
  );
  expect(events).toContainEqual(
    expect.objectContaining({
      type: 'tool.failed',
      toolCallId: 'bad-write-plan',
      failure: expect.objectContaining({ kind: 'model_invalid_tool_args' }),
    }),
  );
});
