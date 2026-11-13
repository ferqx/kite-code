import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecutionRecord } from '@kite-ai/agent/storage';
import { expect, test } from '#kite-test';
import { canonicalJson } from '../../../../packages/agent/src/json';
import { spawn as spawnFixtureProcess } from '../../../../scripts/tooling/process';
import {
  originalExternalShellScope,
  originalShellJobStopped,
  parseAllToolMode,
  reconnectReplyMatches,
  recoveredContextRefresh,
  reusedAgentReplyMatches,
  type ShellDispatchRecord,
  stoppedOriginalBackgroundShell,
} from './model-tools-extended-cases';

test('all-tools mode is explicit, finite, and defaults to the original Full fixture', () => {
  expect(parseAllToolMode([])).toBe('full');
  for (const mode of ['accept_edits', 'auto', 'full'] as const)
    expect(parseAllToolMode([`--mode=${mode}`])).toBe(mode);
  for (const args of [['--mode=ask'], ['--mode='], ['--mode=auto', '--mode=full']])
    expect(() => parseAllToolMode(args)).toThrow('all_tools_mode_invalid');
});

test('a live context refresh requires zero dispatch and exact later successful recovery under a new model decision', () => {
  const stopped = {
    id: 'blocked',
    kind: 'tool',
    status: 'failed',
    authorization: { dispatched: false },
    originStoreId: 'store',
    sessionId: 'session',
    runId: 'run',
    rootWorkCommandId: 'work',
    rootWorkSeq: '2',
    definitionId: 'shell.execute',
    definitionVersion: '1',
    input: { command: 'printf original' },
    stepId: 'before-refresh',
    decisionSource: { kind: 'model_decision', modelExecutionId: 'original-model' },
    result: {
      outcome: 'failed',
      details: {
        code: 'context_refresh_required',
        adapterAttempted: false,
        dispatchCommitted: false,
      },
    },
  } as unknown as ExecutionRecord;
  const recovered = {
    ...stopped,
    id: 'completed',
    status: 'succeeded',
    authorization: { dispatched: true },
    stepId: 'after-refresh',
    decisionSource: { kind: 'model_decision', modelExecutionId: 'fresh-model' },
    result: { outcome: 'succeeded', content: 'original' },
  } as ExecutionRecord;
  expect(recoveredContextRefresh(stopped, [stopped, recovered])).toBe(true);
  expect(recoveredContextRefresh(stopped, [recovered, stopped])).toBe(false);
  expect(recoveredContextRefresh(stopped, [stopped])).toBe(false);
  for (const patch of [
    { status: 'outcome_unknown' },
    { authorization: { dispatched: true } },
    { result: { details: { code: 'context_refresh_required', adapterAttempted: true } } },
    { result: { details: { code: 'invalid_tool_arguments', adapterAttempted: false } } },
  ]) {
    const changed = { ...stopped, ...patch } as ExecutionRecord;
    expect(recoveredContextRefresh(changed, [changed, recovered])).toBe(false);
  }
  for (const patch of [
    { status: 'failed' },
    { authorization: { dispatched: false } },
    { originStoreId: 'other-store' },
    { sessionId: 'other-session' },
    { runId: 'other-run' },
    { rootWorkCommandId: 'other-work' },
    { definitionVersion: '2' },
    { input: { command: 'printf replacement' } },
    { stepId: stopped.stepId },
    { decisionSource: stopped.decisionSource },
  ])
    expect(
      recoveredContextRefresh(stopped, [stopped, { ...recovered, ...patch } as ExecutionRecord]),
    ).toBe(false);
  expect(
    recoveredContextRefresh(stopped, [
      stopped,
      { ...recovered, kind: 'job', parentExecutionId: stopped.id },
      recovered,
    ]),
  ).toBe(false);
});

