import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { RuntimeEvent } from '@kite-ai/agent-kernel';
import { classifyToolOutcome } from '@kite-ai/agent-kernel';
import { classifyFailure } from '#kite-service/bootstrap/runtime/failures';
import { sessionLogDir } from '#kite-service/config/paths';
import {
  mapRuntimeMetadata,
  mapSessionBoundaryMetadata,
  SessionLogCollector,
} from '#kite-service/session-logger';

const FRONTEND = 'metadata-test';
const SECRET = 'UNIQUE_SECRET_1A2_91c53d';
const ABSOLUTE_PATH = `/private/tmp/${SECRET}/workspace/source.ts`;
const COMMAND = `curl -H 'Authorization: Bearer ${SECRET}' https://example.invalid`;
const SOURCE_MARKER = `function source_${SECRET}() { return '${SECRET}'; }`;
const PRIVATE_LINEAGE = 'a'.repeat(64);
const PRIVATE_SCHEMA_REVISION = 'private-schema';
const FAILED_OUTCOME = classifyToolOutcome({
  status: 'failed',
  failure: classifyFailure('tool_runtime_error', 'redacted'),
  authority: { dispatchState: 'started', externalEffects: 'unknown' },
});

function cleanup(threadId: string): void {
  rmSync(sessionLogDir(FRONTEND, threadId), { recursive: true, force: true });
}

afterEach(() => {
  cleanup('metadata');
  cleanup('off');
});

