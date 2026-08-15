import { describe, expect, test } from 'bun:test';
import type { AgentConfig } from '@/core/config';
import type { PendingToolRequest } from '@/core/harness/tool-requests';
import { invokeGovernedTool } from '@/core/harness/tool-runner';
import type { McpRuntimeProvider } from '@/core/mcp';
import { AgentKernel } from '@/core/runtime/kernel';
import { createInitialRuntimeState } from '@/core/runtime/state';
import { createRuntimeStore } from '@/core/runtime/store';
import {
  createNetworkBoundaryEnforcerV1,
  createNetworkBoundaryFetchV1,
  isPublicNetworkAddress,
  NetworkBoundaryError,
  type NetworkResolvedAddressV1,
} from '../../src/core/sandbox/network-enforcer';
import { networkBoundaryPolicyFromExecutionBoundaryV1 } from '../../src/core/sandbox/network-policy';
import type { ExecutionBoundaryV1 } from '../../src/core/sandbox/types';

function policy(mode: 'off' | 'allowlist', hosts: string[] = []) {
  const boundary: ExecutionBoundaryV1 = {
    filesystemScope: 'workspace_write',
    workspaceRoot: process.cwd(),
    networkMode: mode,
    networkAllowlist: hosts,
    allowLocalAndPrivateNetwork: false,
    protectedPathPolicy: 'deny',
    maxProcessTreeSizePerShellInvocation: 8,
    sandboxRequired: true,
    sandboxUnavailable: 'fail',
  };
  return networkBoundaryPolicyFromExecutionBoundaryV1(boundary, true);
}

function taskConfig(
  mode: 'off' | 'allowlist',
  hosts: string[] = [],
  networkBoundaryV1 = true,
): AgentConfig {
  return {
    features: { networkBoundaryV1 },
    executionBoundary: {
      filesystemScope: 'workspace_write',
      workspaceRoot: process.cwd(),
      networkMode: mode,
      networkAllowlist: hosts,
      allowLocalAndPrivateNetwork: false,
      protectedPathPolicy: 'deny',
      maxProcessTreeSizePerShellInvocation: 8,
      sandboxRequired: true,
      sandboxUnavailable: 'fail',
    },
  } as AgentConfig;
}

function request(name: string, args: Record<string, unknown>): PendingToolRequest {
  return {
    source: name.startsWith('mcp__') ? 'mcp' : 'builtin',
    id: `call-${name}`,
    name,
    args,
    reason: 'network boundary fixture',
    protectedCommand: name,
  } as PendingToolRequest;
}

const publicAddress: NetworkResolvedAddressV1 = { address: '93.184.216.34', family: 4 };

