import { describe, expect, test } from 'bun:test';
import {
  getRoleConfig,
  rejectShellOutsideSubAgentRoleCeilingV1,
  resolveSubAgentShellExecutorV1,
} from '../src/index';
import type { ShellInput, ShellResult } from '../src/sandbox';

function shellInput(command: string): ShellInput {
  return { workspace: '/workspace', command };
}

function successfulResult(input: ShellInput): ShellResult {
  return {
    ok: true,
    command: input.command,
    exitCode: 0,
    stdout: 'ok',
    stderr: '',
  };
}

describe('Builtin subagent shell role ceiling', () => {
  test('returns the stable rejection envelope without invoking a shell', () => {
    const result = rejectShellOutsideSubAgentRoleCeilingV1(
      getRoleConfig('explore'),
      'rm output.txt',
    );

    expect(result).toEqual({
      ok: false,
      command: 'rm output.txt',
      exitCode: -1,
      stdout: '',
      stderr:
        'Command rejected: "rm output.txt" is not a read-only command. This sub-agent has read-only access only.',
      status: 'rejected',
      classifierAdviceV1: {
        detailCode: 'policy_denied',
        disposition: 'never',
        maximumAdditionalCalls: 0,
        requiresNewModelResponse: false,
        safeAutomaticRetry: false,
      },
    });
  });

  test('allows a proven read-only command for restricted roles', () => {
    expect(
      rejectShellOutsideSubAgentRoleCeilingV1(getRoleConfig('explore'), 'pwd'),
    ).toBeUndefined();
  });

  test('fails closed before the supplied executor for a restricted role', async () => {
    let calls = 0;
    const executor = resolveSubAgentShellExecutorV1(getRoleConfig('explore'), async (input) => {
      calls += 1;
      return successfulResult(input);
    });

    expect(executor).toBeDefined();
    await expect(executor!(shellInput('touch output.txt'))).resolves.toMatchObject({
      ok: false,
      status: 'rejected',
      command: 'touch output.txt',
    });
    expect(calls).toBe(0);
  });

  test('does not add a ceiling to the unrestricted code role', async () => {
    let calls = 0;
    const executor = resolveSubAgentShellExecutorV1(getRoleConfig('code'), async (input) => {
      calls += 1;
      return successfulResult(input);
    });

    expect(await executor!(shellInput('touch output.txt'))).toEqual({
      ok: true,
      command: 'touch output.txt',
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
    });
    expect(calls).toBe(1);
  });
});