describe('metadata-only session logging', () => {
  test('allowlist mapper never copies content-bearing Runtime fields', () => {
    const fixtures: RuntimeEvent[] = [
      {
        type: 'user.message_appended',
        messageId: SECRET,
        content: `${SECRET} ${ABSOLUTE_PATH}`,
      },
      {
        type: 'model.responded',
        messageId: SECRET,
        durationMs: 37,
        text: SECRET,
        reasoningText: SOURCE_MARKER,
        toolCalls: [{ id: SECRET, name: `provider_${SECRET}`, args: { path: ABSOLUTE_PATH } }],
        inputTokens: 11,
        outputTokens: 7,
      },
      {
        type: 'model.invocation_prepared',
        invocationId: SECRET,
        purpose: 'primary_agent',
        surfaceArtifact: {
          artifactId: SECRET,
          kind: 'model_surface',
          integrityIdentifier: `sha256:${'a'.repeat(64)}`,
          byteLength: 123,
        },
        surfaceIntegrityIdentifier: SECRET,
        routeFingerprint: `sha256:${'b'.repeat(64)}`,
        budget: { kind: 'no_budget', reason: 'resource_budget_disabled' },
        limits: { maxAttempts: 5, perAttemptTimeoutMs: 30_000, totalTimeBudgetMs: 60_000 },
        preparedStateRevision: 42,
        parentInvocationId: SECRET,
        parentToolCallId: SECRET,
      },
      {
        type: 'model.invocation_completed',
        invocationId: SECRET,
        responseArtifact: {
          artifactId: SECRET,
          kind: 'model_response',
          integrityIdentifier: `sha256:${'e'.repeat(64)}`,
          byteLength: 321,
        },
        finishReason: 'stop',
      },
      {
        type: 'tool.queued',
        toolCallId: SECRET,
        name: `untrusted_${SECRET}`,
        args: { command: COMMAND, path: ABSOLUTE_PATH, source: SOURCE_MARKER },
      },
      {
        type: 'tool.progress',
        toolCallId: SECRET,
        chunk: `${SECRET}\n${SOURCE_MARKER}`,
        stream: 'stderr',
      },
      {
        type: 'tool.finished',
        toolCallId: SECRET,
        name: 'shell_execute',
        result: {
          ok: false,
          command: COMMAND,
          exitCode: 1,
          stdout: SOURCE_MARKER,
          stderr: `${ABSOLUTE_PATH}: ${SECRET}`,
          toolTokenCount: 13,
        },
        outcome: {
          ...FAILED_OUTCOME,
          lineage: { failureInstanceId: PRIVATE_LINEAGE },
          timing: { source: 'runtime_boundary', executionMs: 17, totalActiveMs: 31 },
          unknownFields: {
            hasUnknown: true,
            count: 2,
            toolClass: 'builtin_execute',
            schemaRevision: PRIVATE_SCHEMA_REVISION,
          },
        },
      },
      {
        type: 'tool.failed',
        toolCallId: SECRET,
        failure: classifyFailure('tool_runtime_error', `${SECRET}: ${ABSOLUTE_PATH}`),
        outcome: FAILED_OUTCOME,
      },
      {
        type: 'approval.requested',
        interactionId: SECRET,
        toolCallId: SECRET,
        fullModeBypassEligible: false,
        fullModePolicyBypassAllowed: false,
        owner: { kind: 'root_tool', toolCallId: SECRET },
        approval: {
          scope: 'once',
          cwd: ABSOLUTE_PATH,
          threadId: SECRET,
          tool: `unknown_${SECRET}`,
          command: COMMAND,
          risk: 'execute_code',
          approvalHash: SECRET,
          summary: SOURCE_MARKER,
          reason: ABSOLUTE_PATH,
          expectedEffects: [SECRET],
          grantOptions: ['approve_once'],
          recommendedGrant: 'approve_once',
        },
      },
      {
        type: 'context.compaction_failed',
        compactionId: SECRET,
        sourceRevision: 4,
        errorKind: 'summary_model_failed',
        message: `${SOURCE_MARKER} ${ABSOLUTE_PATH}`,
        retryable: false,
      },
      {
        type: 'run.error',
        message: `${SECRET}: ${SOURCE_MARKER}`,
        recoverable: false,
        failure: classifyFailure('mandatory_policy_unavailable', COMMAND),
      },
      {
        type: 'tool.file_change',
        toolCallId: SECRET,
        path: ABSOLUTE_PATH,
        kind: 'edit',
        preview: SOURCE_MARKER,
      },
      {
        type: 'subagent.failed',
        subagent: {
          id: SECRET,
          error: `${SECRET}: ${ABSOLUTE_PATH}`,
          summary: SOURCE_MARKER,
          durationMs: 41,
          diagnostic: {
            code: 'internal_error',
            stage: 'next_round_preparation',
            modelInvocationId: SECRET,
          },
        },
      },
    ];

    const output = JSON.stringify(fixtures.map(mapRuntimeMetadata));
    for (const forbidden of [
      SECRET,
      ABSOLUTE_PATH,
      COMMAND,
      SOURCE_MARKER,
      PRIVATE_LINEAGE,
      PRIVATE_SCHEMA_REVISION,
    ]) {
      expect(output).not.toContain(forbidden);
    }
    expect(output).toContain('"failureKind":"mandatory_policy_unavailable"');
    expect(output).toContain('"toolKind":"shell_execute"');
    expect(output).toContain('"toolKind":"other"');
    expect(output).toContain('"inputTokens":11');
    expect(output).toContain('"outputTokens":7');
    expect(output).toContain('"toolTotalActiveMs":31');
    expect(output).toContain('"subagentFailureCode":"internal_error"');
    expect(output).toContain('"subagentFailureStage":"next_round_preparation"');
  });

  test('session boundary schema exposes only explicit release metadata', () => {
    const record = mapSessionBoundaryMetadata('session.start', 'ok', {
      releaseVersion: '2026.7.30',
      releaseProfile: 'limited',
      releaseCohort: 'phase-1',
    });

    expect(record).toEqual({
      schemaVersion: 1,
      eventType: 'session.start',
      timestamp: expect.any(String),
      status: 'ok',
      metadata: {
        releaseVersion: '2026.7.30',
        releaseProfile: 'limited',
        releaseCohort: 'phase-1',
      },
    });
  });

  test('model evidence status is projected without private invocation fields', () => {
    const interrupted = mapRuntimeMetadata({
      type: 'model.invocation_interrupted',
      invocationId: SECRET,
      dispatchCertainty: 'unknown',
      reasonCode: 'runtime_restored',
    });
    const unavailable = mapRuntimeMetadata({
      type: 'model.invocation_evidence_unavailable',
      invocationId: SECRET,
      reasonCode: 'artifact_missing',
    });

    expect(interrupted).toMatchObject({ status: 'unknown', metadata: {} });
    expect(unavailable).toMatchObject({ status: 'unknown', metadata: {} });
    expect(JSON.stringify([interrupted, unavailable])).not.toContain(SECRET);
  });

  test('release and provider audit fields accept only bounded low-cardinality values', () => {
    const invalid = mapSessionBoundaryMetadata('session.start', 'ok', {
      releaseVersion: `2026.7.30-${SECRET}`,
      releaseProfile: SECRET as 'limited',
      releaseCohort: `phase-${SECRET}`,
    });
    expect(invalid.metadata).toEqual({});
    expect(JSON.stringify(invalid)).not.toContain(SECRET);
  });

  test('metadata collector writes allowlisted records without summary content', async () => {
    const threadId = 'metadata';
    cleanup(threadId);
    const collector = new SessionLogCollector(
      threadId,
      ABSOLUTE_PATH,
      FRONTEND,
      { provider: SECRET, name: SECRET },
      { mode: 'metadata' },
    );
    collector.recordRuntime({
      type: 'user.message_appended',
      messageId: SECRET,
      content: `${COMMAND}\n${SOURCE_MARKER}`,
    });
    collector.recordRuntime({
      type: 'tool.finished',
      toolCallId: SECRET,
      name: 'shell_execute',
      result: {
        ok: false,
        command: COMMAND,
        exitCode: 1,
        stdout: SOURCE_MARKER,
        stderr: ABSOLUTE_PATH,
      },
      outcome: FAILED_OUTCOME,
    });
    await collector.finalize('fatal');

    const directory = sessionLogDir(FRONTEND, threadId);
    const output = readFileSync(join(directory, 'events.jsonl'), 'utf8');
    expect(output).not.toContain(SECRET);
    expect(output).not.toContain(ABSOLUTE_PATH);
    expect(output).not.toContain(COMMAND);
    expect(output).not.toContain(SOURCE_MARKER);
    expect(output).toContain('"eventType":"tool.finished"');
    expect(output).toContain('"status":"error"');
    expect(existsSync(join(directory, 'summary.json'))).toBe(false);
    expect(existsSync(join(directory, 'errors.jsonl'))).toBe(false);
  });

  test('off mode creates no directory and does not fall back to content serializer', async () => {
    const threadId = 'off';
    cleanup(threadId);
    const collector = new SessionLogCollector(
      threadId,
      ABSOLUTE_PATH,
      FRONTEND,
      { provider: SECRET, name: SECRET },
      { mode: 'off' },
    );
    collector.recordRuntime({
      type: 'user.message_appended',
      messageId: SECRET,
      content: SECRET,
    });
    await collector.finalize('completed');

    expect(existsSync(sessionLogDir(FRONTEND, threadId))).toBe(false);
  });
});
