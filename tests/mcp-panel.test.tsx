import { describe, expect, test } from 'bun:test';
import { render } from 'ink-testing-library';
import McpOverlay from '@/app/tui/mcp/McpOverlay';
import type { McpController, McpControllerSnapshot } from '@/app/tui/mcp/types';
import type { McpServerControlState, McpServerKey } from '@/core/mcp';

const pendingServer: Readonly<McpServerControlState> = Object.freeze({
  key: Object.freeze({ name: 'workspace-tools', source: 'project_mcp_json' }),
  effective: true,
  configStatus: 'pending_approval',
  authStatus: 'not_required',
  health: 'disconnected',
  transport: 'stdio',
  source: 'project_mcp_json',
  sourcePath: '/workspace/.mcp.json',
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
  private readonly snapshot: McpControllerSnapshot = Object.freeze({
    control: Object.freeze({
      revision: 'snapshot-1',
      generation: 1,
      servers: Object.freeze([pendingServer]),
    }),
  });

  getSnapshot = () => this.snapshot;
  subscribe = () => () => {};
  retry = async () => {};
  retryByName = async () => {};
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
    expect(lastFrame()).toContain('project_mcp_json');
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
});
