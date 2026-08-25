import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  projectBuiltinToolResultDigests,
  toolExecutionModelContent,
} from '../src/tool-result-projection';

describe('Builtin tool result projection', () => {
  test('binds raw and model digests to the complete successful result', () => {
    const input = {
      ok: true,
      stdout: 'done',
      stderr: '',
      exitCode: 0,
      status: 'success' as const,
    };

    expect(projectBuiltinToolResultDigests(input)).toEqual({
      contentDigest: createHash('sha256').update(toolExecutionModelContent(input)).digest('hex'),
      rawResultDigest: createHash('sha256')
        .update(
          JSON.stringify({
            stdout: input.stdout,
            stderr: input.stderr,
            exitCode: input.exitCode,
            status: input.status,
          }),
        )
        .digest('hex'),
      modelContentDigest: createHash('sha256')
        .update(toolExecutionModelContent(input))
        .digest('hex'),
      digestScope: 'raw',
    });
  });

  test('preserves a supplied raw digest while marking truncated output projected', () => {
    expect(
      projectBuiltinToolResultDigests({
        ok: false,
        stdout: '',
        stderr: 'projected failure',
        exitCode: 1,
        status: 'error',
        rawResultDigest: 'raw-digest',
        truncated: true,
      }),
    ).toEqual({
      contentDigest: createHash('sha256').update('projected failure').digest('hex'),
      rawResultDigest: 'raw-digest',
      modelContentDigest: createHash('sha256').update('projected failure').digest('hex'),
      digestScope: 'projected',
    });
  });

  test('does not invent a raw digest for truncated output', () => {
    const projection = projectBuiltinToolResultDigests({
      ok: true,
      stdout: 'partial',
      stderr: '',
      exitCode: 0,
      status: 'success',
      truncated: true,
    });

    expect(projection.digestScope).toBe('projected');
    expect(projection.rawResultDigest).toBeUndefined();
    expect(Object.isFrozen(projection)).toBe(true);
  });
});
