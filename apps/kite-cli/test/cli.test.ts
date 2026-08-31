import { describe, expect, spyOn, test } from 'bun:test';
import { resolve } from 'node:path';
import {
  type KiteAppControlClient,
  type KiteWorkspaceIdentity,
  WORKSPACE_TRUST_DECISION_RESPONSE_SCHEMA_,
  WORKSPACE_TRUST_QUERY_RESPONSE_SCHEMA_,
} from '@kite-ai/kite-app-contract';
import type {
  KiteSingleServiceClient,
  LocalKiteConnection,
} from '@kite-ai/kite-local-runtime/client';
import type { RuntimeHistoryClient } from '@kite-ai/runtime-client';
import { formatServiceLifecycleResult, main, parseArgs } from '../src/cli/index';

// 测试 CLI 命令行参数解析逻辑 / Test CLI argument parsing logic
describe('cli argument parsing', () => {
  test('recognizes the public managed Service lifecycle surface', () => {
    expect(parseArgs(['service', 'ensure']).command).toBe('service-ensure');
    expect(parseArgs(['service', 'status']).command).toBe('service-status');
    expect(parseArgs(['service', 'status', '--json']).serviceJson).toBe(true);
    expect(parseArgs(['service', 'stop']).command).toBe('service-stop');
    expect(parseArgs(['service', 'restart']).command).toBe('service-restart');
  });

  test('recognizes only the closed Web Gateway lifecycle commands', () => {
    expect(parseArgs(['web']).command).toBe('web-ensure');
    expect(parseArgs(['web', '--json'])).toMatchObject({
      command: 'web-ensure',
      webJson: true,
    });
    expect(parseArgs(['web', 'status'])).toMatchObject({
      command: 'web-status',
      webJson: false,
    });
    expect(parseArgs(['web', 'status', '--json'])).toMatchObject({
      command: 'web-status',
      webJson: true,
    });
    expect(parseArgs(['web', 'stop']).command).toBe('web-stop');
    expect(parseArgs(['web', 'recover']).command).toBe('help');
    expect(parseArgs(['web', 'stop', 'now']).command).toBe('help');
    expect(parseArgs(['web', 'status', 'verbose']).command).toBe('help');
    expect(parseArgs(['web', 'prompt']).command).toBe('help');
    expect(parseArgs(['web', 'create']).command).toBe('help');
    expect(parseArgs(['web', '--kite-home', '/tmp/kite-home']).command).toBe('web-ensure');
    expect(parseArgs(['web', 'status', '--json', '--kite-home', '/tmp/kite-home']).command).toBe(
      'web-status',
    );
  });

  test('uses the single-Service Web client without Coordinator or Gateway terminology', async () => {
    const originalArgv = process.argv;
    const output = spyOn(console, 'log').mockImplementation(() => undefined);
    const calls: string[] = [];
    const client = singleServiceWebClient(calls);
    try {
      process.argv = ['bun', 'kite', 'web'];
      await main({
        singleServiceWeb: { client, staticAssetRoot: '/bundle/web' },
      });
      expect(output.mock.calls.at(-1)).toEqual(['http://127.0.0.1:43125']);

      process.argv = ['bun', 'kite', 'web', 'status', '--json'];
      await main({
        singleServiceWeb: { client, staticAssetRoot: '/bundle/web' },
      });
      expect(output.mock.calls.at(-1)).toEqual([
        JSON.stringify({
          state: 'ready',
          origin: 'http://127.0.0.1:43125',
          assetDigest: '1'.repeat(64),
        }),
      ]);

      process.argv = ['bun', 'kite', 'web', 'stop'];
      await main({
        singleServiceWeb: { client, staticAssetRoot: '/bundle/web' },
      });
      expect(output.mock.calls.at(-1)).toEqual(['Kite Web stopped.']);
      expect(calls).toEqual(['ensure:/bundle/web', 'status', 'stop']);
    } finally {
      process.argv = originalArgv;
      output.mockRestore();
    }
  });

  test('surfaces the single-Service typed asset diagnostic without a generic ensure error', async () => {
    const originalArgv = process.argv;
    process.argv = ['bun', 'kite', 'web'];
    try {
      await expect(
        main({
          singleServiceWeb: {
            staticAssetRoot: '/bundle/missing',
            client: {
              ...singleServiceWebClient([]),
              ensureWeb: async () => ({
                schema: 'kite.local-native.response.v1',
                requestId: 'web-missing',
                operation: 'web_ensure',
                outcome: 'unavailable',
                state: 'absent',
                diagnostic: 'web_assets_missing',
              }),
            },
          },
        }),
      ).rejects.toThrow('Kite Web ensure failed: web_assets_missing.');
    } finally {
      process.argv = originalArgv;
    }
  });

  test('keeps service run private and renders lifecycle results without secrets', () => {
    expect(parseArgs(['service', 'run']).command).toBe('help');
    const result = {
      schema: 'kite.local-runtime-lifecycle-result.v1' as const,
      requestId: 'status-1',
      operation: 'status' as const,
      outcome: 'applied' as const,
      state: 'ready' as const,
      diagnostic: 'build_mismatch' as const,
    };
    expect(formatServiceLifecycleResult(result)).toBe(
      'Service status: applied [ready] (build_mismatch)',
    );
    expect(JSON.parse(formatServiceLifecycleResult(result, true))).toEqual(result);
  });

  test('recognizes explicit Windows sandbox control-plane commands', () => {
    expect(parseArgs(['sandbox', 'status']).command).toBe('sandbox-status');
    expect(parseArgs(['sandbox', 'setup']).command).toBe('sandbox-setup');
  });

  test('recognizes only the parent-owned stdio Runtime Server entrypoint', () => {
    const workspace = resolve('trusted-workspace');
    const args = parseArgs([
      'server',
      '--stdio',
      '--thread',
      'desktop-owned-session',
      '--workspace',
      workspace,
    ]);

    expect(args.command).toBe('server-stdio');
    expect(args.threadId).toBe('desktop-owned-session');
    expect(args.workspace).toBe(workspace);
    expect(parseArgs(['server', '--web']).command).toBe('help');
  });

  test('leaves the stdio session empty when the parent omits its owned thread id', () => {
    expect(parseArgs(['server', '--stdio']).threadId).toBe('');
  });

  // 验证 run 命令默认使用新线程，避免恢复过期的中断 / Verify run defaults to fresh thread to avoid stale interrupt resume
  test('run uses a fresh thread by default to avoid resuming stale interrupts', () => {
    const args = parseArgs(['run', '--task', '你当前是什么模型？上下文有多长']);

    expect(args.task).toBe('你当前是什么模型？上下文有多长');
    expect(args.threadId).toStartWith('run-'); // 自动生成的线程 ID 以 run- 开头 / Auto-generated thread ID starts with run-
    expect(args.threadId).not.toBe('default-thread'); // 不使用 default-thread 避免冲突 / Not using default-thread to avoid collision
  });

  // 验证 --task 被 npm 消费后，run 命令能通过位置参数接收任务文本 / Verify run accepts task as positional argument after npm strips --task
  test('run accepts the task as positional text after npm consumes --task', () => {
    const args = parseArgs(['run', '你当前是什么模型？上下文有多长']);

    expect(args.task).toBe('你当前是什么模型？上下文有多长');
  });

  // 验证用户显式指定线程时，run 命令保留该线程 ID / Verify run keeps explicit thread ID for conversation continuity
  test('run keeps an explicit thread when the user wants conversation continuity', () => {
    const args = parseArgs(['run', '--thread', 'conversation-a', '--task', 'hello']);

    expect(args.threadId).toBe('conversation-a');
  });

  // 验证 resume 命令在未提供线程时默认使用 default-thread / Verify resume defaults to default-thread when no thread given
  test('resume still targets the default thread when no thread is provided', () => {
    const args = parseArgs(['resume']);

    expect(args.threadId).toBe('default-thread');
  });

  test('resume accepts a successor task without exposing compatibility flags', () => {
    const args = parseArgs(['resume', '--thread', 'conversation-a', 'continue safely']);

    expect(args.threadId).toBe('conversation-a');
    expect(args.task).toBe('continue safely');
  });

  // Legacy approval/answer controls are no longer silently ignored after the Service cutover.
  test('rejects legacy resume answer and approval flags instead of silently ignoring them', () => {
    for (const flag of [
      ['--answer', '使用最小实现'],
      ['--approve'],
      ['--approve-same-command'],
      ['--approval-hash', 'hash-a'],
      ['--replace-command', 'echo unsafe-to-ignore'],
      ['--full-access'],
    ]) {
      expect(() => parseArgs(['resume', '--thread', 'conversation-a', ...flag])).toThrow(
        `Unsupported CLI option '${flag[0]}'`,
      );
    }
  });

  // Approval hash and replacement commands are handled by the TUI interaction client.
  test('rejects legacy approval hash and replacement command flags', () => {
    expect(() =>
      parseArgs([
        'resume',
        '--thread',
        'conversation-a',
        '--approval-hash',
        'hash-a',
        '--replace-command',
        'echo unsafe-to-ignore',
      ]),
    ).toThrow("Unsupported CLI option '--approval-hash'");
  });

  // 验证 resume 支持同命令授权 / Verify resume accepts same-command approval grants
  test('rejects the legacy same-command approval flag', () => {
    expect(() =>
      parseArgs(['resume', '--thread', 'conversation-a', '--approve-same-command']),
    ).toThrow("Unsupported CLI option '--approve-same-command'");
  });

  // `--full` is the interaction-mode flag; `--full-access` is a retired approval flag.
  test('rejects the legacy full-access approval flag', () => {
    expect(() => parseArgs(['resume', '--thread', 'conversation-a', '--full-access'])).toThrow(
      "Unsupported CLI option '--full-access'",
    );
  });

  test('rejects legacy local Store and feature flags instead of silently ignoring them', () => {
    for (const flag of ['--checkpoints', '--no-sandbox', '--feature', '--user', '--mode']) {
      expect(() => parseArgs(['run', '--task', 'hello', flag, 'value'])).toThrow(
        `Unsupported CLI option '${flag}'`,
      );
    }
  });

  test('parses one explicit interaction mode for the Service command path', () => {
    expect(parseArgs(['run', '--task', 'hello', '--ask']).interactionMode).toBe('accept_edits');
    expect(parseArgs(['resume', '--task', 'continue', '--auto']).interactionMode).toBe('auto');
    expect(parseArgs(['run', '--task', 'hello', '--full']).interactionMode).toBe('full');
    expect(() => parseArgs(['run', '--task', 'hello', '--ask', '--auto'])).toThrow(
      'Choose only one interaction mode',
    );
    expect(() => parseArgs(['service', 'status', '--full'])).toThrow(
      'Interaction mode flags are supported only by run and resume',
    );
    expect(() => parseArgs(['service', 'stop', '--json'])).toThrow(
      'The --json option is unsupported for this command',
    );
  });

  test('recognizes the explicit Service home without treating its value as task text', () => {
    const args = parseArgs(['run', '--kite-home', '/tmp/kite-home', 'continue safely']);
    expect(args.kiteHome).toBe('/tmp/kite-home');
    expect(args.task).toBe('continue safely');
  });

  test('does not open Runtime for an untrusted Workspace', async () => {
    const calls: string[] = [];
    const originalArgv = process.argv;
    process.argv = ['bun', 'kite', 'run', '--workspace', '/tmp/trusted', '--task', 'hello'];
    try {
      await expect(
        main({
          serviceConnector: {
            connect: async () =>
              createCliConnection({
                calls,
                queryStatus: 'unknown',
                externalReadRoots: ['/tmp/primary/.git'],
              }),
          },
        }),
      ).rejects.toThrow('/tmp/primary/.git');
    } finally {
      process.argv = originalArgv;
    }
    expect(calls).toEqual(['prepare-app-control', 'query-trust', 'close']);
  });

  test('connects Runtime only after the trusted Workspace gate', async () => {
    const calls: string[] = [];
    const originalArgv = process.argv;
    process.argv = [
      'bun',
      'kite',
      'run',
      '--workspace',
      '/tmp/trusted',
      '--task',
      'hello',
      '--auto',
    ];
    try {
      await main({
        serviceConnector: {
          connect: async () =>
            createCliConnection({
              calls,
              queryStatus: 'trusted',
            }),
        },
      });
    } finally {
      process.argv = originalArgv;
    }
    expect(calls).toEqual([
      'prepare-app-control',
      'query-trust',
      'connect-runtime',
      'runtime:create_session',
      'runtime:set_interaction_mode',
      'runtime:start_turn',
      'close',
    ]);
  });

  test('explicitly confirms an external Workspace read scope before opening Runtime', async () => {
    const calls: string[] = [];
    const originalArgv = process.argv;
    process.argv = [
      'bun',
      'kite',
      'run',
      '--workspace',
      '/tmp/trusted',
      '--task',
      'hello',
      '--trust-workspace',
    ];
    try {
      await main({
        serviceConnector: {
          connect: async () =>
            createCliConnection({
              calls,
              queryStatus: 'unknown',
              externalReadRoots: ['/tmp/primary/.git'],
            }),
        },
      });
    } finally {
      process.argv = originalArgv;
    }
    expect(calls.slice(0, 4)).toEqual([
      'prepare-app-control',
      'query-trust',
      'decide-trust',
      'connect-runtime',
    ]);
  });

  test('creates the Runtime Session with the canonical admitted Workspace identity', async () => {
    const calls: string[] = [];
    const commandWorkspaces: string[] = [];
    const originalArgv = process.argv;
    process.argv = ['bun', 'kite', 'run', '--workspace', '/tmp/workspace-alias', '--task', 'hello'];
    try {
      await main({
        serviceConnector: {
          connect: async () =>
            createCliConnection({
              calls,
              commandWorkspaces,
              queryStatus: 'trusted',
            }),
        },
      });
    } finally {
      process.argv = originalArgv;
    }
    expect(commandWorkspaces).toEqual(['/tmp/trusted']);
  });

  // 验证 --skill 参数解析为单值 / Verify --skill flag is parsed
  test('parses --skill flag', () => {
    const result = parseArgs(['run', '--task', 'fix', '--skill', 'tdd']);
    expect(result.skills).toContain('tdd');
  });

  // 验证多个 --skill 参数解析为数组，保持顺序 / Verify multiple --skill flags parse as ordered array
  test('parses multiple --skill flags', () => {
    const result = parseArgs(['run', '--task', 'fix', '--skill', 'tdd', '--skill', 'debugging']);
    expect(result.skills).toEqual(['tdd', 'debugging']);
  });

  // 验证未提供 --skill 时 skills 字段默认为空数组 / Verify skills defaults to empty array when not provided
  test('defaults skills to empty array', () => {
    const result = parseArgs(['run', '--task', 'fix']);
    expect(result.skills).toEqual([]);
  });
});

