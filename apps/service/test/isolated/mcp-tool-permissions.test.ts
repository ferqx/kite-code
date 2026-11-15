import { expect, test } from 'bun:test';
import type { AuthorizationRequest } from '@kite-ai/agent/extensions';
import {
  type CapabilityDescription,
  createPermissionPolicy,
  intersectPermissionPolicies,
  type PermissionMode,
} from '@kite-ai/agent/permissions';
import { mcpToolPermissionDescription } from '../../src/mcp-tool-permissions';

const identity = {
  kind: 'tool' as const,
  definitionId: 'mcp.remote.read',
  definitionVersion: 'catalogue-1',
};
const request: AuthorizationRequest = {
  ...identity,
  sessionId: 's',
  runId: 'r',
  executionId: 'e',
  input: { path: '/test' },
  signal: new AbortController().signal,
};
const readonlyDescription: CapabilityDescription = {
  ...identity,
  revision: 'host',
  hardAllowed: true,
  safeRead: true,
  effects: ['read'],
  autoReview: 'none',
};
function policy(mode: PermissionMode, description = readonlyDescription, trusted = true) {
  return createPermissionPolicy({
    readPolicy: () => ({ mode, workspaceTrust: trusted, revision: 'p', allowed: [identity] }),
    describeCapability: () => mcpToolPermissionDescription(description),
  });
}
test('all MCP calls including trusted readonly catalogue tools require human in workspace mode', async () => {
  for (const definitionId of [
    'mcp.remote.read',
    'mcp.tools.search',
    'mcp.sources.list',
    'mcp.connect',
    'mcp.resources.read',
  ]) {
    const description = { ...readonlyDescription, definitionId };
    const capability = mcpToolPermissionDescription(description);
    expect(capability.safeRead).toBe(false);
    const decision = await createPermissionPolicy({
      readPolicy: () => ({
        mode: 'accept_edits',
        workspaceTrust: true,
        revision: 'p',
        allowed: [description],
      }),
      describeCapability: () => capability,
    }).authorize({ ...request, definitionId });
    expect(decision.allowed).toBe(false);
    expect(decision.approval).toBeDefined();
    expect(decision.check).toBeUndefined();
  }
});
test('Auto ignores safe-read/default-host exemption and requests fail-closed bounded model review', async () => {
  const decision = await policy('auto').authorize(request);
  expect(decision.allowed).toBe(false);
  expect(decision.check).toMatchObject({ stopOnTimeout: true });
  expect(decision.check?.timeoutScope).toBeUndefined();
});
test('Full allows only the effective trusted capability; parent workspace mode still asks', async () => {
  expect((await policy('full').authorize(request)).allowed).toBe(true);
  const decision = await intersectPermissionPolicies(
    policy('full'),
    policy('accept_edits'),
  ).authorize(request);
  expect(decision.allowed).toBe(false);
  expect(decision.approval).toBeDefined();
  expect(
    (await policy('full', { ...readonlyDescription, hardAllowed: false }).authorize(request))
      .allowed,
  ).toBe(false);
  expect((await policy('full', readonlyDescription, false).authorize(request)).allowed).toBe(false);
});
test('MCP policy leaves connection jobs/settings untouched and rejects cancelled checks', async () => {
  const job = { ...readonlyDescription, kind: 'job' as const };
  expect(mcpToolPermissionDescription(job)).toBe(job);
  const controller = new AbortController();
  controller.abort();
  await expect(
    policy('auto').authorize({ ...request, signal: controller.signal }),
  ).rejects.toBeDefined();
});

test('parent Auto review cannot be erased by a Full child and stale target revision changes authorization', async () => {
  for (const policies of [
    [policy('auto'), policy('full')],
    [policy('full'), policy('auto')],
  ] as const) {
    const decision = await intersectPermissionPolicies(...policies).authorize(request);
    expect(decision.allowed).toBe(false);
    expect(decision.check?.stopOnTimeout).toBe(true);
  }
  const before = await policy('auto').authorize(request);
  const after = await policy('auto', {
    ...readonlyDescription,
    revision: 'changed-catalogue',
  }).authorize(request);
  expect(after.revision).not.toBe(before.revision);
});
