import { describe, expect, test } from 'bun:test';
import { createMockModelServer } from './fixtures';

async function requestModel(
  baseURL: string,
  messages: Array<Record<string, unknown>>,
): Promise<Response> {
  return fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages, stream: false }),
  });
}

describe('mock model fixture', () => {
  test('consumes configured responses once instead of wrapping the queue', async () => {
    const server = createMockModelServer();
    try {
      server.setResponses([{ message: { content: 'only response' } }]);

      const first = await fetch(`${server.baseURL}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [], stream: false }),
      });
      const second = await fetch(`${server.baseURL}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [], stream: false }),
      });

      expect(first.status).toBe(200);
      expect(second.status).toBe(500);
      expect(() => server.assertComplete()).toThrow('response queue exhausted');
    } finally {
      server.stop();
    }
  });

  test('keeps request history monotonic across response phases', async () => {
    const server = createMockModelServer();
    try {
      for (const content of ['first', 'second']) {
        server.setResponses([{ message: { content } }]);
        await fetch(`${server.baseURL}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ messages: [{ role: 'user', content }], stream: false }),
        });
      }

      expect(server.getRequestCount()).toBe(2);
      expect(server.getRequests()).toHaveLength(2);
      expect(server.hasRequestMessage('first', 0)).toBe(true);
      expect(server.hasRequestMessage('second', 1)).toBe(true);
      expect(() => server.assertComplete()).not.toThrow();
    } finally {
      server.stop();
    }
  });

  test('matches only the current user turn, not history or injected runtime state', async () => {
    const server = createMockModelServer();
    try {
      server.setResponses([{ message: { content: 'ok' } }]);
      await fetch(`${server.baseURL}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: [
            { role: 'user', content: 'historical target' },
            { role: 'assistant', content: 'old answer' },
            { role: 'user', content: 'current target' },
            {
              role: 'user',
              content: '<runtime-state source="runtime.kernel">injected policy</runtime-state>',
            },
          ],
          stream: false,
        }),
      });

      expect(server.hasRequestMessage('historical target', 0)).toBe(false);
      expect(server.hasRequestMessage('current target', 0)).toBe(true);
      expect(() => server.assertComplete()).not.toThrow();
    } finally {
      server.stop();
    }
  });

  test('rejects phase replacement and teardown while configured responses remain', () => {
    const server = createMockModelServer();
    try {
      server.setResponses([{ message: { content: 'must be consumed' } }]);
      expect(() => server.setResponses([])).toThrow('unconsumed response');
      expect(() => server.assertComplete()).toThrow('were unconsumed');
    } finally {
      server.stop();
    }
  });

  test('accepts a matching tool result in the continuation request', async () => {
    const server = createMockModelServer();
    try {
      server.setResponses([
        {
          message: {
            tool_calls: [{ id: 'call_1', name: 'read_file', args: { path: 'README.md' } }],
          },
        },
        {
          expectedRequest: {
            toolResults: [{ toolCallId: 'call_1', contentIncludes: ['fixture marker'] }],
          },
          message: { content: 'continued' },
        },
      ]);

      expect(
        await requestModel(server.baseURL, [{ role: 'user', content: 'read the file' }]),
      ).toHaveProperty('status', 200);
      expect(
        await requestModel(server.baseURL, [
          { role: 'assistant', content: '', tool_calls: [{ id: 'call_1' }] },
          {
            role: 'tool',
            tool_call_id: 'call_1',
            content: '{"output":"fixture marker"}',
          },
        ]),
      ).toHaveProperty('status', 200);
      expect(() => server.assertComplete()).not.toThrow();
    } finally {
      server.stop();
    }
  });

  test('rejects a tool continuation without an explicit outcome contract', async () => {
    const server = createMockModelServer();
    try {
      server.setResponses([
        {
          message: {
            tool_calls: [{ id: 'call_unchecked', name: 'read_file', args: { path: 'x.txt' } }],
          },
        },
        { message: { content: 'unchecked success claim' } },
      ]);
      await fetch(`${server.baseURL}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'read x' }], stream: false }),
      });
      const response = await fetch(`${server.baseURL}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'tool', tool_call_id: 'call_unchecked', content: 'missing' }],
          stream: false,
        }),
      });

      expect(response.status).toBe(422);
      expect(await response.text()).toContain('without an expectedRequest.toolResults outcome');
      expect(() => server.assertComplete()).toThrow('without an expectedRequest.toolResults');
    } finally {
      server.stop();
    }
  });

  test('keeps a missing tool result unresolved across interleaved model requests', async () => {
    const server = createMockModelServer();
    try {
      server.setResponses([
        {
          message: {
            tool_calls: [{ id: 'call_missing', name: 'read_file', args: { path: 'README.md' } }],
          },
        },
        { message: { content: 'must not be served' } },
      ]);

      await requestModel(server.baseURL, [{ role: 'user', content: 'read the file' }]);
      const interleavedRequest = await requestModel(server.baseURL, [
        { role: 'user', content: 'unrelated next turn' },
      ]);

      expect(interleavedRequest.status).toBe(200);
      expect(() => server.assertComplete()).toThrow('tool result(s) are still pending');
    } finally {
      server.stop();
    }
  });

  test('refuses a canned success response when the actual tool result misses its marker', async () => {
    const server = createMockModelServer();
    try {
      server.setResponses([
        {
          message: {
            tool_calls: [
              { id: 'call_failed', name: 'shell_execute', args: { command: 'echo marker' } },
            ],
          },
        },
        {
          expectedRequest: {
            toolResults: [
              { toolCallId: 'call_failed', contentIncludes: ['EXPECTED_SUCCESS_MARKER'] },
            ],
          },
          message: { content: 'must not be served' },
        },
      ]);

      await requestModel(server.baseURL, [{ role: 'user', content: 'run the command' }]);
      const rejected = await requestModel(server.baseURL, [
        {
          role: 'tool',
          tool_call_id: 'call_failed',
          content: 'sandbox_apply: Operation not permitted',
        },
      ]);

      expect(rejected.status).toBe(422);
      expect(await rejected.text()).toContain('does not include');
      expect(() => server.assertComplete()).toThrow('request contract violation');
    } finally {
      server.stop();
    }
  });

  test('reports an unresolved tool call at teardown unless the turn is explicitly aborted', async () => {
    const server = createMockModelServer();
    try {
      server.setResponses([
        {
          message: {
            tool_calls: [{ id: 'call_pending', name: 'read_file', args: { path: 'README.md' } }],
          },
        },
      ]);
      await requestModel(server.baseURL, [{ role: 'user', content: 'read the file' }]);
      expect(() => server.assertComplete()).toThrow('tool result(s) are still pending');
    } finally {
      server.stop();
    }

    const abortedServer = createMockModelServer();
    try {
      abortedServer.setResponses([
        {
          toolContinuation: 'aborted',
          message: {
            tool_calls: [
              { id: 'call_denied', name: 'shell_execute', args: { command: 'echo no' } },
            ],
          },
        },
      ]);
      await requestModel(abortedServer.baseURL, [{ role: 'user', content: 'deny it' }]);
      expect(() => abortedServer.assertComplete()).not.toThrow();
    } finally {
      abortedServer.stop();
    }
  });
});
