import { describe, expect, test } from 'bun:test';
import { render } from 'ink-testing-library';
import McpPanel from '@/app/tui/components/McpPanel';
import type { McpProjectServerApprovalView } from '@/core/config';
import { McpManager } from '@/core/mcp';

const pendingView: McpProjectServerApprovalView = {
  name: 'workspace-tools',
  sourceKind: 'project_mcp_json',
  sourcePath: '/workspace/.mcp.json',
  transport: 'stdio',
  configDigest: '1234567890abcdef',
  status: 'pending_approval',
  review: { command: 'bun', argumentCount: 2 },
  diagnostics: [],
};

describe('McpPanel project approval', () => {
  test('renders a redacted pending project server without a connection state', () => {
    const { lastFrame } = render(
      <McpPanel manager={new McpManager()} projectApprovals={[pendingView]} onClose={() => {}} />,
    );

    const frame = lastFrame();
    expect(frame).toContain('workspace-tools');
    expect(frame).toContain('pending approval');
    expect(frame).toContain('[12345678]');
    expect(frame).toContain(pendingView.sourcePath);
    expect(frame).toContain('命令：bun（2 个参数）');
  });

  test('approves the selected project server with a', async () => {
    const decisions: string[] = [];
    const { stdin } = render(
      <McpPanel
        manager={new McpManager()}
        projectApprovals={[pendingView]}
        onProjectDecision={(view, decision) => {
          decisions.push(`${view.name}:${decision}`);
        }}
        onClose={() => {}}
      />,
    );

    stdin.write('a');
    await Bun.sleep(10);
    expect(decisions).toEqual([]);
    stdin.write('a');
    await Bun.sleep(10);
    expect(decisions).toEqual(['workspace-tools:approved']);
  });

  test('rejects the selected project server with r', async () => {
    const decisions: string[] = [];
    const { stdin } = render(
      <McpPanel
        manager={new McpManager()}
        projectApprovals={[pendingView]}
        onProjectDecision={(view, decision) => {
          decisions.push(`${view.name}:${decision}`);
        }}
        onClose={() => {}}
      />,
    );

    stdin.write('r');
    await Bun.sleep(10);
    expect(decisions).toEqual([]);
    stdin.write('r');
    await Bun.sleep(10);
    expect(decisions).toEqual(['workspace-tools:rejected']);
  });
});
