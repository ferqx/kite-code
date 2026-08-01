import { describe, expect, test } from 'bun:test';
import { createMockModelServer } from './fixtures';

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
      expect(server.hasRequestMessage('first')).toBe(true);
      expect(server.hasRequestMessage('second', 1)).toBe(true);
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
});
