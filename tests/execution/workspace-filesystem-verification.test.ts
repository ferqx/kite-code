import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSnapshot, digestCapability } from '@/core/capabilities/catalog';
import { getFeatureFlags } from '@/core/config/features';
import {
  admitAuthorizedToolInvocationV1,
  authorizePolicyEvaluatedToolV1,
  classifyValidatedToolInvocationV1,
  commitNormalizedToolReceiptV1,
  createToolCallSnapshotV1,
  dispatchAdmittedToolInvocationV1,
  evaluateClassifiedToolPolicyV1,
  filesystemObservationFromCapabilityResultV1,
  normalizeDispatchedToolOutcomeV1,
  planCommittedToolVerificationV1,
  resolveToolInvocationV1,
  validateResolvedToolInvocationV1,
} from '@/core/execution/tool-pipeline';
import { reduceRuntimeState } from '@/core/runtime/reducer';
import { createInitialRuntimeState } from '@/core/runtime/state';
import { testWorkspaceFilesystemRuntimeV1 } from '../helpers/runtime-model';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Workspace filesystem receipt-backed verification', () => {
  test('write_file observation is Artifact-covered and plans required verification', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kite-filesystem-verification-'));
    roots.push(workspace);
    const snapshot = createToolCallSnapshotV1({
      toolCallId: 'write-call',
      name: 'write_file',
      rawArguments: { path: 'src/result.ts', content: 'export const result = 1;\n' },
      createdAtTurnId: 'turn-1',
    });
    if (!snapshot.ok) throw new Error(snapshot.failure.code);
    const resolved = resolveToolInvocationV1(snapshot.value, {
      currentTurnId: 'turn-1',
      catalogRevision: createSnapshot([]).revision,
      availabilityContext: {
        workspace,
        phase: 'building',
        hasTaskAdapter: true,
        availableSkillIds: [],
        featureFlags: getFeatureFlags(),
      },
      bindings: [],
      descriptors: [],
      disclosures: [],
    });
    if (!resolved.ok) throw new Error(resolved.failure.code);
    const validated = validateResolvedToolInvocationV1(resolved.value);
    if (!validated.ok) throw new Error(validated.failure.code);
    const classified = classifyValidatedToolInvocationV1(validated.value);
    if (!classified.ok) throw new Error(classified.failure.code);
    const policyContext = {
      phase: 'building' as const,
      workspace,
      threadId: 'thread-1',
      authorization: { mode: 'default' as const, commandGrants: {} },
      interactionMode: 'accept_edits' as const,
      planKind: 'building_without_plan' as const,
      circuitBreakerTripped: false,
      callStatus: 'queued' as const,
      gates: {
        recoveryAdmission: 'admitted' as const,
        boundedCancellation: 'admitted' as const,
        executionBoundary: 'admitted' as const,
        skillCapabilityCeiling: 'admitted' as const,
      },
    };
    const policy = evaluateClassifiedToolPolicyV1(classified.value, policyContext);
    if (policy.kind !== 'continue') throw new Error(policy.terminal.kind);
    const authorization = authorizePolicyEvaluatedToolV1(policy.value, policyContext);
    if (authorization.kind !== 'continue') throw new Error(authorization.terminal.kind);
    const admission = admitAuthorizedToolInvocationV1(authorization.value, {
      reservationRequired: false,
      reservationIds: [],
      freshness: 'current',
    });
    if (admission.kind !== 'continue') throw new Error(admission.terminal.kind);

    let state = createInitialRuntimeState({
      threadId: 'thread-1',
      userId: 'test',
      workspace,
    });
    const forgedObservation = Object.freeze({
      actorIdentityDigest: digestCapability({ actor: 'parent' }),
      lexicalTargetDigest: `sha256:${'1'.repeat(64)}`,
      canonicalTargetDigest: `sha256:${'2'.repeat(64)}`,
      targetIdentityDigest: `sha256:${'3'.repeat(64)}`,
      contentDigest: `sha256:${'4'.repeat(64)}`,
    });
    const forged = await dispatchAdmittedToolInvocationV1(
      admission.value,
      {
        workspace,
        request: {
          source: 'builtin',
          id: 'write-call',
          name: 'write_file',
          args: { path: 'src/result.ts', content: 'export const result = 1;\n' },
          reason: 'fixture',
          protectedCommand: 'write_file src/result.ts',
        },
      },
      {
        threadId: 'thread-1',
        toolCallId: 'write-call',
        persistence: {
          getState: () => state,
          persistEvents: async (events) => {
            for (const event of events) state = reduceRuntimeState(state, event);
            return true;
          },
        },
      },
      {
        dispatch: async (input) => {
          await input.beforeDispatch?.();
          return {
            ok: true,
            command: 'write_file src/result.ts',
            exitCode: 0,
            stdout: 'written',
            stderr: '',
            filesystemObservation: forgedObservation,
          };
        },
      },
    );
    if (forged.kind !== 'dispatched') throw new Error(forged.kind);
    expect(() => normalizeDispatchedToolOutcomeV1(forged.value)).toThrow(
      'authentic process-local Workspace filesystem authority',
    );

    state = createInitialRuntimeState({
      threadId: 'thread-1',
      userId: 'test',
      workspace,
    });
    const dispatched = await dispatchAdmittedToolInvocationV1(
      admission.value,
      {
        workspace,
        request: {
          source: 'builtin',
          id: 'write-call',
          name: 'write_file',
          args: { path: 'src/result.ts', content: 'export const result = 1;\n' },
          reason: 'fixture',
          protectedCommand: 'write_file src/result.ts',
        },
      },
      {
        threadId: 'thread-1',
        toolCallId: 'write-call',
        persistence: {
          getState: () => state,
          persistEvents: async (events) => {
            for (const event of events) state = reduceRuntimeState(state, event);
            return true;
          },
        },
        filesystemRuntime: testWorkspaceFilesystemRuntimeV1(workspace),
      },
    );
    if (dispatched.kind !== 'dispatched') throw new Error(dispatched.kind);
    const observation = dispatched.value.result.filesystemObservation;
    if (!observation) throw new Error('authentic filesystem observation missing');
    expect(() =>
      normalizeDispatchedToolOutcomeV1({
        ...dispatched.value,
        result: structuredClone(dispatched.value.result),
      }),
    ).toThrow('authentic dispatched Pipeline outcome');
    expect(() =>
      normalizeDispatchedToolOutcomeV1({
        ...dispatched.value,
        result: { ...dispatched.value.result },
      }),
    ).toThrow('authentic dispatched Pipeline outcome');
    expect(() =>
      normalizeDispatchedToolOutcomeV1({
        ...dispatched.value,
        recorded: { ...dispatched.value.recorded, attempt: dispatched.value.recorded.attempt + 1 },
      }),
    ).toThrow('authentic dispatched Pipeline outcome');
    expect(() =>
      normalizeDispatchedToolOutcomeV1({
        ...dispatched.value,
        result: {
          ...dispatched.value.result,
          filesystemObservation: {
            ...observation,
            lexicalTargetDigest: `sha256:${'9'.repeat(64)}`,
          },
        },
      }),
    ).toThrow('authentic dispatched Pipeline outcome');
    let artifactResult: import('@/protocol/capabilities').CapabilityResult | undefined;
    const receipt = commitNormalizedToolReceiptV1(
      normalizeDispatchedToolOutcomeV1(dispatched.value),
      {
        write: (_invocationId, result) => {
          artifactResult = structuredClone(result);
          return {
            artifactId: `pa_${'a'.repeat(64)}`,
            kind: 'capability_result',
            integrityIdentifier: `hmac-sha256:${'b'.repeat(64)}`,
            byteLength: 42,
          };
        },
      },
      '2026-08-17T00:00:01.000Z',
    );

    expect(filesystemObservationFromCapabilityResultV1(artifactResult!)).toEqual(observation);
    expect(receipt.terminalEvents[0]).toMatchObject({ filesystemObservation: observation });
    expect(
      planCommittedToolVerificationV1(receipt, {
        enabled: true,
        requestedAt: '2026-08-17T00:00:02.000Z',
      }),
    ).toMatchObject({
      kind: 'planned',
      value: {
        verificationEvents: [{ type: 'verification.requested', mode: 'required' }],
      },
    });
  });
});