function singleServiceWebClient(calls: string[]): KiteSingleServiceClient {
  return {
    describe: async () => ({
      schema: 'kite.local-native.response.v1',
      requestId: 'describe-1',
      operation: 'describe',
      outcome: 'ready',
      service: {
        instanceId: 'service-1',
        pid: 42,
        startedAt: '2026-08-30T00:00:00.000Z',
        protocolVersion: 1,
        clientContractRevision: 'kite-local-runtime-contract-v1',
        serverVersion: 'service-1',
        buildId: 'build-1',
        httpOrigin: 'http://127.0.0.1:43125',
      },
      accessToken: 'a'.repeat(43),
    }),
    ensureWeb: async (root) => {
      calls.push(`ensure:${root}`);
      return {
        schema: 'kite.local-native.response.v1',
        requestId: 'ensure-1',
        operation: 'web_ensure',
        outcome: 'ready',
        origin: 'http://127.0.0.1:43125',
        launchUrl: 'http://127.0.0.1:43125',
        assetDigest: '1'.repeat(64),
      };
    },
    statusWeb: async () => {
      calls.push('status');
      return {
        schema: 'kite.local-native.response.v1',
        requestId: 'status-1',
        operation: 'web_status',
        outcome: 'ready',
        state: 'ready',
        origin: 'http://127.0.0.1:43125',
        assetDigest: '1'.repeat(64),
      };
    },
    stopWeb: async () => {
      calls.push('stop');
      return {
        schema: 'kite.local-native.response.v1',
        requestId: 'stop-1',
        operation: 'web_stop',
        outcome: 'applied',
        state: 'absent',
      };
    },
    stopService: async () => ({
      schema: 'kite.local-native.response.v1',
      requestId: 'service-stop-1',
      operation: 'service_stop',
      outcome: 'applied',
      state: 'draining',
    }),
  };
}

