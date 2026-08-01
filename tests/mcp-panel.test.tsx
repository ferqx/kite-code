import { describe, expect, test } from 'bun:test';
import { render } from 'ink-testing-library';
import McpOverlay from '@/app/tui/mcp/McpOverlay';
import { buildServerActions, derivePrimaryStatus, moveSelection } from '@/app/tui/mcp/model';
import type { McpController, McpControllerSnapshot } from '@/app/tui/mcp/types';
import type { McpAuthResult, McpServerControlState, McpServerKey } from '@/core/mcp';

function server(overrides: Partial<McpServerControlState> = {}): Readonly<McpServerControlState> {
  const tools = ['click', 'close_page', 'drag', 'emulate', 'evaluate_script'].map(
    (name) =>
      ({
        name,
        discovered: true,
        description:
          name === 'click'
            ? `Clicks on the provided element ${'with complete wrapped documentation '.repeat(4)}END_DESCRIPTION`
            : undefined,
        parameters:
          name === 'click'
            ? Object.freeze([
                Object.freeze({
                  name: 'uid',
                  required: true,
                  type: 'string',
                  description: `The uid of an element on the page ${'from the page content snapshot '.repeat(4)}END_PARAMETER`,
                }),
                Object.freeze({
                  name: 'dblClick',
                  required: false,
                  type: 'boolean',
                  description: 'Set to true for double clicks.',
                }),
              ])
            : Object.freeze([]),
      }) as McpServerControlState['tools'][number],
  );
  return Object.freeze({
    key: Object.freeze({ name: 'github', source: 'project' }),
    effective: true,
    configStatus: 'configured',
    authStatus: 'not_required',
    credentialPresent: false,
    health: 'ready',
    transport: 'http',
    contentEgress: Object.freeze({
      remote: true,
      nonEmptyArgumentsClassification: 'confidential',
      independentPermitRequired: true,
    }),
    source: 'project',
    sourcePath: '/workspace/.kite-code/mcp.json',
    configuration: Object.freeze({ endpoint: 'https://example.com/mcp' }),
    revision: 'revision-1',
    enabled: true,
    required: false,
    toolCount: tools.length,
    availableToolCount: tools.length,
    resourceCount: 0,
    promptCount: 0,
    tools: Object.freeze(tools),
    resources: Object.freeze([]),
    prompts: Object.freeze([]),
    ...overrides,
  });
}

class FakeController implements McpController {
  readonly decisions: string[] = [];
  readonly logins: string[] = [];
  readonly cancelledFlows: string[] = [];
  readonly retries: string[] = [];
  readonly enabled: string[] = [];
  readonly added: string[] = [];
  readonly removed: string[] = [];
  private readonly snapshot: McpControllerSnapshot;
  private readonly addDelayMs: number;

  constructor(
    servers: readonly Readonly<McpServerControlState>[] = [server()],
    message?: string,
    addDelayMs = 0,
  ) {
    this.addDelayMs = addDelayMs;
    this.snapshot = Object.freeze({
      control: Object.freeze({
        revision: 'snapshot-1',
        generation: 1,
        servers: Object.freeze([...servers]),
        sourceRevisions: Object.freeze({ local: 'local-1', project: 'project-1', user: 'user-1' }),
      }),
      ...(message ? { message } : {}),
    });
  }

  getSnapshot = () => this.snapshot;
  subscribe = () => () => {};
  decide = async (key: McpServerKey, decision: 'approved' | 'rejected') => {
    this.decisions.push(`${key.name}:${decision}`);
    return true;
  };
  login = async (key: McpServerKey): Promise<McpAuthResult> => {
    this.logins.push(key.name);
    return { status: 'authorization_required', flowId: 'flow-1', authorizationUrl: 'https://x' };
  };
  cancelAuth = async (flowId: string) => {
    this.cancelledFlows.push(flowId);
  };
  retry = async (key: McpServerKey) => {
    this.retries.push(key.name);
    return true;
  };
  setEnabled = async (key: McpServerKey, _revision: string, enabled: boolean) => {
    this.enabled.push(`${key.name}:${enabled}`);
    return true;
  };
  add = async (input: {
    scope: 'project' | 'user';
    name: string;
    config: { type: 'http' | 'stdio'; url?: string; command?: string };
  }) => {
    this.added.push(`${input.scope}:${input.name}:${input.config.type}`);
    if (this.addDelayMs > 0) await Bun.sleep(this.addDelayMs);
    return { name: input.name, source: input.scope };
  };
  remove = async (key: McpServerKey) => {
    this.removed.push(key.name);
    return true;
  };
}

