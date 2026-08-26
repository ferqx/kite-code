import { describe, expect, test } from 'bun:test';
import { sep } from 'node:path';
import type {
  McpAuthResult,
  McpServerControlState,
  McpServerKey,
} from '@kite-ai/builtin-runtime/mcp';
import { render } from 'ink-testing-library';
import McpOverlay from '#kite-cli/tui/mcp/McpOverlay';
import { buildServerActions, derivePrimaryStatus, moveSelection } from '#kite-cli/tui/mcp/model';
import type { McpController, McpControllerSnapshot } from '#kite-cli/tui/mcp/types';

/** Poll the latest rendered frame until the predicate holds, so async effect
 *  timing (auth→detail return) does not depend on a fixed sleep across hosts. */
async function waitForFrame(
  getFrame: () => string | undefined,
  predicate: (frame: string) => boolean,
  timeoutMs = 1000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate(getFrame() ?? '')) return;
    await Bun.sleep(10);
  }
  throw new Error('waitForFrame: timed out waiting for expected frame content');
}

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
        sourceRevisions: Object.freeze({ project: 'project-1', user: 'user-1' }),
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

class AutoReturnAuthController implements McpController {
  readonly logins: string[] = [];
  readonly decisions: string[] = [];
  readonly cancelledFlows: string[] = [];
  readonly retries: string[] = [];
  readonly enabled: string[] = [];
  readonly added: string[] = [];
  readonly removed: string[] = [];
  private readonly listeners = new Set<() => void>();
  private snapshot: McpControllerSnapshot;

  constructor(servers: readonly Readonly<McpServerControlState>[] = [server()], message?: string) {
    this.snapshot = Object.freeze({
      control: Object.freeze({
        revision: 'snapshot-1',
        generation: 1,
        servers: Object.freeze([...servers]),
        sourceRevisions: Object.freeze({ project: 'project-1', user: 'user-1' }),
      }),
      ...(message ? { message } : {}),
    });
  }

  getSnapshot = () => this.snapshot;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private emit() {
    for (const listener of this.listeners) listener();
  }

  private updateServer = (key: McpServerKey, update: Partial<McpServerControlState>) => {
    const servers = this.snapshot.control.servers.map((current) => {
      if (current.key.name === key.name && current.key.source === key.source) {
        return Object.freeze({ ...current, ...update });
      }
      return current;
    });
    this.snapshot = Object.freeze({
      ...this.snapshot,
      control: Object.freeze({
        ...this.snapshot.control,
        servers: Object.freeze(servers),
      }),
    });
    this.emit();
  };

  decide = async (key: McpServerKey, decision: 'approved' | 'rejected') => {
    this.decisions.push(`${key.name}:${decision}`);
    return true;
  };

  login = async (key: McpServerKey): Promise<McpAuthResult> => {
    this.logins.push(key.name);
    this.updateServer(key, {
      authStatus: 'authorizing',
      authFlowId: 'flow-1',
      diagnostic: undefined,
    });
    void (async () => {
      await Bun.sleep(10);
      this.updateServer(key, {
        authStatus: 'authenticated',
        authFlowId: undefined,
        health: 'ready',
      });
    })();
    return { status: 'authorization_required', flowId: 'flow-1', authorizationUrl: 'https://x' };
  };

  cancelAuth = async (flowId: string) => {
    this.cancelledFlows.push(flowId);
    const entries = [...this.snapshot.control.servers];
    const entry = entries.find((candidate) => candidate.authFlowId === flowId);
    if (entry) {
      this.updateServer(entry.key, { authStatus: 'login_required', authFlowId: undefined });
    }
  };

  retry = async (key: McpServerKey) => {
    this.retries.push(key.name);
    return true;
  };

  setEnabled = async (key: McpServerKey, expectedRevision: string, enabled: boolean) => {
    this.enabled.push(`${key.name}:${expectedRevision}:${enabled}`);
    return true;
  };

