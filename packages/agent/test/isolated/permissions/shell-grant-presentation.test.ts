import { expect, test } from 'bun:test';
import type { AuthorizationRequest } from '../../../src/extensions';
import { grantDigest, parseGrantCandidate } from '../../../src/permission-grants';
import { createShellToolBehaviors } from '../../../src/tools/shell-approval';

test('long Shell presentation remains valid without truncating exact authority', async () => {
  const behavior = createShellToolBehaviors({
    extensions: [
      {
        id: 'shell-test',
        version: '1',
        apiMajor: 1,
        tools: [
          {
            id: 'shell.execute',
            version: '1',
            description: 'test shell',
            inputSchema: { type: 'object' },
            execute: async () => {
              throw Error('not_executed');
            },
          },
        ],
      },
    ],
    snapshot: {},
    enableReview: false,
    commandDigest: (r) => grantDigest(r.input),
    prepareRiskReview: async () => null,
  })[0]!;
  const offer = async (command: string) => {
    const request: AuthorizationRequest = {
      kind: 'tool',
      runId: 'run',
      executionId: 'execution',
      definitionId: 'shell.execute',
      definitionVersion: '1',
      signal: new AbortController().signal,
      sessionId: 'session',
      input: { command, execution_timeout_ms: 240000 },
    };
    const before = { ...request, input: structuredClone(request.input) };
    const result = (await behavior.grantOffers!(request))[0]!;
    expect(request).toEqual(before);
    expect(parseGrantCandidate(result)).toEqual(result);
    expect(result.presentation.details.every((s) => s.length <= 8192)).toBe(true);
    expect(result.scope).toEqual({ commandDigest: grantDigest(request.input) });
    return result;
  };
  for (const length of [8191, 8192, 8310]) await offer('x'.repeat(length));
  const a = await offer(`${'x'.repeat(8310)}a`);
  const b = await offer(`${'x'.repeat(8310)}b`);
  expect(a.presentation).toEqual(b.presentation);
  expect(a.scopeDigest).not.toBe(b.scopeDigest);
  expect(a.scope).not.toEqual(b.scope);
});
