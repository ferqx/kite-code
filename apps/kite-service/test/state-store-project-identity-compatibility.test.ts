import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import {
  createInitialAgentState,
  encodeCurrentAgentStateJson,
  LEGACY_STATE26_FORMAT_EPOCH,
  LEGACY_STATE26_SCHEMA_VERSION,
  RUNTIME_STATE_FORMAT_EPOCH,
  RUNTIME_STATE_SCHEMA_VERSION,
} from '@kite-ai/agent-kernel';
import { canonicalPathForComparison } from '@kite-ai/builtin-runtime/sandbox';
import {
  createRuntimeHostStateStorageBinding,
  resolveProjectIdentity,
} from '@kite-ai/runtime-host';
import type { SqliteRuntimeCompatibilitySession } from '@kite-ai/runtime-storage-sqlite';
import { createKiteRuntimeCompatibilityMigrator } from '../src/bootstrap/runtime/state-store-compatibility';

const RECOVERY_KEY = 'a'.repeat(64);

function digestFor(workspace: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(canonicalPathForComparison(workspace)).digest('hex')}`;
}

function legacyStateJson(input: {
  readonly sessionId: string;
  readonly workspace: string;
  readonly projectId: string;
  readonly workspaceDigest: string;
}): string {
  const current = createInitialAgentState({
    threadId: input.sessionId,
    userId: 'user-1',
    workspace: input.workspace,
    projectId: input.projectId,
    canonicalWorkspaceDigest: input.workspaceDigest,
    turnId: 'turn-1',
    recoveryIdentityKey: RECOVERY_KEY,
    interactionMode: 'accept_edits',
  });
  const legacy = JSON.parse(encodeCurrentAgentStateJson(current)) as Record<string, unknown>;
  legacy.schemaVersion = LEGACY_STATE26_SCHEMA_VERSION;
  legacy.formatEpoch = LEGACY_STATE26_FORMAT_EPOCH;
  delete legacy.interactionModeRevision;
  delete legacy.pendingApprovals;
  delete legacy.activeApprovalId;
  delete legacy.nextQueueSequence;
  delete legacy.approvalGeneration;
  delete legacy.sessionCommandGrants;
  delete legacy.approvalReceipts;
  return JSON.stringify(legacy);
}

function compatibilitySession(input: {
  readonly sessionId: string;
  readonly workspace: string;
  readonly projectId: string;
  readonly workspaceDigest: string;
  readonly stateProjectId?: string;
  readonly namedSnapshot?: string;
}): SqliteRuntimeCompatibilitySession {
  const stateJson = legacyStateJson({
    ...input,
    projectId: input.stateProjectId ?? input.projectId,
  });
  return {
    session: {
      sessionId: input.sessionId,
      projectId: input.projectId,
      workspaceDigest: input.workspaceDigest,
      stateSchemaVersion: LEGACY_STATE26_SCHEMA_VERSION,
      formatEpoch: LEGACY_STATE26_FORMAT_EPOCH,
      revision: 0,
      name: 'legacy session',
      updatedAt: 1,
      modelProvider: null,
      modelName: null,
    },
    snapshot: {
      schemaVersion: LEGACY_STATE26_SCHEMA_VERSION,
      formatEpoch: LEGACY_STATE26_FORMAT_EPOCH,
      revision: 0,
      stateJson,
      eventPosition: 0,
      stateChecksum: '',
      createdAt: 1,
    },
    events: [],
    namedSnapshots:
      input.namedSnapshot === undefined
        ? []
        : [
            {
              name: 'turn-1',
              schemaVersion: LEGACY_STATE26_SCHEMA_VERSION,
              formatEpoch: LEGACY_STATE26_FORMAT_EPOCH,
              revision: 0,
              stateJson: input.namedSnapshot,
              eventPosition: 0,
              stateChecksum: '',
              createdAt: 1,
            },
          ],
    filePreimages: [],
  };
}

describe('State 26 persisted Project identity compatibility', () => {
  test('maps a proven legacy identity and named snapshot to coordinator-compatible identity', () => {
    const root = mkdtempSync(join(process.cwd(), '.kite-state26-identity-'));
    const workspace = join(root, 'historical-workspace');
    mkdirSync(workspace);
    const digest = digestFor(workspace);
    const projectIdentity = resolveProjectIdentity(workspace);
    const legacyProjectId = 'project-legacy-1';
    const migrated = createKiteRuntimeCompatibilityMigrator(
      createRuntimeHostStateStorageBinding().codec,
    )(
      compatibilitySession({
        sessionId: 'legacy-identity-session',
        workspace,
        projectId: legacyProjectId,
        workspaceDigest: digest,
        namedSnapshot: legacyStateJson({
          sessionId: 'legacy-identity-session',
          workspace,
          projectId: legacyProjectId,
          workspaceDigest: digest,
        }),
      }),
      {
        storeSchemaVersion: 5,
        stateSchemaVersion: LEGACY_STATE26_SCHEMA_VERSION,
        formatEpoch: LEGACY_STATE26_FORMAT_EPOCH,
      },
    );
    try {
      expect(migrated).not.toBeNull();
      if (!migrated) return;
      expect(migrated.projectId).toBe(projectIdentity.projectId);
      expect(migrated.workspaceDigest).toBe(digest);
      const state = JSON.parse(migrated.stateJson) as {
        session: { projectId: string; workspace: string; canonicalWorkspaceDigest: string };
      };
      expect(state.session).toMatchObject({
        projectId: projectIdentity.projectId,
        workspace,
        canonicalWorkspaceDigest: digest,
      });
      const named = JSON.parse(migrated.namedSnapshots?.[0]?.stateJson ?? '{}') as {
        session?: { projectId?: string };
      };
      expect(named.session?.projectId).toBe(projectIdentity.projectId);
      expect(isAbsolute(state.session.workspace)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.each([
    ['relative workspace', 'relative/workspace', `sha256:${'0'.repeat(64)}`],
    ['digest drift', '/tmp/state26-identity', `sha256:${'0'.repeat(64)}`],
  ])('rejects %s instead of inventing Project identity', (_name, workspace, digest) => {
    const projectId = 'project-legacy-invalid';
    const result = createKiteRuntimeCompatibilityMigrator(
      createRuntimeHostStateStorageBinding().codec,
    )(
      compatibilitySession({
        sessionId: `invalid-${_name}`,
        workspace,
        projectId,
        workspaceDigest: digest,
      }),
      {
        storeSchemaVersion: 5,
        stateSchemaVersion: LEGACY_STATE26_SCHEMA_VERSION,
        formatEpoch: LEGACY_STATE26_FORMAT_EPOCH,
      },
    );
    expect(result).toBeNull();
  });

  test('accepts a symlinked historical workspace only through its canonical identity', () => {
    const root = mkdtempSync(join(process.cwd(), '.kite-state26-identity-symlink-'));
    const target = join(root, 'target');
    const alias = join(root, 'alias');
    mkdirSync(target);
    symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const identity = resolveProjectIdentity(alias);
    try {
      const result = createKiteRuntimeCompatibilityMigrator(
        createRuntimeHostStateStorageBinding().codec,
      )(
        compatibilitySession({
          sessionId: 'symlink-identity',
          workspace: alias,
          projectId: 'legacy-symlink-project',
          workspaceDigest: identity.workspaceDigest,
        }),
        {
          storeSchemaVersion: 5,
          stateSchemaVersion: LEGACY_STATE26_SCHEMA_VERSION,
          formatEpoch: LEGACY_STATE26_FORMAT_EPOCH,
        },
      );
      expect(result?.projectId).toBe(identity.projectId);
      expect(JSON.parse(result?.stateJson ?? '{}').session.workspace).toBe(alias);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects a removed historical workspace even when its old digest once matched', () => {
    const root = mkdtempSync(join(process.cwd(), '.kite-state26-identity-removed-'));
    const workspace = join(root, 'removed');
    mkdirSync(workspace);
    const digest = digestFor(workspace);
    rmSync(workspace, { recursive: true, force: true });
    try {
      const result = createKiteRuntimeCompatibilityMigrator(
        createRuntimeHostStateStorageBinding().codec,
      )(
        compatibilitySession({
          sessionId: 'removed-identity',
          workspace,
          projectId: 'legacy-removed-project',
          workspaceDigest: digest,
        }),
        {
          storeSchemaVersion: 5,
          stateSchemaVersion: LEGACY_STATE26_SCHEMA_VERSION,
          formatEpoch: LEGACY_STATE26_FORMAT_EPOCH,
        },
      );
      expect(result).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects a source row whose identity differs from decoded State 26', () => {
    const root = mkdtempSync(join(process.cwd(), '.kite-state26-identity-row-'));
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const digest = digestFor(workspace);
    try {
      const result = createKiteRuntimeCompatibilityMigrator(
        createRuntimeHostStateStorageBinding().codec,
      )(
        compatibilitySession({
          sessionId: 'row-mismatch',
          workspace,
          projectId: 'row-project',
          stateProjectId: 'state-project',
          workspaceDigest: digest,
        }),
        {
          storeSchemaVersion: 5,
          stateSchemaVersion: LEGACY_STATE26_SCHEMA_VERSION,
          formatEpoch: LEGACY_STATE26_FORMAT_EPOCH,
        },
      );
      expect(result).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects missing legacy Project identity evidence', () => {
    const root = mkdtempSync(join(process.cwd(), '.kite-state26-identity-missing-'));
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const digest = digestFor(workspace);
    try {
      const result = createKiteRuntimeCompatibilityMigrator(
        createRuntimeHostStateStorageBinding().codec,
      )(
        compatibilitySession({
          sessionId: 'missing-project-identity',
          workspace,
          projectId: '',
          workspaceDigest: digest,
        }),
        {
          storeSchemaVersion: 5,
          stateSchemaVersion: LEGACY_STATE26_SCHEMA_VERSION,
          formatEpoch: LEGACY_STATE26_FORMAT_EPOCH,
        },
      );
      expect(result).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects mixed snapshot metadata instead of widening the State 26 profile', () => {
    const root = mkdtempSync(join(process.cwd(), '.kite-state26-identity-mixed-'));
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const digest = digestFor(workspace);
    try {
      const input = compatibilitySession({
        sessionId: 'mixed-profile',
        workspace,
        projectId: 'legacy-mixed-project',
        workspaceDigest: digest,
      });
      const result = createKiteRuntimeCompatibilityMigrator(
        createRuntimeHostStateStorageBinding().codec,
      )(
        {
          ...input,
          snapshot: {
            ...input.snapshot,
            schemaVersion: RUNTIME_STATE_SCHEMA_VERSION,
            formatEpoch: RUNTIME_STATE_FORMAT_EPOCH,
          },
        },
        {
          storeSchemaVersion: 5,
          stateSchemaVersion: LEGACY_STATE26_SCHEMA_VERSION,
          formatEpoch: LEGACY_STATE26_FORMAT_EPOCH,
        },
      );
      expect(result).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('does not rewrite a current State 27 project identity', () => {
    const state = createInitialAgentState({
      threadId: 'current-identity-session',
      userId: 'user-1',
      workspace: 'relative/current-workspace',
      projectId: 'project-legacy-current',
      canonicalWorkspaceDigest: `sha256:${'b'.repeat(64)}`,
      turnId: 'turn-current',
      recoveryIdentityKey: RECOVERY_KEY,
      interactionMode: 'accept_edits',
    });
    const input: SqliteRuntimeCompatibilitySession = {
      session: {
        sessionId: state.session.threadId,
        projectId: state.session.projectId!,
        workspaceDigest: state.session.canonicalWorkspaceDigest!,
        stateSchemaVersion: RUNTIME_STATE_SCHEMA_VERSION,
        formatEpoch: RUNTIME_STATE_FORMAT_EPOCH,
        revision: 0,
        name: 'current session',
        updatedAt: 1,
        modelProvider: null,
        modelName: null,
      },
      snapshot: {
        schemaVersion: RUNTIME_STATE_SCHEMA_VERSION,
        formatEpoch: RUNTIME_STATE_FORMAT_EPOCH,
        revision: 0,
        stateJson: encodeCurrentAgentStateJson(state),
        eventPosition: 0,
        stateChecksum: '',
        createdAt: 1,
      },
      events: [],
      namedSnapshots: [],
      filePreimages: [],
    };
    const result = createKiteRuntimeCompatibilityMigrator(
      createRuntimeHostStateStorageBinding().codec,
    )(input, {
      storeSchemaVersion: 5,
      stateSchemaVersion: RUNTIME_STATE_SCHEMA_VERSION,
      formatEpoch: RUNTIME_STATE_FORMAT_EPOCH,
    });
    expect(result).not.toBeNull();
    expect(JSON.parse(result!.stateJson).session.projectId).toBe('project-legacy-current');
  });
});
