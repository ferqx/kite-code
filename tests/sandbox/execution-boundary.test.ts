import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ExecutionBackendCapabilitiesV1,
  ExecutionBoundaryAdmissionReasonV1,
  ExecutionBoundaryV1,
  InProcessReadOnlyToolCatalogV1,
  ProductionExecutionQualificationV1,
} from '@kite/builtin-runtime/sandbox';
import {
  isDescriptorAdmittedByInProcessReadOnlyCatalogV1,
  readExecutionEnvironmentIdentityV1,
} from '@kite/builtin-runtime/sandbox';
import {
  APPROVED_PRODUCTION_EXECUTION_QUALIFICATION_DIGEST_V1,
  admitProductionExecutionBoundaryV1,
  composeExecutionBoundaryRolloutV1,
  computeExecutionBoundaryDigestV1,
  computeInProcessReadOnlyToolCatalogDigestV1,
  computeProductionExecutionQualificationRegistryDigestV1,
  executionBackendCapabilitiesV1Schema,
  executionBoundaryV1Schema,
  loadAgentConfig,
  loadApprovedProductionExecutionQualificationRegistryV1,
  loadProductionAgentConfig,
  ProductionExecutionAdmissionError,
  parseExecutionBoundaryV1,
  parseProductionExecutionQualificationRegistryV1,
  qualificationMatchesExecutionEnvironmentV1,
  tightenExecutionBoundaryV1,
} from '#app/config';
import { evaluateExecutionBoundaryQualificationV1 } from '#app/config/execution-boundary';
import type { RuntimeJsonValueV1 } from '#runtime-spi';
import {
  createTestAgentToolsV1 as createAgentTools,
  executeTestRuntimeToolV1,
  testBuiltinToolCatalogV1,
} from '../helpers/runtime-model';

const temporaryDirectories: string[] = [];
const originalKiteCodeHome = process.env.KITE_CODE_HOME;

function temporaryWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), 'kite-execution-boundary-'));
  temporaryDirectories.push(workspace);
  return workspace;
}

function boundary(
  workspaceRoot: string,
  overrides: Partial<ExecutionBoundaryV1> = {},
): ExecutionBoundaryV1 {
  return {
    filesystemScope: 'workspace_write',
    workspaceRoot,
    networkMode: 'off',
    networkAllowlist: [],
    allowLocalAndPrivateNetwork: false,
    protectedPathPolicy: 'deny',
    maxProcessTreeSizePerShellInvocation: 32,
    sandboxRequired: true,
    sandboxUnavailable: 'fail',
    ...overrides,
  };
}

function supportedBackend(
  overrides: Partial<ExecutionBackendCapabilitiesV1> = {},
): ExecutionBackendCapabilitiesV1 {
  return {
    backend: 'seatbelt',
    filesystem: {
      read_only: 'enforced',
      workspace_write: 'enforced',
      full_access: 'unsupported',
    },
    network: { off: 'enforced', allowlist: 'enforced' },
    syscallFilter: 'unsupported',
    processTreeLimit: 'enforced',
    childProcessInheritance: 'enforced',
    verifiedInProcessReadOnly: 'unsupported',
    ...overrides,
  };
}

function toolCatalog(toolIds: string[] = []): InProcessReadOnlyToolCatalogV1 {
  const catalog = {
    version: 1 as const,
    revision: 'fixture-v1',
    tools: toolIds.map((toolId) => ({
      toolId,
      descriptorRevision: 'fixture-v1',
      filesystem: 'workspace_read' as const,
      network: 'none' as const,
      process: false as const,
      write: false as const,
      externalPath: false as const,
    })),
  };
  return { ...catalog, digest: computeInProcessReadOnlyToolCatalogDigestV1(catalog) };
}

function descriptorCatalog(toolName: string): InProcessReadOnlyToolCatalogV1 {
  const descriptor = builtinDescriptor(toolName);
  const catalog = {
    version: 1 as const,
    revision: 'runtime-binding-fixture-v1',
    tools: [
      {
        toolId: descriptor.capabilityId,
        descriptorRevision: descriptor.revision,
        filesystem: 'workspace_read' as const,
        network: 'none' as const,
        process: false as const,
        write: false as const,
        externalPath: false as const,
      },
    ],
  };
  return { ...catalog, digest: computeInProcessReadOnlyToolCatalogDigestV1(catalog) };
}

function builtinDescriptor(toolName: string) {
  const entry = testBuiltinToolCatalogV1().entries.find(
    (candidate) => candidate.visibility === 'model' && candidate.name === toolName,
  );
  if (!entry) throw new Error(`Missing builtin fixture ${toolName}`);
  return entry.descriptor;
}