function createCliConnection(input: {
  calls: string[];
  commandWorkspaces?: string[];
  queryStatus: 'trusted' | 'unknown';
  externalReadRoots?: readonly string[];
}): LocalKiteConnection {
  const workspace: KiteWorkspaceIdentity = {
    canonicalPath: '/tmp/trusted',
    projectId: 'cli-test-project',
    workspaceDigest: `sha256:${'0'.repeat(64)}`,
  };
  let revision = 0;
  const externalReadScope = {
    roots: input.externalReadRoots ?? [],
    digest: `sha256:${'0'.repeat(64)}` as const,
  };
  const runtime = {
    command: async (command: {
      readonly type: string;
      readonly commandId: string;
      readonly workspace?: string;
    }) => {
      input.calls.push(`runtime:${command.type}`);
      if (command.type === 'create_session' && command.workspace) {
        input.commandWorkspaces?.push(command.workspace);
      }
      revision += 1;
      return {
        status: 'applied' as const,
        commandId: command.commandId,
        sessionId: 'cli-test-session',
        revision,
      };
    },
    subscribe: () => ({
      [Symbol.asyncIterator]: () => ({
        next: async () => ({ done: true as const, value: undefined }),
        return: async () => ({ done: true as const, value: undefined }),
      }),
    }),
  };
  return {
    runtime: runtime as never,
    history: {} as RuntimeHistoryClient,
    app: {
      queryWorkspaceTrust: async () => {
        input.calls.push('query-trust');
        return {
          schema: WORKSPACE_TRUST_QUERY_RESPONSE_SCHEMA_,
          workspace,
          status: input.queryStatus,
          revision: 'trust-revision-1',
          canDecide: input.queryStatus !== 'trusted',
          externalReadScope,
        };
      },
      decideWorkspaceTrust: async () => {
        input.calls.push('decide-trust');
        return {
          schema: WORKSPACE_TRUST_DECISION_RESPONSE_SCHEMA_,
          workspace,
          status: 'trusted',
          outcome: 'recorded',
          revision: 'trust-revision-2',
          externalReadScope,
        };
      },
    } as unknown as KiteAppControlClient,
    credential: {
      writeProviderCredential: async () => {
        throw new Error('credential is not used by CLI test');
      },
    },
    service: {} as LocalKiteConnection['service'],
    status: 'disconnected',
    generation: 0,
    snapshotStore: {} as LocalKiteConnection['snapshotStore'],
    subscribe: () => () => undefined,
    prepareAppControl: async () => {
      input.calls.push('prepare-app-control');
    },
    connect: async () => {
      input.calls.push('connect-runtime');
    },
    reconnect: async () => undefined,
    close: async () => {
      input.calls.push('close');
    },
    [Symbol.asyncDispose]: async () => undefined,
  };
}