describe('network boundary endpoint admission', () => {
  test('network off rejects before DNS resolution', async () => {
    let resolutions = 0;
    const enforcer = createNetworkBoundaryEnforcerV1(policy('off'), async () => {
      resolutions += 1;
      return [publicAddress];
    });
    await expect(
      enforcer.admit({
        url: 'https://example.com',
        toolCallId: 'tool-off',
        invocationId: 'off-1',
        hop: 0,
      }),
    ).rejects.toMatchObject({ code: 'network_off' });
    expect(resolutions).toBe(0);
  });

  test('requires an exact allowlisted DNS host and rejects IP literals', async () => {
    const enforcer = createNetworkBoundaryEnforcerV1(
      policy('allowlist', ['api.example.com']),
      async () => [publicAddress],
    );
    await expect(
      enforcer.admit({
        url: 'https://other.example.com',
        toolCallId: 'tool-host-1',
        invocationId: 'host-1',
        hop: 0,
      }),
    ).rejects.toMatchObject({ code: 'host_not_allowlisted' });
    await expect(
      enforcer.admit({
        url: 'https://93.184.216.34',
        toolCallId: 'tool-host-2',
        invocationId: 'host-2',
        hop: 0,
      }),
    ).rejects.toMatchObject({ code: 'ip_literal_denied' });
    await expect(
      enforcer.admit({
        url: 'http://2130706433',
        toolCallId: 'tool-host-3',
        invocationId: 'host-3',
        hop: 0,
      }),
    ).rejects.toMatchObject({ code: 'ip_literal_denied' });
    await expect(
      enforcer.admit({
        url: 'http://[::1]',
        toolCallId: 'tool-host-4',
        invocationId: 'host-4',
        hop: 0,
      }),
    ).rejects.toMatchObject({ code: 'ip_literal_denied' });
  });

  test('rejects known metadata hostnames even if DNS claims a public address', async () => {
    const enforcer = createNetworkBoundaryEnforcerV1(
      policy('allowlist', ['metadata.google.internal']),
      async () => [publicAddress],
    );
    await expect(
      enforcer.admit({
        url: 'http://metadata.google.internal/computeMetadata/v1',
        toolCallId: 'tool-metadata',
        invocationId: 'metadata',
        hop: 0,
      }),
    ).rejects.toMatchObject({ code: 'private_or_reserved_address' });
  });

  test('rejects private, link-local, metadata, documentation, and mixed DNS answers', async () => {
    for (const address of [
      '127.0.0.1',
      '10.0.0.1',
      '169.254.169.254',
      '192.0.2.1',
      '::1',
      'fe80::1',
      'fd00::1',
      '2001:db8::1',
      '3fff::1',
      '::ffff:127.0.0.1',
    ]) {
      const family = address.includes(':') ? 6 : 4;
      const enforcer = createNetworkBoundaryEnforcerV1(
        policy('allowlist', ['api.example.com']),
        async () => [{ address, family } as NetworkResolvedAddressV1],
      );
      await expect(
        enforcer.admit({
          url: 'https://api.example.com',
          toolCallId: `tool-${address}`,
          invocationId: address,
          hop: 0,
        }),
      ).rejects.toMatchObject({ code: 'private_or_reserved_address' });
    }

    const mixed = createNetworkBoundaryEnforcerV1(
      policy('allowlist', ['api.example.com']),
      async () => [publicAddress, { address: '127.0.0.1', family: 4 }],
    );
    await expect(
      mixed.admit({
        url: 'https://api.example.com',
        toolCallId: 'tool-mixed',
        invocationId: 'mixed',
        hop: 0,
      }),
    ).rejects.toMatchObject({ code: 'private_or_reserved_address' });
  });

  test('uses a stable endpoint revision but a distinct receipt per invocation', async () => {
    const addresses = [
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 as const },
      publicAddress,
    ];
    let reverse = false;
    const enforcer = createNetworkBoundaryEnforcerV1(
      policy('allowlist', ['api.example.com']),
      async () => {
        reverse = !reverse;
        return reverse ? addresses : [...addresses].reverse();
      },
    );
    const first = await enforcer.admit({
      url: 'https://api.example.com/v1',
      toolCallId: 'tool-one',
      invocationId: 'one',
      hop: 0,
    });
    const second = await enforcer.admit({
      url: 'https://api.example.com/v2',
      toolCallId: 'tool-two',
      invocationId: 'two',
      hop: 0,
    });
    expect(first.endpointRevision).toBe(second.endpointRevision);
    expect(first.receiptDigest).not.toBe(second.receiptDigest);
    expect(first.invocationId).not.toBe(second.invocationId);
  });

  test('checks and pins every redirect hop before issuing the next request', async () => {
    const requests: string[] = [];
    const fetchImpl = createNetworkBoundaryFetchV1(
      policy('allowlist', ['public.example', 'private.example']),
      {
        resolver: async (hostname) =>
          hostname === 'private.example' ? [{ address: '127.0.0.1', family: 4 }] : [publicAddress],
        request: async (input) => {
          requests.push(`${input.url.href}@${input.admission.address}`);
          return new Response(null, {
            status: 302,
            headers: { location: 'https://private.example/secret' },
          });
        },
      },
    );

    await expect(fetchImpl('https://public.example/start')).rejects.toMatchObject({
      code: 'private_or_reserved_address',
    });
    expect(requests).toEqual(['https://public.example/start@93.184.216.34']);
  });

  test('re-resolves the same host on redirect and stops DNS rebinding before the socket', async () => {
    let resolutions = 0;
    let requests = 0;
    const fetchImpl = createNetworkBoundaryFetchV1(policy('allowlist', ['rebind.example']), {
      resolver: async () => {
        resolutions += 1;
        return resolutions === 1 ? [publicAddress] : [{ address: '127.0.0.1', family: 4 }];
      },
      request: async () => {
        requests += 1;
        return new Response(null, { status: 302, headers: { location: '/next' } });
      },
    });

    await expect(fetchImpl('https://rebind.example/start')).rejects.toMatchObject({
      code: 'private_or_reserved_address',
    });
    expect(resolutions).toBe(2);
    expect(requests).toBe(1);
  });

  test('classifies public and embedded IPv4 addresses conservatively', () => {
    expect(isPublicNetworkAddress('8.8.8.8')).toBe(true);
    expect(isPublicNetworkAddress('2606:4700:4700::1111')).toBe(true);
    expect(isPublicNetworkAddress('::ffff:8.8.8.8')).toBe(false);
    expect(isPublicNetworkAddress('::ffff:127.0.0.1')).toBe(false);
    expect(isPublicNetworkAddress('not-an-ip')).toBe(false);
  });

  test('returns a typed unavailable failure when the controller crashes', async () => {
    const enforcer = createNetworkBoundaryEnforcerV1(
      policy('allowlist', ['api.example.com']),
      async () => {
        throw new Error('resolver crashed');
      },
    );
    try {
      await enforcer.admit({
        url: 'https://api.example.com',
        toolCallId: 'tool-crash',
        invocationId: 'crash',
        hop: 0,
      });
      throw new Error('Expected admission to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(NetworkBoundaryError);
      expect(error).toMatchObject({ code: 'controller_unavailable' });
    }
  });

  test('persists an allow decision before opening the pinned request', async () => {
    let releaseRecorder: (() => void) | undefined;
    let recorderStarted: (() => void) | undefined;
    const recorderStartedPromise = new Promise<void>((resolve) => {
      recorderStarted = resolve;
    });
    const recorderReleasePromise = new Promise<void>((resolve) => {
      releaseRecorder = resolve;
    });
    let requestStarted = false;
    const fetchImpl = createNetworkBoundaryFetchV1(policy('allowlist', ['api.example.com']), {
      resolver: async () => [publicAddress],
      recordDecision: async () => {
        recorderStarted?.();
        await recorderReleasePromise;
      },
      request: async () => {
        requestStarted = true;
        return new Response('ok');
      },
    });

    const pending = fetchImpl('https://api.example.com/data');
    await recorderStartedPromise;
    expect(requestStarted).toBe(false);
    releaseRecorder?.();
    await expect(pending.then((response) => response.text())).resolves.toBe('ok');
    expect(requestStarted).toBe(true);
  });

  test('fails closed when allow or denial receipt persistence is unavailable', async () => {
    let requestCount = 0;
    const allowFetch = createNetworkBoundaryFetchV1(policy('allowlist', ['api.example.com']), {
      resolver: async () => [publicAddress],
      recordDecision: async () => {
        throw new Error('store unavailable');
      },
      request: async () => {
        requestCount += 1;
        return new Response('unexpected');
      },
    });
    await expect(allowFetch('https://api.example.com')).rejects.toMatchObject({
      code: 'controller_unavailable',
    });
    expect(requestCount).toBe(0);

    const denyEnforcer = createNetworkBoundaryEnforcerV1(
      policy('allowlist', ['api.example.com']),
      async () => [{ address: '127.0.0.1', family: 4 }],
      async () => {
        throw new Error('store unavailable');
      },
    );
    await expect(
      denyEnforcer.admit({
        url: 'https://api.example.com',
        toolCallId: 'tool-deny-store',
        invocationId: 'deny-store',
        hop: 0,
      }),
    ).rejects.toMatchObject({ code: 'controller_unavailable' });
  });

  test('bounds redirect configuration before any admission occurs', () => {
    expect(() =>
      createNetworkBoundaryFetchV1(policy('allowlist', ['api.example.com']), {
        maxRedirects: Number.POSITIVE_INFINITY,
      }),
    ).toThrow('integer between 0 and 20');
  });
});