  add = async () => {
    this.added.push('noop');
    return null;
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
    expect(lastFrame()).not.toContain('◆ Kite Code');
    expect(lastFrame()).toContain('1 个服务器');
    expect(lastFrame()).toContain('项目配置');
    expect(lastFrame()).toContain('❯ github');
    expect(lastFrame()).toContain('● 已连接');
    expect(lastFrame()).toContain('/workspace/.kite-code/mcp.json · 5 个工具');
    expect(lastFrame()).toContain('添加 MCP 服务器');
    expect(lastFrame()).not.toContain('A Add');
    expect(lastFrame()).not.toContain('L Login');
    const listFrame = lastFrame() ?? '';
    expect(listFrame.indexOf('1 个服务器')).toBeLessThan(listFrame.indexOf('项目'));
    expect(listFrame.indexOf('项目')).toBeLessThan(listFrame.indexOf('❯ github'));
    expect(listFrame.indexOf('❯ github')).toBeLessThan(listFrame.indexOf('＋ 添加 MCP 服务器'));
    expect(listFrame.indexOf('＋ 添加 MCP 服务器')).toBeLessThan(listFrame.indexOf('↑↓ 导航'));

    stdin.write('\r');
    await Bun.sleep(10);
    expect(lastFrame()).toContain('── github');
    expect(lastFrame()).toContain('MCP 服务器');
    expect(lastFrame()).toContain('状态');
    expect(lastFrame()).toContain('已连接');
    expect(lastFrame()).toContain('传输方式');
    expect(lastFrame()).toContain('配置位置');
    expect(lastFrame()).toContain('能力');
    expect(lastFrame()).toContain('❯ 查看工具');
    expect(lastFrame()).toContain('重新连接');
    expect(lastFrame()).toContain('禁用');
    expect(lastFrame()).toContain('移除');
    expect(lastFrame()).not.toContain('. Back');
    const detailFrame = lastFrame() ?? '';
    expect(detailFrame.indexOf('状态')).toBeLessThan(detailFrame.indexOf('操作'));
    expect(detailFrame.indexOf('操作')).toBeLessThan(detailFrame.indexOf('❯ 查看工具'));

    stdin.write('\x1b[B');
    await Bun.sleep(5);
    const reconnectFrame = lastFrame() ?? '';
    expect(reconnectFrame).toContain('❯ 重新连接');
    expect(reconnectFrame).toContain('将断开并重新连接“github”。正在进行的工具调用可能中断。');
    const reconnectLines = reconnectFrame.split('\n');
    const reconnectOption = reconnectLines.findIndex((line) => line.includes('❯ 重新连接'));
    const disableOption = reconnectLines.findIndex((line) => line.includes('禁用'));
    expect(disableOption).toBe(reconnectOption + 2);
    expect(reconnectLines[reconnectOption + 1]?.trim()).toBe(
      '将断开并重新连接“github”。正在进行的工具调用可能中断。',
    );
    expect(reconnectLines[reconnectOption + 2]?.trim()).toBe('禁用');
  });

  test('groups project and user servers under their configuration paths', async () => {
    const userServer = server({
      key: Object.freeze({ name: 'docs', source: 'user' }),
      source: 'user',
      sourcePath: '/home/user/.kite-code/mcp.json',
    });
    const controller = new FakeController([server(), userServer]);
    const { lastFrame } = render(<McpOverlay controller={controller} onClose={() => {}} />);

    expect(lastFrame()).toContain('项目');
    expect(lastFrame()).toContain('/workspace/.kite-code/mcp.json · 5 个工具');
    expect(lastFrame()).toContain('用户');
    expect(lastFrame()).toContain('/home/user/.kite-code/mcp.json · 5 个工具');
    expect(lastFrame()).toContain('github');
    expect(lastFrame()).toContain('docs');
  });

  test('uses the shared connecting animation copy during automatic connection', () => {
    const connecting = server({ health: 'connecting', toolCount: 0, availableToolCount: 0 });
    const controller = new FakeController([connecting]);
    const { lastFrame } = render(<McpOverlay controller={controller} onClose={() => {}} />);

    expect(lastFrame()).toContain('◌ 连接中...');
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
    expect(lastFrame()).toContain('正在连接...');
    expect(controller.enabled).toEqual(['github:true']);
  });

  test('groups current project and user sources', () => {
    const project = server({
      key: Object.freeze({ name: 'project-server', source: 'project' }),
      source: 'project',
      sourcePath: '/workspace/.kite-code/mcp.json',
    });
    const user = server({
      key: Object.freeze({ name: 'user-server', source: 'user' }),
      source: 'user',
      sourcePath: '/home/user/.kite-code/mcp.json',
    });
    const controller = new FakeController([project, user]);
    const { lastFrame } = render(<McpOverlay controller={controller} onClose={() => {}} />);

    expect(lastFrame()).toContain('项目');
    expect(lastFrame()).toContain('/workspace/.kite-code/mcp.json · 5 个工具');
    expect(lastFrame()).toContain('用户');
    expect(lastFrame()).toContain('/home/user/.kite-code/mcp.json · 5 个工具');
  });

  test('opens a windowed tools list from a connected server', async () => {
    const controller = new FakeController();
    const { stdin, lastFrame } = render(<McpOverlay controller={controller} onClose={() => {}} />);

    stdin.write('\r');
    await Bun.sleep(5);
    stdin.write('\r');
    await Bun.sleep(5);
    expect(lastFrame()).toContain('5 个工具');
    const toolListLines = (lastFrame() ?? '').split('\n');
    const toolSummary = toolListLines.findIndex(
      (line) => line.includes('5 个工具') && line.includes('github'),
    );
    const firstTool = toolListLines.findIndex((line) => line.includes('❯ 1. click'));
    const secondTool = toolListLines.findIndex((line) => line.includes('2. close_page'));
    expect(toolSummary).toBeGreaterThanOrEqual(0);
    expect(firstTool).toBe(toolSummary + 2);
    expect(lastFrame()).toContain('❯ 1. click');
    expect(lastFrame()).toContain('2. close_page');
    expect(toolListLines[firstTool]?.indexOf('1.')).toBe(toolListLines[secondTool]?.indexOf('2.'));
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
    expect(lastFrame()).toContain('5 个工具');
    stdin.write('\x1b');
    await Bun.sleep(30);
    expect(lastFrame()).toContain('── github');
  });

  test('renders controller feedback in the detail status row instead of below the actions', async () => {
    const controller = new FakeController([server()], 'Retried MCP server github.');
    const { stdin, lastFrame } = render(<McpOverlay controller={controller} onClose={() => {}} />);

    stdin.write('\r');
    await Bun.sleep(5);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('状态');
    expect(frame).toContain('Retried MCP server github.');
    expect(frame.indexOf('Retried MCP server github.')).toBeLessThan(frame.indexOf('重新连接'));
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
    expect(lines.filter((line) => line.includes('配置位置'))).toHaveLength(1);
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
    expect(lastFrame()).toContain('❯ 认证');
    stdin.write('\r');
    await Bun.sleep(5);
    expect(lastFrame()).toContain('❯ 打开浏览器');
    stdin.write('l');
    await Bun.sleep(5);
    expect(controller.logins).toEqual([]);
    stdin.write('\r');
    await Bun.sleep(10);
    expect(controller.logins).toEqual(['github']);
  });

  test('returns to server detail when sample MCP endpoint authentication completes', async () => {
    const controller = new AutoReturnAuthController([
      server({
        key: Object.freeze({ name: 'example-server', source: 'project' }),
        source: 'project',
        configuration: Object.freeze({
          endpoint: 'https://example-server.modelcontextprotocol.io/mcp',
        }),
        authStatus: 'login_required',
        health: 'disconnected',
        diagnostic: Object.freeze({
          code: 'auth_required',
          retryable: false,
          message: 'Login required.',
        }),
      }),
    ]);
    const { stdin, lastFrame } = render(<McpOverlay controller={controller} onClose={() => {}} />);

    stdin.write('\r');
    await Bun.sleep(5);
    expect(lastFrame()).toContain('── example-server');
    stdin.write('\r');
    await Bun.sleep(5);
    stdin.write('\r');
    await Bun.sleep(10);
    expect(controller.logins).toEqual(['example-server']);
    await waitForFrame(
      lastFrame,
      (f) => f.includes('❯ 查看工具') && !f.includes('认证 MCP 服务器'),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('── example-server');
    expect(frame).toContain('状态');
    expect(frame).toContain('已连接');
    expect(frame).toContain('操作');
    expect(frame).toContain('❯ 查看工具');
    expect(frame).not.toContain('认证 MCP 服务器');
  });

  test('returns to server detail automatically after auth is marked authenticated', async () => {
    const controller = new AutoReturnAuthController([
      server({
        key: Object.freeze({ name: 'sample', source: 'project' }),
        source: 'project',
        configuration: Object.freeze({
          endpoint: 'https://example-server.modelcontextprotocol.io/mcp',
        }),
        authStatus: 'login_required',
        health: 'disconnected',
        diagnostic: Object.freeze({
          code: 'auth_required',
          retryable: false,
          message: 'Login required.',
        }),
      }),
    ]);
    const { stdin, lastFrame } = render(<McpOverlay controller={controller} onClose={() => {}} />);

    stdin.write('\r');
    await Bun.sleep(5);
    expect(lastFrame()).toContain('── sample');
    expect(lastFrame()).toContain('❯ 认证');
    stdin.write('\r');
    await Bun.sleep(5);
    expect(lastFrame()).toContain('认证 MCP 服务器');
    expect(lastFrame()).toContain('❯ 打开浏览器');
    stdin.write('\r');
    await Bun.sleep(5);
    expect(controller.logins).toEqual(['sample']);

    const authenticatingFrame = lastFrame() ?? '';
    expect(authenticatingFrame).toContain('认证 MCP 服务器');
    expect(authenticatingFrame).toContain('请在浏览器中完成登录。');
    await waitForFrame(lastFrame, (f) => f.includes('── sample') && !f.includes('认证 MCP 服务器'));
    const finalFrame = lastFrame() ?? '';
    expect(finalFrame).toContain('── sample');
    expect(finalFrame).toContain('MCP 服务器');
    expect(finalFrame).toContain('状态');
    expect(finalFrame).toContain('已连接');
    expect(finalFrame).toContain('操作');
    expect(finalFrame).not.toContain('认证 MCP 服务器');
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
    const approvalFrame = lastFrame() ?? '';
    expect(approvalFrame).toContain('❯ 稍后决定');
    expect(lastFrame()).toContain('批准并连接');
    expect(lastFrame()).toContain('拒绝服务器');
    const approvalLines = approvalFrame.split('\n');
    const approvalWarning = approvalLines.findIndex((line) =>
      line.includes('只批准你信任的项目。'),
    );
    const approvalOption = approvalLines.findIndex((line) => line.includes('❯ 稍后决定'));
    expect(approvalOption).toBe(approvalWarning + 2);
    expect(approvalLines[approvalWarning + 1]?.trim()).toBe('');
    expect(controller.decisions).toEqual([]);
  });

  test('adds a project HTTP server through the five-step flow', async () => {
    const controller = new FakeController([]);
    const { stdin, lastFrame } = render(<McpOverlay controller={controller} onClose={() => {}} />);

    expect(lastFrame()).toContain('❯ ＋ 添加 MCP 服务器');
    stdin.write('\r');
    await Bun.sleep(5);
    expect(lastFrame()).toContain('添加 MCP 服务器 · 1/5');
    const transportLines = (lastFrame() ?? '').split('\n');
    const transportQuestion = transportLines.findIndex((line) => line.includes('服务器如何运行？'));
    const httpOption = transportLines.findIndex((line) => line.includes('❯ HTTP'));
    expect(httpOption).toBe(transportQuestion + 2);
    expect(transportLines[transportQuestion + 1]?.trim()).toBe('');
    stdin.write('\r');
    await Bun.sleep(5);
    stdin.write('docs');
    await Bun.sleep(5);
    const nameLines = (lastFrame() ?? '').split('\n');
    const nameLabel = nameLines.findIndex((line) => line.includes('服务器名称'));
    const nameInput = nameLines.findIndex((line) => line.trim() === 'docs');
    expect(nameInput).toBe(nameLabel + 2);
    expect(nameLines[nameLabel + 1]?.trim()).toBe('');
    stdin.write('\r');
    await Bun.sleep(5);
    stdin.write('https://mcp.example.com/mcp');
    await Bun.sleep(5);
    stdin.write('\r');
    await Bun.sleep(5);
    expect(lastFrame()).toContain('❯ 当前项目');
    expect(lastFrame()).toContain(`.kite-code${sep}mcp.json`);
    const scopeLines = (lastFrame() ?? '').split('\n');
    const scopeQuestion = scopeLines.findIndex((line) => line.includes('服务器应在哪些范围可用？'));
    const projectOption = scopeLines.findIndex((line) => line.includes('❯ 当前项目'));
    expect(projectOption).toBe(scopeQuestion + 2);
    expect(scopeLines[scopeQuestion + 1]?.trim()).toBe('');
    stdin.write('\r');
    await Bun.sleep(5);
    expect(lastFrame()).toContain('❯ 添加并连接');
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

    expect(lastFrame()).toContain('正在添加并连接...');
    expect(lastFrame()).toContain('请稍候');
  });

  test('protects disable with a safe-default confirmation', async () => {
    const controller = new FakeController();
    const { stdin, lastFrame } = render(<McpOverlay controller={controller} onClose={() => {}} />);

    stdin.write('\r');
    await Bun.sleep(5);
    stdin.write('\x1b[B');
    stdin.write('\x1b[B');
    await Bun.sleep(5);
    expect(lastFrame()).toContain('❯ 禁用');
    stdin.write('\r');
    await Bun.sleep(5);
    const confirmFrame = lastFrame() ?? '';
    expect(confirmFrame).toContain('❯ 取消');
    const confirmLines = confirmFrame.split('\n');
    const confirmWarning = confirmLines.findIndex((line) => line.includes('将禁用“github”'));
    const cancelOption = confirmLines.findIndex((line) => line.includes('❯ 取消'));
    expect(cancelOption).toBe(confirmWarning + 2);
    expect(confirmLines[confirmWarning + 1]?.trim()).toBe('');
    expect(controller.enabled).toEqual([]);
    stdin.write('\x1b[B');
    await Bun.sleep(5);
    stdin.write('\r');
    await Bun.sleep(10);
    expect(controller.enabled).toEqual(['github:false']);
  });
});
