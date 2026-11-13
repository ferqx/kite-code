import type { ModelEvent, ModelRequest } from '@kite-ai/ai';
import { createCompatibleModelBinding, createSdkModelAdapter } from '@kite-ai/ai/sdk';
import { expect, test } from '#kite-test';
import { describeLiveModelAttemptFailure } from '../../e2e/live/model/live-model-fixture';

const secret = 'private-response https://private.invalid/token?key=fixture-secret';
const frame = (type: string, value: Record<string, unknown>) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`;
const created = frame('response.created', {
  response: { id: 'fixture-response', created_at: 1, model: 'fixture-model' },
});
const request: ModelRequest = {
  requestId: 'fixture-attempt',
  modelId: 'fixture',
  messages: [{ role: 'user', content: 'Read the fixture.' }],
  tools: [
    {
      id: 'read_fixture',
      definitionVersion: '1',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
  ],
};

for (const mode of [
  'response-failed',
  'error-event',
  'invalid-json',
  'eof',
  'connection',
] as const) {
  test(`live failure diagnostic retains only the real SDK classification: ${mode}`, async () => {
    let fetches = 0;
    const fetcher = Object.assign(async () => {
      fetches++;
      if (mode === 'connection')
        throw Object.assign(new TypeError(secret, { cause: new Error(secret) }), {
          code: 'ECONNRESET',
        });
      const body =
        mode === 'response-failed'
          ? created +
            frame('response.failed', {
              sequence_number: 1,
              response: { error: { code: 'quota', message: secret } },
            })
          : mode === 'error-event'
            ? created + frame('error', { sequence_number: 1, code: 'error', message: secret })
            : mode === 'invalid-json'
              ? 'data: not-json\n\n'
              : created;
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    }, {});
    const adapter = createSdkModelAdapter({
      models: new Map([
        [
          'fixture',
          createCompatibleModelBinding({
            baseURL: 'https://fixture.invalid/v1',
            modelId: 'fixture-model',
            protocol: 'responses',
            fetch: fetcher,
          }),
        ],
      ]),
    });
    const events: ModelEvent[] = [];
    let failure: unknown;
    try {
      for await (const event of adapter.stream(request, { signal: new AbortController().signal }))
        events.push(event);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(events.some((event) => event.type === 'finish' || event.type === 'tool_call')).toBe(
      false,
    );
    expect(fetches).toBe(1);
    const diagnostic = describeLiveModelAttemptFailure(request.requestId, events.length, failure);
    expect(diagnostic).toEqual({
      requestId: 'fixture-attempt',
      eventCount: mode === 'eof' ? 1 : 0,
      reason:
        mode === 'eof'
          ? 'stream_incomplete'
          : mode === 'connection'
            ? 'connection_failed'
            : mode === 'invalid-json'
              ? 'model_failed'
              : 'provider_unavailable',
    });
    expect(JSON.stringify(diagnostic)).not.toContain(secret);
    expect(Object.keys(diagnostic).sort()).toEqual(['eventCount', 'reason', 'requestId']);
  });
}

test('live failure diagnostic does not trust arbitrary error messages, causes or lookalike fields', () => {
  const error = Object.assign(new Error(secret, { cause: new Error(secret) }), {
    name: 'ModelAttemptError',
    reason: 'stream_incomplete',
    status: 503,
    headers: { authorization: secret },
  });
  expect(describeLiveModelAttemptFailure('fixture-attempt', 2, error)).toEqual({
    requestId: 'fixture-attempt',
    eventCount: 2,
    reason: 'model_failed',
  });
});
