import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eventsForInvalidModelToolCalls } from '@/core/controllers/model-controller';
import { buildContextProjection } from '@/core/model/context-projection';
import { createAgentKernel } from '@/core/runtime/kernel';
import { createRuntimeStore } from '@/core/runtime/store';

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

test('persists only an opaque HMAC identity for invalid provider raw arguments', () => {
  const rawSecret = '{"path":"/private/secret.txt","token":"hunter2"';
  const events = eventsForInvalidModelToolCalls(
    [
      {
        id: 'bad-private-call',
        name: 'read_file',
        args: { _raw_invalid_args: rawSecret, _parse_error: `invalid near ${rawSecret}` },
      },
    ],
    'message-private',
    0,
    'a'.repeat(64),
  );
  const serialized = JSON.stringify(events);
  expect(serialized).not.toContain('/private/secret.txt');
  expect(serialized).not.toContain('hunter2');
  expect(events[0]).toMatchObject({
    type: 'tool.queued',
    args: {
      _invalid_args_code: 'invalid_json',
      _invalid_args_redacted: true,
    },
    invocationFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  expect(JSON.stringify((events[0] as { args?: unknown }).args)).not.toMatch(/[a-f0-9]{64}/u);
});

test('keeps invalid provider raw arguments out of model/responded, event store, state, and transcript', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kite-invalid-provider-privacy-'));
  const storePath = join(dir, 'runtime.db');
  const rawSecret = '{"path":"/private/store-secret.txt","token":"store-hunter2"';
  const threadId = 'invalid-provider-store-privacy';
  try {
    const events = eventsForInvalidModelToolCalls(
      [
        {
          id: 'bad-store-call',
          name: 'read_file',
          args: { _raw_invalid_args: rawSecret, _parse_error: `private ${rawSecret}` },
        },
      ],
      'message-store-private',
      0,
      'b'.repeat(64),
    );
    const queued = events.find((event) => event.type === 'tool.queued');
    expect(queued?.type).toBe('tool.queued');
    if (queued?.type !== 'tool.queued') throw new Error('expected queued invalid call');
    const kernel = createAgentKernel({
      threadId,
      userId: 'user',
      workspace: '/workspace',
      storePath,
    });
    kernel.processEvent({
      type: 'model.responded',
      messageId: 'message-store-private',
      toolCalls: [
        {
          id: queued.toolCallId,
          name: queued.name,
          args: queued.args,
          canonicalInvocationFingerprint: queued.invocationFingerprint,
        },
      ],
    });
    kernel.processEvents(events);
    expect(JSON.stringify(kernel.getState())).not.toContain('store-secret');
    expect(JSON.stringify(kernel.getState())).not.toContain('store-hunter2');
    const providerProjection = buildContextProjection({
      role: 'agent',
      state: kernel.getState(),
      serializedTools: [],
    });
    const providerJson = JSON.stringify(providerProjection.providerMessages);
    expect(providerJson).toContain('"_invalid_args_redacted":true');
    expect(providerJson).not.toContain(queued.invocationFingerprint!);
    expect(providerJson).not.toContain(kernel.getState().toolRecovery.identityKey);
    kernel.close();

    const store = createRuntimeStore(storePath);
    const stored = JSON.stringify(store.loadEventsStrict(threadId));
    store.close();
    expect(stored).not.toContain('store-secret');
    expect(stored).not.toContain('store-hunter2');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
