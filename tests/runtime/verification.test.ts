import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpConnectionManager } from '@/core/mcp/manager';
import { eventsForRuntimeAction } from '@/core/runtime/actions';
import type { RuntimeEvent } from '@/core/runtime/events';
import { reduceRuntimeState } from '@/core/runtime/reducer';
import { decideNextEffect } from '@/core/runtime/scheduler';
import { createInitialRuntimeState, type RuntimeState } from '@/core/runtime/state';
import { executeVerificationEffect } from '@/core/verification/executor';
import { resolveVerificationMode } from '@/core/verification/policy';
import { verificationRequestForSkill } from '@/core/verification/requests';
import type { VerificationSpecV1 } from '@/protocol/verification';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function activeState(): RuntimeState {
  const workspace = join(tmpdir(), `kite-verification-${crypto.randomUUID()}`);
  mkdirSync(workspace, { recursive: true });
  roots.push(workspace);
  const state = createInitialRuntimeState({ threadId: 'thread', userId: 'user', workspace });
  state.activeTaskId = 'task';
  state.tasks.task = {
    taskId: 'task',
    userGoal: 'verify the change',
    status: 'active',
    startedAtTurnId: state.turn.turnId,
    sideEffectsStarted: true,
    planning: { kind: 'building_without_plan' },
    planHistory: [],
  };
  state.transcript.final = 'finished';
  return state;
}

function spec(checks: VerificationSpecV1['checks'], maxAttempts = 1): VerificationSpecV1 {
  return {
    schemaVersion: 1,
    verificationId: 'verification-1',
    taskId: 'task',
    subject: 'test outcome',
    checks,
    repair: { maxAttempts },
  };
}

function request(
  mode: 'not_required' | 'best_effort' | 'required',
  value: VerificationSpecV1,
): RuntimeEvent {
  return {
    type: 'verification.requested',
    verificationId: value.verificationId,
    taskId: 'task',
    mode,
    spec: value,
    requestedAt: '2026-07-15T00:00:00.000Z',
  };
}

function reduceAll(state: RuntimeState, events: RuntimeEvent[]): RuntimeState {
  return events.reduce(reduceRuntimeState, state);
}

