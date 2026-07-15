import { describe, expect, test } from 'bun:test';
import { render } from 'ink-testing-library';
import McpOverlay from '@/app/tui/mcp/McpOverlay';
import type { McpController, McpControllerSnapshot } from '@/app/tui/mcp/types';
import type { McpServerConfigInput, McpWritableScope } from '@/core/config';
import type { McpServerControlState, McpServerKey } from '@/core/mcp';

const pendingServer: Readonly<McpServerControlState> = Object.freeze({
  key: Object.freeze({ name: 'workspace-tools', source: 'project' }),
  effective: true,
  configStatus: 'pending_approval',
  authStatus: 'not_required',
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

class FakeController implements McpController {
  readonly decisions: string[] = [];
  readonly additions: Array<{
    scope: McpWritableScope;
    name: string;
    config: McpServerConfigInput;
  }> = [];
  readonly mutations: string[] = [];
  private readonly snapshot: McpControllerSnapshot = Object.freeze({
    control: Object.freeze({
      revision: 'snapshot-1',
      generation: 1,
      servers: Object.freeze([pendingServer]),
      sourceRevisions: Object.freeze({ local: 'local', project: 'project', user: 'user' }),
    }),
  });

  getSnapshot = () => this.snapshot;
  subscribe = () => () => {};
  retry = async () => {};
  retryByName = async () => {};
  reload = async () => {};
  add = async (scope: McpWritableScope, name: string, config: McpServerConfigInput) => {
    this.additions.push({ scope, name, config });
    return true;
  };
  setEnabled = async (server: Readonly<McpServerControlState>, enabled: boolean) => {
    this.mutations.push(`${enabled ? 'enable' : 'disable'}:${server.key.name}`);
    return true;
  };
  remove = async (server: Readonly<McpServerControlState>) => {
    this.mutations.push(`remove:${server.key.name}`);
    return true;
  };
  migrate = async (server: Readonly<McpServerControlState>) => {
    this.mutations.push(`migrate:${server.key.name}`);
    return true;
  };
  decide = async (key: McpServerKey, decision: 'approved' | 'rejected') => {
    this.decisions.push(`${key.name}:${decision}`);
  };
}

describe('MCP management overlay', () => {
  test('renders a pending project server from the control snapshot', () => {
    const controller = new FakeController();
    const { lastFrame } = render(<McpOverlay controller={controller} onClose={() => {}} />);
    expect(lastFrame()).toContain('workspace-tools');
    expect(lastFrame()).toContain('pending-approval');
    expect(lastFrame()).toContain('project');
  });

  test('navigates to the redacted approval route and requires double confirmation', async () => {
    const controller = new FakeController();
    const { stdin, lastFrame } = render(<McpOverlay controller={controller} onClose={() => {}} />);
    stdin.write('\r');
    await Bun.sleep(10);
    stdin.write('a');
    await Bun.sleep(10);
    expect(lastFrame()).toContain('/ approval');
    expect(lastFrame()).toContain('/workspace/.mcp.json');
    expect(lastFrame()).toContain('1234567890ab');
    expect(lastFrame()).toContain('Command: bun (2 arguments)');

    stdin.write('a');
    await Bun.sleep(10);
    expect(controller.decisions).toEqual([]);
    stdin.write('a');
    await Bun.sleep(10);
    expect(controller.decisions).toEqual(['workspace-tools:approved']);
  });

  test('adds a project HTTP server through the non-OAuth wizard', async () => {
    const controller = new FakeController();
    const { stdin, lastFrame } = render(<McpOverlay controller={controller} onClose={() => {}} />);
    stdin.write('a');
    await Bun.sleep(10);
    expect(lastFrame()).toContain('MCP Management / add');

    await enter(stdin, 'phase2-demo');
    await enter(stdin, 'http');
    await enter(stdin, 'https://example.com/mcp?token=hidden');
    await enter(stdin, 'n');
    await enter(stdin, 'project');
    await enter(stdin, '2500');
    expect(lastFrame()).toContain('Project save will require separate approval.');
    expect(lastFrame()).toContain('https://example.com');
    expect(lastFrame()).not.toContain('token=hidden');
    await enter(stdin);

    expect(controller.additions).toEqual([
      {
        scope: 'project',
        name: 'phase2-demo',
        config: { type: 'http', url: 'https://example.com/mcp?token=hidden', timeout: 2500 },
      },
    ]);
  });

  test('stores HTTP authentication as an environment reference', async () => {
    const controller = new FakeController();
    const { stdin, lastFrame } = render(<McpOverlay controller={controller} onClose={() => {}} />);
    stdin.write('a');
    await Bun.sleep(10);
    await enter(stdin, 'environment-http');
    await enter(stdin, 'http');
    await enter(stdin, 'https://example.com/mcp');
    await enter(stdin, 'e');
    await enter(stdin, 'Authorization=Bearer $' + '{MCP_TOKEN}');
    await enter(stdin, 'local');
    await enter(stdin);
    expect(lastFrame()).toContain('Environment/header keys: Authorization');
    expect(lastFrame()).not.toContain('MCP_TOKEN');
    await enter(stdin);

    expect(controller.additions[0]?.config).toEqual({
      type: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer $' + '{MCP_TOKEN}' },
    });
  });

  test('navigates destructive actions to confirmation before mutation', async () => {
    const controller = new FakeController();
    const { stdin, lastFrame } = render(<McpOverlay controller={controller} onClose={() => {}} />);
    stdin.write('\r');
    await Bun.sleep(10);
    stdin.write('d');
    await Bun.sleep(10);
    expect(lastFrame()).toContain('Confirm disable: workspace-tools');
    expect(controller.mutations).toEqual([]);
    stdin.write('\r');
    await Bun.sleep(10);
    expect(controller.mutations).toEqual(['disable:workspace-tools']);
  });
});

async function enter(stdin: { write(value: string): void }, value = ''): Promise<void> {
  if (value) stdin.write(value);
  await Bun.sleep(5);
  stdin.write('\r');
  await Bun.sleep(10);
}
