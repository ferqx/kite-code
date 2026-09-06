import { describe, expect, test } from 'bun:test';
import {
  assertAcceptedPresentationEnvelope,
  assertListRuntimeLogEventsRequest,
  assertListRuntimeLogSessionsRequest,
  assertRuntimeClientEvent,
  assertRuntimeClientInteraction,
  assertRuntimeCommand,
  assertRuntimeQuery,
  assertRuntimeSessionIndexNotification,
  assertRuntimeSubscriptionSpec,
  isAcceptedPresentationEnvelope,
  isRuntimeClientEvent,
  isRuntimeClientInteraction,
  isRuntimeCommand,
  isRuntimeQuery,
  isRuntimeSessionIndexNotification,
  isRuntimeSubscriptionSpec,
  RUNTIME_COMMAND_SCHEMA_,
  RUNTIME_CONTRACT_BOUNDARY_,
  RUNTIME_CONTRACT_SCHEMA_,
  RUNTIME_PROJECTION_SCHEMA_,
  type RuntimeAccess,
  type RuntimeCommand,
} from '@kite-ai/runtime-contract';

describe('runtime contract package boundary', () => {
  test('is a frozen private in-process Contract', () => {
    expect(RUNTIME_CONTRACT_BOUNDARY_).toEqual({
      audience: 'kite-app',
      transport: 'in-process',
      revision: 'runtime-contract-current',
      schema: RUNTIME_CONTRACT_SCHEMA_,
    });
    expect(Object.isFrozen(RUNTIME_CONTRACT_BOUNDARY_)).toBe(true);
  });

  test('accepts only the RM command envelope', () => {
    const command: RuntimeCommand = {
      schema: RUNTIME_COMMAND_SCHEMA_,
      commandId: 'command-1',
      type: 'create_session',
      workspace: '/workspace',
      bootstrapSessionId: 'session-1',
    };
    expect(isRuntimeCommand(command)).toBe(true);
    expect(isRuntimeCommand({ ...command, schema: 'future' })).toBe(false);
    expect(
      isRuntimeCommand({
        ...command,
        commandId: 'command\n1',
      }),
    ).toBe(false);
    expect(() => assertRuntimeCommand({ ...command, commandId: '' })).toThrow(
      'Invalid RuntimeCommand',
    );
    expect(
      isRuntimeCommand({
        ...command,
        unexpected: 'must fail before Host dispatch',
      }),
    ).toBe(false);
    expect(
      isRuntimeCommand({
        schema: RUNTIME_COMMAND_SCHEMA_,
        commandId: 'command-multiline',
        type: 'start_turn',
        sessionId: 'session-1',
        expectedRevision: 0,
        input: 'First line\nSecond line\twith indentation',
      }),
    ).toBe(true);
    expect(
      isRuntimeCommand({
        schema: RUNTIME_COMMAND_SCHEMA_,
        commandId: 'command-unsafe-number',
        type: 'start_turn',
        sessionId: 'session-1',
        expectedRevision: 0,
        input: 'Run a skill',
        initialSkills: [{ skillId: 'skill-1', input: { count: Number.MAX_SAFE_INTEGER + 1 } }],
      }),
    ).toBe(false);
    const prototypeShaped = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(prototypeShaped, '__proto__', {
      enumerable: true,
      value: 'forbidden',
    });
    expect(
      isRuntimeCommand({
        schema: RUNTIME_COMMAND_SCHEMA_,
        commandId: 'command-prototype-key',
        type: 'start_turn',
        sessionId: 'session-1',
        expectedRevision: 0,
        input: 'Run a skill',
        initialSkills: [{ skillId: 'skill-1', input: prototypeShaped }],
      }),
    ).toBe(false);
    expect(
      isRuntimeCommand({
        schema: RUNTIME_COMMAND_SCHEMA_,
        commandId: 'command-array-input',
        type: 'start_turn',
        sessionId: 'session-1',
        expectedRevision: 0,
        input: 'Run a skill',
        initialSkills: [{ skillId: 'skill-1', input: [] }],
      }),
    ).toBe(false);
    const deleteSession: RuntimeCommand = {
      schema: RUNTIME_COMMAND_SCHEMA_,
      commandId: 'delete-session-1',
      type: 'delete_session',
      sessionId: 'session-1',
      expectedRevision: 4,
    };
    expect(isRuntimeCommand(deleteSession)).toBe(true);
    expect(isRuntimeCommand({ ...deleteSession, snapshot: {} })).toBe(false);
  });

  test('requires complete State 27 interaction identity to settle an interaction', () => {
    const interaction = {
      kind: 'approval' as const,
      interactionId: 'approval-1',
      sessionRevision: 7,
      generation: 3,
      grants: ['approve_once', 'same_command'] as const,
      owner: { kind: 'root_tool' as const, toolCallId: 'tool-1' },
      command: 'git status --short',
      title: 'Allow tool',
    };
    expect(isRuntimeClientInteraction(interaction)).toBe(true);
    expect(() => assertRuntimeClientInteraction(interaction)).not.toThrow();
    expect(isRuntimeClientInteraction({ ...interaction, cwd: '/private/workspace' })).toBe(false);
    expect(isRuntimeClientInteraction({ ...interaction, command: 42 })).toBe(false);
    expect(
      isRuntimeClientInteraction({ ...interaction, grants: ['approve_once', 'full_access'] }),
    ).toBe(false);

    const command: RuntimeCommand = {
      schema: RUNTIME_COMMAND_SCHEMA_,
      commandId: 'command-settle-1',
      type: 'respond_interaction',
      sessionId: 'session-1',
      expectedRevision: 7,
      interaction,
      response: { kind: 'approval', decision: 'approve_once' },
    };
    expect(isRuntimeCommand(command)).toBe(true);
    expect(isRuntimeCommand({ ...command, expectedRevision: 8 })).toBe(false);
    expect(isRuntimeCommand({ ...command, response: { kind: 'text', value: 'yes' } })).toBe(false);

    const inputInteraction = {
      kind: 'input' as const,
      interactionId: 'input-1',
      sessionRevision: 7,
      question: 'Continue?',
      allowFreeText: true,
    };
    const inputCancel: RuntimeCommand = {
      schema: RUNTIME_COMMAND_SCHEMA_,
      commandId: 'command-input-cancel',
      type: 'respond_interaction',
      sessionId: 'session-1',
      expectedRevision: 7,
      interaction: inputInteraction,
      response: { kind: 'input_cancel' },
    };
    expect(isRuntimeCommand(inputCancel)).toBe(true);
    expect(isRuntimeCommand({ ...inputCancel, response: { kind: 'text', value: '' } })).toBe(false);
    expect(isRuntimeCommand({ ...command, response: { kind: 'input_cancel' } })).toBe(false);

    expect(
      isRuntimeClientInteraction({
        kind: 'plan_review',
        interactionId: 'plan-review-1',
        sessionRevision: 8,
        plan: { planId: 'plan-1', version: 2, structuralDigest: 'digest-1' },
        summary: 'Plan title\n\n1. Inspect\n2. Verify',
      }),
    ).toBe(true);
    expect(
      isRuntimeClientInteraction({
        kind: 'provider_action',
        interactionId: 'provider-1',
        sessionRevision: 9,
        provider: { providerId: 'mcp-1', directoryRevision: 'directory-3' },
        action: 'retry',
      }),
    ).toBe(true);
    expect(
      isRuntimeClientInteraction({
        kind: 'verification',
        interactionId: 'verification-1',
        sessionRevision: 10,
        verification: { verificationId: 'verify-1', revision: 'verify-revision-2' },
      }),
    ).toBe(true);
  });

  test('admits only closed client event and subscription vocabularies', () => {
    const event = {
      type: 'model.text_delta' as const,
      requestId: 'request-1',
      text: 'A safe client-visible delta.',
    };
    expect(isRuntimeClientEvent(event)).toBe(true);
    expect(() => assertRuntimeClientEvent(event)).not.toThrow();
    expect(
      isRuntimeClientEvent({
        type: 'user.message',
        messageId: 'message-multiline',
        kind: 'task',
        text: 'first line\nsecond line',
      }),
    ).toBe(true);
    expect(isRuntimeClientEvent({ ...event, providerBody: { secret: 'nope' } })).toBe(false);
    expect(isRuntimeClientEvent({ type: 'model.text_delta', text: event.text })).toBe(false);
    expect(isRuntimeClientEvent({ type: 'model.reasoning_delta', text: 'private chain' })).toBe(
      false,
    );
    expect(
      isRuntimeClientEvent({
        type: 'reasoning.activity',
        requestId: 'request-1',
        state: 'streaming',
        segmentId: 'reasoning-1',
        text: 'Inspecting local state.',
      }),
    ).toBe(true);
    expect(
      isRuntimeClientEvent({
        type: 'reasoning.activity',
        state: 'streaming',
        segmentId: 'reasoning-1',
        text: 'Inspecting local state.',
      }),
    ).toBe(false);
    expect(
      isRuntimeClientEvent({
        type: 'reasoning.activity',
        requestId: 'request-1',
        state: 'streaming',
        segmentId: 'reasoning-1',
        text: 'Inspecting local state.',
        reasoning: 'extra private field',
      }),
    ).toBe(false);
    expect(
      isRuntimeClientEvent({
        type: 'turn.terminal',
        turnId: 'turn-1',
        status: 'cancelled',
        cause: 'user',
      }),
    ).toBe(true);
    expect(
      isRuntimeClientEvent({
        type: 'turn.terminal',
        turnId: 'turn-1',
        status: 'failed',
        cause: 'provider',
      }),
    ).toBe(false);
    expect(
      isRuntimeClientEvent({
        type: 'model.responded',
        requestId: 'request-1',
        messageId: 'message-1',
        durationMs: 250,
        toolCallCount: 2,
      }),
    ).toBe(true);
    expect(
      isRuntimeClientEvent({
        type: 'model.responded',
        requestId: 'request-1',
        messageId: 'message-1',
        durationMs: -1,
        toolCallCount: 0,
      }),
    ).toBe(false);
    expect(
      isRuntimeClientEvent({
        type: 'model.responded',
        requestId: 'request-1',
        messageId: 'message-1',
        durationMs: Number.MAX_SAFE_INTEGER + 1,
        toolCallCount: 0,
      }),
    ).toBe(false);
    expect(isRuntimeClientEvent({ type: 'planning.entered', taskId: 'task-1' })).toBe(true);
    expect(
      isRuntimeClientEvent({
        type: 'plan.approved',
        interactionId: 'plan-review-1',
        sessionRevision: 4,
        mode: 'auto',
      }),
    ).toBe(true);
    expect(isRuntimeClientEvent({ type: 'interaction_mode.changed', mode: 'full' })).toBe(true);
    expect(
      isRuntimeClientEvent({
        type: 'run.terminal',
        runId: 'turn-1',
        status: 'failed',
        outcome: {
          status: 'resource_saturated',
          reasonCode: 'resource_saturated',
          safeRetry: true,
          recoveryEntry: 'retry',
        },
      }),
    ).toBe(true);
    expect(
      isRuntimeClientEvent({
        type: 'run.terminal',
        runId: 'turn-1',
        status: 'failed',
        outcome: {
          status: 'resource_saturated',
          reasonCode: 'resource_saturated',
          safeRetry: true,
          recoveryEntry: 'retry',
        },
        message: 'private failure detail',
      }),
    ).toBe(false);
    expect(isRuntimeClientEvent({ type: 'model.text_delta', text: 'x'.repeat(65_537) })).toBe(
      false,
    );
    expect(
      isRuntimeClientEvent({
        type: 'tool.queued',
        toolId: 'tool-1',
        presentationGroupId: 'model-message-1',
        toolName: 'read_file',
        presentation: 'exploration',
        arguments: { path: '/workspace/src/index.ts', pattern: 'needle' },
        summary: 'Queued.',
      }),
    ).toBe(true);
    expect(
      isRuntimeClientEvent({
        type: 'tool.queued',
        toolId: 'tool-1',
        presentationGroupId: '',
        presentation: 'exploration',
        arguments: {},
        summary: 'Queued.',
      }),
    ).toBe(false);
    expect(
      isRuntimeClientEvent({
        type: 'tool.queued',
        toolId: 'tool-1',
        toolName: 'mcp__private__credential=secret',
        presentation: 'exploration',
        arguments: {},
        summary: 'Queued.',
      }),
    ).toBe(false);
    expect(
      isRuntimeClientEvent({
        type: 'tool.queued',
        toolId: 'tool-1',
        presentation: 'unknown',
        arguments: {},
        summary: 'Queued.',
      }),
    ).toBe(false);
    expect(
      isRuntimeClientEvent({
        type: 'tool.finished',
        toolId: 'tool-1',
        toolName: 'read_file',
        presentation: 'exploration',
        result: { ok: true, exitCode: 0, stdout: '', stderr: '' },
        summary: 'Completed.',
      }),
    ).toBe(true);
    expect(
      isRuntimeClientEvent({
        type: 'tool.progress',
        toolId: 'tool-1',
        summary: 'stdout line one\nstdout line two\n',
        stream: 'stdout',
        lineCount: 2,
      }),
    ).toBe(true);
    expect(
      isRuntimeClientEvent({
        type: 'tool.queued',
        toolId: 'tool-unsafe',
        presentation: 'standalone',
        arguments: { amount: Number.MAX_SAFE_INTEGER + 1 },
        summary: 'Queued.',
      }),
    ).toBe(false);
    const prototypeArguments = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(prototypeArguments, '__proto__', { enumerable: true, value: 'blocked' });
    expect(
      isRuntimeClientEvent({
        type: 'tool.queued',
        toolId: 'tool-prototype',
        presentation: 'standalone',
        arguments: prototypeArguments,
        summary: 'Queued.',
      }),
    ).toBe(false);
    expect(
      isRuntimeClientEvent({
        type: 'tool.finished',
        toolId: 'tool-unknown-result',
        presentation: 'standalone',
        result: { ok: true, exitCode: 0, stdout: '', stderr: '', resultMeta: {} },
        summary: 'Completed.',
      }),
    ).toBe(false);
    expect(
      isRuntimeClientEvent({
        type: 'tool.file_changed',
        toolId: 'tool-1',
        change: 'modified',
        summary: 'Updated one workspace file.',
      }),
    ).toBe(true);
    expect(
      isRuntimeClientEvent({
        type: 'tool.file_changed',
        toolId: 'tool-1',
        change: 'modified',
        path: '/private/workspace/secret.txt',
      }),
    ).toBe(false);
    expect(
      isRuntimeClientEvent({
        type: 'subagent.started',
        subagentId: 'subagent-1',
        role: 'explore',
        name: 'Inspect the runtime',
        concurrencyGroupId: 'subagent-batch:tool-1',
      }),
    ).toBe(true);
    expect(
      isRuntimeClientEvent({
        type: 'subagent.started',
        subagentId: 'subagent-1',
        role: 'explore',
        name: 'Inspect the runtime',
        concurrencyGroupId: '',
      }),
    ).toBe(false);
    expect(
      isRuntimeClientEvent({
        type: 'subagent.completed',
        subagentId: 'subagent-1',
        summary: 'Inspection complete.',
        toolCallCount: 3,
        durationMs: 12_345,
      }),
    ).toBe(true);
    expect(
      isRuntimeClientEvent({
        type: 'subagent.failed',
        subagentId: 'subagent-1',
        summary: 'Inspection failed.',
        toolCallCount: 2,
        durationMs: 9_000,
        diagnostic: { code: 'model_step_failed', stage: 'model_step' },
      }),
    ).toBe(true);
    expect(
      isRuntimeClientEvent({
        type: 'subagent.failed',
        subagentId: 'subagent-1',
        summary: 'Inspection failed.',
        diagnostic: {
          code: 'model_step_failed',
          stage: 'model_step',
          modelInvocationId: 'private-correlation',
        },
      }),
    ).toBe(false);
    expect(
      isRuntimeClientEvent({
        type: 'subagent.step',
        subagentId: 'subagent-1',
        stepId: 'step-1',
        toolCallId: 'child-tool-1',
        toolName: 'read_file',
        status: 'completed',
        arguments: { path: '/private/workspace' },
      }),
    ).toBe(true);
    expect(
      isRuntimeClientEvent({
        type: 'subagent.step',
        subagentId: 'subagent-1',
        stepId: 'step-1',
        toolCallId: 'child-tool-1',
        toolName: 'read_file',
        status: 'cancelled',
        result: { ok: false },
      }),
    ).toBe(false);
    expect(
      isRuntimeClientEvent({
        type: 'tool.failed',
        toolId: 'tool-1',
        presentation: 'standalone',
        summary: 'Tool failed.',
      }),
    ).toBe(true);
    expect(
      isRuntimeClientEvent({ type: 'tool.failed', toolId: 'tool-1', summary: 'Tool failed.' }),
    ).toBe(false);
    expect(
      isRuntimeClientEvent({
        type: 'subagent.phase',
        subagentId: 'subagent-1',
        parentToolCallId: 'task-call-1',
        status: 'suspended',
        approvalState: 'awaiting_user',
        interactionId: 'approval-1',
      }),
    ).toBe(true);
    expect(
      isRuntimeClientEvent({
        type: 'subagent.review',
        subagentId: 'subagent-1',
        parentToolCallId: 'task-call-1',
        reviewId: 'review-1',
        toolCallId: 'child-tool-1',
        status: 'reviewing',
      }),
    ).toBe(true);
    expect(
      isRuntimeClientEvent({
        type: 'subagent.step',
        subagentId: 'subagent-1',
        stepId: 'step-1',
        toolCallId: 'child-tool-1',
        toolName: 'read_file',
        status: 'completed',
        extra: true,
      }),
    ).toBe(false);

    const accepted = {
      sessionId: 'session-1',
      connectionGeneration: 2,
      durability: 'ephemeral' as const,
      runId: 'run-1',
      taskId: 'task-1',
      turnId: 'turn-1',
      stream: {
        actorId: 'agent-1',
        attemptId: 'attempt-1',
        compositionRevision: 'composition-1',
        streamId: 'stream-1',
        sequence: 1,
      },
      event: { type: 'model.text_delta' as const, requestId: 'request-1', text: 'delta' },
    };
    expect(isAcceptedPresentationEnvelope(accepted)).toBe(true);
    expect(() => assertAcceptedPresentationEnvelope(accepted)).not.toThrow();
    expect(
      isAcceptedPresentationEnvelope({
        ...accepted,
        connectionGeneration: 0,
      }),
    ).toBe(false);
    expect(
      isAcceptedPresentationEnvelope({
        ...accepted,
        durability: 'durable',
      }),
    ).toBe(false);
    expect(
      isAcceptedPresentationEnvelope({
        ...accepted,
        durability: 'bogus',
      }),
    ).toBe(false);
    const { stream: _ephemeralStream, ...withoutEphemeralStream } = accepted;
    expect(isAcceptedPresentationEnvelope(withoutEphemeralStream)).toBe(false);
    expect(isAcceptedPresentationEnvelope({ ...accepted, turnId: undefined })).toBe(false);
    const { stream: _stream, ...durableAccepted } = accepted;
    expect(
      isAcceptedPresentationEnvelope({
        ...durableAccepted,
        durability: 'durable',
        turnId: 'turn-1',
        event: { type: 'model.requested' as const, requestId: 'request-1' },
      }),
    ).toBe(false);
    expect(
      isAcceptedPresentationEnvelope({
        ...durableAccepted,
        durability: 'durable',
        turnId: 'turn-1',
        event: { type: 'turn.terminal', turnId: 'predecessor-turn', status: 'completed' },
      }),
    ).toBe(false);

    const sessionSpec = {
      scope: 'session' as const,
      sessionId: 'session-1',
      afterRevision: 4,
      includeEphemeral: true,
    };
    expect(isRuntimeSubscriptionSpec(sessionSpec)).toBe(true);
    expect(isRuntimeSubscriptionSpec({ scope: 'sessions' })).toBe(true);
    expect(
      isRuntimeSubscriptionSpec({ ...sessionSpec, signal: new AbortController().signal }),
    ).toBe(false);
    expect(() => assertRuntimeSubscriptionSpec({ scope: 'sessions', unknown: true })).toThrow(
      'Invalid RuntimeSubscriptionSpec',
    );

    expect(
      isRuntimeClientInteraction({
        kind: 'input',
        interactionId: 'input-2',
        sessionRevision: 5,
        question: 'Choose one',
        allowFreeText: false,
        options: [{ id: 'one', label: 'One', description: 'The first option' }],
      }),
    ).toBe(true);
  });

  test('defines an atomic, closed session-index notification stream', () => {
    const base = { serverInstanceId: 'server-1', generation: 2, indexRevision: 9 };
    const session = {
      schema: RUNTIME_PROJECTION_SCHEMA_,
      sessionId: 'session-1',
      revision: 7,
      lifecycle: 'open' as const,
      displayName: 'Refactor runtime contract',
      interactionQueue: { revision: 7, interactions: [] },
    };
    const notifications = [
      { type: 'index_reset_begin' as const, ...base },
      { type: 'session_upsert' as const, ...base, session },
      { type: 'session_remove' as const, ...base, sessionId: 'session-old' },
      { type: 'index_reset_end' as const, ...base },
    ];
    for (const notification of notifications) {
      expect(isRuntimeSessionIndexNotification(notification)).toBe(true);
      expect(() => assertRuntimeSessionIndexNotification(notification)).not.toThrow();
    }
    expect(
      isRuntimeSessionIndexNotification({
        type: 'session_upsert',
        ...base,
        session: { ...session, workspace: '/private/workspace' },
      }),
    ).toBe(false);
    expect(
      isRuntimeSessionIndexNotification({ type: 'index_reset_end', ...base, rawState: {} }),
    ).toBe(false);
    for (const interactionQueue of [
      { revision: 6, interactions: [] },
      { revision: 7, activeInteractionId: 'missing', interactions: [] },
      {
        revision: 7,
        interactions: [
          {
            kind: 'approval',
            interactionId: 'duplicate',
            sessionRevision: 7,
            generation: 1,
            grants: ['approve_once'],
          },
          {
            kind: 'approval',
            interactionId: 'duplicate',
            sessionRevision: 7,
            generation: 1,
            grants: ['approve_once'],
          },
        ],
      },
    ]) {
      expect(
        isRuntimeSessionIndexNotification({
          type: 'session_upsert',
          ...base,
          session: { ...session, interactionQueue },
        }),
      ).toBe(false);
    }
  });

  test('rejects duplicate active interaction fields unless their full identity matches', () => {
    const approval = {
      kind: 'approval' as const,
      interactionId: 'approval-full-identity',
      sessionRevision: 7,
      generation: 1,
      command: 'bun test',
      grants: ['approve_once' as const],
    };
    const notification = {
      type: 'session_upsert' as const,
      serverInstanceId: 'server-1',
      generation: 2,
      indexRevision: 9,
      session: {
        schema: RUNTIME_PROJECTION_SCHEMA_,
        sessionId: 'session-1',
        revision: 7,
        lifecycle: 'open' as const,
        interactionQueue: {
          revision: 7,
          activeInteractionId: approval.interactionId,
          interactions: [approval],
        },
        activeWork: {
          workId: 'work-1',
          phase: 'building' as const,
          status: 'waiting' as const,
          activeTurn: {
            turnId: 'turn-1',
            status: 'waiting' as const,
            interaction: { ...approval, command: 'bun test --changed' },
          },
        },
      },
    };

    expect(isRuntimeSessionIndexNotification(notification)).toBe(false);
    expect(() => assertRuntimeSessionIndexNotification(notification)).toThrow(
      'Invalid RuntimeSessionIndexNotification',
    );
  });

  test('validates closed query fields and rejects non-JSON command payloads', () => {
    const query = {
      schema: 'kite.runtime-query.v1' as const,
      type: 'get_rewind_preview' as const,
      sessionId: 'session-1',
      checkpointId: 'checkpoint-1',
    };
    expect(isRuntimeQuery(query)).toBe(true);
    expect(() => assertRuntimeQuery({ ...query, extra: true })).toThrow('Invalid RuntimeQuery');
    const listRuns = {
      schema: 'kite.runtime-query.v1' as const,
      type: 'list_runs' as const,
      sessionId: 'session-1',
      phase: 'building' as const,
      status: 'waiting' as const,
      cursor: { createdRevision: 7, runId: 'run-7' },
      limit: 200,
    };
    expect(isRuntimeQuery(listRuns)).toBe(true);
    expect(isRuntimeQuery({ ...listRuns, limit: 201 })).toBe(false);
    expect(isRuntimeQuery({ ...listRuns, cursor: { ...listRuns.cursor, extra: true } })).toBe(
      false,
    );
    expect(
      isRuntimeQuery({
        schema: 'kite.runtime-query.v1',
        type: 'get_run',
        sessionId: 'session-1',
        runId: 'run-1',
      }),
    ).toBe(true);

    const clearGrants = {
      schema: RUNTIME_COMMAND_SCHEMA_,
      commandId: 'command-clear-grants',
      type: 'clear_session_command_grants' as const,
      sessionId: 'session-1',
      expectedRevision: 4,
    };
    expect(isRuntimeCommand(clearGrants)).toBe(true);
    expect(isRuntimeCommand({ ...clearGrants, grantSubjects: ['private'] })).toBe(false);

    expect(
      isRuntimeCommand({
        schema: RUNTIME_COMMAND_SCHEMA_,
        commandId: 'command-2',
        type: 'start_turn',
        sessionId: 'session-1',
        expectedRevision: 0,
        input: 'Run a skill',
        initialSkills: [{ skillId: 'skill-1', input: { callback: () => undefined } }],
      }),
    ).toBe(false);
  });

  test('describes command/query/subscription without internal authority', () => {
    const access: RuntimeAccess = {
      command: async (command) => ({
        status: 'rejected',
        commandId: command.commandId,
        code: 'unsupported',
      }),
      query: async (query) => ({
        status: 'rejected',
        queryType: query.type,
        code: 'unsupported',
      }),
      subscribe: async function* () {},
    };
    expect(access).toBeDefined();
  });

  test('validates bounded opaque log cursors without SQLite or HTTP types', () => {
    expect(() =>
      assertListRuntimeLogSessionsRequest({
        limit: 2,
        cursor: { updatedAt: 10, sessionId: 'session-1' },
      }),
    ).not.toThrow();
    expect(() =>
      assertListRuntimeLogEventsRequest({
        sessionId: 'session-1',
        direction: 'forward',
        limit: 2,
        afterSequence: 1,
        beforeSequence: 2,
      }),
    ).not.toThrow();
    expect(() =>
      assertListRuntimeLogEventsRequest({
        sessionId: 'session-1',
        direction: 'forward',
        limit: 2,
        afterSequence: 2,
        beforeSequence: 2,
      }),
    ).toThrow('lower than beforeSequence');
    expect(() =>
      assertListRuntimeLogEventsRequest({
        sessionId: 'session-1',
        direction: 'forward',
        limit: 201,
      }),
    ).toThrow('1 to 200');
  });
});