describe('verification policy and scheduler', () => {
  test('verification sources can raise but never lower the effective mode', () => {
    expect(resolveVerificationMode({ baseline: 'best_effort', skillMode: 'not_required' })).toBe(
      'best_effort',
    );
    expect(
      resolveVerificationMode({
        skillMode: 'best_effort',
        capabilityEffects: { filesystem: 'none', network: 'write', externalState: 'none' },
      }),
    ).toBe('required');
    expect(resolveVerificationMode({ skillMode: 'required', userMode: 'not_required' })).toBe(
      'required',
    );
  });

  test('ordinary answers still complete when no required verification exists', () => {
    expect(decideNextEffect(activeState())).toEqual({ type: 'emit_final' });
  });

  test('pending best-effort verification never blocks an already final answer', () => {
    const state = reduceRuntimeState(
      activeState(),
      request(
        'best_effort',
        spec([
          {
            checkId: 'optional',
            type: 'file_assertion',
            description: 'optional evidence',
            path: 'optional.txt',
            assertion: 'exists',
          },
        ]),
      ),
    );
    expect(decideNextEffect(state)).toEqual({ type: 'emit_final' });
  });

  test('required failed verification repairs and then passes within budget', async () => {
    let state = reduceRuntimeState(
      activeState(),
      request(
        'required',
        spec([
          {
            checkId: 'tests',
            type: 'command',
            description: 'run tests',
            command: 'bun test',
          },
        ]),
      ),
    );
    expect(decideNextEffect(state)).toEqual({
      type: 'run_verification',
      verificationId: 'verification-1',
    });
    const failed = await executeVerificationEffect(
      { type: 'run_verification', verificationId: 'verification-1' },
      state,
      {
        shellExecutor: async ({ command }) => ({
          ok: false,
          command,
          exitCode: 1,
          stdout: '',
          stderr: 'failed',
        }),
      },
    );
    state = reduceAll(state, failed);
    expect(state.verification.records['verification-1']?.status).toBe('failed');
    expect(decideNextEffect(state).type).toBe('repair_verification');

    state = reduceAll(
      state,
      await executeVerificationEffect(
        { type: 'repair_verification', verificationId: 'verification-1' },
        state,
      ),
    );
    expect(state.transcript.final).toBeUndefined();
    expect(state.transcript.messages.at(-1)?.kind).toBe('runtime');
    state = reduceRuntimeState(state, {
      type: 'model.responded',
      messageId: 'repair-result',
      text: 'repaired',
    });
    expect(decideNextEffect(state).type).toBe('run_verification');

    const passed = await executeVerificationEffect(
      { type: 'run_verification', verificationId: 'verification-1' },
      state,
      {
        shellExecutor: async ({ command }) => ({
          ok: true,
          command,
          exitCode: 0,
          stdout: 'ok',
          stderr: '',
        }),
      },
    );
    state = reduceAll(state, passed);
    expect(state.verification.records['verification-1']).toMatchObject({
      status: 'passed',
      attempts: 2,
      repairAttempts: 1,
    });
    expect(decideNextEffect(state)).toEqual({ type: 'emit_final' });
  });

  test('budget exhaustion blocks required completion until a structured user waiver', async () => {
    let state = reduceRuntimeState(
      activeState(),
      request(
        'required',
        spec(
          [
            {
              checkId: 'review',
              type: 'reviewer',
              description: 'review evidence',
              instructions: 'verify it',
            },
          ],
          0,
        ),
      ),
    );
    state = reduceAll(
      state,
      await executeVerificationEffect(
        { type: 'run_verification', verificationId: 'verification-1' },
        state,
      ),
    );
    expect(state.verification.records['verification-1']?.status).toBe('budget_exhausted');
    expect(decideNextEffect(state).type).toBe('request_verification_decision');

    const waiver = eventsForRuntimeAction(state, {
      type: 'waive_verification',
      verificationId: 'verification-1',
      reason: 'Accepted without independent evidence.',
    });
    expect(waiver).toEqual([
      expect.objectContaining({ type: 'verification.waived', actor: 'user' }),
    ]);
    state = reduceAll(state, waiver);
    expect(state.verification.records['verification-1']).toMatchObject({
      status: 'waived',
      waiver: { actor: 'user' },
    });
    expect(decideNextEffect(state)).toEqual({ type: 'emit_final' });
  });

  test('best-effort failure is recorded but does not block final output', async () => {
    let state = reduceRuntimeState(
      activeState(),
      request(
        'best_effort',
        spec([
          {
            checkId: 'missing',
            type: 'file_assertion',
            description: 'missing file',
            path: 'missing.txt',
            assertion: 'exists',
          },
        ]),
      ),
    );
    state = reduceAll(
      state,
      await executeVerificationEffect(
        { type: 'run_verification', verificationId: 'verification-1' },
        state,
      ),
    );
    expect(state.verification.records['verification-1']?.status).toBe('failed');
    expect(decideNextEffect(state)).toEqual({ type: 'emit_final' });
  });
});

