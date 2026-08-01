import { describe, expect, test } from 'bun:test';
import {
  EXECUTION_STATUS_CAPABILITIES_V1,
  type ExecutionStatusProjectionInputV1,
  formatExecutionStatusV1,
  formatUnadmittedExecutionStatusV1,
  projectExecutionStatusV1,
  tryProjectAdmittedExecutionStatusV1,
} from '../../src/app/release/execution-status';

function input(
  overrides: Partial<ExecutionStatusProjectionInputV1> = {},
): ExecutionStatusProjectionInputV1 {
  return {
    sandboxBackend: 'seatbelt',
    sandboxAvailable: true,
    boundary: {
      filesystemScope: 'workspace_write',
      networkMode: 'allowlist',
      networkAllowlist: ['api.example.com', 'objects.example.com'],
      protectedPathPolicy: 'deny',
      sandboxUnavailable: 'fail',
    },
    capabilitySurface: {
      network: true,
      process: true,
      write: true,
      workspaceWrite: true,
      shell: true,
      skillChild: true,
      localStdioMcp: false,
    },
    worktreeMode: 'controller_worktree',
    controllerOwned: true,
    capabilityDisabledReasons: {
      localStdioMcp: ['feature_disabled'],
    },
    ...overrides,
  };
}

describe('execution status projection', () => {
  test('projects the actual enforcement and controller state in a stable order', () => {
    const status = projectExecutionStatusV1(input());

    expect(status).toEqual({
      version: 1,
      sandbox: {
        backend: 'seatbelt',
        available: true,
        unavailablePolicy: 'fail',
        fallbackActive: false,
      },
      filesystemScope: 'workspace_write',
      network: {
        mode: 'allowlist',
        allowlistedHostCount: 2,
      },
      protectedPaths: {
        policy: 'deny',
      },
      controllerWorktree: {
        mode: 'controller_worktree',
        controllerOwned: true,
        active: true,
        disabledReasons: [],
      },
      capabilities: [
        { capability: 'network', enabled: true, disabledReasons: [] },
        { capability: 'process', enabled: true, disabledReasons: [] },
        { capability: 'write', enabled: true, disabledReasons: [] },
        { capability: 'workspaceWrite', enabled: true, disabledReasons: [] },
        { capability: 'shell', enabled: true, disabledReasons: [] },
        { capability: 'skillChild', enabled: true, disabledReasons: [] },
        {
          capability: 'localStdioMcp',
          enabled: false,
          disabledReasons: ['feature_disabled'],
        },
      ],
    });
    expect(status.capabilities.map(({ capability }) => capability)).toEqual([
      ...EXECUTION_STATUS_CAPABILITIES_V1,
    ]);
    expect(JSON.stringify(status)).not.toContain('api.example.com');
    expect(JSON.stringify(status)).not.toContain('objects.example.com');
  });

  test('shows read-only fallback and typed reasons without exposing the security profile', () => {
    const status = projectExecutionStatusV1(
      input({
        sandboxBackend: 'none',
        sandboxAvailable: false,
        boundary: {
          filesystemScope: 'read_only',
          networkMode: 'off',
          networkAllowlist: [],
          protectedPathPolicy: 'deny',
          sandboxUnavailable: 'verified_in_process_read_only',
        },
        capabilitySurface: {
          network: false,
          process: false,
          write: false,
          workspaceWrite: false,
          shell: false,
          skillChild: false,
          localStdioMcp: false,
        },
        worktreeMode: 'current_checkout',
        controllerOwned: false,
        capabilityDisabledReasons: {
          localStdioMcp: ['feature_disabled', 'feature_disabled'],
        },
        worktreeDisabledReasons: ['feature_disabled'],
      }),
    );

    expect(status.sandbox).toEqual({
      backend: 'none',
      available: false,
      unavailablePolicy: 'verified_in_process_read_only',
      fallbackActive: true,
    });
    expect(status.network).toEqual({ mode: 'off', allowlistedHostCount: 0 });
    expect(status.controllerWorktree).toEqual({
      mode: 'current_checkout',
      controllerOwned: false,
      active: false,
      disabledReasons: ['controller_worktree_disabled', 'feature_disabled'],
    });
    expect(status.capabilities.find(({ capability }) => capability === 'network')).toEqual({
      capability: 'network',
      enabled: false,
      disabledReasons: ['network_off', 'sandbox_verified_read_only_fallback'],
    });
    expect(status.capabilities.find(({ capability }) => capability === 'write')).toEqual({
      capability: 'write',
      enabled: false,
      disabledReasons: ['filesystem_read_only', 'sandbox_verified_read_only_fallback'],
    });
    expect(status.capabilities.find(({ capability }) => capability === 'localStdioMcp')).toEqual({
      capability: 'localStdioMcp',
      enabled: false,
      disabledReasons: ['feature_disabled', 'sandbox_verified_read_only_fallback'],
    });

    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain('workspaceRoot');
    expect(serialized).not.toContain('networkAllowlist');
    expect(serialized).not.toContain('maxProcessTreeSizePerShellInvocation');
    expect(serialized).not.toContain('inProcessReadOnlyTools');
    expect(serialized).not.toContain('qualificationProof');
  });

  test('keeps disabled annotations off enabled capabilities and reports fail-closed fallback', () => {
    const status = projectExecutionStatusV1(
      input({
        sandboxBackend: 'none',
        sandboxAvailable: false,
        capabilityDisabledReasons: {
          network: ['feature_disabled'],
          localStdioMcp: ['approved_qualification_unavailable'],
        },
        worktreeMode: 'controller_worktree',
        controllerOwned: false,
      }),
    );

    expect(status.sandbox.fallbackActive).toBe(false);
    expect(status.capabilities.find(({ capability }) => capability === 'network')).toEqual({
      capability: 'network',
      enabled: true,
      disabledReasons: [],
    });
    expect(status.capabilities.find(({ capability }) => capability === 'localStdioMcp')).toEqual({
      capability: 'localStdioMcp',
      enabled: false,
      disabledReasons: ['approved_qualification_unavailable', 'sandbox_unavailable'],
    });
    expect(status.controllerWorktree.disabledReasons).toEqual(['controller_ownership_unverified']);
  });

  test('formats only admitted effective state and never exposes allowlisted hosts', () => {
    const config = {
      apiKey: 'secret',
      baseURL: 'https://model.example.com',
      modelName: 'model',
      providerName: 'provider',
      providerType: 'openai' as const,
      sandbox: { enabled: true },
      executionBoundary: {
        ...input().boundary,
        workspaceRoot: '/workspace',
        allowLocalAndPrivateNetwork: false as const,
        maxProcessTreeSizePerShellInvocation: 16,
        sandboxRequired: true,
      },
      executionCapabilitySurface: {
        ...input().capabilitySurface,
        inProcessReadOnlyTools: null,
      },
      productionExecution: { qualificationId: 'qualification-v1' },
    };
    const status = tryProjectAdmittedExecutionStatusV1({
      config,
      sandboxRuntime: { backend: 'seatbelt', available: true },
    });

    expect(status).not.toBeNull();
    const text = formatExecutionStatusV1(status!);
    expect(text).toContain('Execution boundary: admitted');
    expect(text).toContain('Network: mode=allowlist allowlisted_host_count=2');
    expect(text).toContain('localStdioMcp: disabled (feature_disabled)');
    expect(text).not.toContain('api.example.com');
    expect(text).not.toContain('objects.example.com');
    expect(text).not.toContain('qualification-v1');
    expect(text).not.toContain('secret');
  });

  test('reports an unadmitted development entry without inventing a release boundary', () => {
    const config = {
      apiKey: '',
      baseURL: 'http://localhost:11434',
      modelName: 'model',
      providerName: 'provider',
      providerType: 'ollama' as const,
      sandbox: { enabled: false },
    };
    expect(
      tryProjectAdmittedExecutionStatusV1({
        config,
        sandboxRuntime: { backend: 'none', available: false },
      }),
    ).toBeNull();
    expect(formatUnadmittedExecutionStatusV1({ backend: 'none', available: false })).toContain(
      'Execution boundary: not admitted',
    );
  });
});