describe('network boundary tool integration', () => {
  test('rolls a disabled feature back to network off and persists the denial receipt', async () => {
    const decisions: Array<{ outcome: string; failureCode?: string }> = [];
    const result = await invokeGovernedTool({
      workspace: process.cwd(),
      request: request('web_fetch', { url: 'https://api.example.com/data' }),
      authorization: { mode: 'full_access', commandGrants: {} },
      approvedGrant: 'approve_once',
      taskConfig: taskConfig('allowlist', ['api.example.com'], false),
      recordNetworkDecision: async (decision) => {
        decisions.push(decision);
      },
    });

    expect(result.ok).toBe(false);
    expect(result.resultMeta).toMatchObject({
      networkFailureCode: 'network_off',
      networkAdmissionDigests: [expect.any(String), expect.any(String)],
    });
    expect(decisions).toHaveLength(2);
    expect(decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ outcome: 'denied', failureCode: 'network_off' }),
      ]),
    );
  });

  test('projects approved shell network access through a sealed managed-tool boundary', async () => {
    let observedNetworkMode: string | undefined;
    const result = await invokeGovernedTool({
      workspace: process.cwd(),
      request: request('shell_execute', { command: 'curl https://api.example.com' }),
      authorization: { mode: 'full_access', commandGrants: {} },
      approvedGrant: 'approve_once',
      taskConfig: taskConfig('allowlist', ['api.example.com']),
      shellExecutor: async (input) => {
        observedNetworkMode = input.networkMode;
        return { ok: true, command: input.command, exitCode: 0, stdout: '', stderr: '' };
      },
    });

    expect(result.ok).toBe(true);
    expect(observedNetworkMode).toBe('allow_all');
  });

  test('rejects every MCP transport entrypoint before consulting the provider', async () => {
    let providerCalls = 0;
    const provider = new Proxy(
      {},
      {
        get: () => () => {
          providerCalls += 1;
          throw new Error('MCP provider must not be consulted');
        },
      },
    ) as McpRuntimeProvider;
    for (const networkRequest of [
      request('list_mcp_resources', {}),
      request('list_mcp_tools', {}),
      request('read_mcp_resource', { server: 'docs', uri: 'docs://one' }),
      request('mcp__docs__search', { query: 'one' }),
    ]) {
      const result = await invokeGovernedTool({
        workspace: process.cwd(),
        request: networkRequest,
        authorization: { mode: 'full_access', commandGrants: {} },
        approvedGrant: 'approve_once',
        taskConfig: taskConfig('allowlist', ['api.example.com']),
        mcpManager: provider,
      });
      expect(result).toMatchObject({
        ok: false,
        status: 'rejected',
        resultMeta: { networkFailureCode: 'controller_unavailable' },
      });
    }
    expect(providerCalls).toBe(0);
  });

  test('persists per-hop network decisions into the Runtime snapshot idempotently', async () => {
    const decision = await createNetworkBoundaryEnforcerV1(
      policy('allowlist', ['api.example.com']),
      async () => [publicAddress],
    ).admit({
      url: 'https://api.example.com/data',
      toolCallId: 'runtime-fetch',
      invocationId: 'runtime-invocation',
      hop: 0,
    });
    const store = createRuntimeStore(':memory:');
    const kernel = new AgentKernel({
      store,
      initialState: createInitialRuntimeState({
        threadId: 'network-runtime',
        userId: 'user',
        workspace: process.cwd(),
      }),
      interactionMode: 'accept_edits',
    });
    kernel.processEvent({
      type: 'tool.queued',
      toolCallId: 'runtime-fetch',
      name: 'web_fetch',
      args: { url: 'https://api.example.com/data' },
    });
    kernel.processEvent({
      type: 'network.admission_decided',
      toolCallId: 'runtime-fetch',
      decision,
    });
    kernel.processEvent({
      type: 'network.admission_decided',
      toolCallId: 'runtime-fetch',
      decision,
    });

    const snapshot =
      store.loadSnapshot<ReturnType<typeof createInitialRuntimeState>>('network-runtime');
    expect(snapshot?.tools.calls['runtime-fetch']?.networkDecisions).toEqual([decision]);
    kernel.close();
  });
});
