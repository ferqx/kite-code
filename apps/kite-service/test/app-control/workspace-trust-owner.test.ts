import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WORKSPACE_TRUST_DECISION_REQUEST_SCHEMA_,
  WORKSPACE_TRUST_QUERY_REQUEST_SCHEMA_,
} from '@kite-ai/kite-app-contract';
import { createWorkspaceTrustOwner } from '../../src/app-control/owners/workspace-trust-owner';

describe('Workspace Trust App Control owner', () => {
  test('canonicalizes, applies revision CAS, and records only an explicit trust decision', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kite-trust-owner-'));
    const workspace = join(root, 'workspace');
    const storePath = join(root, 'workspace-trust.jsonc');
    mkdirSync(workspace);
    const owner = createWorkspaceTrustOwner({ storePath });
    const first = await owner.query({
      schema: WORKSPACE_TRUST_QUERY_REQUEST_SCHEMA_,
      workspace,
    });
    expect(first).toMatchObject({ status: 'unknown', canDecide: true });

    const conflict = await owner.decide({
      schema: WORKSPACE_TRUST_DECISION_REQUEST_SCHEMA_,
      workspace: first.workspace,
      observedStatus: first.status,
      expectedRevision: `stale-${first.revision}`,
      decision: 'trust',
      externalReadScopeDigest: first.externalReadScope.digest,
    });
    expect(conflict.outcome).toBe('conflict');

    const scopeConflict = await owner.decide({
      schema: WORKSPACE_TRUST_DECISION_REQUEST_SCHEMA_,
      workspace: first.workspace,
      observedStatus: first.status,
      expectedRevision: first.revision,
      decision: 'trust',
      externalReadScopeDigest: `sha256:${'f'.repeat(64)}`,
    });
    expect(scopeConflict.outcome).toBe('conflict');

    const recorded = await owner.decide({
      schema: WORKSPACE_TRUST_DECISION_REQUEST_SCHEMA_,
      workspace: first.workspace,
      observedStatus: first.status,
      expectedRevision: first.revision,
      decision: 'trust',
      externalReadScopeDigest: first.externalReadScope.digest,
    });
    expect(recorded).toMatchObject({ outcome: 'recorded', status: 'trusted' });
    expect(recorded.revision).not.toBe(first.revision);
  });
});