describe('VerificationSpec execution and recovery', () => {
  test('runs deterministic file and schema checks before reviewer evidence', async () => {
    let state = activeState();
    writeFileSync(join(state.session.workspace, 'result.json'), '{"ok":true}');
    state = reduceRuntimeState(
      state,
      request(
        'required',
        spec([
          {
            checkId: 'file',
            type: 'file_assertion',
            description: 'result exists',
            path: 'result.json',
            assertion: 'exists',
          },
          {
            checkId: 'schema',
            type: 'schema',
            description: 'structured result',
            subject: { kind: 'literal', value: { ok: true } },
            schema: {
              type: 'object',
              properties: { ok: { type: 'boolean' } },
              required: ['ok'],
              additionalProperties: false,
            },
          },
        ]),
      ),
    );
    state = reduceAll(
      state,
      await executeVerificationEffect(
        { type: 'run_verification', verificationId: 'verification-1' },
        state,
      ),
    );
    expect(state.verification.records['verification-1']?.status).toBe('passed');
    expect(Object.values(state.verification.records['verification-1']!.checkResults)).toHaveLength(
      2,
    );
  });

  test('reviewer receives original receipts, artifacts, and skill output', async () => {
    let state = activeState();
    state.capabilities.invocations.invocation = {
      invocationId: 'invocation',
      toolCallId: 'tool',
      capabilityId: 'mcp:fixture/write',
      capabilityRevision: 'r1',
      argumentsDigest: 'args',
      authorizationDigest: 'auth',
      effectiveEffectsDigest: 'effects',
      status: 'succeeded',
      recordedAt: '2026-07-15T00:00:00.000Z',
      artifact: {
        artifactId: `pa_${'a'.repeat(64)}`,
        kind: 'capability_result',
        integrityIdentifier: `hmac-sha256:${'b'.repeat(64)}`,
        byteLength: 1,
      },
    };
    state.skills.frames.activation = {
      activationId: 'activation',
      skillId: 'skill:test',
      skillRevision: 'r1',
      taskId: 'task',
      input: {},
      contextMode: 'inline',
      agent: 'code',
      capabilityCeiling: [],
      verificationMode: 'required',
      requestedBy: 'user',
      activatedAt: '2026-07-15T00:00:00.000Z',
      status: 'closed',
      output: { ok: true },
    };
    state = reduceRuntimeState(
      state,
      request(
        'required',
        spec([
          {
            checkId: 'review',
            type: 'reviewer',
            description: 'review raw evidence',
            invocationIds: ['invocation'],
            activationIds: ['activation'],
            instructions: 'verify evidence',
          },
        ]),
      ),
    );
    let received: unknown;
    const events = await executeVerificationEffect(
      { type: 'run_verification', verificationId: 'verification-1' },
      state,
      {
        artifactStore: {
          read: () => ({ status: 'success', content: [{ type: 'text', text: 'raw evidence' }] }),
        } as never,
        reviewer: async (input) => {
          received = input;
          return { outcome: 'passed', summary: 'evidence confirms success' };
        },
      },
    );
    expect(received).toMatchObject({
      receipts: [{ invocationId: 'invocation', argumentsDigest: 'args' }],
      artifacts: [{ invocationId: 'invocation', result: { status: 'success' } }],
      skillOutputs: [{ activationId: 'activation', output: { ok: true } }],
    });
    state = reduceAll(state, events);
    expect(state.verification.records['verification-1']?.status).toBe('passed');
  });

  test('reviewer fails closed before model dispatch when receipt Artifact access is unavailable', async () => {
    let state = activeState();
    state.capabilities.invocations.invocation = {
      invocationId: 'invocation',
      toolCallId: 'tool',
      capabilityId: 'mcp:fixture/write',
      capabilityRevision: 'r1',
      argumentsDigest: 'args',
      authorizationDigest: 'auth',
      effectiveEffectsDigest: 'effects',
      status: 'succeeded',
      recordedAt: '2026-07-15T00:00:00.000Z',
      artifact: {
        artifactId: `pa_${'a'.repeat(64)}`,
        kind: 'capability_result',
        integrityIdentifier: `hmac-sha256:${'b'.repeat(64)}`,
        byteLength: 1,
      },
    };
    state = reduceRuntimeState(
      state,
      request(
        'required',
        spec([
          {
            checkId: 'review',
            type: 'reviewer',
            description: 'review raw evidence',
            invocationIds: ['invocation'],
            instructions: 'verify evidence',
          },
        ]),
      ),
    );
    let reviewerCalls = 0;
    const events = await executeVerificationEffect(
      { type: 'run_verification', verificationId: 'verification-1' },
      state,
      {
        reviewer: async () => {
          reviewerCalls += 1;
          return { outcome: 'passed', summary: 'must not be trusted' };
        },
      },
    );

    expect(reviewerCalls).toBe(0);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'verification.check_completed',
        result: expect.objectContaining({
          outcome: 'inconclusive',
          summary: 'The capability Artifact reader is unavailable.',
        }),
      }),
    );
  });

  test('MCP read-after-write revalidates a read-only capability revision', async () => {
    let state = activeState();
    state.capabilities.invocations.source = {
      invocationId: 'source',
      toolCallId: 'write-tool',
      capabilityId: 'mcp:fixture/write',
      capabilityRevision: 'write-r1',
      argumentsDigest: 'args',
      authorizationDigest: 'auth',
      effectiveEffectsDigest: 'effects',
      status: 'succeeded',
      recordedAt: '2026-07-15T00:00:00.000Z',
    };
    state = reduceRuntimeState(
      state,
      request(
        'required',
        spec([
          {
            checkId: 'read-after-write',
            type: 'mcp_read_after_write',
            description: 'read the created object',
            invocationId: 'source',
            capabilityId: 'mcp:fixture/read',
            capabilityRevision: 'read-r1',
            arguments: { id: 'object-1' },
            outputSchema: {
              type: 'object',
              properties: { exists: { type: 'boolean' } },
              required: ['exists'],
            },
          },
        ]),
      ),
    );
    const manager = new McpConnectionManager();
    manager.findCapability = () => ({
      capabilityId: 'mcp:fixture/read',
      revision: 'read-r1',
      kind: 'mcp_tool',
      displayName: 'read',
      description: 'read fixture',
      provider: { type: 'mcp', id: 'fixture', provenance: 'project' },
      declaredEffects: { filesystem: 'none', network: 'read', externalState: 'read' },
      effectiveEffects: { filesystem: 'none', network: 'read', externalState: 'read' },
      policy: { workspaceTrustRequired: false, minimumApproval: 'none' },
      availability: 'available',
      diagnostics: [],
    });
    manager.callCapability = async () =>
      ({ structuredContent: { exists: true }, content: [] }) as never;
    state = reduceAll(
      state,
      await executeVerificationEffect(
        { type: 'run_verification', verificationId: 'verification-1' },
        state,
        { mcpManager: manager },
      ),
    );
    expect(state.verification.records['verification-1']?.status).toBe('passed');
  });

  test('compensation runs only after an explicit user request and remains unverified', async () => {
    const compensationSpec = spec(
      [
        {
          checkId: 'missing',
          type: 'file_assertion',
          description: 'must exist',
          path: 'missing',
          assertion: 'exists',
        },
      ],
      0,
    );
    compensationSpec.compensation = { command: 'undo' };
    let state = reduceRuntimeState(activeState(), request('required', compensationSpec));
    state = reduceAll(
      state,
      await executeVerificationEffect(
        { type: 'run_verification', verificationId: 'verification-1' },
        state,
      ),
    );
    expect(decideNextEffect(state).type).toBe('request_verification_decision');
    state = reduceAll(
      state,
      eventsForRuntimeAction(state, {
        type: 'request_verification_compensation',
        verificationId: 'verification-1',
      }),
    );
    expect(decideNextEffect(state).type).toBe('run_verification_compensation');
    state = reduceAll(
      state,
      await executeVerificationEffect(
        { type: 'run_verification_compensation', verificationId: 'verification-1' },
        state,
        {
          shellExecutor: async ({ command }) => ({
            ok: true,
            command,
            exitCode: 0,
            stdout: '',
            stderr: '',
          }),
        },
      ),
    );
    expect(state.verification.records['verification-1']).toMatchObject({
      status: 'compensated',
      compensation: { outcome: 'passed' },
    });
    expect(decideNextEffect(state).type).toBe('request_verification_decision');
  });

  test('invalid required specs fail closed and remain diagnosable', () => {
    const invalid = spec([]);
    const state = reduceRuntimeState(activeState(), request('required', invalid));
    expect(state.verification.records['verification-1']).toMatchObject({
      status: 'budget_exhausted',
      diagnostics: [expect.stringContaining('At least one')],
    });
    expect(decideNextEffect(state).type).toBe('request_verification_decision');
  });

  test('high-risk Skill effects raise best-effort contract verification to required', () => {
    const state = activeState();
    const event = verificationRequestForSkill({
      activation: {
        activationId: 'activation',
        skillId: 'skill:publish',
        skillRevision: 'r1',
        taskId: 'task',
        input: {},
        contextMode: 'inline',
        agent: 'code',
        capabilityCeiling: [],
        verificationMode: 'best_effort',
        requestedBy: 'user',
        activatedAt: '2026-07-15T00:00:00.000Z',
      },
      contract: {
        schemaVersion: 1,
        name: 'publish',
        version: '1.0.0',
        description: 'publish',
        instructions: 'publish',
        invocation: { allowImplicit: false, allowManual: true },
        context: { mode: 'inline', agent: 'code' },
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        capabilityCeiling: [],
        deniedCapabilities: [],
        effectiveCapabilityCeiling: [],
        effects: { filesystem: 'none', network: 'write', externalState: 'write' },
        effectiveEffects: { filesystem: 'none', network: 'write', externalState: 'write' },
        minimumApproval: 'user',
        effectiveMinimumApproval: 'user',
        execution: { timeoutMs: 1_000, maxAttempts: 1 },
        verification: { mode: 'best_effort' },
        recovery: { retry: 'never' },
        files: [],
        dependencyRevisions: {},
      },
      sourcePath: join(state.session.workspace, '.kite-code', 'skills', 'publish', 'SKILL.md'),
      workspace: state.session.workspace,
    });
    expect(event?.mode).toBe('required');
  });
});