describe('MCP Select model', () => {
  test('derives status priority and complete rejected actions', () => {
    const rejected = server({
      configStatus: 'rejected',
      health: 'disconnected',
      approval: Object.freeze({
        configDigest: 'digest',
        review: Object.freeze({ command: 'bun' }),
      }),
    });
    expect(derivePrimaryStatus(rejected)).toBe('rejected');
    expect(buildServerActions(rejected).map((option) => option.id)).toEqual([
      'review_decision',
      'remove',
    ]);
  });

  test('moves only through enabled options', () => {
    const options = [
      { id: 'one', label: 'One' },
      { id: 'two', label: 'Two', disabled: true },
      { id: 'three', label: 'Three' },
    ] as const;
    expect(moveSelection(options, 'one', 'down')).toBe('three');
    expect(moveSelection(options, 'three', 'up')).toBe('one');
  });
});

describe('MCP management overlay', () => {
  test('uses the list only for navigation and opens a read-only detail action menu', async () => {
    const controller = new FakeController();
    const { stdin, lastFrame } = render(<McpOverlay controller={controller} onClose={() => {}} />);

    await Bun.sleep(5);
    expect(lastFrame()).toContain('1 server');
    expect(lastFrame()).toContain('Project MCPs (/workspace/.kite-code/mcp.json)');
    expect(lastFrame()).toContain('> github · ✔ connected · 5 tools');
    expect(lastFrame()).toContain('Add MCP server');
    expect(lastFrame()).not.toContain('A Add');
    expect(lastFrame()).not.toContain('L Login');

    stdin.write('\r');
    await Bun.sleep(10);
    expect(lastFrame()).toContain('github MCP Server');
    expect(lastFrame()).toContain('Status:');
    expect(lastFrame()).toContain('connected');
    expect(lastFrame()).toContain('Endpoint:');
    expect(lastFrame()).not.toContain('Transport:');
    expect(lastFrame()).toContain('Config location:');
    expect(lastFrame()).toContain('Capabilities:');
    expect(lastFrame()).toContain('❯ 1. View tools');
    expect(lastFrame()).toContain('Reconnect');
    expect(lastFrame()).toContain('Disable server');
    expect(lastFrame()).toContain('Remove server');
    expect(lastFrame()).not.toContain('. Back');
  });

  test('groups project and user servers under their configuration paths', async () => {
    const userServer = server({
      key: Object.freeze({ name: 'docs', source: 'user' }),
      source: 'user',
      sourcePath: '/home/user/.kite-code/mcp.json',
    });
    const controller = new FakeController([server(), userServer]);
    const { lastFrame } = render(<McpOverlay controller={controller} onClose={() => {}} />);

    expect(lastFrame()).toContain('Project MCPs (/workspace/.kite-code/mcp.json)');
    expect(lastFrame()).toContain('User MCPs (/home/user/.kite-code/mcp.json)');
    expect(lastFrame()).toContain('github · ✔ connected');
    expect(lastFrame()).toContain('docs · ✔ connected');
  });

  test('uses the shared connecting animation copy during automatic connection', () => {
    const connecting = server({ health: 'connecting', toolCount: 0, availableToolCount: 0 });
    const controller = new FakeController([connecting]);
    const { lastFrame } = render(<McpOverlay controller={controller} onClose={() => {}} />);

    expect(lastFrame()).toContain('◌ connecting...');
  });

  test('keeps connecting progress visible when enabling completes immediately', async () => {
    const disabled = server({
      enabled: false,
      configStatus: 'disabled',
      health: 'disconnected',
      toolCount: 0,
      availableToolCount: 0,
    });
    const controller = new FakeController([disabled]);
    const { stdin, lastFrame } = render(<McpOverlay controller={controller} onClose={() => {}} />);

    stdin.write('\r');
    await Bun.sleep(5);
    stdin.write('\r');
    await Bun.sleep(20);
    expect(lastFrame()).toContain('Connecting...');
    expect(controller.enabled).toEqual(['github:true']);
  });

  test('folds compatibility sources into project or user groups', () => {
    const legacyProject = server({
      key: Object.freeze({ name: 'legacy-project', source: 'project_mcp_json' }),
      source: 'project_mcp_json',
      sourcePath: '/workspace/.mcp.json',
    });
    const legacyUser = server({
      key: Object.freeze({ name: 'legacy-user', source: 'user_legacy' }),
      source: 'user_legacy',
      sourcePath: '/home/user/.kite-code/kite-code.jsonc',
    });
    const controller = new FakeController([legacyProject, legacyUser]);
    const { lastFrame } = render(<McpOverlay controller={controller} onClose={() => {}} />);

    expect(lastFrame()).toContain('Project MCPs (/workspace/.mcp.json)');
    expect(lastFrame()).toContain('User MCPs (/home/user/.kite-code/kite-code.jsonc)');
    expect(lastFrame()).not.toContain('Legacy MCPs');
  });

  test('opens a windowed tools list from a connected server', async () => {
    const controller = new FakeController();
    const { stdin, lastFrame } = render(<McpOverlay controller={controller} onClose={() => {}} />);

    stdin.write('\r');
    await Bun.sleep(5);
    stdin.write('\r');
    await Bun.sleep(5);
    expect(lastFrame()).toContain('Tools for github');
    expect(lastFrame()).toContain('5 tools');
    expect(lastFrame()).toContain('❯ 1. click');
    expect(lastFrame()).toContain('2. close_page');
    stdin.write('\r');
    await Bun.sleep(5);
    expect(lastFrame()).toContain('Tool name:');
    expect(lastFrame()).toContain('mcp__github__click');
    expect(lastFrame()).toContain('Clicks on the provided element');
    expect(lastFrame()).toContain('END_DESCRIPTION');
    expect(lastFrame()).toContain('uid (required): string');
    expect(lastFrame()).toContain('END_PARAMETER');
    expect(lastFrame()).toContain('dblClick: boolean');
    stdin.write('\x1b');
    await Bun.sleep(30);
    expect(lastFrame()).toContain('Tools for github');
    stdin.write('\x1b');
    await Bun.sleep(30);
    expect(lastFrame()).toContain('github MCP Server');
  });

  test('renders controller feedback in the detail status row instead of below the actions', async () => {
    const controller = new FakeController([server()], 'Retried MCP server github.');
    const { stdin, lastFrame } = render(<McpOverlay controller={controller} onClose={() => {}} />);

    stdin.write('\r');
    await Bun.sleep(5);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Status:');
    expect(frame).toContain('Retried MCP server github.');
    expect(frame.indexOf('Retried MCP server github.')).toBeLessThan(frame.indexOf('Reconnect'));
  });

  test('does not leak detail operation feedback into the server list', () => {
    const controller = new FakeController([server()], 'Retried MCP server github.');
    const { lastFrame } = render(<McpOverlay controller={controller} onClose={() => {}} />);

    expect(lastFrame()).not.toContain('Retried MCP server github.');
  });

  test('does not leak server operation feedback into tools or tool detail', async () => {
    const controller = new FakeController([server()], 'Enabled MCP server github.');
    const { stdin, lastFrame } = render(<McpOverlay controller={controller} onClose={() => {}} />);

    stdin.write('\r');
    await Bun.sleep(5);
    stdin.write('\r');
    await Bun.sleep(5);
    expect(lastFrame()).not.toContain('Enabled MCP server github.');
    stdin.write('\r');
    await Bun.sleep(5);
    expect(lastFrame()).not.toContain('Enabled MCP server github.');
  });

  test('redacts HTTP endpoint query parameters from the detail projection', async () => {
    const controller = new FakeController([
      server({
        configuration: Object.freeze({ endpoint: 'https://example.com/mcp?token=secret' }),
      }),
    ]);
    const { stdin, lastFrame } = render(<McpOverlay controller={controller} onClose={() => {}} />);

    stdin.write('\r');
    await Bun.sleep(5);
    expect(lastFrame()).not.toContain('token=secret');
  });

  test('keeps a long config location on one truncated line', async () => {
    const longPath = `/workspace/.kite-code/${'nested/'.repeat(30)}mcp.json`;
    const controller = new FakeController([server({ sourcePath: longPath })]);
    const { stdin, lastFrame } = render(<McpOverlay controller={controller} onClose={() => {}} />);

    stdin.write('\r');
    await Bun.sleep(5);
    const lines = (lastFrame() ?? '').split('\n');
    expect(lines.filter((line) => line.includes('Config location:'))).toHaveLength(1);
    expect(lines.filter((line) => line.includes('nested/'))).toHaveLength(1);
  });

  test('authenticates through visible options instead of the l shortcut', async () => {
    const auth = server({
      authStatus: 'login_required',
      health: 'disconnected',
      diagnostic: Object.freeze({
        code: 'auth_required',
        retryable: false,
        message: 'Login required.',
      }),
    });
    const controller = new FakeController([auth]);
    const { stdin, lastFrame } = render(<McpOverlay controller={controller} onClose={() => {}} />);

    stdin.write('\r');
    await Bun.sleep(5);
    expect(lastFrame()).toContain('❯ 1. Authenticate');
    stdin.write('\r');
    await Bun.sleep(5);
    expect(lastFrame()).toContain('> Open browser');
    stdin.write('l');
    await Bun.sleep(5);
    expect(controller.logins).toEqual([]);
    stdin.write('\r');
    await Bun.sleep(10);
    expect(controller.logins).toEqual(['github']);
  });

  test('reviews project approval through a safe-default Select', async () => {
    const pending = server({
      key: Object.freeze({ name: 'project-tools', source: 'project' }),
      source: 'project',
      sourcePath: '/workspace/.mcp.json',
      transport: 'stdio',
      configStatus: 'pending_approval',
      health: 'disconnected',
      approval: Object.freeze({
        configDigest: 'digest',
        review: Object.freeze({ command: 'bun', argumentCount: 2 }),
      }),
    });
    const controller = new FakeController([pending]);
    const { stdin, lastFrame } = render(<McpOverlay controller={controller} onClose={() => {}} />);

    stdin.write('\r');
    await Bun.sleep(5);
    stdin.write('\r');
    await Bun.sleep(5);
    expect(lastFrame()).toContain('> Decide later');
    expect(lastFrame()).toContain('Approve and connect');
    expect(lastFrame()).toContain('Reject server');
    expect(controller.decisions).toEqual([]);
  });

  test('adds a project HTTP server through the five-step flow', async () => {
    const controller = new FakeController([]);
    const { stdin, lastFrame } = render(<McpOverlay controller={controller} onClose={() => {}} />);

    expect(lastFrame()).toContain('> ＋ Add MCP server');
    stdin.write('\r');
    await Bun.sleep(5);
    expect(lastFrame()).toContain('Add MCP Server · 1/5');
    stdin.write('\r');
    await Bun.sleep(5);
    stdin.write('docs');
    await Bun.sleep(5);
    stdin.write('\r');
    await Bun.sleep(5);
    stdin.write('https://mcp.example.com/mcp');
    await Bun.sleep(5);
    stdin.write('\r');
    await Bun.sleep(5);
    expect(lastFrame()).toContain('Project  ');
    expect(lastFrame()).toContain('.kite-code/mcp.json');
    stdin.write('\r');
    await Bun.sleep(5);
    expect(lastFrame()).toContain('> Add and connect');
    expect(lastFrame()).not.toContain('  Back');
    expect(lastFrame()).not.toContain('  Cancel');
    stdin.write('\r');
    await Bun.sleep(10);
    expect(controller.added).toEqual(['project:docs:http']);
  });

  test('shows progress while add reconciliation is pending', async () => {
    const controller = new FakeController([], undefined, 100);
    const { stdin, lastFrame } = render(<McpOverlay controller={controller} onClose={() => {}} />);

    stdin.write('\r');
    await Bun.sleep(5);
    stdin.write('\r');
    await Bun.sleep(5);
    stdin.write('docs');
    await Bun.sleep(5);
    stdin.write('\r');
    await Bun.sleep(5);
    stdin.write('https://mcp.example.com/mcp');
    await Bun.sleep(5);
    stdin.write('\r');
    await Bun.sleep(5);
    stdin.write('\r');
    await Bun.sleep(5);
    stdin.write('\r');
    await Bun.sleep(10);

    expect(lastFrame()).toContain('Adding and connecting...');
    expect(lastFrame()).toContain('Please wait');
  });

  test('protects disable with a safe-default confirmation', async () => {
    const controller = new FakeController();
    const { stdin, lastFrame } = render(<McpOverlay controller={controller} onClose={() => {}} />);

    stdin.write('\r');
    await Bun.sleep(5);
    stdin.write('\x1b[B');
    stdin.write('\x1b[B');
    await Bun.sleep(5);
    expect(lastFrame()).toContain('❯ 3. Disable server');
    stdin.write('\r');
    await Bun.sleep(5);
    expect(lastFrame()).toContain('> Cancel');
    expect(controller.enabled).toEqual([]);
    stdin.write('\x1b[B');
    await Bun.sleep(5);
    stdin.write('\r');
    await Bun.sleep(10);
    expect(controller.enabled).toEqual(['github:false']);
  });
});