function nativeEvidence(stopped: boolean) {
  const identity = (pid: number, parentPid: number) => ({
    pid,
    parentPid,
    birth: { seconds: '1', microseconds: 1 },
    unavailable: [],
  });
  return {
    version: 1,
    coverage: 'shell-owned-coalition',
    binding: { sessionId: 's', executionId: 'job', nonce: 'original-nonce' },
    ownerPid: 30,
    broker: {
      ...identity(32, 30),
      exit: stopped ? { code: 0, signal: null, reaped: true } : null,
      kernelState: stopped ? 'absent' : 'alive',
    },
    guardian: { ...identity(33, 1), exit: null, kernelState: stopped ? 'absent' : 'alive' },
    root: {
      identity: identity(34, 33),
      observation: stopped ? { kind: 2, status: 15 } : null,
      observationFailed: false,
      reaped: stopped,
      waitpid: stopped ? { pid: 34, status: 15, statusMatched: true } : null,
    },
    coalition: {
      id: '1',
      guardianUniqueId: '2',
      guardianPidVersion: 3,
      claimTaskCount: 1,
      terminalTaskCount: stopped ? 1 : null,
      processTreeStopped: stopped,
      label: 'com.kitecode.shell.12345678-1234-1234-1234-123456789abc',
      domain: 'user/501',
      registrationRemoved: stopped,
    },
  };
}
function background() {
  const details = {
    accepted: true,
    shell_id: 'original',
    ref: {
      key: 'original',
      extensionId: 'builtin.shell',
      executionId: 'job',
      sessionId: 's',
      originStoreId: 'store',
      commandId: 'operation',
    },
  };
  return [
    {
      id: 'tool',
      kind: 'tool',
      definitionId: 'shell.execute',
      definitionVersion: '1',
      status: 'succeeded',
      sessionId: 's',
      originStoreId: 'store',
      rootWorkCommandId: 'work',
      rootWorkSeq: '1',
      authorization: { dispatched: true },
      input: {
        background: true,
        command: 'printf original',
        filesystem: 'workspace_write',
        network: 'none',
      },
      result: { outcome: 'succeeded', content: JSON.stringify(details), details },
    },
    {
      id: 'job',
      kind: 'job',
      definitionId: 'shell.command',
      definitionVersion: '1',
      parentExecutionId: 'tool',
      sessionId: 's',
      originStoreId: 'store',
      rootWorkCommandId: 'work',
      rootWorkSeq: '1',
      originCommandId: 'operation',
      cancelWithParent: true,
      status: 'cancelled',
      input: {
        command: 'printf original',
        permissions: { filesystem: 'workspace_write', network: 'none' },
      },
      reference: {
        executionId: 'job',
        nonce: 'original-nonce',
        supervisorPid: 32,
        launchdGuardianPid: 33,
        coalitionId: '1',
        ownedProcesses: nativeEvidence(false),
        confinement: {
          backend: 'macos-seatbelt',
          profileDigest: 'a'.repeat(64),
          subprocesses: 'coalition_owned',
        },
      },
      result: {
        outcome: 'cancelled',
        details: {
          groupStopped: true,
          processTreeStopped: true,
          ownedProcesses: nativeEvidence(true),
        },
      },
    },
  ] as unknown as ExecutionRecord[];
}

test('background stop requires the current original starter, exact Job and confirmed process cleanup', () => {
  expect(stoppedOriginalBackgroundShell(background())).toBe(true);
  const supervised = background();
  const details = (supervised[1]!.result as { details: Record<string, unknown> }).details;
  details.groupStopped = true;
  expect(stoppedOriginalBackgroundShell(supervised)).toBe(true);
  for (const mutate of [
    (rows: ExecutionRecord[]) => {
      rows[0]!.definitionId = 'shell.launch';
    },
    (rows: ExecutionRecord[]) => {
      rows[1]!.parentExecutionId = 'another-tool';
    },
    (rows: ExecutionRecord[]) => {
      rows[1]!.sessionId = 'another-session';
    },
    (rows: ExecutionRecord[]) => {
      rows[1]!.status = 'running';
    },
    (rows: ExecutionRecord[]) => {
      rows[1]!.result = {
        outcome: 'cancelled',
        details: { cleanupConfirmed: true, processTreeStopped: false },
      };
    },
    (rows: ExecutionRecord[]) => {
      rows[1]!.result = {
        outcome: 'cancelled',
        details: { cleanupConfirmed: false, groupStopped: true, processTreeStopped: true },
      };
    },
    (rows: ExecutionRecord[]) => {
      rows[1]!.result = {
        outcome: 'cancelled',
        details: { groupStopped: false, processTreeStopped: true },
      };
    },
    (rows: ExecutionRecord[]) => {
      rows[0]!.result = { outcome: 'succeeded', content: 'shell_id: original', details: {} };
    },
  ]) {
    const rows = background();
    mutate(rows);
    expect(stoppedOriginalBackgroundShell(rows)).toBe(false);
  }
  const rows = background();
  rows.push(structuredClone(rows[0]!));
  expect(stoppedOriginalBackgroundShell(rows)).toBe(false);
});

