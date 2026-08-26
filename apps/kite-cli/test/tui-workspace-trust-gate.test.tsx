import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  type KiteAppControlClient,
  WORKSPACE_TRUST_DECISION_REQUEST_SCHEMA_,
  WORKSPACE_TRUST_QUERY_REQUEST_SCHEMA_,
  WORKSPACE_TRUST_QUERY_RESPONSE_SCHEMA_,
  type WorkspaceTrustDecisionResponse,
  type WorkspaceTrustQueryRequest,
  type WorkspaceTrustQueryResponse,
} from '@kite-ai/kite-app-contract';
import { render } from 'ink-testing-library';
import WorkspaceTrustGate from '../src/tui/components/WorkspaceTrustGate';

const WORKSPACE = '/requested/workspace';
const CANONICAL_WORKSPACE = {
  canonicalPath: '/canonical/workspace',
  projectId: 'project_workspace',
  workspaceDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
} as const;

function queryResponse(
  status: WorkspaceTrustQueryResponse['status'],
  revision: string,
  canDecide = status === 'unknown',
): WorkspaceTrustQueryResponse {
  return {
    schema: WORKSPACE_TRUST_QUERY_RESPONSE_SCHEMA_,
    workspace: CANONICAL_WORKSPACE,
    status,
    revision,
    canDecide,
  };
}

function clientFixture(input: {
  readonly queries: WorkspaceTrustQueryResponse[];
  readonly decisions?: WorkspaceTrustDecisionResponse[];
}) {
  const queryRequests: WorkspaceTrustQueryRequest[] = [];
  const decisionRequests: unknown[] = [];
  let queryIndex = 0;
  let decisionIndex = 0;
  const client = {
    queryWorkspaceTrust: async (request: WorkspaceTrustQueryRequest) => {
      queryRequests.push(request);
      const response = input.queries[Math.min(queryIndex++, input.queries.length - 1)];
      if (!response) throw new Error('No Workspace Trust query fixture configured.');
      return response;
    },
    decideWorkspaceTrust: async (
      request: Parameters<KiteAppControlClient['decideWorkspaceTrust']>[0],
    ) => {
      decisionRequests.push(request);
      const response =
        input.decisions?.[Math.min(decisionIndex++, (input.decisions?.length ?? 1) - 1)];
      if (!response) throw new Error('No Workspace Trust decision fixture configured.');
      return response;
    },
  } as unknown as KiteAppControlClient;
  return { client, queryRequests, decisionRequests };
}

async function waitForFrameText(lastFrame: () => string | undefined, text: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!(lastFrame() ?? '').includes(text)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for frame text: ${text}`);
    await Bun.sleep(5);
  }
}

describe('WorkspaceTrustGate App Control client boundary', () => {
  test('queries on mount and trusts the returned canonical identity with CAS revision', async () => {
    const fixture = clientFixture({
      queries: [queryResponse('unknown', 'trust-revision-1')],
      decisions: [
        {
          schema: 'kite.app.workspace-trust.decision-response.v1',
          workspace: CANONICAL_WORKSPACE,
          status: 'trusted',
          outcome: 'recorded',
          revision: 'trust-revision-2',
        },
      ],
    });
    let trusted = 0;
    const view = render(
      <WorkspaceTrustGate
        workspace={WORKSPACE}
        appControl={fixture.client}
        onTrusted={() => {
          trusted += 1;
        }}
      />,
    );

    await waitForFrameText(view.lastFrame, 'Trust status: unknown');
    expect(fixture.queryRequests).toEqual([
      { schema: WORKSPACE_TRUST_QUERY_REQUEST_SCHEMA_, workspace: WORKSPACE },
    ]);

    view.stdin.write('\x1b[A');
    await waitForFrameText(view.lastFrame, '› Trust this workspace and continue');
    view.stdin.write('\r');
    await waitForFrameText(view.lastFrame, 'Saving workspace trust…');
    await eventually(() => fixture.decisionRequests.length === 1);

    expect(fixture.decisionRequests).toEqual([
      {
        schema: WORKSPACE_TRUST_DECISION_REQUEST_SCHEMA_,
        workspace: CANONICAL_WORKSPACE,
        observedStatus: 'unknown',
        expectedRevision: 'trust-revision-1',
        decision: 'trust',
      },
    ]);
    expect(trusted).toBe(1);
    view.unmount();
  });

  test('re-queries after conflict without replaying the trust mutation', async () => {
    const fixture = clientFixture({
      queries: [
        queryResponse('unknown', 'trust-revision-1'),
        queryResponse('unknown', 'trust-revision-2'),
      ],
      decisions: [
        {
          schema: 'kite.app.workspace-trust.decision-response.v1',
          workspace: CANONICAL_WORKSPACE,
          status: 'unknown',
          outcome: 'conflict',
          revision: 'trust-revision-2',
        },
      ],
    });
    let trusted = 0;
    const view = render(
      <WorkspaceTrustGate
        workspace={WORKSPACE}
        appControl={fixture.client}
        onTrusted={() => {
          trusted += 1;
        }}
      />,
    );
    await waitForFrameText(view.lastFrame, 'Trust status: unknown');
    view.stdin.write('\x1b[A');
    await waitForFrameText(view.lastFrame, '› Trust this workspace and continue');
    view.stdin.write('\r');

    await eventually(() => fixture.queryRequests.length === 2);
    await eventually(() => fixture.decisionRequests.length === 1);
    expect(fixture.decisionRequests).toHaveLength(1);
    expect(fixture.queryRequests[1]).toEqual({
      schema: WORKSPACE_TRUST_QUERY_REQUEST_SCHEMA_,
      workspace: WORKSPACE,
    });
    expect(trusted).toBe(0);
    view.unmount();
  });

  test.each([
    'corrupt',
    'unavailable',
  ] as const)('renders %s status from App Control', async (status) => {
    const fixture = clientFixture({
      queries: [queryResponse(status, `${status}-revision`, false)],
    });
    const view = render(
      <WorkspaceTrustGate workspace={WORKSPACE} appControl={fixture.client} onTrusted={() => {}} />,
    );
    await waitForFrameText(view.lastFrame, `Trust status: ${status}`);
    expect(view.lastFrame()).toContain('Workspace trust needs attention');
    view.unmount();
  });

  test('decline keeps the exit path and never calls App Control mutation', async () => {
    const fixture = clientFixture({ queries: [queryResponse('unknown', 'trust-revision-1')] });
    const view = render(
      <WorkspaceTrustGate workspace={WORKSPACE} appControl={fixture.client} onTrusted={() => {}} />,
    );
    await waitForFrameText(view.lastFrame, '› Exit Kite Code');
    view.stdin.write('\r');
    await Bun.sleep(10);
    expect(fixture.decisionRequests).toHaveLength(0);
    view.unmount();
  });

  test('does not import or access the legacy Workspace Trust store', () => {
    const source = readFileSync(
      new URL('../src/tui/components/WorkspaceTrustGate.tsx', import.meta.url),
      'utf8',
    );
    expect(source).not.toContain('config/workspace-trust');
    expect(source).not.toContain('workspaceTrustPath');
    expect(source).not.toContain('trustWorkspace');
  });
});

async function eventually(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for App Control call.');
    await Bun.sleep(5);
  }
}
