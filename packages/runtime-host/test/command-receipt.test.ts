import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { RuntimeCommand } from '@kite-ai/runtime-contract';
import {
  createRuntimeCommandCommitEvidence,
  digestRuntimeCommand,
  parseRuntimeStoredCommandReceipt,
  resolveRuntimeCommandReceipt,
} from '../src/host/command-receipt';
import { runtimeStartMessageId } from '../src/host/run-projection';
import { createRuntimeStoredCommandReceipt } from '../src/storage';

const DIGEST = 'a'.repeat(64);

function command(
  input = 'hello',
  nested: Readonly<Record<string, unknown>> = { a: 1, b: 2 },
): Extract<RuntimeCommand, { type: 'start_turn' }> {
  return {
    schema: 'kite.runtime-command.v1',
    commandId: 'command-1',
    type: 'start_turn',
    sessionId: 'session-1',
    expectedRevision: 0,
    input,
    initialSkills: [{ skillId: 'skill-1', input: nested }],
  };
}

function stored(commandInput = command()) {
  return createRuntimeStoredCommandReceipt(
    {
      ...createRuntimeCommandCommitEvidence({
        command: commandInput,
        targetSessionId: 'session-1',
        committedAt: 1_700_000_000_000,
      }),
      requestDigest: digestRuntimeCommand(commandInput),
    },
    3,
  );
}

describe('Host persistent command receipt helper', () => {
  test('hashes canonical JSON with sorted object keys and preserved array order', () => {
    const first = command('hello', { a: 1, b: 2 });
    const reorderedKeys = command('hello', { b: 2, a: 1 });
    const reorderedArray = {
      ...command(),
      initialSkills: [
        { skillId: 'skill-2', input: {} },
        { skillId: 'skill-1', input: { a: 1, b: 2 } },
      ],
    } satisfies RuntimeCommand;

    expect(digestRuntimeCommand(first)).toBe(digestRuntimeCommand(reorderedKeys));
    expect(digestRuntimeCommand(first)).not.toBe(digestRuntimeCommand(reorderedArray));
    expect(digestRuntimeCommand(first)).not.toBe(digestRuntimeCommand(command('different')));
  });

  test('rejects non-JSON values and prototype surprises', () => {
    const undefinedValue = { ...command(), input: undefined } as unknown as RuntimeCommand;
    const nullPrototype = Object.create(null) as Record<string, unknown>;
    nullPrototype.safe = true;
    const unusualPrototype = command('hello', nullPrototype);

    expect(() => digestRuntimeCommand(undefinedValue)).toThrow('not JSON-safe');
    expect(() => digestRuntimeCommand(unusualPrototype)).toThrow('unsafe object prototype');
  });

  test('uses runtimeCommandSessionId scope when constructing commit evidence', () => {
    const create = {
      schema: 'kite.runtime-command.v1',
      commandId: 'create-1',
      type: 'create_session',
      workspace: '/ignored-by-admission',
      bootstrapSessionId: 'created-session',
    } satisfies RuntimeCommand;
    const fork = {
      schema: 'kite.runtime-command.v1',
      commandId: 'fork-1',
      type: 'fork_session',
      sourceSessionId: 'source-session',
      sourceRevision: 4,
    } satisfies RuntimeCommand;

    expect(
      createRuntimeCommandCommitEvidence({
        command: create,
        targetSessionId: 'created-session',
        committedAt: 1,
      }).scopeSessionId,
    ).toBe('created-session');
    expect(
      createRuntimeCommandCommitEvidence({
        command: fork,
        targetSessionId: 'fork-target',
        committedAt: 1,
      }).scopeSessionId,
    ).toBe('source-session');
  });

  test('rejects malformed, noncanonical, extra-key, and identity-mismatched records', () => {
    const record = stored();
    const malformed = { ...record, originalReceiptJson: 'not-json' };
    const noncanonical = {
      ...record,
      originalReceiptJson: ` ${record.originalReceiptJson}`,
    };
    const extraKey = {
      ...record,
      originalReceiptJson:
        '{"status":"applied","commandId":"command-1","sessionId":"session-1","revision":3,"extra":true}',
    };
    const identityMismatch = {
      ...record,
      originalReceiptJson:
        '{"status":"applied","commandId":"other-command","sessionId":"session-1","revision":3}',
    };
    const revisionMismatch = {
      ...record,
      originalReceiptJson:
        '{"status":"applied","commandId":"command-1","sessionId":"session-1","revision":4}',
    };

    expect(() => parseRuntimeStoredCommandReceipt(malformed)).toThrow('JSON is malformed');
    expect(() => parseRuntimeStoredCommandReceipt(noncanonical)).toThrow('not canonical');
    expect(() => parseRuntimeStoredCommandReceipt(extraKey)).toThrow('does not match');
    expect(() => parseRuntimeStoredCommandReceipt(identityMismatch)).toThrow('does not match');
    expect(() => parseRuntimeStoredCommandReceipt(revisionMismatch)).toThrow('does not match');
  });

  test('replays the same command and rejects a body mismatch before preparation', () => {
    const original = command();
    const record = stored(original);

    expect(resolveRuntimeCommandReceipt(original, record)).toEqual({
      status: 'idempotent_replay',
      commandId: 'command-1',
      sessionId: 'session-1',
      originalRevision: 3,
    });
    expect(resolveRuntimeCommandReceipt(command('different'), record)).toEqual({
      status: 'rejected',
      commandId: 'command-1',
      code: 'invalid_command',
    });
    expect(() =>
      resolveRuntimeCommandReceipt({ ...original, commandId: 'another-command' }, record),
    ).toThrow('does not match the command scope');
  });

  test('returns the original closed Run resource and rejects result tampering', () => {
    const original = command();
    const json = JSON.stringify({
      schema: 'kite.runtime.run-resource-result.v1',
      run: {
        schema: 'kite.runtime-run.v1',
        sessionId: 'session-1',
        runId: 'run-1',
        phase: 'building',
        status: 'queued',
        createdRevision: 3,
        lastRevision: 3,
        createdAtMs: 1_700_000_000_000,
      },
    });
    const record = {
      ...stored(original),
      resourceResult: {
        schema: 'kite.runtime.run-resource-result.v1',
        json,
        digest: createHash('sha256').update(json).digest('hex'),
      },
    };
    expect(resolveRuntimeCommandReceipt(original, record)).toEqual({
      status: 'idempotent_replay',
      commandId: 'command-1',
      sessionId: 'session-1',
      originalRevision: 3,
      resource: {
        kind: 'run',
        messageId: runtimeStartMessageId('command-1'),
        run: {
          schema: 'kite.runtime-run.v1',
          sessionId: 'session-1',
          runId: 'run-1',
          phase: 'building',
          status: 'queued',
          createdRevision: 3,
          lastRevision: 3,
          createdAtMs: 1_700_000_000_000,
        },
      },
    });
    expect(() =>
      resolveRuntimeCommandReceipt(original, {
        ...record,
        resourceResult: { ...record.resourceResult, digest: 'b'.repeat(64) },
      }),
    ).toThrow('digest does not match');
  });

  test('retains a lowercase SHA-256 digest without persisting the command body', () => {
    const evidence = createRuntimeCommandCommitEvidence({
      command: command('private command body'),
      targetSessionId: 'session-1',
      committedAt: 1,
    });

    expect(evidence.requestDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(evidence)).not.toContain('private command body');
    expect(DIGEST).toHaveLength(64);
  });
});