test('original native stop proof rejects nonce, process, tree and sibling substitutions', () => {
  for (const mutate of [
    (rows: ExecutionRecord[]) => {
      (rows[1]!.reference as Record<string, unknown>).nonce = 'another';
    },
    (rows: ExecutionRecord[]) => {
      (rows[1]!.reference as Record<string, unknown>).supervisorPid = 99;
    },
    (rows: ExecutionRecord[]) => {
      rows[1]!.rootWorkCommandId = 'another-work';
    },
    (rows: ExecutionRecord[]) => {
      rows[1]!.status = 'outcome_unknown';
    },
    (rows: ExecutionRecord[]) => {
      const d = (rows[1]!.result as { details: Record<string, unknown> }).details;
      d.ownedProcesses = {
        ...nativeEvidence(true),
        binding: { sessionId: 's', executionId: 'another-job', nonce: 'original-nonce' },
      };
    },
    (rows: ExecutionRecord[]) => {
      const d = (rows[1]!.result as { details: Record<string, unknown> }).details;
      const p = nativeEvidence(true);
      p.coalition.registrationRemoved = false;
      d.ownedProcesses = p;
    },
    (rows: ExecutionRecord[]) => {
      const d = (rows[1]!.result as { details: Record<string, unknown> }).details;
      const p = nativeEvidence(true);
      p.root.reaped = false;
      d.ownedProcesses = p;
    },
    (rows: ExecutionRecord[]) => {
      const d = (rows[1]!.result as { details: Record<string, unknown> }).details;
      delete d.ownedProcesses;
      d.cleanupConfirmed = true;
    },
  ]) {
    const rows = background();
    mutate(rows);
    expect(stoppedOriginalBackgroundShell(rows)).toBe(false);
  }
});

function externalScope() {
  const rows = background();
  (rows[0]!.input as Record<string, unknown>).filesystem = 'full_access';
  (rows[1]!.input as Record<string, unknown>).permissions = {
    filesystem: 'full_access',
    network: 'none',
  };
  const current = {
    namespace: 'builtin.permissions',
    version: '1',
    data: {
      capability: {
        kind: 'job',
        definitionId: 'shell.command',
        definitionVersion: '1',
        hardAllowed: true,
        executionScope: { filesystem: 'full_access', network: 'none' },
      },
    },
  };
  const authorization = {
    allowed: true,
    definitionVersion: '1',
    inputDigest: createHash('sha256').update(canonicalJson(rows[1]!.input)).digest('hex'),
    snapshot: {
      namespace: 'builtin.business.permissions',
      version: '1',
      data: {
        current,
        gate: {
          namespace: 'builtin.planning',
          version: '1',
          data: { planning: { status: 'disabled' } },
        },
      },
    },
  };
  const original: ShellDispatchRecord = {
    id: 'job',
    session_id: 's',
    origin_store_id: 'store',
    parent_execution_id: 'tool',
    intent_json: JSON.stringify(rows[1]!.input),
    reference_json: JSON.stringify(rows[1]!.reference),
    dispatch_authorization_json: JSON.stringify(authorization),
  };
  return { rows, original, authorization };
}

test('external scope requires the original final dispatch and native profile binding, not requested scope alone', () => {
  const valid = externalScope();
  expect(originalExternalShellScope(valid.rows[0], valid.rows[1]!, valid.original)).toBe(true);
  for (const mutate of [
    (f: ReturnType<typeof externalScope>) => {
      f.original.id = 'another-job';
    },
    (f: ReturnType<typeof externalScope>) => {
      f.original.session_id = 'sibling';
    },
    (f: ReturnType<typeof externalScope>) => {
      f.authorization.allowed = false;
    },
    (f: ReturnType<typeof externalScope>) => {
      f.authorization.inputDigest = '0'.repeat(64);
    },
    (f: ReturnType<typeof externalScope>) => {
      f.authorization.snapshot.data.current.data.capability.executionScope.filesystem =
        'workspace_write';
    },
    (f: ReturnType<typeof externalScope>) => {
      (
        f.rows[1]!.reference as { confinement: { profileDigest: string } }
      ).confinement.profileDigest = 'b'.repeat(64);
    },
    (f: ReturnType<typeof externalScope>) => {
      const ref = f.rows[1]!.reference as { confinement: { profileDigest: string } };
      ref.confinement.profileDigest = 'not-a-profile-digest';
      f.original.reference_json = JSON.stringify(ref);
    },
    (f: ReturnType<typeof externalScope>) => {
      (f.rows[1]!.reference as Record<string, unknown>).nonce = 'wrong';
    },
    (f: ReturnType<typeof externalScope>) => {
      f.rows[1]!.parentExecutionId = 'another-tool';
    },
  ]) {
    const f = externalScope();
    mutate(f);
    f.original.dispatch_authorization_json = JSON.stringify(f.authorization);
    expect(originalExternalShellScope(f.rows[0], f.rows[1]!, f.original)).toBe(false);
  }
});

