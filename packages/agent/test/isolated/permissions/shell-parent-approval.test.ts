import { expect, test } from 'bun:test';
import type {
  AuthorizationRequest,
  Extension,
  Json,
  PermissionDecision,
} from '@kite-ai/agent/extensions';
import { grantDigest } from '../../../src/permission-grants';
import { createShellToolBehaviors } from '../../../src/tools/shell-approval';

function setup(qualification: string) {
  function unexpected(): never {
    throw Error('Fixture must not run a process');
  }
  const extension: Extension = {
    id: 'builtin.shell',
    version: '1',
    apiMajor: 1,
    tools: [
      {
        id: 'shell.execute',
        version: '1',
        description: 'fixture',
        inputSchema: {},
        execute: unexpected,
      },
    ],
    jobs: [
      {
        id: 'shell.command',
        version: '1',
        description: 'fixture',
        inputSchema: {},
        start: unexpected,
        observe: unexpected,
        cancel: unexpected,
        dispose: unexpected,
      },
    ],
  };
  const [tool, job] = createShellToolBehaviors({
    extensions: [extension],
    snapshot: { qualification, host: {} },
    commandDigest: () => 'c'.repeat(64),
    prepareRiskReview: async () => null,
  });
  const scope = { filesystem: 'workspace_write', network: 'internet' };
  const baseInput = { command: 'printf approved', workdir: '/owned', ...scope };
  const parentRequest: AuthorizationRequest = {
    kind: 'tool',
    sessionId: 's',
    runId: 'r',
    executionId: 'parent',
    definitionId: 'shell.execute',
    definitionVersion: '1',
    input: baseInput,
    signal: new AbortController().signal,
  };
  const jobRequest: AuthorizationRequest = {
    ...parentRequest,
    kind: 'job',
    runId: null,
    executionId: 'job',
    definitionId: 'shell.command',
    input: { command: baseInput.command, workdir: baseInput.workdir, permissions: scope },
  };
  const decision: PermissionDecision = {
    allowed: false,
    revision: 'stock',
    reason: 'approval_required',
    approval: { request: { mode: 'accept_edits' } },
  };
  function context(input: Json = baseInput) {
    return {
      parent: {
        executionId: parentRequest.executionId,
        kind: parentRequest.kind,
        definitionId: parentRequest.definitionId,
        definitionVersion: parentRequest.definitionVersion,
        input,
        inputDigest: grantDigest(input),
      },
    };
  }
  return { baseInput, context, decision, job, jobRequest, parentRequest, tool };
}

test('only a qualified attached Mac Shell Tool can offer its proof for an exact child', async () => {
  const { baseInput, context, decision, jobRequest, tool } = setup(
    'macos_launchd_coalition_seatbelt',
  );
  const proofs: Json[] = [];
  const bridge = {
    worktree: async () => {
      throw Error('Unexpected separate bridge');
    },
    shell: async (proof: Json) => {
      proofs.push(proof);
      return null;
    },
  };
  const authorize = tool!.authorizeChild!;
  await authorize(jobRequest, decision, context(), bridge);
  expect(proofs).toEqual([
    {
      parentExecutionId: 'parent',
      parentInputDigest: grantDigest(baseInput),
      childInputDigest: grantDigest(jobRequest.input),
      operationDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      cancelWithParent: true,
      parentBindings: [{ kind: 'tool', definitionId: 'shell.execute', definitionVersion: '1' }],
    },
  ]);
  await authorize(jobRequest, { ...decision, approval: undefined }, context(), bridge);
  await authorize(jobRequest, decision, context({ ...baseInput, network: 'none' }), bridge);
  await authorize(jobRequest, decision, context({ ...baseInput, workdir: '/other-owned' }), bridge);
  await authorize(
    jobRequest,
    decision,
    context({ ...baseInput, command: 'printf changed' }),
    bridge,
  );
  await authorize(
    jobRequest,
    decision,
    context({ ...baseInput, cancellation: 'detached' }),
    bridge,
  );
  expect(proofs).toHaveLength(1);
});

test('Mac Request Approval ranges belong only to supported attached Tool; Auto and Windows stay separate', async () => {
  const f = setup('macos_launchd_coalition_seatbelt');
  expect(await f.tool!.grantOffers!(f.parentRequest, 'accept_edits')).toHaveLength(1);
  expect(await f.job!.grantOffers!(f.jobRequest, 'accept_edits')).toEqual([]);
  const detached = { ...f.parentRequest, input: { ...f.baseInput, cancellation: 'detached' } };
  expect(await f.tool!.grantOffers!(detached, 'accept_edits')).toEqual([]);
  expect(await f.tool!.grantOffers!(detached, 'auto')).toHaveLength(1);
  expect(await f.job!.grantOffers!(f.jobRequest, 'auto')).toHaveLength(1);
  expect(setup('windows_original_git_bash_current_user_job').tool!.authorizeChild).toBeUndefined();
  expect(setup('windows_unelevated_powershell_job').tool!.authorizeChild).toBeUndefined();
  expect(setup('linux_owned_pid_namespace_bubblewrap').tool!.authorizeChild).toBeUndefined();
});
