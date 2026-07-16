import { describe, expect, test } from 'bun:test';
import { render } from 'ink-testing-library';
import McpAuthPrompt from '@/app/tui/mcp/McpAuthPrompt';
import McpOverlay from '@/app/tui/mcp/McpOverlay';
import McpProjectTrustPrompt from '@/app/tui/mcp/McpProjectTrustPrompt';
import type { McpController, McpControllerSnapshot } from '@/app/tui/mcp/types';
import type { McpServerControlState, McpServerKey } from '@/core/mcp';

const pendingServer: Readonly<McpServerControlState> = Object.freeze({
  key: Object.freeze({ name: 'workspace-tools', source: 'project' }),
  effective: true,
  configStatus: 'pending_approval',
  authStatus: 'not_required',
  credentialPresent: false,
  health: 'disconnected',
  transport: 'stdio',
  source: 'project',
  sourcePath: '/workspace/.mcp.json',
  revision: 'project:workspace-tools:revision',
  enabled: true,
  required: false,
  toolCount: 0,
  availableToolCount: 0,
  resourceCount: 0,
  promptCount: 0,
  tools: Object.freeze([]),
  resources: Object.freeze([]),
  prompts: Object.freeze([]),
  approval: Object.freeze({
    configDigest: '1234567890abcdef',
    review: Object.freeze({ command: 'bun', argumentCount: 2 }),
  }),
  diagnostic: Object.freeze({
    code: 'approval_required',
    retryable: false,
    message: 'Project MCP server approval is required.',
  }),
});

const shadowedServer: Readonly<McpServerControlState> = Object.freeze({
  ...pendingServer,
  key: Object.freeze({ name: 'shadowed-tools', source: 'user' }),
  effective: false,
  source: 'user',
  sourcePath: '/home/user/.kite-code/kite-code.jsonc',
  revision: 'user:shadowed-tools:revision',
  approval: undefined,
});

const disconnectedServer: Readonly<McpServerControlState> = Object.freeze({
  ...pendingServer,
  key: Object.freeze({ name: 'offline-tools', source: 'user' }),
  configStatus: 'configured',
  source: 'user',
  sourcePath: '/home/user/.kite-code/kite-code.jsonc',
  revision: 'user:offline-tools:revision',
  approval: undefined,
});

const authServer: Readonly<McpServerControlState> = Object.freeze({
  ...disconnectedServer,
  key: Object.freeze({ name: 'oauth-tools', source: 'user' }),
  authStatus: 'login_required',
  transport: 'http',
  revision: 'user:oauth-tools:revision',
  diagnostic: Object.freeze({
    code: 'auth_required',
    retryable: false,
    message: 'Login required.',
  }),
});

class FakeController implements McpController {
  readonly decisions: string[] = [];
  readonly logins: string[] = [];
  readonly cancelledFlows: string[] = [];
  private readonly snapshot: McpControllerSnapshot = Object.freeze({
    control: Object.freeze({
      revision: 'snapshot-1',
      generation: 1,
      servers: Object.freeze([pendingServer, disconnectedServer, shadowedServer]),
      sourceRevisions: Object.freeze({ local: 'local', project: 'project', user: 'user' }),
    }),
  });

  getSnapshot = () => this.snapshot;
  subscribe = () => () => {};
  decide = async (key: McpServerKey, decision: 'approved' | 'rejected') => {
    this.decisions.push(`${key.name}:${decision}`);
    return true;
  };
  login = async (key: McpServerKey) => {
    this.logins.push(key.name);
    return true;
  };
  cancelAuth = async (flowId: string) => {
    this.cancelledFlows.push(flowId);
  };
}

describe('MCP read-only list', () => {
  test('shows only effective server names and connection status', () => {
    const controller = new FakeController();
    const { lastFrame } = render(<McpOverlay controller={controller} onClose={() => {}} />);

    expect(lastFrame()).toContain('MCP Servers');
    expect(lastFrame()).toContain('[pending-approval] workspace-tools');
    expect(lastFrame()).toContain('[disconnected] offline-tools');
    expect(lastFrame()).not.toContain('shadowed-tools');
    expect(lastFrame()).not.toContain('stdio');
    expect(lastFrame()).not.toContain('project');
    expect(lastFrame()).not.toContain('tools)');
    expect(lastFrame()).not.toContain('/workspace/.mcp.json');
  });

  test('does not expose detail or configuration actions', async () => {
    const controller = new FakeController();
    const { stdin, lastFrame } = render(<McpOverlay controller={controller} onClose={() => {}} />);

    stdin.write('\r');
    stdin.write('a');
    stdin.write('d');
    await Bun.sleep(10);

    expect(lastFrame()).toContain('[pending-approval] workspace-tools');
    expect(lastFrame()).not.toContain('detail');
    expect(lastFrame()).not.toContain('add');
    expect(controller.decisions).toEqual([]);
  });
});

describe('MCP authentication prompt', () => {
  test('is separate from the read-only list and starts only on explicit input', async () => {
    const controller = new FakeController();
    const { stdin, lastFrame } = render(
      <McpAuthPrompt controller={controller} server={authServer} onDefer={() => {}} />,
    );
    expect(lastFrame()).toContain('MCP authentication required');
    expect(lastFrame()).toContain('oauth-tools');
    expect(controller.logins).toEqual([]);
    stdin.write('\r');
    await Bun.sleep(10);
    expect(controller.logins).toEqual(['oauth-tools']);
  });

  test('cancels the active callback flow on Esc', async () => {
    const controller = new FakeController();
    const authorizing = Object.freeze({
      ...authServer,
      authStatus: 'authorizing' as const,
      authFlowId: 'flow-id',
    });
    const { stdin } = render(
      <McpAuthPrompt controller={controller} server={authorizing} onDefer={() => {}} />,
    );
    stdin.write('\x1b');
    await Bun.sleep(20);
    expect(controller.cancelledFlows).toEqual(['flow-id']);
  });
});

describe('Project MCP trust prompt', () => {
  test('is separate from /mcp and requires double confirmation', async () => {
    const controller = new FakeController();
    const { stdin, lastFrame } = render(
      <McpProjectTrustPrompt controller={controller} server={pendingServer} onDefer={() => {}} />,
    );

    expect(lastFrame()).toContain('Project MCP configuration');
    expect(lastFrame()).toContain('/workspace/.mcp.json');
    expect(lastFrame()).toContain('1234567890ab');
    expect(lastFrame()).toContain('Command: bun (2 arguments)');

    stdin.write('a');
    await Bun.sleep(10);
    expect(controller.decisions).toEqual([]);
    expect(lastFrame()).toContain('Press a again to confirm.');

    stdin.write('a');
    await Bun.sleep(10);
    expect(controller.decisions).toEqual(['workspace-tools:approved']);
  });

  test('defers without recording a decision', async () => {
    const controller = new FakeController();
    let deferred = false;
    const { stdin } = render(
      <McpProjectTrustPrompt
        controller={controller}
        server={pendingServer}
        onDefer={() => {
          deferred = true;
        }}
      />,
    );

    await Bun.sleep(10);
    stdin.write('\x1b');
    await Bun.sleep(30);
    expect(deferred).toBe(true);
    expect(controller.decisions).toEqual([]);
  });
});