test('Windows owned Job closure stays a current platform proof rather than a cleanup boolean fallback', () => {
  const rows = background();
  const ref = rows[1]!.reference as Record<string, unknown>;
  ref.confinement = {
    backend: 'windows-restricted-token-job',
    filesystem: 'workspace_write',
    network: 'none',
  };
  delete ref.ownedProcesses;
  const owned = {
    version: 1,
    coverage: 'windows-job-members',
    root: { pid: 32, creationTime: '123456789', exitCode: 0, waitConfirmed: true },
    job: { activeProcesses: 0, treeStopped: true, terminationRequested: true },
    closed: true,
    closeUnknown: false,
  };
  rows[1]!.result = {
    outcome: 'cancelled',
    details: { processTreeStopped: true, cleanupConfirmed: true, ownedProcesses: owned },
  };
  expect(originalShellJobStopped(rows[0], rows[1]!)).toBe(true);
  for (const mutate of [
    (p: typeof owned) => {
      p.root.pid = 99;
    },
    (p: typeof owned) => {
      p.root.waitConfirmed = false;
    },
    (p: typeof owned) => {
      p.job.activeProcesses = 1;
    },
    (p: typeof owned) => {
      p.closed = false;
    },
    (p: typeof owned) => {
      p.closeUnknown = true;
    },
  ]) {
    const changed = structuredClone(rows),
      proof = structuredClone(owned);
    mutate(proof);
    (changed[1]!.result as { details: Record<string, unknown> }).details.ownedProcesses = proof;
    expect(originalShellJobStopped(changed[0], changed[1]!)).toBe(false);
  }
});

test('reply formatting may vary while exact tokens and arithmetic must remain correct', () => {
  const token = 'RECONNECT-12345678-1234-1234-1234-123456789abc';
  for (const text of [`${token}; 31 × 37 = 1147.`, `${token}\n31 * 37 = 1,147`])
    expect(reconnectReplyMatches(text, token)).toBe(true);
  for (const text of [
    `RECONNECT-22345678-1234-1234-1234-123456789abc 1147`,
    `${token} 11470`,
    `${token} 1,148`,
    `${token} -1147`,
    `${token} 1147.5`,
    `${token} 11,47`,
    `${token} 1147\nRECONNECT-22345678-1234-1234-1234-123456789abc`,
  ])
    expect(reconnectReplyMatches(text, token)).toBe(false);
  expect(reusedAgentReplyMatches('REUSED:A-token', 'A-token')).toBe(true);
  expect(reusedAgentReplyMatches('REUSED: A-token', 'A-token')).toBe(true);
  expect(reusedAgentReplyMatches('REUSED:B-token', 'A-token')).toBe(false);
  expect(reusedAgentReplyMatches('REUSED: A-token copied-extra', 'A-token')).toBe(false);
});

test('live all-tools refuses missing opt-in and unsupported modes before creating evidence or opening any model', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kite-all-tools-admission-'));
  try {
    for (const [enabled, args, reason] of [
      ['0', ['--mode=auto'], 'all_tools_requires_opt_in_and_new_absolute_output'],
      [
        '0',
        ['--mode=auto', '--model=gpt-6-luna', '--reasoning-effort=medium'],
        'all_tools_requires_opt_in_and_new_absolute_output',
      ],
      ['1', ['--mode=auto', '--model=unsupported'], 'live_approval_execution_model_invalid'],
      ['1', ['--mode=unknown'], 'all_tools_mode_invalid'],
      ['1', ['--mode=auto', '--mode=full'], 'all_tools_mode_invalid'],
      ['1', ['--mode=auto', '--unknown=1'], 'all_tools_requires_opt_in_and_new_absolute_output'],
    ] as const) {
      const output = join(root, 'report.json');
      const child = spawnFixtureProcess(
        [
          process.execPath,
          ...process.execArgv,
          join(import.meta.dirname, 'model-tools-all.live.ts'),
          `--output=${output}`,
          ...args,
        ],
        {
          env: { ...process.env, KITE_RUN_LIVE_MODEL_TOOLS: enabled },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code).not.toBe(0);
      expect(stdout).toBe('');
      expect(stderr).toContain(reason);
      expect(existsSync(output)).toBe(false);
      expect(existsSync(`${output}.workspace`)).toBe(false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);