function qualification(
  outcome: ProductionExecutionQualificationV1['outcome'] = 'supported',
  overrides: Partial<ProductionExecutionQualificationV1> = {},
): ProductionExecutionQualificationV1 {
  const backendCapabilities = overrides.backendCapabilities ?? supportedBackend();
  return {
    version: 1,
    qualificationId: 'fixture-only-not-production-approved',
    decisionId: 'D-04',
    outcome,
    platform: 'darwin',
    osRelease: 'fixture-release',
    osVersion: 'fixture-version',
    arch: 'arm64',
    bunVersion: 'fixture-bun',
    backend: backendCapabilities.backend,
    selectedNetworkMode: 'off',
    entrypoints: ['tui', 'foreground_cli'],
    evidenceDigest: `sha256:${'a'.repeat(64)}`,
    evidenceCommit: 'a'.repeat(40),
    backendCapabilities,
    processCapabilitySurface: {
      shell: true,
      skillChild: false,
      localStdioMcp: false,
    },
    inProcessReadOnlyTools: toolCatalog(),
    ...overrides,
  };
}

function reverseObjectInsertionOrder<T>(value: T): T {
  if (Array.isArray(value)) return value.map(reverseObjectInsertionOrder) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .reverse()
        .map(([key, child]) => [key, reverseObjectInsertionOrder(child)]),
    ) as T;
  }
  return value;
}

function expectProductionRejection(
  load: () => unknown,
  reason: ExecutionBoundaryAdmissionReasonV1,
): void {
  let thrown: unknown;
  try {
    load();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ProductionExecutionAdmissionError);
  expect((thrown as ProductionExecutionAdmissionError).decision.reason).toBe(reason);
}

