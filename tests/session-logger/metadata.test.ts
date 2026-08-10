import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { sessionLogDir } from '@/core/config/paths';
import type { RuntimeEvent } from '@/core/runtime/events';
import { classifyFailure } from '@/core/runtime/failures';
import {
  mapRuntimeMetadataV1,
  mapSessionBoundaryMetadataV1,
  SessionLogCollector,
} from '@/core/session-logger';

const FRONTEND = 'metadata-test';
const SECRET = 'UNIQUE_SECRET_1A2_91c53d';
const ABSOLUTE_PATH = `/private/tmp/${SECRET}/workspace/source.ts`;
const COMMAND = `curl -H 'Authorization: Bearer ${SECRET}' https://example.invalid`;
const SOURCE_MARKER = `function source_${SECRET}() { return '${SECRET}'; }`;

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
        outcomeV1: {
          schemaVersion: 1,
          status: 'failed',
          failure: { kind: 'tool_runtime_error', detailCode: 'runtime_exception' },
          dispatchState: 'started',
          externalEffects: 'unknown',
          recovery: {
            disposition: 'never',
            maximumAdditionalCalls: 0,
            requiresNewModelResponse: false,
            safeAutomaticRetry: false,
          },
          lineage: { failureInstanceId: SECRET, recoveryOf: ABSOLUTE_PATH },
          timing: { source: 'runtime_boundary', executionMs: 17, totalActiveMs: 31 },
          unknownFields: {
            hasUnknown: true,
            count: 2,
            toolClass: 'builtin_execute',
            schemaRevision: SECRET,
          },
        },
      },
      {
        type: 'tool.failed',
        toolCallId: SECRET,
        failure: classifyFailure('tool_runtime_error', `${SECRET}: ${ABSOLUTE_PATH}`),
      },
      {
        type: 'approval.requested',
        interactionId: SECRET,
        toolCallId: SECRET,
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
        },
      },
      {
        type: 'provider.data_policy_status',
        status: 'blocked',
        reason: 'mandatory_policy_unavailable',
        registryDigest: SECRET,
        policyRevision: SECRET,
      },
    ];

    const output = JSON.stringify(fixtures.map(mapRuntimeMetadataV1));
    for (const forbidden of [SECRET, ABSOLUTE_PATH, COMMAND, SOURCE_MARKER]) {
      expect(output).not.toContain(forbidden);
    }
    expect(output).toContain('"failureKind":"mandatory_policy_unavailable"');
    expect(output).toContain('"toolKind":"shell_execute"');
    expect(output).toContain('"toolKind":"other"');
    expect(output).toContain('"inputTokens":11');
    expect(output).toContain('"outputTokens":7');
    expect(output).toContain('"toolTotalActiveMs":31');
  });

  test('session boundary schema exposes only explicit release metadata', () => {
    const record = mapSessionBoundaryMetadataV1('session.start', 'ok', {
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

  test('release and provider audit fields accept only bounded low-cardinality values', () => {
    const provider = mapRuntimeMetadataV1({
      type: 'provider.data_policy_status',
      status: 'ready',
      reason: 'admitted',
      registryDigest: `sha256:${'a'.repeat(64)}`,
      policyRevision: 'm0-empty-2026-07-30',
    });
    expect(provider.metadata).toEqual({
      capabilityKind: 'provider_data_policy',
      approvalResult: 'admitted',
      providerPolicyDigest: `sha256:${'a'.repeat(64)}`,
      providerPolicyRevision: 'm0-empty-2026-07-30',
    });

    const invalid = mapSessionBoundaryMetadataV1('session.start', 'ok', {
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