afterEach(() => {
  if (originalKiteCodeHome === undefined) delete process.env.KITE_CODE_HOME;
  else process.env.KITE_CODE_HOME = originalKiteCodeHome;
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('ExecutionBoundaryV1 schema', () => {
  test('canonicalizes Workspace Trust identity and exact host allowlists', () => {
    const workspace = temporaryWorkspace();
    const nested = join(workspace, 'nested');
    mkdirSync(nested);
    const alias = join(workspace, 'workspace-alias');
    symlinkSync(workspace, alias, process.platform === 'win32' ? 'junction' : 'dir');

    const parsed = parseExecutionBoundaryV1(
      boundary(join(alias, 'nested', '..'), {
        networkMode: 'allowlist',
        networkAllowlist: ['API.Example.COM.', 'api.example.com', 'cdn.example.com'],
      }),
    );

    expect(parsed.workspaceRoot).toBe(realpathSync.native(workspace));
    expect(parsed.networkAllowlist).toEqual(['api.example.com', 'cdn.example.com']);
  });

  test('fails closed on unknown, ambiguous, local, or non-canonicalizable values', () => {
    const workspace = temporaryWorkspace();
    const ordinaryFile = join(workspace, 'not-a-workspace');
    writeFileSync(ordinaryFile, 'file');
    const valid = boundary(workspace);
    const invalid: unknown[] = [
      { ...valid, unknown: true },
      { ...valid, allowLocalAndPrivateNetwork: true },
      { ...valid, maxProcessTreeSizePerShellInvocation: 0 },
      { ...valid, networkMode: 'off', networkAllowlist: ['api.example.com'] },
      { ...valid, networkMode: 'allowlist', networkAllowlist: [] },
      { ...valid, networkMode: 'allowlist', networkAllowlist: ['127.0.0.1'] },
      { ...valid, networkMode: 'allowlist', networkAllowlist: ['https://api.example.com/path'] },
      { ...valid, workspaceRoot: join(workspace, 'missing') },
      { ...valid, workspaceRoot: ordinaryFile },
    ];

    for (const value of invalid) {
      expect(executionBoundaryV1Schema.safeParse(value).success).toBe(false);
    }
  });

  test('produces a stable digest across path aliases, host order, and duplicates', () => {
    const workspace = temporaryWorkspace();
    const alias = join(workspace, 'alias');
    symlinkSync(workspace, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const first = boundary(workspace, {
      networkMode: 'allowlist',
      networkAllowlist: ['b.example.com', 'a.example.com'],
    });
    const second = boundary(alias, {
      networkMode: 'allowlist',
      networkAllowlist: ['A.EXAMPLE.COM', 'b.example.com', 'a.example.com'],
    });

    expect(computeExecutionBoundaryDigestV1(first)).toBe(computeExecutionBoundaryDigestV1(second));
    expect(computeExecutionBoundaryDigestV1(first)).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});

describe('ExecutionBoundaryV1 monotonic composition', () => {
  test('only tightens scopes, hosts, protected paths, process limits, and fallback', () => {
    const workspace = temporaryWorkspace();
    const result = tightenExecutionBoundaryV1({
      ceiling: boundary(workspace, {
        filesystemScope: 'full_access',
        networkMode: 'allowlist',
        networkAllowlist: ['api.example.com', 'cdn.example.com'],
        protectedPathPolicy: 'prompt',
        maxProcessTreeSizePerShellInvocation: 64,
        sandboxRequired: false,
        sandboxUnavailable: 'verified_in_process_read_only',
      }),
      tightening: boundary(workspace, {
        filesystemScope: 'workspace_write',
        networkMode: 'allowlist',
        networkAllowlist: ['api.example.com', 'other.example.com'],
        maxProcessTreeSizePerShellInvocation: 32,
      }),
    });

    expect(result).toMatchObject({
      filesystemScope: 'workspace_write',
      networkMode: 'allowlist',
      networkAllowlist: ['api.example.com'],
      protectedPathPolicy: 'deny',
      maxProcessTreeSizePerShellInvocation: 32,
      sandboxRequired: true,
      sandboxUnavailable: 'fail',
    });
  });

  test('collapses an empty allowlist intersection to network off', () => {
    const workspace = temporaryWorkspace();
    const result = tightenExecutionBoundaryV1({
      ceiling: boundary(workspace, {
        networkMode: 'allowlist',
        networkAllowlist: ['a.example.com'],
      }),
      tightening: boundary(workspace, {
        networkMode: 'allowlist',
        networkAllowlist: ['b.example.com'],
      }),
    });
    expect(result.networkMode).toBe('off');
    expect(result.networkAllowlist).toEqual([]);
  });

  test('never composes boundaries for different canonical workspaces', () => {
    const first = temporaryWorkspace();
    const second = temporaryWorkspace();
    expect(() =>
      tightenExecutionBoundaryV1({ ceiling: boundary(first), tightening: boundary(second) }),
    ).toThrow('different canonical workspaces');
  });

  test('is commutative and never widens any filesystem or numeric limit combination', () => {
    const workspace = temporaryWorkspace();
    const scopes = ['read_only', 'workspace_write', 'full_access'] as const;
    const limits = [1, 16, 32, 64] as const;
    const scopeRank = { read_only: 0, workspace_write: 1, full_access: 2 } as const;

    for (const leftScope of scopes) {
      for (const rightScope of scopes) {
        for (const leftLimit of limits) {
          for (const rightLimit of limits) {
            const left = boundary(workspace, {
              filesystemScope: leftScope,
              maxProcessTreeSizePerShellInvocation: leftLimit,
            });
            const right = boundary(workspace, {
              filesystemScope: rightScope,
              maxProcessTreeSizePerShellInvocation: rightLimit,
            });
            const leftRight = tightenExecutionBoundaryV1({ ceiling: left, tightening: right });
            const rightLeft = tightenExecutionBoundaryV1({ ceiling: right, tightening: left });

            expect(leftRight).toEqual(rightLeft);
            expect(scopeRank[leftRight.filesystemScope]).toBeLessThanOrEqual(scopeRank[leftScope]);
            expect(scopeRank[leftRight.filesystemScope]).toBeLessThanOrEqual(scopeRank[rightScope]);
            expect(leftRight.maxProcessTreeSizePerShellInvocation).toBe(
              Math.min(leftLimit, rightLimit),
            );
          }
        }
      }
    }
  });
});

describe('production execution admission', () => {
  test('uses the release-pinned empty registry and cannot accept caller-created support', () => {
    const workspace = temporaryWorkspace();
    const registry = loadApprovedProductionExecutionQualificationRegistryV1();
    expect(registry.digest).toBe(APPROVED_PRODUCTION_EXECUTION_QUALIFICATION_DIGEST_V1);
    expect(registry.status).toBe('accepted_empty_support_set');
    expect(registry.qualifications).toEqual([]);
    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registry.qualifications)).toBe(true);

    expect(
      admitProductionExecutionBoundaryV1({
        featureEnabled: false,
        boundary: boundary(workspace),
        workspaceRoot: workspace,
        entrypoint: 'tui',
        sandboxEnabled: true,
      }).reason,
    ).toBe('feature_disabled');
    const decision = admitProductionExecutionBoundaryV1({
      featureEnabled: true,
      boundary: boundary(workspace),
      workspaceRoot: workspace,
      entrypoint: 'tui',
      sandboxEnabled: true,
    });
    expect(decision).toMatchObject({ allowed: false, reason: 'platform_excluded' });
    expect(decision.surface).toEqual({
      inProcessReadOnlyTools: null,
      network: false,
      process: false,
      write: false,
      workspaceWrite: false,
      shell: false,
      skillChild: false,
      localStdioMcp: false,
      gitInspect: false,
      brokeredGitFeatureRevision: null,
    });
    expect(
      admitProductionExecutionBoundaryV1({
        featureEnabled: true,
        boundary: boundary(workspace),
        workspaceRoot: workspace,
        entrypoint: 'tui',
        sandboxEnabled: false,
      }).reason,
    ).toBe('sandbox_disabled');
  });

  test('uses the same canonical environment identity as native evidence', () => {
    const environment = readExecutionEnvironmentIdentityV1();
    expect(['darwin', 'linux', 'win32']).toContain(environment.platform);
    const exactQualification = qualification('supported', {
      platform: environment.platform as ProductionExecutionQualificationV1['platform'],
      osRelease: environment.osRelease,
      osVersion: environment.osVersion,
      arch: environment.arch,
      bunVersion: environment.bunVersion,
    });
    expect(
      qualificationMatchesExecutionEnvironmentV1({
        qualification: exactQualification,
        environment,
        backend: exactQualification.backend,
        entrypoint: 'foreground_cli',
      }),
    ).toBe(true);
    expect(
      qualificationMatchesExecutionEnvironmentV1({
        qualification: { ...exactQualification, osVersion: `${environment.osVersion}-drift` },
        environment,
        backend: exactQualification.backend,
        entrypoint: 'foreground_cli',
      }),
    ).toBe(false);
  });

  test('rejects duplicate environment admission keys independent of registry order', () => {
    const first = qualification('supported', { qualificationId: 'first' });
    const second = qualification('supported', { qualificationId: 'second' });
    const registryWithoutDigest = {
      version: 1 as const,
      decisionId: 'D-04' as const,
      revision: 'duplicate-environment-fixture',
      status: 'accepted_non_empty_support_set' as const,
      selectedNetworkMode: 'off' as const,
      evidenceCommit: 'a'.repeat(40),
      qualifications: [first, second],
    };
    const reversedWithoutDigest = {
      ...registryWithoutDigest,
      qualifications: [second, first],
    };
    const digest = computeProductionExecutionQualificationRegistryDigestV1(registryWithoutDigest);
    expect(computeProductionExecutionQualificationRegistryDigestV1(reversedWithoutDigest)).toBe(
      digest,
    );
    expect(() =>
      parseProductionExecutionQualificationRegistryV1({
        ...registryWithoutDigest,
        digest,
      }),
    ).toThrow('production environment admission keys must be unique');
    expect(() =>
      parseProductionExecutionQualificationRegistryV1({
        ...reversedWithoutDigest,
        digest,
      }),
    ).toThrow('production environment admission keys must be unique');
  });

  test('qualification and catalog digests ignore caller object insertion order', () => {
    const catalogWithoutDigest = {
      version: 1 as const,
      revision: 'canonical-order-fixture',
      tools: [
        {
          toolId: 'builtin:β',
          descriptorRevision: 'revision-β',
          filesystem: 'workspace_read' as const,
          network: 'none' as const,
          process: false as const,
          write: false as const,
          externalPath: false as const,
        },
        {
          toolId: 'builtin:Z',
          descriptorRevision: 'revision-Z',
          filesystem: 'workspace_read' as const,
          network: 'none' as const,
          process: false as const,
          write: false as const,
          externalPath: false as const,
        },
      ],
    };
    const catalogDigest = computeInProcessReadOnlyToolCatalogDigestV1(catalogWithoutDigest);
    expect(
      computeInProcessReadOnlyToolCatalogDigestV1(
        reverseObjectInsertionOrder(catalogWithoutDigest),
      ),
    ).toBe(catalogDigest);

    const registryWithoutDigest = {
      version: 1 as const,
      decisionId: 'D-04' as const,
      revision: 'canonical-order-fixture',
      status: 'accepted_non_empty_support_set' as const,
      selectedNetworkMode: 'off' as const,
      evidenceCommit: 'a'.repeat(40),
      qualifications: [
        qualification('supported', {
          qualificationId: 'qualification-β',
          inProcessReadOnlyTools: { ...catalogWithoutDigest, digest: catalogDigest },
        }),
      ],
    };
    expect(
      computeProductionExecutionQualificationRegistryDigestV1(
        reverseObjectInsertionOrder(registryWithoutDigest),
      ),
    ).toBe(computeProductionExecutionQualificationRegistryDigestV1(registryWithoutDigest));
  });

  test('the fixture-only technical evaluator fails closed on identity and scope', () => {
    const workspace = temporaryWorkspace();
    const otherWorkspace = temporaryWorkspace();
    const common = {
      featureEnabled: true,
      boundary: boundary(workspace),
      workspaceRoot: workspace,
      qualification: qualification(),
    };
    expect(
      evaluateExecutionBoundaryQualificationV1({ ...common, boundary: undefined }).reason,
    ).toBe('boundary_missing');
    expect(evaluateExecutionBoundaryQualificationV1({ ...common, boundary: {} }).reason).toBe(
      'boundary_invalid',
    );
    expect(
      evaluateExecutionBoundaryQualificationV1({ ...common, workspaceRoot: otherWorkspace }).reason,
    ).toBe('workspace_mismatch');
    expect(
      evaluateExecutionBoundaryQualificationV1({
        ...common,
        boundary: boundary(workspace, { filesystemScope: 'full_access' }),
      }).reason,
    ).toBe('full_access_not_qualified');
    expect(
      evaluateExecutionBoundaryQualificationV1({
        ...common,
        qualification: qualification('supported', { entrypoints: ['tui'] }),
      }).reason,
    ).toBe('approved_qualification_unavailable');
  });

  test('requires every declared backend strength instead of sandboxAvailable', () => {
    const workspace = temporaryWorkspace();
    const cases: Array<[ExecutionBackendCapabilitiesV1, ExecutionBoundaryAdmissionReasonV1]> = [
      [supportedBackend({ backend: 'none' }), 'sandbox_required'],
      [
        supportedBackend({
          filesystem: {
            read_only: 'enforced',
            workspace_write: 'unsupported',
            full_access: 'unsupported',
          },
        }),
        'backend_filesystem_unsupported',
      ],
      [
        supportedBackend({ network: { off: 'unsupported', allowlist: 'enforced' } }),
        'backend_network_unsupported',
      ],
      [
        supportedBackend({ backend: 'bubblewrap', syscallFilter: 'unsupported' }),
        'backend_syscall_filter_unsupported',
      ],
      [supportedBackend({ processTreeLimit: 'unsupported' }), 'backend_process_tree_unsupported'],
      [
        supportedBackend({ childProcessInheritance: 'unsupported' }),
        'backend_child_inheritance_unsupported',
      ],
    ];

    for (const [backendCapabilities, reason] of cases) {
      const decision = evaluateExecutionBoundaryQualificationV1({
        featureEnabled: true,
        boundary: boundary(workspace),
        workspaceRoot: workspace,
        qualification: qualification('supported', {
          backend: backendCapabilities.backend,
          backendCapabilities,
        }),
      });
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe(reason);
      expect(decision.surface.inProcessReadOnlyTools).toBeNull();
      expect(
        Object.values(decision.surface).filter((value) => typeof value === 'boolean'),
      ).not.toContain(true);
    }
  });

  test('technical evaluation admits only the capability surface represented by a valid fixture', () => {
    const workspace = temporaryWorkspace();
    const decision = evaluateExecutionBoundaryQualificationV1({
      featureEnabled: true,
      boundary: boundary(workspace),
      workspaceRoot: workspace,
      qualification: qualification(),
    });

    expect(decision.allowed).toBe(true);
    expect(decision.admissionKind).toBe('technical_evaluation');
    expect(decision.reason).toBe('admitted');
    expect(decision.surface).toEqual({
      inProcessReadOnlyTools: toolCatalog(),
      network: false,
      process: true,
      write: true,
      workspaceWrite: true,
      shell: true,
      skillChild: false,
      localStdioMcp: false,
      gitInspect: false,
      brokeredGitFeatureRevision: null,
    });
  });

  test('never exposes process capabilities omitted by the qualification surface', () => {
    const workspace = temporaryWorkspace();
    const base = qualification();
    const expanded = evaluateExecutionBoundaryQualificationV1({
      featureEnabled: true,
      boundary: boundary(workspace),
      workspaceRoot: workspace,
      qualification: {
        ...base,
        processCapabilitySurface: {
          shell: true,
          skillChild: true,
          localStdioMcp: false,
        },
      },
    });
    expect(expanded.allowed).toBe(true);
    expect(expanded.surface).toMatchObject({ shell: true, skillChild: true, localStdioMcp: false });

    const brokered = evaluateExecutionBoundaryQualificationV1({
      featureEnabled: true,
      boundary: boundary(workspace),
      workspaceRoot: workspace,
      qualification: {
        ...base,
        processCapabilitySurface: {
          shell: true,
          skillChild: false,
          localStdioMcp: false,
          brokeredGit: {
            featureRevision: 'brokered-git-r1',
            inspect: true,
            shellDenyEvidence: {
              featureRevision: 'brokered-git-r1',
              platform: 'darwin',
              backend: 'seatbelt',
              outcome: 'qualified',
              metadataReadDeny: true,
              metadataWriteDeny: true,
              profileRevision: 'fixture-profile-r1',
              profileDigest: `sha256:${'b'.repeat(64)}`,
              protectedRulesDigest: `sha256:${'c'.repeat(64)}`,
            },
          },
        },
      },
    });
    expect(brokered.allowed).toBe(true);
    expect(brokered.surface).toMatchObject({
      gitInspect: true,
      brokeredGitFeatureRevision: 'brokered-git-r1',
    });

    expect(
      evaluateExecutionBoundaryQualificationV1({
        featureEnabled: true,
        boundary: boundary(workspace),
        workspaceRoot: workspace,
        qualification: {
          ...base,
          processCapabilitySurface: {
            shell: false,
            skillChild: true,
            localStdioMcp: false,
          },
        },
      }).reason,
    ).toBe('approved_qualification_unavailable');
  });

  test('read-only native surface independently blocks in-process writers and network tools', async () => {
    const workspace = temporaryWorkspace();
    const configPath = join(workspace, 'kite-code.jsonc');
    writeFileSync(configPath, JSON.stringify({ provider: { ollama: { type: 'ollama' } } }));
    const decision = evaluateExecutionBoundaryQualificationV1({
      featureEnabled: true,
      boundary: boundary(workspace, { filesystemScope: 'read_only' }),
      workspaceRoot: workspace,
      qualification: qualification(),
    });
    expect(decision.allowed).toBe(true);
    expect(decision.surface).toMatchObject({
      network: false,
      process: true,
      write: false,
      shell: true,
    });

    const config = {
      ...loadAgentConfig({ configPath, providerName: 'ollama' }),
      executionCapabilitySurface: decision.surface,
    };
    const disclosed = createAgentTools({ workspace, config });
    expect(disclosed).toHaveProperty('read_file');
    expect(disclosed).toHaveProperty('shell_execute');
    expect(disclosed).not.toHaveProperty('write_file');
    expect(disclosed).not.toHaveProperty('edit_file');
    expect(disclosed).not.toHaveProperty('web_fetch');

    const target = join(workspace, 'should-not-exist.txt');
    const requests: ReadonlyArray<{
      readonly name: 'write_file' | 'edit_file';
      readonly args: Readonly<Record<string, RuntimeJsonValueV1>>;
    }> = [
      {
        name: 'write_file' as const,
        args: { path: 'should-not-exist.txt', content: 'forbidden' },
      },
      {
        name: 'edit_file' as const,
        args: {
          path: 'should-not-exist.txt',
          old_string: 'before',
          new_string: 'after',
        },
      },
    ];
    for (const request of requests) {
      const rejected = await executeTestRuntimeToolV1({
        workspace,
        toolName: request.name,
        args: request.args,
        execution: { taskConfig: config, sandboxAvailable: true },
      });
      expect(rejected.terminal).toMatchObject({ type: 'tool.rejected' });
      if (rejected.terminal?.type === 'tool.rejected') {
        expect(rejected.terminal.reason).toContain('outside the admitted execution surface');
      }
      expect(existsSync(target)).toBe(false);
    }

    const outsideWorkspace = temporaryWorkspace();
    writeFileSync(join(outsideWorkspace, 'secret.txt'), 'external read\n');
    symlinkSync(
      outsideWorkspace,
      join(workspace, 'escape'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    for (const path of [join(outsideWorkspace, 'secret.txt'), 'escape/secret.txt']) {
      const externalRead = await executeTestRuntimeToolV1({
        workspace,
        toolName: 'read_file',
        args: { path },
        execution: { taskConfig: config, sandboxAvailable: true },
      });
      // A native process qualification may withhold writers/network tools, but
      // it must not reinterpret a governed in-process file read as an external
      // process capability. This fixture intentionally has no filesystem
      // Pipeline composition, so only the execution-surface rejection matters.
      expect(externalRead.terminal?.type).not.toBe('tool.rejected');
      if (externalRead.terminal?.type === 'tool.finished') {
        expect(externalRead.terminal.result.stderr).not.toContain(
          'outside the admitted execution surface',
        );
      }
    }
  });

  test('read-only-only qualification never exposes a process or writer', () => {
    const workspace = temporaryWorkspace();
    const fallbackBackend = supportedBackend({
      backend: 'none',
      verifiedInProcessReadOnly: 'enforced',
    });
    const readOnlyQualification = qualification('read_only_only', {
      backend: 'none',
      backendCapabilities: fallbackBackend,
      inProcessReadOnlyTools: descriptorCatalog('read_file'),
    });
    const decision = evaluateExecutionBoundaryQualificationV1({
      featureEnabled: true,
      boundary: boundary(workspace, {
        filesystemScope: 'read_only',
        sandboxUnavailable: 'verified_in_process_read_only',
      }),
      workspaceRoot: workspace,
      qualification: readOnlyQualification,
    });

    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe('verified_in_process_read_only');
    expect(decision.surface).toEqual({
      inProcessReadOnlyTools: readOnlyQualification.inProcessReadOnlyTools,
      network: false,
      process: false,
      write: false,
      workspaceWrite: false,
      shell: false,
      skillChild: false,
      localStdioMcp: false,
      gitInspect: false,
      brokeredGitFeatureRevision: null,
    });
    expect(
      evaluateExecutionBoundaryQualificationV1({
        featureEnabled: true,
        boundary: boundary(workspace),
        workspaceRoot: workspace,
        qualification: readOnlyQualification,
      }).reason,
    ).toBe('platform_read_only_only');

    const tamperedCatalog = {
      ...readOnlyQualification.inProcessReadOnlyTools,
      tools: [
        {
          ...readOnlyQualification.inProcessReadOnlyTools.tools[0]!,
          process: true,
        },
      ],
    };
    expect(
      evaluateExecutionBoundaryQualificationV1({
        featureEnabled: true,
        boundary: boundary(workspace, {
          filesystemScope: 'read_only',
          sandboxUnavailable: 'verified_in_process_read_only',
        }),
        workspaceRoot: workspace,
        qualification: {
          ...readOnlyQualification,
          inProcessReadOnlyTools: tamperedCatalog,
        },
      }).reason,
    ).toBe('approved_qualification_unavailable');
  });

  test('binds the sealed read-only catalog at disclosure and execution time', async () => {
    const workspace = temporaryWorkspace();
    const configPath = join(workspace, 'kite-code.jsonc');
    writeFileSync(configPath, JSON.stringify({ provider: { ollama: { type: 'ollama' } } }));
    const catalog = descriptorCatalog('read_file');
    const readFileDescriptor = builtinDescriptor('read_file');
    expect(
      isDescriptorAdmittedByInProcessReadOnlyCatalogV1({
        catalog,
        descriptor: readFileDescriptor,
      }),
    ).toBe(true);
    expect(
      isDescriptorAdmittedByInProcessReadOnlyCatalogV1({
        catalog,
        descriptor: { ...readFileDescriptor, revision: `${readFileDescriptor.revision}-drift` },
      }),
    ).toBe(false);

    const config = {
      ...loadAgentConfig({ configPath, providerName: 'ollama' }),
      executionCapabilitySurface: {
        inProcessReadOnlyTools: catalog,
        network: false,
        process: false,
        write: false,
        workspaceWrite: false,
        shell: false,
        skillChild: false,
        localStdioMcp: false,
        gitInspect: false,
        brokeredGitFeatureRevision: null,
      },
    };
    const disclosed = createAgentTools({ workspace, config });
    expect(Object.keys(disclosed)).toEqual(['read_file']);

    const rejected = await executeTestRuntimeToolV1({
      workspace,
      toolName: 'search_files',
      args: { pattern: '*.ts' },
      execution: { taskConfig: config, sandboxAvailable: true },
    });
    expect(rejected.terminal).toMatchObject({ type: 'tool.rejected' });
    if (rejected.terminal?.type === 'tool.rejected') {
      expect(rejected.terminal.reason).toContain('sealed read-only catalog');
    }
  });
});

describe('execution boundary config injection', () => {
  test('composes every rollout source monotonically with deny wins', () => {
    expect(composeExecutionBoundaryRolloutV1([])).toBe(false);
    expect(composeExecutionBoundaryRolloutV1([undefined, true, undefined])).toBe(true);
    expect(composeExecutionBoundaryRolloutV1([false, true])).toBe(false); // user false, project true
    expect(composeExecutionBoundaryRolloutV1([true, false])).toBe(false); // config true, CLI false
    expect(composeExecutionBoundaryRolloutV1([false, true])).toBe(false); // config false, CLI true
  });

  test('ordinary config cannot attach a boundary and production requires both flag layers', () => {
    const workspace = temporaryWorkspace();
    const configPath = join(workspace, 'kite-code.jsonc');
    const artifactBoundary = boundary(workspace);
    writeFileSync(
      configPath,
      JSON.stringify({
        provider: { ollama: { type: 'ollama' } },
        features: { executionBoundaryV1: true },
        executionBoundary: { ...artifactBoundary, filesystemScope: 'full_access' },
      }),
    );

    expect(
      loadAgentConfig({ configPath, providerName: 'ollama' }).executionBoundary,
    ).toBeUndefined();

    const production = (
      artifactExecutionBoundaryV1Enabled: boolean,
      featureOverrides?: { executionBoundaryV1: boolean },
      sandboxEnabled?: boolean,
    ) =>
      loadProductionAgentConfig({
        configPath,
        providerName: 'ollama',
        artifactExecutionBoundaryV1Enabled,
        artifactExecutionBoundary: artifactBoundary,
        workspaceRoot: workspace,
        entrypoint: 'tui',
        featureOverrides,
        sandboxEnabled,
      });
    expectProductionRejection(() => production(false), 'feature_disabled');
    expectProductionRejection(() => production(true), 'platform_excluded');
    expectProductionRejection(
      () => production(true, { executionBoundaryV1: false }),
      'feature_disabled',
    );
    expectProductionRejection(() => production(true, undefined, false), 'sandbox_disabled');

    writeFileSync(
      configPath,
      JSON.stringify({ provider: { ollama: { type: 'ollama' } }, features: {} }),
    );
    expectProductionRejection(() => production(true), 'feature_disabled');
    expectProductionRejection(
      () => production(false, { executionBoundaryV1: true }),
      'feature_disabled',
    );
    expectProductionRejection(
      () => production(true, { executionBoundaryV1: true }),
      'platform_excluded',
    );

    writeFileSync(
      configPath,
      JSON.stringify({
        provider: { ollama: { type: 'ollama' } },
        features: { executionBoundaryV1: false },
      }),
    );
    expectProductionRejection(() => production(true), 'feature_disabled');

    writeFileSync(
      configPath,
      JSON.stringify({
        provider: { ollama: { type: 'ollama' } },
        features: { executionBoundaryV1: true },
        sandbox: { enabled: false },
      }),
    );
    expectProductionRejection(() => production(true), 'sandbox_disabled');
  });

  test('loads project configuration from the admitted canonical workspace', () => {
    const workspace = temporaryWorkspace();
    const configDirectory = join(workspace, '.kite-code');
    mkdirSync(configDirectory);
    writeFileSync(
      join(configDirectory, 'kite-code.jsonc'),
      JSON.stringify({
        provider: { ollama: { type: 'ollama' } },
        features: { executionBoundaryV1: true },
      }),
    );
    const config = loadAgentConfig({ workspace, providerName: 'ollama' });
    expect(config.features?.executionBoundaryV1).toBe(true);
  });

  test('does not let project true elevate an explicit user false', () => {
    const userHome = temporaryWorkspace();
    const workspace = temporaryWorkspace();
    process.env.KITE_CODE_HOME = userHome;
    mkdirSync(join(userHome, '.kite-code'));
    writeFileSync(
      join(userHome, '.kite-code', 'kite-code.jsonc'),
      JSON.stringify({
        provider: { ollama: { type: 'ollama' } },
        features: { executionBoundaryV1: false },
      }),
    );
    mkdirSync(join(workspace, '.kite-code'));
    writeFileSync(
      join(workspace, '.kite-code', 'kite-code.jsonc'),
      JSON.stringify({ features: { executionBoundaryV1: true } }),
    );

    const load = () =>
      loadProductionAgentConfig({
        providerName: 'ollama',
        artifactExecutionBoundaryV1Enabled: true,
        artifactExecutionBoundary: boundary(workspace),
        workspaceRoot: workspace,
        entrypoint: 'tui',
      });
    expectProductionRejection(load, 'feature_disabled');
  });

  test('rejects malformed backend strength projections', () => {
    expect(
      executionBackendCapabilitiesV1Schema.safeParse({
        ...supportedBackend(),
        processTreeLimit: true,
      }).success,
    ).toBe(false);
  });
});
